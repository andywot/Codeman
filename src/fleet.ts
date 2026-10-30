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
 *
 * Alerts and per-session telemetry ride the same `--settings` (see {@link REMOTE_SIGNALS_VERSION}):
 * the remote machine may not be able to reach this server, so nothing is POSTed. Instead the
 * launch carries Claude Code hooks that APPEND one `<unix seconds> <event>` line per hook to
 * `~/.config/claude-rc/events/<key>.log`, and the statusLine also saves the whole statusline
 * JSON to `~/.config/claude-rc/session/<key>.json`. `<key>` is `$CLAUDE_RC_SESSION`, which the
 * remote pane command exports (tmux-manager.ts, the remote tmux session name, so a session
 * re-attached after a server restart still finds its files). The server tails both over the
 * pooled shell (remote-session-signals.ts). No prompt text, tool input or message is written.
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
  /**
   * `shell`/`api` only: a quota-throttle status URL (`http://127.0.0.1:3001/api/status`) read
   * ON each machine with the usage pass, so a gateway bound to one machine's loopback works.
   */
  quotaUrl?: string;
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
/** Relative to $HOME: hook events per session (one `<unix seconds> <event>` line each). */
export const EVENTS_DIR = '.config/claude-rc/events';
/** Relative to $HOME: the latest statusline JSON per session. */
export const SESSION_STATUS_DIR = '.config/claude-rc/session';
/** The env var the remote pane exports with the session's file key (tmux-manager.ts). */
export const REMOTE_SESSION_ENV = 'CLAUDE_RC_SESSION';
/**
 * Bumped when the launch's hook/statusline shape changes. Stored on `SessionRemote.launch.signals`,
 * so a session launched before it is told apart (the dashboard says it needs a new start).
 */
export const REMOTE_SIGNALS_VERSION = 1;
/**
 * The hook events a remote launch records, with the Claude Code hook (and Notification matcher)
 * behind each. Same names as `/api/hook-event` (hooks-config.ts), so the server feeds them through
 * the same handler. UserPromptSubmit is left out: its only use there needs the prompt's
 * conversation id, and nothing about the prompt is written.
 */
export const REMOTE_HOOK_EVENTS = [
  { event: 'permission_prompt', hook: 'Notification', matcher: 'permission_prompt' },
  { event: 'idle_prompt', hook: 'Notification', matcher: 'idle_prompt' },
  { event: 'elicitation_dialog', hook: 'Notification', matcher: 'elicitation_dialog' },
  { event: 'elicitation_complete', hook: 'Notification', matcher: 'elicitation_complete' },
  { event: 'elicitation_response', hook: 'Notification', matcher: 'elicitation_response' },
  { event: 'stop', hook: 'Stop' },
] as const;
export type RemoteHookEvent = (typeof REMOTE_HOOK_EVENTS)[number]['event'];
/** Status file id for sessions on the machine's own login (outside ID_RE, so no account can clash). */
const MACHINE_LOGIN_ID = '_machine';
/** What a `shell` account's command may export for claude (carried to Windows claude via WSLENV). */
const SHELL_ACCOUNT_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
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
  if (account.quotaUrl && (account.kind === 'machine' || account.kind === 'token' || !URL_RE.test(account.quotaUrl))) {
    return 'The quota URL must be http(s), for GLM-style accounts only';
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
  const binary = windows ? WINDOWS_CLAUDE_BINARY : 'claude';

  if (account?.kind === 'token') {
    env.CLAUDE_CODE_OAUTH_TOKEN = `$(cat ${secretFile(account.id)})`;
  } else if (account?.kind === 'shell' && account.setupCommand && SETUP_RE.test(account.setupCommand)) {
    // A missing or failing command (not defined on this machine) silently left claude on
    // the machine's own login, so the launch stops where the pane shows why instead.
    const word = account.setupCommand.split(' ')[0];
    setup.push(
      `${account.setupCommand} >/dev/null || { echo "Claude RC: '${word}' failed or is not set up on this machine." >&2; exit 1; }`
    );
    // WSLENV carries what the command exported across into the Windows process; without it
    // Windows claude never saw the gateway and ran on the subscription.
    if (windows) setup.push(`export WSLENV="\${WSLENV:+$WSLENV:}${SHELL_ACCOUNT_VARS.map((k) => `${k}/w`).join(':')}"`);
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
    // WSLENV carries the variables across into the Windows process. ⚠️ `/w` (WSL → Windows),
    // never `/u`, which only carries Windows → WSL: with `/u` Windows claude saw none of them
    // and silently ran on the machine's own login (checked with cmd.exe, 2026-10-30).
    if (windows) setup.push(`export WSLENV="\${WSLENV:+$WSLENV:}${keys.map((k) => `${k}/w`).join(':')}"`);
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
  // Usage, alerts and per-session telemetry (see the file header). Windows claude runs
  // statusLine and hook commands outside WSL's shell, so only WSL/Linux sessions get them.
  if (windows) return { setup: setup.length ? setup.join('; ') + '; ' : '', binary, args };
  // The per-account usage reading: Claude logins only (an api/shell account has no plan
  // windows, or not this account's). A session on the machine's own login saves as
  // MACHINE_LOGIN_ID; the server maps that reading to the account whose email the
  // machine is logged in with.
  const usageId = account?.kind === 'api' || account?.kind === 'shell' ? null : account ? account.id : MACHINE_LOGIN_ID;
  const settings = buildRemoteSignalsSettings(usageId !== null && (!account || ID_RE.test(usageId)) ? usageId : null);
  args += ` --settings '${JSON.stringify(settings)}'`;
  return { setup: setup.length ? setup.join('; ') + '; ' : '', binary, args, signals: REMOTE_SIGNALS_VERSION };
}

/**
 * The one `--settings` object of a WSL/Linux launch: the statusLine (per-session save, plus the
 * per-account usage save when `usageId` is given) and the hooks of {@link REMOTE_HOOK_EVENTS}.
 *
 * ⚠️ Every command here contains no quote characters and no backslashes, so the JSON sits safely
 * inside the single-quoted shell argument of the launch (and through the outer shellescape
 * layers). The file key comes from `$CLAUDE_RC_SESSION`; without it (a pane command that does
 * not export it) the per-session parts write nothing: `test -z $X` with X empty is `test -z`,
 * which is true. Nothing is printed, so the statusline row stays empty and no hook output
 * reaches the model.
 */
export function buildRemoteSignalsSettings(usageId: string | null): {
  statusLine: { type: 'command'; command: string };
  hooks: Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }>
  >;
} {
  const key = `$${REMOTE_SESSION_ENV}`;
  const d = '$HOME/.config/claude-rc';
  // Save stdin to a temp file, copy it to the session file when there is a key, then move it
  // to the account file (or drop it).
  const perSession = `test -z ${key} || { cp $t ${d}/session/.${key}.$$ && mv -f ${d}/session/.${key}.$$ ${d}/session/${key}.json; }`;
  const statusLine =
    `t=${d}/.st.$$; mkdir -p ${d}/session ${d}/status && cat > $t && { ${perSession}; }; ` +
    (usageId ? `mv -f $t ${d}/status/${usageId}.json` : 'rm -f $t');
  const hookCommand = (event: string) =>
    `cat >/dev/null; test -z ${key} || { mkdir -p ${d}/events && echo $(date +%s) ${event} >> ${d}/events/${key}.log; }`;
  const hooks: Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }>
  > = {};
  for (const spec of REMOTE_HOOK_EVENTS) {
    const entry = {
      ...('matcher' in spec ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command' as const, command: hookCommand(spec.event), timeout: 10 }],
    };
    (hooks[spec.hook] ??= []).push(entry);
  }
  return { statusLine: { type: 'command', command: statusLine }, hooks };
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
    if (head.startsWith('~')) {
      const id = head.slice(1).trim();
      const usage = ID_RE.test(id) ? parseThrottleQuota(block.slice(nl + 1), new Date().toISOString()) : null;
      if (usage) byAccount.set(id, usage);
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

/**
 * {@link STATUS_READ_SCRIPT} plus each quota URL, fetched on the machine as `\n@@~<account>\n`
 * then the body. A machine without that gateway prints an empty body (refused in milliseconds).
 * ⚠️ The URL is validated by URL_RE (no quotes or spaces), so it sits safely single-quoted.
 */
export function buildStatusReadScript(accounts: FleetAccount[]): string {
  const quota = accounts
    .filter((a) => a.quotaUrl && ID_RE.test(a.id) && URL_RE.test(a.quotaUrl))
    .map((a) => `; printf '\\n@@~%s\\n' ${a.id}; curl -s -m 3 '${a.quotaUrl}' 2>/dev/null | head -c 262144`)
    .join('');
  // A subshell: its `cd ... || exit 0` must not skip the quota reads.
  return quota ? `(${STATUS_READ_SCRIPT})${quota}` : STATUS_READ_SCRIPT;
}

/**
 * The whole key pool of a quota-throttle `/api/status` as one account's windows: the mean of
 * each window over the distinct quota pools (keys of one org/project share one), and the soonest
 * future reset. Keys with an error or no reading are left out; null when none is left.
 */
export function parseThrottleQuota(text: string, fetchedAt: string): FleetUsage | null {
  let data: { keys?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data?.keys)) return null;
  const now = Date.now();
  const pools = new Map<string, { five: number | null; week: number | null; fiveAt: number; weekAt: number }>();
  for (const raw of data.keys as Array<Record<string, unknown>>) {
    if (!raw || raw.error) continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const five = num(raw.five_hour_pct);
    const week = num(raw.weekly_pct);
    if (five === null && week === null) continue;
    const pool = raw.org || raw.project ? `${raw.org}/${raw.project}` : String(raw.name);
    pools.set(pool, { five, week, fiveAt: num(raw.five_hour_reset) ?? 0, weekAt: num(raw.weekly_reset) ?? 0 });
  }
  if (!pools.size) return null;
  const all = [...pools.values()];
  const mean = (xs: Array<number | null>) => {
    const ok = xs.filter((x): x is number => x !== null);
    return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  };
  const soonest = (xs: number[]) => {
    const future = xs.filter((x) => x > now);
    return future.length ? new Date(Math.min(...future)).toISOString() : null;
  };
  return {
    fiveHour: mean(all.map((p) => p.five)),
    fiveHourResetsAt: soonest(all.map((p) => p.fiveAt)),
    sevenDay: mean(all.map((p) => p.week)),
    sevenDayResetsAt: soonest(all.map((p) => p.weekAt)),
    fetchedAt,
  };
}

async function readHostStatus(host: RemoteHost, accounts: FleetAccount[]): Promise<void> {
  const result = await runOnHost(host, buildStatusReadScript(accounts), undefined, 20_000);
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
        pending = readHostStatus(host, config.accounts)
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
