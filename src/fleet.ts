/**
 * @fileoverview Fleet (fork): machines, accounts and launch profiles for remote Claude sessions.
 *
 * Claude RC treats every machine the owner works on (a PC's WSL, the same PC's native
 * Windows, a Linux server) as a remote host, and every Claude login or API key as an
 * ACCOUNT chosen per session, instead of one remote host per account/variant.
 *
 * Machines are ordinary `RemoteHost`s with two fork fields: `machine` (the machine's
 * name, shared by its systems) and `system` (`wsl` | `windows` | `linux`). A Windows
 * system runs the native Windows `claude` from WSL (`cmd.exe /c claude`), which keeps
 * the agent's own file access native while tmux and ssh stay on the WSL side.
 *
 * Accounts live in `fleet.json` in the config dir (mode 0600, it holds secrets):
 *
 * - `machine`: the machine's own `claude` login. Nothing is injected.
 * - `token`:   a long-lived `claude setup-token` held by this server and copied to the
 *              machine at launch (~/.config/claude-rc/<id>.secret, 0600), then exported
 *              as CLAUDE_CODE_OAUTH_TOKEN. This is how one login is shared across every
 *              device: a normal OAuth login cannot be copied, because its refresh token
 *              rotates and the other copies are signed out.
 * - `api`:     an Anthropic-compatible endpoint (GLM and the like): base URL, a key
 *              copied the same way, and the model names to map onto.
 * - `shell`:   a shell function or command already set up on the machine (e.g. the
 *              owner's `use-glm`), run in the login shell before `claude`.
 *
 * ⚠️ Secrets never leave the server except over the ssh connection that writes the
 * file, via stdin (never argv). Responses carry `hasSecret`, never the value. The launch
 * command only names the FILE, so the persisted session state holds no secret either.
 *
 * ⚠️ Everything interpolated into a remote command is built here from validated
 * fields (ids match `[a-z0-9-]`, models a fixed shape, URLs `https?://` without quotes)
 * and shell-quoted; the browser never supplies command text.
 *
 * Usage (5-hour and 7-day windows) of a `token` account is read by the server itself:
 * a one-token request with that account's token returns the windows in its
 * `anthropic-ratelimit-unified-*` response headers. (The OAuth usage endpoint needs the
 * `user:profile` scope, which a `claude setup-token` token does not have; measured.)
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { RemoteHost, SessionRemote } from './types/index.js';
import { shellescape } from './remote-hosts.js';
import { remoteExecStatus, type RemoteExecError } from './remote-shell-pool.js';

export type FleetSystem = 'wsl' | 'windows' | 'linux';
export type FleetAccountKind = 'machine' | 'token' | 'api' | 'shell';

export interface FleetAccount {
  id: string;
  label: string;
  kind: FleetAccountKind;
  /** Claude account email (shown to tell accounts apart). */
  email?: string;
  /** `api` only: Anthropic-compatible base URL. */
  baseUrl?: string;
  /** `api` only: model every Claude tier maps to (e.g. `glm-5.3`). */
  apiModel?: string;
  /** `api` only: model for the small/fast tier. */
  apiSmallModel?: string;
  /** `shell` only: function/command run first, e.g. `use-glm` (words, no metacharacters). */
  setupCommand?: string;
  /** Token or API key (kinds `token` and `api`). Never sent to the browser. */
  secret?: string;
}

export interface FleetConfig {
  accounts: FleetAccount[];
}

export interface FleetUsage {
  fiveHour: number | null;
  fiveHourResetsAt: string | null;
  sevenDay: number | null;
  sevenDayResetsAt: string | null;
  fetchedAt: string;
}

/** Windows `claude`, reached from WSL. */
export const WINDOWS_CLAUDE_BINARY = '/mnt/c/Windows/System32/cmd.exe /c claude';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,60}(\[1m\])?$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const SECRET_DIR = '~/.config/claude-rc';
const SETUP_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*( [A-Za-z0-9_.:[\]=-]+){0,6}$/;

export function fleetPath(configDir: string): string {
  return join(configDir, 'fleet.json');
}

export async function readFleet(configDir: string): Promise<FleetConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(fleetPath(configDir), 'utf8')) as Partial<FleetConfig>;
    return { accounts: Array.isArray(raw.accounts) ? raw.accounts : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: [] };
    throw err;
  }
}

export async function writeFleet(configDir: string, config: FleetConfig): Promise<void> {
  const path = fleetPath(configDir);
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, path);
}

/** The account as the browser may see it. */
export function publicAccount(account: FleetAccount): Omit<FleetAccount, 'secret'> & { hasSecret: boolean } {
  const { secret, ...rest } = account;
  return { ...rest, hasSecret: Boolean(secret) };
}

const ACCOUNT_KINDS = new Set<string>(['machine', 'token', 'api', 'shell']);

/** Validates an account from the browser; returns an error message or null. */
export function validateAccount(account: FleetAccount): string | null {
  if (!ID_RE.test(account.id)) return 'Account id must be lowercase letters, digits and dashes';
  if (!account.label || account.label.length > 60) return 'Account name is required (60 characters at most)';
  if (!ACCOUNT_KINDS.has(account.kind)) return 'Unknown account kind';
  if (account.kind === 'shell' && !(account.setupCommand && SETUP_RE.test(account.setupCommand))) {
    return 'Give the command as plain words, e.g. use-glm';
  }
  if (account.email && !/^[^\s@'"]+@[^\s@'"]+$/.test(account.email)) return 'Invalid email';
  if (account.kind === 'api') {
    if (!account.baseUrl || !URL_RE.test(account.baseUrl)) return 'API accounts need a base URL (http or https)';
    if (account.apiModel && !MODEL_RE.test(account.apiModel)) return 'Invalid model name';
    if (account.apiSmallModel && !MODEL_RE.test(account.apiSmallModel)) return 'Invalid small model name';
  }
  if (account.secret !== undefined && (/[\r\n]/.test(account.secret) || account.secret.length > 4096)) {
    return 'The token must be a single line';
  }
  return null;
}

export function isValidModel(model: string): boolean {
  return MODEL_RE.test(model);
}

function secretFile(accountId: string): string {
  return `${SECRET_DIR}/${accountId}.secret`;
}

/**
 * The launch profile for one session: shell statements run before `claude`, the binary,
 * and extra arguments. Stored on `SessionRemote.launch`, so a respawn relaunches the
 * same account and model.
 */
export function buildLaunch(
  host: Pick<RemoteHost, 'system'>,
  account: FleetAccount | undefined,
  model: string | undefined
): NonNullable<SessionRemote['launch']> {
  const windows = host.system === 'windows';
  const setup: string[] = [];
  const env: Record<string, string> = {};
  let binary = windows ? WINDOWS_CLAUDE_BINARY : 'claude';

  if (account?.kind === 'token') {
    env.CLAUDE_CODE_OAUTH_TOKEN = `$(cat ${secretFile(account.id)})`;
  } else if (account?.kind === 'shell' && account.setupCommand && SETUP_RE.test(account.setupCommand)) {
    setup.push(`${account.setupCommand} >/dev/null`);
  } else if (account?.kind === 'api') {
    env.ANTHROPIC_BASE_URL = `'${account.baseUrl}'`;
    env.ANTHROPIC_AUTH_TOKEN = `$(cat ${secretFile(account.id)})`;
    if (account.apiModel) {
      for (const key of [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL',
      ]) {
        env[key] = `'${account.apiModel}'`;
      }
    }
    if (account.apiSmallModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = `'${account.apiSmallModel}'`;
  }

  const keys = Object.keys(env);
  if (keys.length) {
    // An account replaces whatever the machine's shell profile pointed claude at.
    setup.push('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN');
    setup.push(...keys.map((key) => `export ${key}="${env[key].replace(/^'|'$/g, '')}"`));
    // WSLENV carries the variables across into the Windows process.
    if (windows) setup.push(`export WSLENV="\${WSLENV:+$WSLENV:}${keys.map((k) => `${k}/u`).join(':')}"`);
  }

  // An api account fixes the model through the env above; --model would be a Claude name.
  const args = model && account?.kind !== 'api' && MODEL_RE.test(model) ? ` --model '${model}'` : '';
  return { setup: setup.length ? setup.join('; ') + '; ' : '', binary, args };
}

const SSH_TIMEOUT_MS = 20_000;

/** Runs one command on a host over the same ssh options as a session, optional stdin. */
export function runOnHost(
  host: RemoteHost,
  command: string,
  input?: string | Buffer,
  timeoutMs = SSH_TIMEOUT_MS
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (process.env.VITEST) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  // A pooled shell: the host's login is paid once, not per command. stdin (tokens) goes
  // through it base64-encoded and never touches the remote disk (remote-shell-pool.ts).
  return remoteExecStatus(host, command, { input, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }).then(
    (r) => ({ code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr }),
    (err: RemoteExecError) => ({
      code: typeof err.code === 'number' ? err.code : err.killed ? null : -1,
      stdout: '',
      stderr: err.stderr || err.message,
    })
  );
}

/**
 * Writes an uploaded file (a pasted image or document) into `<dir>/.codeman-uploads/`
 * on the host, the same folder a local session uses, and returns its path there.
 * The bytes go over ssh stdin; `dir` and `filename` are shell-quoted.
 */
export async function pushUploadToHost(
  host: RemoteHost,
  dir: string,
  filename: string,
  bytes: Buffer
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error('Invalid upload name');
  const uploads = `${dir.replace(/\/+$/, '')}/.codeman-uploads`;
  const target = `${uploads}/${filename}`;
  const result = await runOnHost(
    host,
    `mkdir -p ${shellescape(uploads)} && ` +
      `{ [ -e ${shellescape(uploads + '/.gitignore')} ] || printf '*\\n' > ${shellescape(uploads + '/.gitignore')}; } && ` +
      `cat > ${shellescape(target)}`,
    bytes,
    60_000
  );
  if (result.code !== 0) {
    throw new Error(`Could not copy the file to ${host.label}: ${result.stderr.trim() || 'ssh failed'}`);
  }
  return target;
}

/** Copies an account's secret to the host (0600). No-op for accounts without one. */
export async function pushAccountSecret(host: RemoteHost, account: FleetAccount | undefined): Promise<void> {
  const needed = account && (account.kind === 'token' || account.kind === 'api');
  if (!needed) return;
  if (!account.secret) throw new Error(`${account.label} has no token saved yet`);
  const file = secretFile(account.id);
  const result = await runOnHost(
    host,
    `umask 077; mkdir -p ${SECRET_DIR} && cat > ${file}.tmp && mv -f ${file}.tmp ${file}`,
    account.secret + '\n'
  );
  if (result.code !== 0) {
    throw new Error(
      `Could not copy ${account.label}'s token to ${host.label}: ${result.stderr.trim() || 'ssh failed'}`
    );
  }
}

export interface FolderListing {
  path: string;
  exists: boolean;
  dirs: string[];
}

/**
 * Lists the folders in `path` on a host (one level). A leading `~` is the remote home.
 * `exists: false` means the folder is not there; an ssh failure throws.
 */
export async function listHostFolders(host: RemoteHost, path: string): Promise<FolderListing> {
  if (/[\0\r\n]/.test(path) || path.length > 1024) throw new Error('Invalid path');
  const target =
    path === '~' || path === ''
      ? '"$HOME"'
      : path.startsWith('~/')
        ? `"$HOME"/${shellescape(path.slice(2))}`
        : shellescape(path);
  const script =
    `cd -- ${target} 2>/dev/null || { echo '@@missing'; exit 0; }; pwd; ` +
    `for d in .[!.]* *; do [ -d "$d" ] && printf '%s\\n' "$d"; done 2>/dev/null | head -n 400`;
  const result = await runOnHost(host, script);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${host.label} did not answer`);
  const lines = result.stdout.split('\n').filter(Boolean);
  if (lines[0] === '@@missing') return { path, exists: false, dirs: [] };
  const [resolved, ...dirs] = lines;
  return {
    path: resolved,
    exists: true,
    dirs: dirs.filter((d) => d !== '*' && d !== '.[!.]*').sort((a, b) => a.localeCompare(b)),
  };
}

// ── Usage ──────────────────────────────────────────────────────────────────

/** A small, cheap model for the one-token usage check. */
const USAGE_PROBE_MODEL = 'claude-haiku-5-5';
const USAGE_TTL_MS = 180_000;
const usageCache = new Map<string, { at: number; usage: FleetUsage | null }>();
const usageInFlight = new Map<string, Promise<FleetUsage | null>>();

/** The 5-hour and 7-day windows from a response's unified rate-limit headers, or null. */
export function parseUnifiedRateLimitHeaders(headers: Headers, fetchedAt: string): FleetUsage | null {
  const pct = (name: string) => {
    const v = Number.parseFloat(headers.get(`anthropic-ratelimit-unified-${name}-utilization`) ?? '');
    return Number.isFinite(v) ? Math.round(v * 1000) / 10 : null;
  };
  const at = (name: string) => {
    const v = Number.parseInt(headers.get(`anthropic-ratelimit-unified-${name}-reset`) ?? '', 10);
    return Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null;
  };
  const usage = {
    fiveHour: pct('5h'),
    fiveHourResetsAt: at('5h'),
    sevenDay: pct('7d'),
    sevenDayResetsAt: at('7d'),
    fetchedAt,
  };
  return usage.fiveHour === null && usage.sevenDay === null ? null : usage;
}

/**
 * Ask Anthropic for one token account's windows: a one-token request (about 35 tokens
 * on the smallest model) whose response headers carry them. Never throws.
 */
async function probeTokenUsage(account: FleetAccount): Promise<FleetUsage | null> {
  if (process.env.VITEST || !account.secret) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.secret}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: USAGE_PROBE_MODEL,
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    // A 429 still carries the windows (that is how a full limit looks).
    const usage = parseUnifiedRateLimitHeaders(res.headers, new Date().toISOString());
    await res.body?.cancel().catch(() => {});
    return usage;
  } catch {
    return null;
  }
}

/** Usage per token account id, read with each account's own token; cached three minutes. */
export async function readFleetUsage(config: FleetConfig): Promise<Map<string, FleetUsage>> {
  const out = new Map<string, FleetUsage>();
  await Promise.all(
    config.accounts
      .filter((a) => a.kind === 'token' && a.secret)
      .map(async (account) => {
        const cached = usageCache.get(account.id);
        let usage: FleetUsage | null;
        if (cached && Date.now() - cached.at < USAGE_TTL_MS) usage = cached.usage;
        else {
          let pending = usageInFlight.get(account.id);
          if (!pending) {
            pending = probeTokenUsage(account).finally(() => usageInFlight.delete(account.id));
            usageInFlight.set(account.id, pending);
          }
          usage = await pending;
          usageCache.set(account.id, { at: Date.now(), usage });
        }
        if (usage) out.set(account.id, usage);
      })
  );
  return out;
}

/** This server's ssh public key, which machines must authorize. */
export async function readServerPublicKey(): Promise<string | null> {
  const home = process.env.HOME || '';
  for (const name of ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub']) {
    try {
      return (await fs.readFile(join(home, '.ssh', name), 'utf8')).trim();
    } catch {
      /* next */
    }
  }
  return null;
}

/** Creates an ed25519 key for this server when it has none. */
export async function ensureServerKey(): Promise<string | null> {
  const existing = await readServerPublicKey();
  if (existing) return existing;
  const home = process.env.HOME || '';
  await fs.mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve) =>
    execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'claude-rc', '-f', join(home, '.ssh', 'id_ed25519')], () =>
      resolve()
    )
  );
  return readServerPublicKey();
}
