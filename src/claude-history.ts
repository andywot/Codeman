/**
 * @fileoverview Fork: past Claude Code conversations on a machine, for "Resume
 * Conversation" across machines.
 *
 * One read-only POSIX sh script per page, run through the host's pooled shell
 * (`remote-shell-pool.ts`), never a fresh ssh:
 *
 * - `stat` every `~/.claude/projects/<key>/<id>.jsonl` (one level deep, so subagent
 *   logs under `<id>/subagents/` are never listed), sort newest first, and keep only
 *   the requested page;
 * - for each file on that page, a bounded HEAD read (the first prompt and the
 *   folder Claude stamped on its records) and a bounded TAIL read (the title, the
 *   last prompt), base64-encoded so no transcript byte can forge a marker line;
 * - which conversations are running right now: Claude Code's own per-process
 *   records `~/.claude/sessions/<pid>.json` whose pid is alive (`/proc/<pid>`, no
 *   signal is ever sent) and conversation ids named on a `claude` command line.
 *
 * Nothing is written, renamed or signalled. Pages are cached briefly per machine
 * (`ClaudeHistoryService`), so flipping the machine filter back and forth costs no
 * extra ssh round trips.
 *
 * Everything below the script is pure and tested against the real script run under
 * a temporary HOME (`test/claude-history.test.ts`).
 */

import { shellescape } from './remote-hosts.js';
import type { RemoteHost } from './types.js';

/** A Claude conversation id, as Claude Code names its `<id>.jsonl` logs. */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

export const HISTORY_DEFAULT_LIMIT = 30;
export const HISTORY_MAX_LIMIT = 50;
/** Bytes read from the start of each file: the first prompt and the folder live there. */
export const HISTORY_HEAD_BYTES = 24 * 1024;
/** Bytes read from the end of each file: the latest title and prompt live there. */
export const HISTORY_TAIL_BYTES = 8 * 1024;
const PROMPT_MAX = 160;
const TITLE_MAX = 120;

export interface HistoryScriptOptions {
  offset: number;
  limit: number;
  headBytes?: number;
  tailBytes?: number;
}

function int(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(n) ? n : min)));
}

/** The shell body (POSIX sh). Only validated integers are interpolated. */
export function historyScriptBody(opts: HistoryScriptOptions): string {
  const offset = int(opts.offset, 0, 1_000_000);
  const limit = int(opts.limit, 1, HISTORY_MAX_LIMIT);
  const head = int(opts.headBytes ?? HISTORY_HEAD_BYTES, 1024, 256 * 1024);
  const tail = int(opts.tailBytes ?? HISTORY_TAIL_BYTES, 1024, 256 * 1024);
  return [
    'umask 077',
    'pd="$HOME/.claude/projects"',
    'echo "@@begin"',
    '[ -d /proc/self ] && echo "@@proc"',
    // Running conversations: live per-process records, then ids on claude command lines.
    'for f in "$HOME"/.claude/sessions/*.json; do',
    '  [ -f "$f" ] || continue',
    '  b=${f##*/}; n=${b%.json}',
    '  case "$n" in ""|*[!0-9]*) continue;; esac',
    '  [ -d "/proc/$n" ] || continue',
    // Field 22 (start time), counted after the command name, which may hold spaces.
    `  st=$(sed 's/.*) //' "/proc/$n/stat" 2>/dev/null | awk '{print $20}')`,
    '  printf "@@live %s %s " "$n" "${st:-0}"; head -c 4000 "$f" | tr "\\n\\r" "  "; echo',
    'done',
    String.raw`ps -eo args= 2>/dev/null | awk '/(^|[ \/])claude([ .]|$)/' | sed -n -e 's/.*--resume[ =]\([A-Za-z0-9-]\{8,\}\).*/@@argv \1/p' -e 's/.*--session-id[ =]\([A-Za-z0-9-]\{8,\}\).*/@@argv \1/p' | head -n 200`,
    'if [ -d "$pd" ]; then',
    // GNU stat, else BSD stat. `mtime:size:path`, newest first.
    '  if stat -c %Y "$pd" >/dev/null 2>&1; then S="stat -c %Y:%s:%n"; else S="stat -f %m:%z:%N"; fi',
    `  find "$pd" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' ! -name 'agent-*' -exec $S {} + 2>/dev/null |`,
    '    sort -t: -k1,1nr |',
    `    awk -v o=${offset} -v l=${limit} 'NR > o && NR <= o + l { print } END { print "@@total " NR }' |`,
    '    while IFS= read -r line; do',
    '      case "$line" in "@@total "*) echo "$line"; continue;; esac',
    '      rest=${line#*:}; sz=${rest%%:*}; f=${rest#*:}',
    '      printf "@@file %s\\n" "$line"',
    `      printf "@@head "; head -c ${head} "$f" 2>/dev/null | base64 | tr -d '\\n\\r'; echo`,
    `      if [ "$sz" -gt ${head} ] 2>/dev/null; then printf "@@tail "; tail -c ${tail} "$f" 2>/dev/null | base64 | tr -d '\\n\\r'; echo; fi`,
    '    done',
    'else',
    '  echo "@@total 0"',
    'fi',
    'echo "@@end"',
  ].join('\n');
}

/** The complete command, run under `sh` whatever the login shell is. */
export function historyCommand(opts: HistoryScriptOptions): string {
  return `sh -c ${shellescape(historyScriptBody(opts))}`;
}

// ── Parsing ────────────────────────────────────────────────────────────────

export interface RawHistoryFile {
  path: string;
  mtime: number;
  size: number;
  head: string;
  tail: string;
}

export interface RawLiveRecord {
  pid: number;
  /** /proc/<pid>/stat field 22, or '0' when unread. */
  startTime: string;
  json: string;
}

export interface RawHistory {
  total: number;
  files: RawHistoryFile[];
  live: RawLiveRecord[];
  argvIds: string[];
  /** The machine has /proc, so the live check means something. */
  procAvailable: boolean;
  /** False when the output stopped before `@@end`. */
  complete: boolean;
}

function decodeB64(text: string): string {
  try {
    return Buffer.from(text.trim(), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Parse the script's stdout. Unknown or malformed lines are skipped. */
export function parseHistoryOutput(stdout: string): RawHistory {
  const out: RawHistory = { total: 0, files: [], live: [], argvIds: [], procAvailable: false, complete: false };
  let current: RawHistoryFile | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('@@')) continue;
    const space = line.indexOf(' ');
    const tag = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1);
    switch (tag) {
      case '@@proc':
        out.procAvailable = true;
        break;
      case '@@live': {
        const m = /^(\d+) (\d+) (.*)$/.exec(rest);
        if (m) out.live.push({ pid: Number(m[1]), startTime: m[2], json: m[3].trim() });
        break;
      }
      case '@@argv':
        if (CONVERSATION_ID_RE.test(rest.trim()) && !out.argvIds.includes(rest.trim())) out.argvIds.push(rest.trim());
        break;
      case '@@file': {
        current = null;
        const m = /^(\d+):(\d+):(\/.+\.jsonl)$/.exec(rest);
        if (!m) break;
        current = { mtime: Number(m[1]), size: Number(m[2]), path: m[3], head: '', tail: '' };
        out.files.push(current);
        break;
      }
      case '@@head':
        if (current) current.head = decodeB64(rest);
        break;
      case '@@tail':
        if (current) current.tail = decodeB64(rest);
        break;
      case '@@total': {
        const n = Number(rest.trim());
        if (Number.isFinite(n) && n >= 0) out.total = n;
        break;
      }
      case '@@end':
        out.complete = true;
        break;
    }
  }
  return out;
}

/** Conversation ids running on that machine (live session records, then command lines). */
export function runningConversationIds(raw: Pick<RawHistory, 'live' | 'argvIds'>): Set<string> {
  const ids = new Set<string>();
  for (const rec of raw.live) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rec.json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    // A record naming another pid, or a reused pid (start time disagrees), is stale.
    if (typeof data.pid === 'number' && data.pid !== rec.pid) continue;
    const procStart =
      typeof data.procStart === 'string' || typeof data.procStart === 'number' ? String(data.procStart) : '';
    if (procStart && rec.startTime !== '0' && procStart !== rec.startTime) continue;
    if (typeof data.kind === 'string' && data.kind !== 'interactive') continue;
    if (typeof data.sessionId === 'string' && CONVERSATION_ID_RE.test(data.sessionId)) ids.add(data.sessionId);
  }
  for (const id of raw.argvIds) ids.add(id);
  return ids;
}

// ── One conversation ───────────────────────────────────────────────────────

interface TranscriptRow {
  type?: string;
  cwd?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  isSidechain?: unknown;
  entrypoint?: unknown;
  customTitle?: unknown;
  aiTitle?: unknown;
  message?: { content?: unknown };
}

function* rows(text: string): Generator<TranscriptRow> {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const row = JSON.parse(line) as TranscriptRow;
      if (row && typeof row === 'object') yield row;
    } catch {
      // A line cut by the head/tail window, or malformed.
    }
  }
}

/** The human-typed text of a user row, or undefined for tool results and injected text. */
export function userPromptText(row: TranscriptRow): string | undefined {
  if (row.type !== 'user' || !row.message || row.isMeta || row.isCompactSummary || row.isSidechain) return undefined;
  const content = row.message.content;
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const block = content.find((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text') as
      | { text?: unknown }
      | undefined;
    if (typeof block?.text === 'string') text = block.text;
  }
  if (!text) return undefined;
  if (
    /^\s*(?:<local-command|<command-name>|<command-message>|<task-notification>|<system-reminder>|<teammate-message\b|Another Claude session sent a message:|Base directory for this skill:|Caveat:)/i.test(
      text
    )
  ) {
    return undefined;
  }
  const clean = text
    .replace(/<[^>]+>/g, '')
    .replace(new RegExp(String.raw`\x1b\[[0-9;]*[a-zA-Z]`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 2) return undefined;
  // Never surface what looks like a credential in a list row.
  if (/\b(sk-ant-|ANTHROPIC_API_KEY|API_KEY=|SECRET=|TOKEN=)/i.test(clean)) return undefined;
  return clean.length > PROMPT_MAX ? `${clean.slice(0, PROMPT_MAX)}…` : clean;
}

export interface ConversationSummary {
  id: string;
  /** Claude's project folder key (the parent directory name). */
  projectKey: string;
  /** The folder Claude ran in, from its own records; absent when none was read. */
  cwd?: string;
  /** `/rename` title, else Claude's own generated title. */
  title?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  /** Epoch ms of the file's last write. */
  lastActivityAt: number;
  sizeBytes: number;
  /** An SDK / `claude -p` style run nobody can usefully resume. */
  automated: boolean;
  /** Neither window held a user or assistant message. */
  empty: boolean;
}

/** Summarize one file from its head and tail windows. Null for a name that is not a conversation id. */
export function summarizeConversation(file: RawHistoryFile): ConversationSummary | null {
  const parts = file.path.split('/');
  const id = (parts.pop() ?? '').replace(/\.jsonl$/, '');
  const projectKey = parts.pop() ?? '';
  if (!CONVERSATION_ID_RE.test(id)) return null;
  let headCwd: string | undefined;
  let tailCwd: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let sawMessage = false;
  let sawCli = false;
  let sawOther = false;
  const scan = (text: string, isHead: boolean) => {
    for (const row of rows(text)) {
      if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle.trim()) {
        customTitle = row.customTitle.trim();
      } else if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) {
        aiTitle = row.aiTitle.trim();
      }
      if (row.type !== 'user' && row.type !== 'assistant') continue;
      sawMessage = true;
      if (typeof row.entrypoint === 'string') {
        if (row.entrypoint === 'cli') sawCli = true;
        else if (/^sdk(-|$)/.test(row.entrypoint)) sawOther = true;
      }
      if (typeof row.cwd === 'string' && row.cwd.startsWith('/') && row.cwd.length < 4096) {
        if (isHead) headCwd ??= row.cwd;
        else tailCwd = row.cwd;
      }
      const prompt = userPromptText(row);
      if (prompt) {
        if (isHead) firstPrompt ??= prompt;
        lastPrompt = prompt;
      }
    }
  };
  scan(file.head, true);
  if (file.tail) scan(file.tail, false);
  const title = customTitle ?? aiTitle;
  return {
    id,
    projectKey,
    ...((headCwd ?? tailCwd) ? { cwd: headCwd ?? tailCwd } : {}),
    ...(title ? { title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(lastPrompt && lastPrompt !== firstPrompt ? { lastPrompt } : {}),
    lastActivityAt: file.mtime * 1000,
    sizeBytes: file.size,
    automated: sawOther && !sawCli,
    empty: !sawMessage,
  };
}

// ── A page ─────────────────────────────────────────────────────────────────

export interface HistoryRow extends Omit<ConversationSummary, 'automated' | 'empty'> {
  /** A Claude on that machine has this conversation open right now. */
  running: boolean;
  /** The dashboard session showing this conversation, when there is one. */
  openSessionId?: string;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Conversation files on the machine (before automated/empty ones are dropped). */
  total: number;
  offset: number;
  limit: number;
  /** Offset of the next page, or null after the last one. */
  nextOffset: number | null;
  /** Whether running conversations could be told apart (the machine has /proc). */
  runningKnown: boolean;
  fetchedAt: number;
}

/**
 * Turn one script run into a page. Automated runs and files with no message in
 * either window are left out; `knownOpen` maps conversation ids the dashboard
 * already shows on that machine to their session ids.
 */
export function buildHistoryPage(
  raw: RawHistory,
  offset: number,
  limit: number,
  knownOpen: ReadonlyMap<string, string> = new Map(),
  now = Date.now()
): HistoryPage {
  const running = runningConversationIds(raw);
  const seen = new Set<string>();
  const out: HistoryRow[] = [];
  for (const file of raw.files) {
    const s = summarizeConversation(file);
    if (!s || s.automated || s.empty || seen.has(s.id)) continue;
    seen.add(s.id);
    const { automated: _a, empty: _e, ...rest } = s;
    const openSessionId = knownOpen.get(s.id);
    out.push({
      ...rest,
      running: running.has(s.id) || Boolean(openSessionId),
      ...(openSessionId ? { openSessionId } : {}),
    });
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const next = offset + limit;
  return {
    rows: out,
    total: raw.total,
    offset,
    limit,
    nextOffset: next < raw.total ? next : null,
    runningKnown: raw.procAvailable,
    fetchedAt: now,
  };
}

// ── IO + cache ─────────────────────────────────────────────────────────────

const HISTORY_TIMEOUT_MS = 20_000;
const HISTORY_MAX_BUFFER = 8 * 1024 * 1024;
export const HISTORY_CACHE_TTL_MS = 30_000;
const HISTORY_CACHE_MAX = 64;

export type HistoryRunner = (host: RemoteHost, command: string) => Promise<{ stdout: string; stderr: string }>;

/** Run the listing on a host through its pooled shell. Throws with a short message. */
export async function runHistoryOnHost(host: RemoteHost, command: string): Promise<{ stdout: string; stderr: string }> {
  const { remoteExecStatus } = await import('./remote-shell-pool.js');
  try {
    const result = await remoteExecStatus(host, command, {
      timeout: HISTORY_TIMEOUT_MS,
      maxBuffer: HISTORY_MAX_BUFFER,
    });
    return { stdout: result.stdout.toString('utf8'), stderr: result.stderr };
  } catch (err) {
    const e = err as { message?: string; stderr?: string; killed?: boolean };
    const detail = e.killed ? 'timed out' : (e.stderr || e.message || 'ssh failed').trim().split('\n').pop();
    throw new Error(`${host.label}: ${detail}`);
  }
}

/** Clamp the query's paging to what one script run reads. */
export function historyPaging(query: { offset?: string; limit?: string }): { offset: number; limit: number } {
  const offset = Math.max(0, Math.min(1_000_000, parseInt(query.offset ?? '0', 10) || 0));
  const limit = Math.max(1, Math.min(HISTORY_MAX_LIMIT, parseInt(query.limit ?? '', 10) || HISTORY_DEFAULT_LIMIT));
  return { offset, limit };
}

interface CacheEntry {
  at: number;
  raw: RawHistory;
}

/**
 * Pages per machine, cached for HISTORY_CACHE_TTL_MS. Concurrent requests for the
 * same page share one script run. The running marks are recomputed on every read
 * from the dashboard's own sessions, so only the machine's side is cached.
 */
export class ClaudeHistoryService {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<RawHistory>>();

  constructor(
    private readonly runner: HistoryRunner = runHistoryOnHost,
    private readonly now: () => number = Date.now
  ) {}

  async page(
    host: RemoteHost,
    paging: { offset: number; limit: number },
    opts: { fresh?: boolean; knownOpen?: ReadonlyMap<string, string> } = {}
  ): Promise<HistoryPage> {
    const key = `${host.id}|${paging.offset}|${paging.limit}`;
    const hit = this.cache.get(key);
    let raw: RawHistory;
    let at: number;
    if (!opts.fresh && hit && this.now() - hit.at < HISTORY_CACHE_TTL_MS) {
      ({ raw, at } = hit);
    } else {
      let pending = this.inFlight.get(key);
      if (!pending) {
        pending = this.load(host, paging).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
      }
      raw = await pending;
      at = this.now();
      this.cache.delete(key);
      this.cache.set(key, { at, raw });
      while (this.cache.size > HISTORY_CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    }
    return buildHistoryPage(raw, paging.offset, paging.limit, opts.knownOpen, at);
  }

  /** Drop every cached page of one host (after a resume, say). */
  forget(hostId: string): void {
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${hostId}|`)) this.cache.delete(key);
  }

  private async load(host: RemoteHost, paging: { offset: number; limit: number }): Promise<RawHistory> {
    const { stdout, stderr } = await this.runner(host, historyCommand(paging));
    const raw = parseHistoryOutput(stdout);
    if (!raw.complete) throw new Error(stderr.trim().split('\n').pop() || `${host.label} did not answer`);
    return raw;
  }
}
