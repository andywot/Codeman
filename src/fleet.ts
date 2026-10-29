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
 * - `cswap`:   a claude-swap slot on that machine (`cswap run <slot> -- claude`).
 *              Linux/WSL only, since cswap switches a Linux config dir.
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
 * Usage (5-hour and 7-day windows) is read from `cswap list --json` on the machine
 * named by `usageHostId`, matched to accounts by email or cswap slot.
 */

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { RemoteHost, SessionRemote } from './types/index.js';
import { buildSshConnectionArgs, remoteSshTarget, shellescape } from './remote-hosts.js';

export type FleetSystem = 'wsl' | 'windows' | 'linux';
export type FleetAccountKind = 'machine' | 'cswap' | 'token' | 'api' | 'shell';

export interface FleetAccount {
  id: string;
  label: string;
  kind: FleetAccountKind;
  /** Claude account email; links the account to its cswap usage reading. */
  email?: string;
  /** cswap slot number (kind `cswap`), also used to match usage. */
  slot?: number;
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
  /** Remote host whose `cswap list --json` provides usage readings. */
  usageHostId?: string;
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
    return { accounts: Array.isArray(raw.accounts) ? raw.accounts : [], usageHostId: raw.usageHostId };
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

const ACCOUNT_KINDS = new Set<string>(['machine', 'cswap', 'token', 'api', 'shell']);

/** Validates an account from the browser; returns an error message or null. */
export function validateAccount(account: FleetAccount): string | null {
  if (!ID_RE.test(account.id)) return 'Account id must be lowercase letters, digits and dashes';
  if (!account.label || account.label.length > 60) return 'Account name is required (60 characters at most)';
  if (!ACCOUNT_KINDS.has(account.kind)) return 'Unknown account kind';
  if (account.kind === 'shell' && !(account.setupCommand && SETUP_RE.test(account.setupCommand))) {
    return 'Give the command as plain words, e.g. use-glm';
  }
  if (account.email && !/^[^\s@'"]+@[^\s@'"]+$/.test(account.email)) return 'Invalid email';
  if (account.kind === 'cswap' && !(Number.isInteger(account.slot) && account.slot! >= 1 && account.slot! <= 99)) {
    return 'cswap accounts need a slot number';
  }
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

  // cswap switches a Linux config dir, which Windows claude never reads; on Windows a
  // cswap account uses the token saved with it instead.
  const viaToken = account?.kind === 'token' || (account?.kind === 'cswap' && windows);
  if (account?.kind === 'cswap' && windows && !account.secret) {
    throw new Error(`${account.label} needs a token to run on Windows: add one in Machines & accounts`);
  }
  if (account?.kind === 'cswap' && account.slot && !windows) {
    binary = `cswap run ${account.slot} -- claude`;
  } else if (viaToken && account) {
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
  // buildSshConnectionArgs returns shell tokens (some pre-quoted), so run through sh.
  const line = [...buildSshConnectionArgs(host), shellescape(remoteSshTarget(host)), shellescape(command)].join(' ');
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', line], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 4_000_000) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.stdin.end(input ?? '');
  });
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
  const needed =
    account &&
    (account.kind === 'token' || account.kind === 'api' || (account.kind === 'cswap' && host.system === 'windows'));
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

interface CswapAccount {
  number?: number;
  email?: string;
  usage?: {
    fiveHour?: { pct?: number; resetsAt?: string };
    sevenDay?: { pct?: number; resetsAt?: string };
  };
}

let usageCache: { at: number; byKey: Map<string, FleetUsage> } | null = null;
let usageInFlight: Promise<Map<string, FleetUsage>> | null = null;
const USAGE_TTL_MS = 120_000;

/** Usage per account id, from cswap on the usage host; cached two minutes. */
export async function readFleetUsage(config: FleetConfig, hosts: RemoteHost[]): Promise<Map<string, FleetUsage>> {
  const host = hosts.find((h) => h.id === config.usageHostId);
  if (!host) return new Map();
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return mapUsage(config, usageCache.byKey);
  usageInFlight ??= (async () => {
    try {
      const result = await runOnHost(host, 'exec bash -lc "cswap list --json"', undefined, 30_000);
      const byKey = new Map<string, FleetUsage>();
      if (result.code === 0) {
        const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as { accounts?: CswapAccount[] };
        const fetchedAt = new Date().toISOString();
        for (const acct of parsed.accounts ?? []) {
          const usage: FleetUsage = {
            fiveHour: acct.usage?.fiveHour?.pct ?? null,
            fiveHourResetsAt: acct.usage?.fiveHour?.resetsAt ?? null,
            sevenDay: acct.usage?.sevenDay?.pct ?? null,
            sevenDayResetsAt: acct.usage?.sevenDay?.resetsAt ?? null,
            fetchedAt,
          };
          if (acct.email) byKey.set(`email:${acct.email.toLowerCase()}`, usage);
          if (acct.number) byKey.set(`slot:${acct.number}`, usage);
        }
      }
      usageCache = { at: Date.now(), byKey };
      return byKey;
    } catch {
      usageCache = { at: Date.now(), byKey: new Map() };
      return usageCache.byKey;
    } finally {
      usageInFlight = null;
    }
  })();
  return mapUsage(config, await usageInFlight);
}

function mapUsage(config: FleetConfig, byKey: Map<string, FleetUsage>): Map<string, FleetUsage> {
  const out = new Map<string, FleetUsage>();
  for (const account of config.accounts) {
    const hit =
      (account.email && byKey.get(`email:${account.email.toLowerCase()}`)) ||
      (account.kind === 'cswap' && account.slot && byKey.get(`slot:${account.slot}`));
    if (hit) out.set(account.id, hit);
  }
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
