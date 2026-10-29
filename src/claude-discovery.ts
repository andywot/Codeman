/**
 * @fileoverview Fork: find every Claude Code running on a machine, including ones the
 * dashboard did not start.
 *
 * One read-only shell script per machine (run locally with `sh -c`, or on a remote
 * host through its pooled shell, `remote-shell-pool.ts`) reports:
 *
 * - every tmux pane on every socket in the user's tmux directory
 *   (`${TMUX_TMPDIR:-/tmp}/tmux-<uid>/*`), via `list-panes -a`;
 * - the process table (`ps`), so a `claude` process is placed by its ancestry: a
 *   descendant of a pane's pid runs in that pane, anything else runs outside tmux;
 * - each candidate's working directory (`/proc/<pid>/cwd`, or `lsof` without /proc);
 * - Claude Code's own per-process records, `~/.claude/sessions/<pid>.json` (only files
 *   named `<digits>.json`; the `.key` files beside them are never read), which carry
 *   the conversation id;
 * - the conversation logs that could belong to them (`~/.claude/projects/…/*.jsonl`):
 *   the files named after a known id, and the newest few in each candidate's folder.
 *
 * ⚠️ Discovery is READ-ONLY. The script lists, reads and prints. It never starts a tmux
 * server (`list-panes` does not), never signals a process (not even `kill -0`), never
 * renames, attaches or sends keys. Adopting a session is a separate, explicit attach.
 *
 * Everything below `parseDiscoveryOutput` is pure, so the parsing and classification
 * are tested against recorded output (`test/claude-discovery.test.ts`).
 */

import { execFile } from 'node:child_process';
import { shellescape, withRemoteTmuxPath } from './remote-hosts.js';
import type { RemoteHost, SessionRemote } from './types.js';

/** Field separator inside `list-panes -F`; printable, so no tmux build escapes it. */
export const PANE_SEP = '|@|';

/** tmux socket names this module will report or attach to (`tmux -L <name>`). */
export const TMUX_SOCKET_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * tmux session names this module can ATTACH to. Pane commands pass through
 * `bash -c "<json>"`, which still interprets `$`, backticks, quotes and backslashes,
 * so a name outside this set is listed but not offered for attach.
 */
export const ADOPTED_TMUX_NAME_RE = /^[A-Za-z0-9_.@+=%,~ -]{1,100}$/;

/** A Claude conversation id, as Claude Code names its `<id>.jsonl` logs. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

const MAX_CANDIDATES = 200;
const MAX_ANCESTRY_DEPTH = 64;

/**
 * The shell body (POSIX sh). Callers run it as `sh -c <body>` so the remote user's
 * login shell (zsh, fish) never parses it; see {@link discoveryCommand}.
 */
export function discoveryScriptBody(): string {
  const fmt = [
    '#{session_name}',
    '#{window_index}',
    '#{pane_index}',
    '#{pane_pid}',
    '#{pane_current_command}',
    '#{session_attached}',
    '#{session_windows}',
    '#{session_created}',
    '#{pane_current_path}',
  ].join(PANE_SEP);
  return [
    'umask 077',
    'd="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"',
    'echo "@@sockdir $d"',
    // Panes on every socket. A stale socket (no server) just prints nothing; a wedged
    // server is cut off after 5 s so one bad socket cannot stall the whole listing.
    'T=""; command -v timeout >/dev/null 2>&1 && T="timeout 5"',
    'if command -v tmux >/dev/null 2>&1; then',
    '  for s in "$d"/*; do',
    '    [ -S "$s" ] || continue',
    '    n=${s##*/}',
    '    case "$n" in *[!A-Za-z0-9._-]*) continue;; esac',
    `    $T tmux -S "$s" list-panes -a -F "@@pane $n${PANE_SEP}${fmt}" 2>/dev/null`,
    '  done',
    'fi',
    // Process table: pid/ppid/comm for every process (comm last, it may hold spaces),
    // full args only for lines that mention claude.
    `ps -eo pid=,ppid=,comm= 2>/dev/null | sed 's/^ */@@pc /'`,
    `ps -eo pid=,args= 2>/dev/null | awk '/(^|[ \\/])claude([ .]|$)|\\/claude\\/|cmd[.]exe/ { sub(/^ +/, ""); print "@@args " substr($0, 1, 600) }'`,
    // Candidates: a process named claude, a version number (the native installer's
    // binary is ~/.local/share/claude/versions/<x.y.z>), or Windows cmd.exe (a Windows
    // claude started from WSL). The classifier decides; this only bounds the work.
    `cands=$(ps -eo pid=,comm= 2>/dev/null | awk '$2=="claude" || $2=="cmd.exe" || $2 ~ /^[0-9]+[.][0-9]+[.][0-9]+$/ {print $1}' | head -n ${MAX_CANDIDATES})`,
    'ids=""',
    'for p in $cands; do',
    '  c=""',
    '  if [ -d /proc/$p ]; then',
    '    c=$(readlink /proc/$p/cwd 2>/dev/null)',
    `    st=$(awk '{print $22}' /proc/$p/stat 2>/dev/null)`,
    '    [ -n "$st" ] && echo "@@start $p $st"',
    '  elif [ ! -d /proc/self ] && command -v lsof >/dev/null 2>&1; then',
    `    c=$(lsof -a -p $p -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)`,
    '  fi',
    '  [ -n "$c" ] && printf "@@cwd %s %s\\n" "$p" "$c"',
    'done',
    // Claude Code's per-process records, for live pids only.
    'for f in "$HOME"/.claude/sessions/*.json; do',
    '  [ -f "$f" ] || continue',
    '  b=${f##*/}; n=${b%.json}',
    '  case "$n" in ""|*[!0-9]*) continue;; esac',
    '  case " $(echo $cands) " in *" $n "*) ;; *) continue;; esac',
    '  printf "@@sess %s " "$n"; head -c 4000 "$f" | tr "\\n\\r" "  "; echo',
    `  i=$(sed -n 's/.*"sessionId" *: *"\\([A-Za-z0-9-]*\\)".*/\\1/p' "$f" | head -n 1)`,
    '  [ -n "$i" ] && ids="$ids $i"',
    'done',
    // Ids named on a command line (--resume / --session-id / -r).
    `ids="$ids $(ps -eo args= 2>/dev/null | awk '/[Cc]laude/' | tr ' =' '\\n\\n' | grep -E '^[A-Za-z0-9][A-Za-z0-9-]{7,99}$' | grep -- '-' | head -n 100 | tr '\\n' ' ')"`,
    'pd="$HOME/.claude/projects"',
    'logline() { m=$(date -r "$1" +%s 2>/dev/null) || m=0; printf "@@log %s %s\\n" "$m" "$1"; }',
    'if [ -d "$pd" ]; then',
    `  for i in $(printf "%s\\n" $ids | sort -u | head -n 200); do`,
    '    case "$i" in *[!A-Za-z0-9-]*) continue;; esac',
    '    for f in "$pd"/*/"$i".jsonl; do [ -f "$f" ] && logline "$f"; done',
    '  done',
    // The newest logs in each candidate's own folder (Claude's folder key: every
    // character outside [A-Za-z0-9] becomes '-').
    '  for p in $cands; do',
    '    c=$(readlink /proc/$p/cwd 2>/dev/null) || continue',
    `    e=$(printf "%s" "$c" | sed 's/[^A-Za-z0-9]/-/g')`,
    '    [ -d "$pd/$e" ] || continue',
    '    ls -t "$pd/$e"/*.jsonl 2>/dev/null | head -n 3 | while IFS= read -r f; do logline "$f"; done',
    '  done',
    'fi',
    'echo "@@end"',
  ].join('\n');
}

/** The complete command: tmux's PATH widened, the body under `sh -c`. */
export function discoveryCommand(): string {
  return withRemoteTmuxPath(`sh -c ${shellescape(discoveryScriptBody())}`);
}

// ── Parsing ────────────────────────────────────────────────────────────────

export interface RawPane {
  socket: string;
  sessionName: string;
  window: number;
  pane: number;
  panePid: number;
  currentCommand: string;
  attachedClients: number;
  windows: number;
  created: number;
  currentPath: string;
}

export interface RawProcess {
  pid: number;
  ppid: number;
  comm: string;
  args?: string;
  cwd?: string;
  /** /proc/<pid>/stat field 22 (start time in clock ticks), as text. */
  startTime?: string;
}

/** The fields of `~/.claude/sessions/<pid>.json` this module reads. */
export interface ClaudeSessionRecord {
  pid: number;
  sessionId?: string;
  cwd?: string;
  procStart?: string;
  name?: string;
  status?: string;
  version?: string;
  kind?: string;
}

export interface RawLog {
  path: string;
  mtime: number;
}

export interface RawDiscovery {
  sockDir: string | null;
  panes: RawPane[];
  processes: Map<number, RawProcess>;
  records: Map<number, ClaudeSessionRecord>;
  logs: RawLog[];
  /** False when the output stopped before `@@end` (timeout, truncated buffer). */
  complete: boolean;
}

function toInt(value: string | undefined): number {
  const n = Number((value ?? '').trim());
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function parsePane(rest: string): RawPane | null {
  const cols = rest.split(PANE_SEP);
  if (cols.length < 10) return null;
  // The path is last and may itself contain the separator: rejoin the tail.
  const [socket, sessionName, win, pane, pid, cmd, attached, windows, created] = cols;
  const currentPath = cols.slice(9).join(PANE_SEP);
  const panePid = toInt(pid);
  if (!TMUX_SOCKET_NAME_RE.test(socket) || !sessionName || !Number.isFinite(panePid) || panePid <= 0) return null;
  return {
    socket,
    sessionName,
    window: toInt(win),
    pane: toInt(pane),
    panePid,
    currentCommand: cmd,
    attachedClients: Math.max(0, toInt(attached) || 0),
    windows: Math.max(1, toInt(windows) || 1),
    created: toInt(created) || 0,
    currentPath,
  };
}

function parseRecord(pid: number, json: string): ClaudeSessionRecord | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  // A record names its own pid; one that disagrees with its file name is not trusted.
  if (typeof data.pid === 'number' && data.pid !== pid) return null;
  const str = (key: string, max = 300): string | undefined =>
    typeof data[key] === 'string' && (data[key] as string).length <= max ? (data[key] as string) : undefined;
  const sessionId = str('sessionId', 100);
  return {
    pid,
    sessionId: sessionId && CONVERSATION_ID_RE.test(sessionId) ? sessionId : undefined,
    cwd: str('cwd', 4096),
    procStart:
      typeof data.procStart === 'string' || typeof data.procStart === 'number' ? String(data.procStart) : undefined,
    name: str('name', 200),
    status: str('status', 40),
    version: str('version', 40),
    kind: str('kind', 40),
  };
}

/** Parse the script's stdout. Unknown or malformed lines are skipped. */
export function parseDiscoveryOutput(stdout: string): RawDiscovery {
  const out: RawDiscovery = {
    sockDir: null,
    panes: [],
    processes: new Map(),
    records: new Map(),
    logs: [],
    complete: false,
  };
  const proc = (pid: number): RawProcess | undefined => out.processes.get(pid);
  const args = new Map<number, string>();
  const cwds = new Map<number, string>();
  const starts = new Map<number, string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('@@')) continue;
    const space = line.indexOf(' ');
    const tag = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1);
    switch (tag) {
      case '@@sockdir':
        out.sockDir = rest || null;
        break;
      case '@@pane': {
        const pane = parsePane(rest);
        if (pane) out.panes.push(pane);
        break;
      }
      case '@@pc': {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(rest);
        if (m) out.processes.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3].trim() });
        break;
      }
      case '@@args': {
        const m = /^(\d+)\s+(.*)$/.exec(rest.trim());
        if (m) args.set(Number(m[1]), m[2]);
        break;
      }
      case '@@cwd': {
        const m = /^(\d+) (.+)$/.exec(rest);
        if (m) cwds.set(Number(m[1]), m[2]);
        break;
      }
      case '@@start': {
        const m = /^(\d+) (\d+)$/.exec(rest.trim());
        if (m) starts.set(Number(m[1]), m[2]);
        break;
      }
      case '@@sess': {
        const m = /^(\d+) (.*)$/.exec(rest);
        if (!m) break;
        const record = parseRecord(Number(m[1]), m[2].trim());
        if (record) out.records.set(record.pid, record);
        break;
      }
      case '@@log': {
        const m = /^(\d+) (\/.+\.jsonl)$/.exec(rest);
        if (m && !out.logs.some((l) => l.path === m[2])) out.logs.push({ path: m[2], mtime: Number(m[1]) });
        break;
      }
      case '@@end':
        out.complete = true;
        break;
    }
  }
  for (const [pid, value] of args) {
    const p = proc(pid);
    if (p) p.args = value;
  }
  for (const [pid, value] of cwds) {
    const p = proc(pid);
    if (p) p.cwd = value;
  }
  for (const [pid, value] of starts) {
    const p = proc(pid);
    if (p) p.startTime = value;
  }
  return out;
}

// ── Classification ─────────────────────────────────────────────────────────

export type ClaudeSystem = 'linux' | 'windows';

/**
 * Whether a process is Claude Code, and which kind: `linux` for the CLI itself (named
 * `claude`, or the native installer's version-numbered binary), `windows` for a
 * Windows `claude` launched from WSL through `cmd.exe /c claude`. Null otherwise.
 *
 * Only the process NAME or the program itself counts, never a mention of "claude"
 * anywhere in the arguments: a shell running `cat ~/.claude/x` is not Claude.
 */
export function claudeProcessKind(p: Pick<RawProcess, 'comm' | 'args'>): ClaudeSystem | null {
  const comm = p.comm.trim();
  const args = p.args ?? '';
  const argv0 = args.split(/\s+/)[0] ?? '';
  const base = argv0.split('/').pop() ?? '';
  if (comm === 'cmd.exe') {
    return /(^|\s)\/c\s+"?claude(\.exe)?(\s|"|$)/i.test(args) ? 'windows' : null;
  }
  if (comm === 'claude') return 'linux';
  if (/^\d+\.\d+\.\d+$/.test(comm)) {
    return /claude/i.test(argv0) || /\/claude\/versions\//.test(argv0) ? 'linux' : null;
  }
  if (base === 'claude' && (comm === 'node' || comm === 'bun')) return 'linux';
  if ((comm === 'node' || comm === 'bun') && /@anthropic-ai\/claude-code\/cli\.(m?js)/.test(args)) return 'linux';
  return null;
}

/** A non-interactive run (`claude -p …`, `--print`), which no one can attach to or resume. */
export function isPrintRun(args: string | undefined): boolean {
  return /(^|\s)(-p|--print)(\s|=|$)/.test(args ?? '');
}

/** The conversation id a command line names (`--resume <id>`, `--session-id <id>`, `-r <id>`). */
export function conversationIdFromArgs(args: string | undefined): string | undefined {
  if (!args) return undefined;
  const m = /(?:^|\s)(?:--resume|--session-id|-r)(?:=|\s+)["']?([A-Za-z0-9][A-Za-z0-9-]{7,99})/.exec(args);
  return m && CONVERSATION_ID_RE.test(m[1]) ? m[1] : undefined;
}

/** Claude's folder key for a working directory: every character outside [A-Za-z0-9] becomes `-`. */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export type ConversationSource = 'session-file' | 'argv' | 'newest-log';

export interface ConversationGuess {
  conversationId?: string;
  /** Where the id came from; `newest-log` is a guess (the newest log in that folder). */
  conversationSource?: ConversationSource;
  /** The log file on that machine, when it was seen. */
  logPath?: string;
  /** More than one Claude in that folder had no id of its own, so the guess may be another's. */
  ambiguous?: boolean;
}

export interface DiscoveredClaudeBase extends ConversationGuess {
  pid: number;
  /** linux: the CLI on this system; windows: a Windows claude started from WSL. */
  system: ClaudeSystem;
  /** Working directory, when it could be read. */
  cwd?: string;
  /** Claude's own label for the conversation (from its session record). */
  title?: string;
  /** Claude's own status from its session record (`idle`, `busy`, …). */
  status?: string;
  version?: string;
}

export interface DiscoveredTmuxClaude extends DiscoveredClaudeBase {
  kind: 'tmux';
  socket: string;
  sessionName: string;
  window: number;
  pane: number;
  attachedClients: number;
  windows: number;
  created: number;
}

export interface DiscoveredOutsideClaude extends DiscoveredClaudeBase {
  kind: 'process';
}

export interface ClassifyOptions {
  /** Sockets whose panes are never offered (this server's own tmux socket, locally). */
  hiddenSockets?: Iterable<string>;
  /** tmux sessions the dashboard already shows, as `socket\nsessionName`. */
  knownSessions?: Iterable<{ socket: string; sessionName: string }>;
}

export interface ClassifiedDiscovery {
  tmux: DiscoveredTmuxClaude[];
  outside: DiscoveredOutsideClaude[];
  /** Panes skipped because the dashboard already has them (or they are on a hidden socket). */
  hiddenCount: number;
}

function logIdOf(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.jsonl$/, '');
}

/**
 * Place every Claude process: in a tmux pane (by ancestry) or outside tmux, attach
 * its conversation, and drop what the dashboard already has.
 */
export function classifyDiscovery(raw: RawDiscovery, opts: ClassifyOptions = {}): ClassifiedDiscovery {
  const hidden = new Set(opts.hiddenSockets ?? []);
  const known = new Set([...(opts.knownSessions ?? [])].map((k) => `${k.socket}\n${k.sessionName}`));
  const paneByPid = new Map<number, RawPane>();
  for (const pane of raw.panes) paneByPid.set(pane.panePid, pane);

  const claudePids = new Map<number, ClaudeSystem>();
  for (const p of raw.processes.values()) {
    const kind = claudeProcessKind(p);
    if (!kind) continue;
    // One-shot runs (`claude -p`, hooks, this server's own checks) are not sessions.
    const record = raw.records.get(p.pid);
    if (isPrintRun(p.args) || (record?.kind && record.kind !== 'interactive')) continue;
    claudePids.set(p.pid, kind);
  }

  // Walk up to the pane (or the root). A Claude below another Claude is the same
  // session (a wrapper launching the real binary), so only the topmost is kept.
  const place = (pid: number): { pane: RawPane | null; nested: boolean } => {
    const seen = new Set<number>();
    let cur = pid;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && !seen.has(cur); depth++) {
      seen.add(cur);
      if (cur !== pid && claudePids.has(cur)) return { pane: null, nested: true };
      const pane = paneByPid.get(cur);
      if (pane) return { pane, nested: false };
      const proc = raw.processes.get(cur);
      if (!proc || proc.ppid <= 0) break;
      cur = proc.ppid;
    }
    return { pane: null, nested: false };
  };

  const logs = [...raw.logs];
  const logById = new Map<string, RawLog>();
  for (const log of logs) logById.set(logIdOf(log.path), log);

  interface Placed {
    pid: number;
    system: ClaudeSystem;
    pane: RawPane | null;
    proc: RawProcess;
    record?: ClaudeSessionRecord;
  }
  const placed: Placed[] = [];
  for (const [pid, system] of claudePids) {
    const where = place(pid);
    if (where.nested) continue;
    const proc = raw.processes.get(pid)!;
    let record = raw.records.get(pid);
    // A pid can be reused: a record whose start time disagrees with the process is stale.
    if (record?.procStart && proc.startTime && record.procStart !== proc.startTime) record = undefined;
    placed.push({ pid, system, pane: where.pane, proc, record });
  }

  // Conversation ids: the record first, then the command line, then the newest log
  // in the folder (a guess, flagged ambiguous when several unnamed Claudes share it).
  const guesses = new Map<number, ConversationGuess>();
  const unnamedByFolder = new Map<string, number[]>();
  const cwdOf = (p: Placed): string | undefined => p.proc.cwd ?? p.record?.cwd ?? p.pane?.currentPath ?? undefined;
  for (const p of placed) {
    const fromRecord = p.record?.sessionId;
    const fromArgs = conversationIdFromArgs(p.proc.args);
    const id = fromRecord ?? fromArgs;
    if (id) {
      guesses.set(p.pid, {
        conversationId: id,
        conversationSource: fromRecord ? 'session-file' : 'argv',
        logPath: logById.get(id)?.path,
      });
      continue;
    }
    const cwd = cwdOf(p);
    if (cwd && p.system === 'linux') {
      const key = claudeProjectKey(cwd);
      unnamedByFolder.set(key, [...(unnamedByFolder.get(key) ?? []), p.pid]);
    }
  }
  const claimed = new Set([...guesses.values()].map((g) => g.conversationId));
  for (const [key, pids] of unnamedByFolder) {
    const newest = logs
      .filter((l) => l.path.split('/').slice(-2, -1)[0] === key && !claimed.has(logIdOf(l.path)))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) continue;
    for (const pid of pids) {
      guesses.set(pid, {
        conversationId: logIdOf(newest.path),
        conversationSource: 'newest-log',
        logPath: newest.path,
        ...(pids.length > 1 ? { ambiguous: true } : {}),
      });
    }
  }

  const result: ClassifiedDiscovery = { tmux: [], outside: [], hiddenCount: 0 };
  for (const p of placed) {
    const base: DiscoveredClaudeBase = {
      pid: p.pid,
      system: p.system,
      cwd: cwdOf(p),
      ...(p.record?.name ? { title: p.record.name } : {}),
      ...(p.record?.status ? { status: p.record.status } : {}),
      ...(p.record?.version ? { version: p.record.version } : {}),
      ...(guesses.get(p.pid) ?? {}),
    };
    if (p.pane) {
      if (hidden.has(p.pane.socket) || known.has(`${p.pane.socket}\n${p.pane.sessionName}`)) {
        result.hiddenCount++;
        continue;
      }
      result.tmux.push({
        ...base,
        kind: 'tmux',
        socket: p.pane.socket,
        sessionName: p.pane.sessionName,
        window: p.pane.window,
        pane: p.pane.pane,
        attachedClients: p.pane.attachedClients,
        windows: p.pane.windows,
        created: p.pane.created,
      });
    } else {
      result.outside.push({ ...base, kind: 'process' });
    }
  }
  result.tmux.sort(
    (a, b) =>
      a.socket.localeCompare(b.socket) ||
      a.sessionName.localeCompare(b.sessionName) ||
      a.window - b.window ||
      a.pane - b.pane
  );
  result.outside.sort((a, b) => (a.cwd ?? '').localeCompare(b.cwd ?? '') || a.pid - b.pid);
  return result;
}

// ── IO ─────────────────────────────────────────────────────────────────────

export interface DiscoveryRun {
  ok: boolean;
  error?: string;
  raw?: RawDiscovery;
}

const DISCOVERY_TIMEOUT_MS = 20_000;
const DISCOVERY_MAX_BUFFER = 8 * 1024 * 1024;

/** Run discovery on this server. Never throws. */
export function discoverLocal(): Promise<DiscoveryRun> {
  if (process.env.VITEST) return Promise.resolve({ ok: false, error: 'disabled under test' });
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', discoveryCommand()],
      { timeout: DISCOVERY_TIMEOUT_MS, maxBuffer: DISCOVERY_MAX_BUFFER },
      (err, stdout) => {
        const raw = parseDiscoveryOutput(String(stdout ?? ''));
        if (err && !raw.complete) resolve({ ok: false, error: err.message.split('\n')[0] });
        else resolve({ ok: true, raw });
      }
    );
  });
}

/** Run discovery on a remote host through its pooled shell. Never throws. */
export async function discoverOnHost(host: RemoteHost): Promise<DiscoveryRun> {
  const { remoteExecStatus } = await import('./remote-shell-pool.js');
  try {
    const result = await remoteExecStatus(host, discoveryCommand(), {
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: DISCOVERY_MAX_BUFFER,
    });
    const raw = parseDiscoveryOutput(result.stdout.toString('utf8'));
    if (!raw.complete) {
      return { ok: false, error: result.stderr.trim().split('\n').pop() || `${host.label} did not answer` };
    }
    return { ok: true, raw };
  } catch (err) {
    const e = err as { message?: string; stderr?: string; killed?: boolean };
    const detail = e.killed ? 'timed out' : (e.stderr || e.message || 'ssh failed').trim().split('\n').pop();
    return { ok: false, error: `${host.label}: ${detail}` };
  }
}

// ── Machines ───────────────────────────────────────────────────────────────

/** One machine to look on: this server, or one ssh login (systems of a machine share it). */
export interface DiscoveryTarget {
  /** `local`, or the remote host id discovery runs through. */
  id: string;
  name: string;
  /** Host to attach and resume through (null for this server). */
  hostId: string | null;
  /** The machine's Windows system, when it has one: a Windows claude resumes there. */
  windowsHostId?: string;
  address: string;
}

export const LOCAL_TARGET_ID = 'local';

/**
 * The machines to look on: this server first, then one entry per ssh login. A machine's
 * systems (WSL and Windows on one PC) are one login and one process table, so they are
 * looked at once, through the non-Windows system when there is one.
 */
export function discoveryTargets(hosts: RemoteHost[], localName = 'This server'): DiscoveryTarget[] {
  const targets: DiscoveryTarget[] = [{ id: LOCAL_TARGET_ID, name: localName, hostId: null, address: 'local' }];
  const byLogin = new Map<string, RemoteHost[]>();
  for (const host of hosts) {
    const login = loginKey(host);
    byLogin.set(login, [...(byLogin.get(login) ?? []), host]);
  }
  for (const group of byLogin.values()) {
    const primary = group.find((h) => h.system !== 'windows') ?? group[0];
    const windows = group.find((h) => h.system === 'windows');
    const name = primary.machine || primary.label.split(' · ')[0] || primary.label;
    targets.push({
      id: primary.id,
      name,
      hostId: primary.id,
      ...(windows ? { windowsHostId: windows.id } : {}),
      address: `${primary.username}@${primary.host}`,
    });
  }
  return targets;
}

/** One ssh login: the systems of a machine (WSL and Windows on one PC) share it. */
export function loginKey(r: { username: string; host: string; port?: number }): string {
  return `${r.username}@${r.host}:${r.port ?? 22}`;
}

/** The parts of a dashboard session that say where its tmux session lives. */
export interface KnownSessionSource {
  id: string;
  remote?: SessionRemote;
  adoptedTmux?: { socket: string; sessionName: string };
}

/**
 * What the dashboard already shows on a target, so discovery leaves it out: on this
 * server, its own tmux socket (every dashboard session and every ssh wrapper pane) and
 * the sessions it adopted; on a remote login, the remote tmux session of every
 * dashboard session on that login. `locate` maps a remote session to its tmux socket
 * and name (`remoteTmuxLocation` in tmux-manager.ts).
 */
export function knownForTarget(
  target: DiscoveryTarget,
  hosts: RemoteHost[],
  sessions: Iterable<KnownSessionSource>,
  ownSocket: string,
  locate: (remote: SessionRemote, sessionId: string) => { socket: string; sessionName: string }
): ClassifyOptions {
  const knownSessions: Array<{ socket: string; sessionName: string }> = [];
  if (target.hostId === null) {
    for (const s of sessions) if (s.adoptedTmux) knownSessions.push({ ...s.adoptedTmux });
    return { hiddenSockets: [ownSocket], knownSessions };
  }
  const host = hosts.find((h) => h.id === target.hostId);
  if (!host) return { knownSessions };
  const login = loginKey(host);
  for (const s of sessions) {
    if (s.remote && loginKey(s.remote) === login) knownSessions.push(locate(s.remote, s.id));
  }
  return { knownSessions };
}

export interface MachineDiscovery {
  target: DiscoveryTarget;
  ok: boolean;
  error?: string;
  /** Claude in tmux sessions the dashboard does not show, attachable unless noted. */
  tmux: Array<DiscoveredTmuxClaude & { attachable: boolean }>;
  /** Claude running outside tmux: cannot be attached, only resumed in a new session. */
  outside: DiscoveredOutsideClaude[];
  /** Claude panes left out because the dashboard already has them. */
  hiddenCount: number;
}

export interface DiscoverDeps {
  runLocal: () => Promise<DiscoveryRun>;
  runRemote: (host: RemoteHost) => Promise<DiscoveryRun>;
}

/** Discover one target and classify what it found. Never throws. */
export async function discoverTarget(
  target: DiscoveryTarget,
  hosts: RemoteHost[],
  known: ClassifyOptions,
  deps: DiscoverDeps = { runLocal: discoverLocal, runRemote: discoverOnHost }
): Promise<MachineDiscovery> {
  const empty = { target, tmux: [], outside: [], hiddenCount: 0 };
  let run: DiscoveryRun;
  if (target.hostId === null) {
    run = await deps.runLocal();
  } else {
    const host = hosts.find((h) => h.id === target.hostId);
    if (!host) return { ...empty, ok: false, error: 'Machine not found' };
    run = await deps.runRemote(host);
  }
  if (!run.ok || !run.raw) return { ...empty, ok: false, error: run.error || 'Discovery failed' };
  const classified = classifyDiscovery(run.raw, known);
  const hidden = new Set(known.hiddenSockets ?? []);
  return {
    target,
    ok: true,
    tmux: classified.tmux.map((t) => ({
      ...t,
      attachable: ADOPTED_TMUX_NAME_RE.test(t.sessionName) && !hidden.has(t.socket),
    })),
    outside: classified.outside,
    hiddenCount: classified.hiddenCount,
  };
}
