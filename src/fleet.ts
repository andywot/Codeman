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
 * Usage (5-hour and 7-day windows) comes from the sessions themselves, at no cost: a
 * WSL/Linux session launched with an account gets a statusLine command that saves
 * Claude's statusline JSON (it carries `rate_limits`) to
 * `~/.config/claude-rc/status/<account>.json` on its machine and prints nothing; the
 * server reads those files over the pooled shell. The newest reading per account wins,
 * so an account shows usage once one of its sessions has run. (The OAuth usage endpoint
 * refuses `claude setup-token` tokens, which lack the `user:profile` scope; measured.)
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
/** Relative to $HOME on each machine: the statusline JSON per account (usage readings). */
const STATUS_DIR = '.config/claude-rc/status';
/** Status file id for sessions on the machine's own login (outside ID_RE, so no account can clash). */
const MACHINE_LOGIN_ID = '_machine';
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
    // An empty token silently runs claude on the machine's own login instead, so a
    // missing secret file stops the launch where the pane shows why.
    const tokenKey = keys.find((k) => k === 'CLAUDE_CODE_OAUTH_TOKEN' || k === 'ANTHROPIC_AUTH_TOKEN');
    if (tokenKey && account && ID_RE.test(account.id)) {
      setup.push(
        `[ -n "$${tokenKey}" ] || { echo "Claude RC: the ${account.id} token is missing on this machine. Start the session again from the dashboard." >&2; exit 1; }`
      );
    }
  }

  // An api account fixes the model through the env above; --model would be a Claude name.
  let args = model && account?.kind !== 'api' && MODEL_RE.test(model) ? ` --model '${model}'` : '';
  // Usage reporting (see the file header). Windows claude runs statusLine commands
  // outside WSL's shell, so only WSL/Linux sessions report. The command contains no
  // quote characters, so it sits safely inside the single-quoted JSON.
  // A session on the machine's own login saves as MACHINE_LOGIN_ID; the server maps
  // that reading to the account whose email the machine is logged in with.
  const statusId = account ? account.id : MACHINE_LOGIN_ID;
  if (account?.kind !== 'api' && account?.kind !== 'shell' && !windows && (!account || ID_RE.test(account.id))) {
    const dir = `$HOME/${STATUS_DIR}`;
    const save = `mkdir -p ${dir} && cat > ${dir}/.${statusId}.$$ && mv -f ${dir}/.${statusId}.$$ ${dir}/${statusId}.json`;
    args += ` --settings '${JSON.stringify({ statusLine: { type: 'command', command: save } })}'`;
  }
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

const USAGE_TTL_MS = 120_000;
/** A machine that did not answer is not asked again for this long. */
const USAGE_FAIL_BACKOFF_MS = 10 * 60_000;
const hostReadings = new Map<
  string,
  { at: number; ok: boolean; byAccount: Map<string, FleetUsage>; email?: string | null }
>();
const hostInFlight = new Map<string, Promise<void>>();

/** One account's windows from a saved statusline JSON (`rate_limits`), or null. */
export function parseStatuslineUsage(text: string, fetchedAt: string): FleetUsage | null {
  let data: { rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined> };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const window = (key: string) => {
    const w = data?.rate_limits?.[key];
    const pct = typeof w?.used_percentage === 'number' && Number.isFinite(w.used_percentage) ? w.used_percentage : null;
    const at = typeof w?.resets_at === 'number' && w.resets_at > 0 ? new Date(w.resets_at * 1000).toISOString() : null;
    return { pct, at };
  };
  const five = window('five_hour');
  const seven = window('seven_day');
  if (five.pct === null && seven.pct === null) return null;
  return {
    fiveHour: five.pct,
    fiveHourResetsAt: five.at,
    sevenDay: seven.pct,
    sevenDayResetsAt: seven.at,
    fetchedAt,
  };
}

/** Prints every saved statusline on a machine: `\n@@<account> <mtime>\n` then its JSON. */
export const STATUS_READ_SCRIPT =
  `cd "$HOME/${STATUS_DIR}" 2>/dev/null || exit 0; for f in *.json; do [ -f "$f" ] || continue; ` +
  `printf '\\n@@%s %s\\n' "\${f%.json}" "$(stat -c %Y "$f" 2>/dev/null || echo 0)"; head -c 65536 "$f"; done; ` +
  // The email the machine's own login belongs to (not a secret), for MACHINE_LOGIN_ID.
  `printf '\\n@@=email %s\\n' "$(grep -o '"emailAddress": *"[^"]*"' "$HOME/.claude.json" 2>/dev/null | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/')"`;

/** {@link STATUS_READ_SCRIPT}'s output as readings per account id. */
export function parseStatusReadOutput(stdout: string): Map<string, FleetUsage> {
  return parseStatusRead(stdout).byAccount;
}

/** {@link STATUS_READ_SCRIPT}'s output: readings per status id, and the machine login's email. */
export function parseStatusRead(stdout: string): { byAccount: Map<string, FleetUsage>; email: string | null } {
  const byAccount = new Map<string, FleetUsage>();
  let email: string | null = null;
  for (const block of stdout.split('\n@@').slice(1)) {
    const nl = block.indexOf('\n');
    const head = nl < 0 ? block : block.slice(0, nl);
    if (head.startsWith('=email ')) {
      const value = head.slice(7).trim().toLowerCase();
      if (/^[^\s@'"]+@[^\s@'"]+$/.test(value)) email = value;
      continue;
    }
    const [id, mtime] = head.split(' ');
    if (!ID_RE.test(id) && id !== MACHINE_LOGIN_ID) continue;
    const at = Number(mtime) > 0 ? new Date(Number(mtime) * 1000).toISOString() : new Date().toISOString();
    const usage = parseStatuslineUsage(block.slice(nl + 1), at);
    if (usage) byAccount.set(id, usage);
  }
  return { byAccount, email };
}

async function readHostStatus(host: RemoteHost): Promise<void> {
  const result = await runOnHost(host, STATUS_READ_SCRIPT, undefined, 20_000);
  const read =
    result.code === 0 ? parseStatusRead(result.stdout) : { byAccount: new Map<string, FleetUsage>(), email: null };
  hostReadings.set(host.id, { at: Date.now(), ok: result.code === 0, ...read });
}

/**
 * Usage per account id: the newest statusline reading for that account on any WSL or
 * Linux machine. Machines are re-read every two minutes at most (a dead one every ten).
 */
export async function readFleetUsage(config: FleetConfig, hosts: RemoteHost[]): Promise<Map<string, FleetUsage>> {
  if (process.env.VITEST) return new Map();
  // A machine's Windows system shares its WSL files; ask each address once.
  const seen = new Set<string>();
  const targets = hosts.filter((h) => {
    if (h.system === 'windows') return false;
    const key = `${h.username}@${h.host}:${h.port ?? 22}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await Promise.all(
    targets.map((host) => {
      const last = hostReadings.get(host.id);
      const ttl = last && !last.ok ? USAGE_FAIL_BACKOFF_MS : USAGE_TTL_MS;
      if (last && Date.now() - last.at < ttl) return undefined;
      let pending = hostInFlight.get(host.id);
      if (!pending) {
        pending = readHostStatus(host)
          .catch(() => hostReadings.set(host.id, { at: Date.now(), ok: false, byAccount: new Map() }))
          .then(() => undefined)
          .finally(() => hostInFlight.delete(host.id));
        hostInFlight.set(host.id, pending);
      }
      // Never hold the page for a slow machine: its reading lands on a later refresh.
      return Promise.race([pending, new Promise((r) => setTimeout(r, 1500))]);
    })
  );
  const out = new Map<string, FleetUsage>();
  for (const account of config.accounts) {
    for (const host of targets) {
      const reading = hostReadings.get(host.id);
      const own = reading?.byAccount.get(account.id);
      const viaLogin =
        account.email && reading?.email === account.email.toLowerCase()
          ? reading.byAccount.get(MACHINE_LOGIN_ID)
          : undefined;
      for (const usage of [own, viaLogin]) {
        const best = out.get(account.id);
        if (usage && (!best || usage.fetchedAt > best.fetchedAt)) out.set(account.id, usage);
      }
    }
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
