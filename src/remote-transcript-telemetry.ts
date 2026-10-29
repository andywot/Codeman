/**
 * @fileoverview Remote transcript telemetry (fork): prompt-cache state and usage-limit pauses for
 * remote (ssh) claude sessions, read from what the server can already see of them.
 *
 * A local claude session reports its prompt cache through the statusLine exporter, which POSTs
 * to this server. A remote session cannot: its claude runs on another machine, and its launch
 * carries no exporter (`statusLineExporter` reads `transcript` for it, see `Session`). So the
 * two features that live on that data were local-only:
 *
 * - Prompt-cache keep-warm (prompt-cache-keepwarm.ts) needs `Session.promptCache`. Here it is
 *   DERIVED from the conversation log on the remote host, read over the host's pooled shell
 *   (`readTranscriptTail` in chat-transcript.ts, the chat view's own lookup): the last main-chain
 *   API response's time, its cache lifetime (`usage.cache_creation.ephemeral_1h_input_tokens` /
 *   `ephemeral_5m_input_tokens`) and its context size give `expiresAt`, `ttl` and
 *   `recacheTokensIfCold`, the three facts the keep-warm rulebook reads.
 * - Auto-resume on usage limit (session-auto-ops.ts) already reads the pane's output stream,
 *   which a remote session has (the local pane runs the ssh client). This adds two readings of
 *   the same pause that do not depend on the stream: the pane's visible frame (a local
 *   `capture-pane`, spaced the way the screen shows it) and the log's trailing API error
 *   (`isApiErrorMessage`, e.g. "You've hit your session limit · resets 1:50pm (Asia/Hong_Kong)").
 *   Both go through `Session.noteUsageLimitText()`, which only arms on a reset still ahead.
 *
 * When: once a turn ends (the session's `idle` event, a few seconds later so the log has the
 * last entry), when a session is set up (creation, re-attach, boot recovery: a remote session
 * keeps working while this server restarts), when either switch is turned on, and right before
 * a keep-alive nudge (so a stale reading never sends one). Only while one of the two features
 * wants it, and one read at a time per session. Nothing here writes to a pane.
 *
 * Shape: the two readers of log lines are pure (`derivePromptCacheFromTranscript`,
 * `findTranscriptUsageLimit`) and tested on fake logs; `RemoteTranscriptTelemetry` owns the
 * scheduling and reaches everything else through ports.
 *
 * @module remote-transcript-telemetry
 */

import type { PromptCacheStatus, StatusLineExporter } from './types/index.js';

/** First read: the tail of the log, enough for the last few responses of an ordinary turn. */
export const TRANSCRIPT_TAIL_BYTES = 128 * 1024;
/** Second read when the first held no API response (big tool outputs or pasted images at the end). */
export const TRANSCRIPT_TAIL_MAX_BYTES = 1024 * 1024;
/** After a turn ends: the log's last entries land a moment after the screen goes idle. */
export const IDLE_READ_DELAY_MS = 3_000;

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const;

interface LogUsage {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown };
}

interface LogLine {
  type?: string;
  subtype?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: { id?: string; model?: string; usage?: LogUsage; content?: unknown };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function parse(line: string): LogLine | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' ? (v as LogLine) : null;
  } catch {
    return null;
  }
}

/** A response from the API on the main conversation (not a subagent's, not a synthetic error line). */
function isMainResponse(e: LogLine): boolean {
  if (e.type !== 'assistant' || e.isSidechain === true || e.isApiErrorMessage === true) return false;
  if (e.message?.model === '<synthetic>') return false;
  const u = e.message?.usage;
  return !!u && num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) > 0;
}

function ttlOf(u: LogUsage | undefined): '1h' | '5m' | null {
  const c = u?.cache_creation;
  if (num(c?.ephemeral_1h_input_tokens) > 0) return '1h';
  if (num(c?.ephemeral_5m_input_tokens) > 0) return '5m';
  return null;
}

/**
 * The main conversation's prompt-cache state as of the last API response in `lines` (the log's
 * tail, oldest first), in the statusline's terms; null when the lines hold no response or no
 * response that says which cache lifetime the conversation is on.
 *
 * - `expiresAt`: when the last request was made (the first log entry of its response; a cache
 *   read refreshes the lifetime) plus the lifetime. A little late by the time to first token,
 *   which the keep-warm's five-minute lead absorbs.
 * - `ttl`: from the newest response that wrote to the cache (a pure read says nothing).
 * - `recacheTokensIfCold`: the whole context of that request plus its output, which is what the
 *   next request re-writes if the cache has gone cold.
 * - A compaction after that response (`compact_boundary`) leaves the context it describes gone:
 *   the report carries no `recacheTokensIfCold`, which is how a statusline report reads inside the
 *   compaction window, so `Session.setPromptCache` stamps `compactedAt` and the keep-warm stops.
 *
 * Pure: `now` is passed in.
 */
export function derivePromptCacheFromTranscript(lines: readonly string[], now: number): PromptCacheStatus | null {
  const entries = lines.map(parse);
  let last = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && isMainResponse(e)) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const response = entries[last]!;
  const messageId = response.message?.id;

  // One response is logged as one entry per content block, all sharing the message id and
  // usage; the first of them is closest to when the request was made.
  let requestAt = Date.parse(response.timestamp ?? '');
  for (let i = last - 1; i >= 0 && messageId; i--) {
    const e = entries[i];
    if (!e) continue;
    if (e.type !== 'assistant' || e.isSidechain === true) {
      if (e.isSidechain === true) continue;
      break;
    }
    if (e.message?.id !== messageId) break;
    const at = Date.parse(e.timestamp ?? '');
    if (Number.isFinite(at)) requestAt = Math.min(requestAt, at);
  }
  if (!Number.isFinite(requestAt)) return null;

  let ttl: '1h' | '5m' | null = null;
  for (let i = last; i >= 0 && !ttl; i--) {
    const e = entries[i];
    if (e && isMainResponse(e)) ttl = ttlOf(e.message?.usage);
  }
  if (!ttl) return null;

  const compacted = entries
    .slice(last + 1)
    .some((e) => e?.type === 'system' && e.subtype === 'compact_boundary' && e.isSidechain !== true);
  const expiresAt = requestAt + TTL_MS[ttl];
  const status: PromptCacheStatus = { warm: expiresAt > now, ttl, expiresAt };
  if (!compacted) {
    const u = response.message!.usage!;
    status.recacheTokensIfCold = Math.round(
      num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens)
    );
  }
  return status;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: string }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * The text of the API error the conversation ENDS on, when it does: Claude Code logs a usage-limit
 * stop as a synthetic assistant line (`isApiErrorMessage: true`, `error: "rate_limit"`) whose text
 * is the footer the pane shows. Null when anything the conversation did came after it (a prompt,
 * a tool result, a response), so an old limit in a log that moved on is never read as a pause.
 * Bookkeeping lines (system entries, meta prompts, attachments) are skipped. Whether the text holds
 * a usage limit with a reset time is for `detectUsageLimitPause` to say. Pure.
 */
export function findTranscriptUsageLimit(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e || e.isSidechain === true || e.isMeta === true) continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.type === 'assistant' && e.isApiErrorMessage === true) {
      const text = textOf(e.message?.content);
      return text || null;
    }
    return null;
  }
  return null;
}

// ── The service ─────────────────────────────────────────────────────────────

/** What the service needs from a session; `Session` satisfies it structurally. */
export interface RemoteTelemetrySession {
  readonly id: string;
  readonly statusLineExporter?: StatusLineExporter;
  readonly autoResumeEnabled: boolean;
  /** Arms auto-resume when the text holds a usage limit whose reset is still ahead. */
  noteUsageLimitText(text: string): boolean;
}

export interface RemoteTelemetryPorts {
  getSession(id: string): RemoteTelemetrySession | undefined;
  /** Whether the keep-warm is effectively on for the session (its own switch, else the app default). */
  keepWarmWanted(session: RemoteTelemetrySession): boolean;
  /** The conversation log's last `maxBytes` as lines, over the host's pooled shell; null when there is none yet. */
  readTail(session: RemoteTelemetrySession, maxBytes: number): Promise<{ lines: string[]; size: number } | null>;
  /** The pane's visible frame as plain text (a local capture of the ssh pane); null when it cannot be read. */
  captureScreen(session: RemoteTelemetrySession): string | null;
  /** Store a derived report on the session, broadcast and persist a change, and re-evaluate the keep-warm when `schedule`. */
  applyPromptCache(session: RemoteTelemetrySession, cache: PromptCacheStatus, schedule: boolean): void;
  log?(message: string): void;
}

export interface RefreshOptions {
  /** Wait this long first (a turn's last log entry lands a moment after the screen goes idle). */
  delayMs?: number;
  /** Re-evaluate the keep-warm after a changed report; false for the keep-warm's own pre-nudge read. */
  schedule?: boolean;
}

export class RemoteTranscriptTelemetry {
  /** The read running per session. */
  private readonly running = new Map<string, Promise<void>>();
  /** A trigger that landed mid-read: one more read runs after it (schedule if any asked for it). */
  private readonly again = new Map<string, boolean>();
  /** A delayed read per session, and how to settle whoever awaits it if it is replaced or dropped. */
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; settle: () => void }>();
  /** The last failure logged per session, so an unreachable host is logged once, not every turn. */
  private readonly lastFailure = new Map<string, string>();
  private stopped = false;

  constructor(private readonly ports: RemoteTelemetryPorts) {}

  /** Whether a session is one this service reads for (a remote claude session). */
  static applies(session: { statusLineExporter?: StatusLineExporter } | undefined): boolean {
    return session?.statusLineExporter === 'transcript';
  }

  /**
   * Read the session's log (and screen) once, when it applies and a feature wants it. Resolves when
   * the read is done; a read already running absorbs the trigger and runs once more after it.
   */
  refresh(id: string, opts: RefreshOptions = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const schedule = opts.schedule !== false;
    if (opts.delayMs && opts.delayMs > 0) {
      // One pending delayed read per session; a newer trigger restarts the wait.
      this.clearTimer(id);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.timers.delete(id);
          void this.refresh(id, { schedule }).then(resolve);
        }, opts.delayMs);
        timer.unref?.();
        this.timers.set(id, { timer, settle: resolve });
      });
    }
    const running = this.running.get(id);
    if (running) {
      this.again.set(id, (this.again.get(id) ?? false) || schedule);
      return running;
    }
    const run = this.read(id, schedule)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (this.lastFailure.get(id) !== message) {
          this.lastFailure.set(id, message);
          this.ports.log?.(`[RemoteTelemetry] ${id.slice(0, 8)}: could not read the conversation log: ${message}`);
        }
      })
      .finally(() => {
        if (this.running.get(id) !== run) return;
        this.running.delete(id);
        const next = this.again.get(id);
        if (next !== undefined && !this.stopped) {
          this.again.delete(id);
          void this.refresh(id, { schedule: next });
        }
      });
    this.running.set(id, run);
    return run;
  }

  remove(id: string): void {
    this.clearTimer(id);
    this.running.delete(id);
    this.again.delete(id);
    this.lastFailure.delete(id);
  }

  stop(): void {
    this.stopped = true;
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  private clearTimer(id: string): void {
    const pending = this.timers.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.timers.delete(id);
    pending.settle();
  }

  private async read(id: string, schedule: boolean): Promise<void> {
    const session = this.ports.getSession(id);
    if (!session || !RemoteTranscriptTelemetry.applies(session)) return;
    const resume = session.autoResumeEnabled;
    const keepWarm = this.ports.keepWarmWanted(session);
    if (!resume && !keepWarm) return;

    // The screen first: free (a local capture), and what the user sees is the pause to act on.
    if (resume) {
      const screen = this.ports.captureScreen(session);
      if (screen) session.noteUsageLimitText(screen);
    }

    let tail = await this.ports.readTail(session, TRANSCRIPT_TAIL_BYTES);
    if (this.stopped || this.ports.getSession(id) !== session) return;
    if (!tail) return;
    let cache = derivePromptCacheFromTranscript(tail.lines, Date.now());
    if (!cache && tail.size > TRANSCRIPT_TAIL_BYTES) {
      tail = (await this.ports.readTail(session, TRANSCRIPT_TAIL_MAX_BYTES)) ?? tail;
      if (this.stopped || this.ports.getSession(id) !== session) return;
      cache = derivePromptCacheFromTranscript(tail.lines, Date.now());
    }
    this.lastFailure.delete(id);

    if (resume) {
      const limit = findTranscriptUsageLimit(tail.lines);
      if (limit) session.noteUsageLimitText(limit);
    }
    // Kept up to date even with the keep-warm off: the Session Options readout shows it.
    if (cache) this.ports.applyPromptCache(session, cache, schedule && keepWarm);
  }
}
