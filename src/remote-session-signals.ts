/**
 * @fileoverview Remote session signals (fork): "needs you" / "waiting" alerts and statusline
 * figures for remote (ssh) claude sessions, without the remote machine calling this server.
 *
 * A local claude session POSTs its hooks to `/api/hook-event` and its statusline to
 * `/api/status-telemetry`. A remote one cannot be trusted to reach this server's port (the site
 * is LAN/WireGuard only, behind auth), so its launch (fleet.ts `buildRemoteSignalsSettings`)
 * records both to files on its own machine instead:
 *
 * - `~/.config/claude-rc/events/<key>.log`: one `<unix seconds> <event>` line per hook
 *   (permission_prompt, idle_prompt, the elicitation events, stop). Nothing else: no prompt,
 *   tool input or message text.
 * - `~/.config/claude-rc/session/<key>.json`: the latest statusline JSON.
 *
 * `<key>` is the remote tmux session name (`remoteSignalsKey`), exported to the pane as
 * `$CLAUDE_RC_SESSION` (tmux-manager.ts).
 *
 * This service reads them back over each host's pooled shell (remote-shell-pool.ts): ONE command
 * per host per poll for all of that host's sessions, which prints only the event bytes past the
 * offset already read and the statusline file only when it changed. Every few seconds
 * ({@link POLL_ACTIVE_MS}) while a browser is connected, every {@link POLL_IDLE_MS} otherwise
 * (push notifications still arrive), and through `remoteExecIfIdle`, so a poll never queues
 * behind a user's command. An unreachable host backs off up to {@link MAX_BACKOFF_MS}, the
 * machine poll's asleep re-probe interval, and nothing here ever wakes a machine.
 *
 * What it feeds: each event goes through `handleHookEvent` (hook-event-routes.ts), the very
 * handler the local POST runs, so tab alerts, the Approvals Inbox, wait signals, respawn
 * signals and push notifications behave as for a local session. The statusline goes through the
 * same applier as the local exporter's POST (status-telemetry-apply.ts), minus the account-wide
 * plan chip (the fleet's per-account usage covers remote accounts) and the prompt cache (derived
 * from the conversation log by remote-transcript-telemetry.ts, the one writer for it).
 *
 * The first read of a session SKIPS events already in its file (a server restart must not replay
 * old alerts), and within one read, events older than {@link STALE_EVENT_S} by the remote's own
 * clock are dropped unless the LAST one is a prompt still standing.
 *
 * Shape: script building, output parsing and event selection are pure and exported for
 * test/remote-session-signals.test.ts; `RemoteSessionSignals` owns scheduling through ports.
 *
 * @module remote-session-signals
 */

import type { SessionMode, SessionRemote } from './types/index.js';
import { EVENTS_DIR, REMOTE_HOOK_EVENTS, SESSION_STATUS_DIR, type RemoteHookEvent } from './fleet.js';
import { isReclaimedRemote, remoteTmuxLocation } from './tmux-manager.js';
import { getCli } from './config/cli-registry/registry.js';

/** Poll interval while at least one browser is connected. */
export const POLL_ACTIVE_MS = 4_000;
/** Poll interval with no browser connected (push notifications still need the events). */
export const POLL_IDLE_MS = 30_000;
/** First retry after a failed read; doubles per failure. */
export const FIRST_BACKOFF_MS = 15_000;
/** Longest wait between reads of a host that keeps failing (the machine poll's asleep re-probe). */
export const MAX_BACKOFF_MS = 10 * 60_000;
/** Most new event bytes read per session per poll; the rest is read on the next one. */
export const MAX_EVENT_BYTES = 64 * 1024;
/** Most statusline bytes read per session. */
export const MAX_STATUS_BYTES = 64 * 1024;
/** Events older than this (remote clock) are history, not news. */
export const STALE_EVENT_S = 120;
const READ_TIMEOUT_MS = 10_000;

const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
const KNOWN_EVENTS = new Set<string>(REMOTE_HOOK_EVENTS.map((e) => e.event));
/** Prompt events: the last of these, with nothing after it, is still on screen. */
const PROMPT_EVENTS = new Set<string>(['permission_prompt', 'elicitation_dialog', 'idle_prompt']);

export type RemoteSignalsSupport = 'on' | 'relaunch' | 'unsupported';

/** The file key a remote session's launch writes under: its remote tmux session name. */
export function remoteSignalsKey(remote: SessionRemote, sessionId: string): string {
  return remoteTmuxLocation(remote, sessionId).sessionName;
}

/**
 * Whether a session's alerts and statusline figures can reach the dashboard this way. Undefined
 * for anything but a remote (ssh) claude session. `seen` is true once a read found its files
 * (a re-attached session, whose launch record is gone, still has them).
 */
export function remoteSignalsSupport(
  session: { mode: SessionMode; remote?: SessionRemote; docker?: unknown },
  seen = false
): RemoteSignalsSupport | undefined {
  const remote = session.remote;
  // The CLI whose remote launch carries the fleet profile and reports a statusline (claude),
  // as data rather than an id check (test/cli-registry-no-id-branching.test.ts).
  if (!remote || session.docker || !getCli(session.mode)?.capabilities.statusLineTelemetry) return undefined;
  if (remote.system === 'windows' || remote.commands?.claude) return 'unsupported';
  // An adopted session was started by someone else, without these hooks.
  if (remote.remoteTmuxSocket || (remote.owned === false && !isReclaimedRemote(remote))) return 'unsupported';
  if ((remote.launch?.signals ?? 0) >= 1 || seen) return 'on';
  return 'relaunch';
}

/** Whether the service should read a session's files at all. */
export function remoteSignalsReadable(session: {
  mode: SessionMode;
  remote?: SessionRemote;
  docker?: unknown;
}): boolean {
  const support = remoteSignalsSupport(session);
  if (support === 'on') return true;
  // A re-attached session lost its launch record; its files tell whether it has them.
  return support === 'relaunch' && isReclaimedRemote(session.remote!);
}

export interface SignalsReadEntry {
  key: string;
  /** Event bytes already read; null on the first read (skip what is already there). */
  offset: number | null;
  /** The statusline file's last seen mtime (seconds), or null to read it regardless. */
  statusMtime: number | null;
}

/**
 * The one command that reads every listed session on a host. Prints, per key:
 *
 *     \n@@e <key> <size>\n<new event bytes>      (size -1: no file)
 *     \n@@s <key> <mtime>\n<statusline JSON>     (mtime -1: no file; body only when changed)
 *
 * and first `\n@@now <remote unix seconds>\n`. Event bytes are read from the given offset (the
 * whole file is never sent again); a first read (offset null) reports the size only. The
 * statusline body is sent when its mtime differs from the last seen one, or is within 2 s of
 * the remote's clock (a second write inside the same second would otherwise go unseen).
 * Keys must match {@link KEY_RE}; anything else is left out.
 */
export function buildSignalsReadScript(entries: readonly SignalsReadEntry[]): string {
  const calls: string[] = [];
  for (const entry of entries) {
    if (!KEY_RE.test(entry.key)) continue;
    const offset = entry.offset === null ? -1 : Math.max(0, Math.floor(entry.offset));
    const mtime = entry.statusMtime === null ? -1 : Math.floor(entry.statusMtime);
    calls.push(`rce ${entry.key} ${offset}; rcs ${entry.key} ${mtime}`);
  }
  return [
    'now=$(date +%s)',
    `printf '\\n@@now %s\\n' "$now"`,
    `cd "$HOME" 2>/dev/null || exit 0`,
    // Events: size, then the bytes past the offset (none on a first read).
    `rce() { f=${EVENTS_DIR}/$1.log; if [ ! -f "$f" ]; then printf '\\n@@e %s -1\\n' "$1"; return; fi; ` +
      `s=$(wc -c < "$f" | tr -d ' '); printf '\\n@@e %s %s\\n' "$1" "$s"; ` +
      `if [ "$2" -ge 0 ] && [ "$s" -gt "$2" ]; then tail -c +$(($2 + 1)) "$f" | head -c ${MAX_EVENT_BYTES}; ` +
      `elif [ "$2" -ge 0 ] && [ "$s" -lt "$2" ]; then head -c ${MAX_EVENT_BYTES} "$f"; fi; }`,
    // Statusline: mtime, then the JSON when it changed.
    `rcs() { f=${SESSION_STATUS_DIR}/$1.json; if [ ! -f "$f" ]; then printf '\\n@@s %s -1\\n' "$1"; return; fi; ` +
      `m=$(stat -c %Y "$f" 2>/dev/null || echo 0); printf '\\n@@s %s %s\\n' "$1" "$m"; ` +
      `if [ "$m" != "$2" ] || [ $((now - m)) -lt 2 ]; then head -c ${MAX_STATUS_BYTES} "$f"; fi; }`,
    ...calls,
  ].join('\n');
}

export interface SignalsReadResult {
  /** The remote's clock (unix seconds), when printed. */
  now: number | null;
  events: Map<string, { size: number; body: string }>;
  status: Map<string, { mtime: number; body: string }>;
}

/** {@link buildSignalsReadScript}'s output, per key. Unknown or malformed blocks are skipped. */
export function parseSignalsReadOutput(stdout: string): SignalsReadResult {
  const result: SignalsReadResult = { now: null, events: new Map(), status: new Map() };
  for (const block of stdout.split('\n@@').slice(1)) {
    const nl = block.indexOf('\n');
    const head = nl < 0 ? block : block.slice(0, nl);
    const body = nl < 0 ? '' : block.slice(nl + 1);
    const [kind, a, b] = head.split(' ');
    if (kind === 'now') {
      const now = Number(a);
      if (Number.isFinite(now) && now > 0) result.now = now;
      continue;
    }
    if (!KEY_RE.test(a ?? '') || !/^-?\d+$/.test(b ?? '')) continue;
    if (kind === 'e') result.events.set(a, { size: Number(b), body });
    else if (kind === 's') result.status.set(a, { mtime: Number(b), body });
  }
  return result;
}

export interface RemoteHookLine {
  at: number;
  event: RemoteHookEvent;
}

/**
 * Complete `<unix seconds> <event>` lines in `text`, oldest first, and how many bytes they span
 * (a trailing partial line is left for the next read). Unknown events and malformed lines are
 * skipped but still consumed.
 */
export function parseEventLines(text: string): { events: RemoteHookLine[]; consumed: number } {
  const end = text.lastIndexOf('\n');
  if (end < 0) return { events: [], consumed: 0 };
  const complete = text.slice(0, end + 1);
  const events: RemoteHookLine[] = [];
  for (const line of complete.split('\n')) {
    const m = /^(\d{1,12}) ([a-z_]{1,40})\s*$/.exec(line);
    if (!m || !KNOWN_EVENTS.has(m[2])) continue;
    events.push({ at: Number(m[1]), event: m[2] as RemoteHookEvent });
  }
  return { events, consumed: Buffer.byteLength(complete, 'utf8') };
}

/**
 * The events of one read worth applying, in order. Events older than {@link STALE_EVENT_S} by the
 * remote's own clock (`now`, so clock skew does not matter) happened while nobody could be told
 * (the host was unreachable, the server down) and are dropped, except that the LAST event is kept
 * when it is a prompt: nothing came after it, so that dialog is still waiting. With no remote
 * clock every event is applied. Pure.
 */
export function selectEventsToApply(events: readonly RemoteHookLine[], now: number | null): RemoteHookLine[] {
  if (now === null) return [...events];
  const fresh = events.filter((e) => now - e.at <= STALE_EVENT_S);
  const last = events[events.length - 1];
  if (last && PROMPT_EVENTS.has(last.event) && !fresh.includes(last)) fresh.push(last);
  return fresh;
}

// ── The service ─────────────────────────────────────────────────────────────

/** What the service needs from a session; `Session` satisfies it structurally. */
export interface SignalsSession {
  readonly id: string;
  readonly mode: SessionMode;
  readonly remote?: SessionRemote;
  readonly docker?: unknown;
}

export interface RemoteSignalsPorts {
  sessions(): Iterable<SignalsSession>;
  /** Whether a browser is connected (fast polling only then). */
  browserConnected(): boolean;
  /** Run the read on the session's host through the pooled shell, only when a shell is free. */
  exec(remote: SessionRemote, script: string, timeoutMs: number): Promise<string>;
  /** Feed one hook event through the same handler as `/api/hook-event`. */
  applyEvent(session: SignalsSession, event: RemoteHookEvent): void;
  /** Feed one statusline payload through the same applier as `/api/status-telemetry`. */
  applyStatusline(session: SignalsSession, payload: Record<string, unknown>): void;
  /** The session's files were found: its alerts reach the dashboard. */
  markSeen(session: SignalsSession): void;
  log?(message: string): void;
}

interface SessionCursor {
  key: string;
  offset: number | null;
  statusMtime: number | null;
  seen: boolean;
}

interface HostState {
  running: boolean;
  lastAt: number;
  failures: number;
  retryAt: number;
}

/** Whether an exec failure only means "busy, try next time" (never a backoff). */
function isBusy(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'EBUSY';
}

export class RemoteSessionSignals {
  private readonly cursors = new Map<string, SessionCursor>();
  private readonly hosts = new Map<string, HostState>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly ports: RemoteSignalsPorts) {}

  /** Start the poll loop (one tick per second; each host decides whether it is due). */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  remove(sessionId: string): void {
    this.cursors.delete(sessionId);
  }

  /** One pass: read every host that is due. Resolves when the reads it started are done. */
  async tick(now = Date.now()): Promise<void> {
    if (this.stopped) return;
    const byHost = new Map<string, { remote: SessionRemote; sessions: SignalsSession[] }>();
    const live = new Set<string>();
    for (const session of this.ports.sessions()) {
      if (!session.remote || !remoteSignalsReadable(session)) continue;
      live.add(session.id);
      const hostKey = session.remote.hostId || `${session.remote.username}@${session.remote.host}`;
      let group = byHost.get(hostKey);
      if (!group) byHost.set(hostKey, (group = { remote: session.remote, sessions: [] }));
      group.sessions.push(session);
    }
    for (const id of [...this.cursors.keys()]) if (!live.has(id)) this.cursors.delete(id);
    for (const id of [...this.hosts.keys()]) if (!byHost.has(id)) this.hosts.delete(id);

    const interval = this.ports.browserConnected() ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const reads: Promise<void>[] = [];
    for (const [hostKey, group] of byHost) {
      let state = this.hosts.get(hostKey);
      if (!state) this.hosts.set(hostKey, (state = { running: false, lastAt: 0, failures: 0, retryAt: 0 }));
      if (state.running || now < state.retryAt || now - state.lastAt < interval) continue;
      reads.push(this.readHost(state, group.remote, group.sessions, now));
    }
    await Promise.all(reads);
  }

  private cursorFor(session: SignalsSession): SessionCursor {
    const key = remoteSignalsKeySafe(session);
    let cursor = this.cursors.get(session.id);
    if (!cursor || cursor.key !== key) {
      cursor = { key, offset: null, statusMtime: null, seen: false };
      this.cursors.set(session.id, cursor);
    }
    return cursor;
  }

  private async readHost(
    state: HostState,
    remote: SessionRemote,
    sessions: SignalsSession[],
    now: number
  ): Promise<void> {
    state.running = true;
    state.lastAt = now;
    const cursors = sessions.map((s) => ({ session: s, cursor: this.cursorFor(s) }));
    const script = buildSignalsReadScript(cursors.map(({ cursor }) => cursor));
    try {
      const stdout = await this.ports.exec(remote, script, READ_TIMEOUT_MS);
      if (this.stopped) return;
      state.failures = 0;
      state.retryAt = 0;
      this.applyRead(parseSignalsReadOutput(stdout), cursors);
    } catch (err) {
      if (isBusy(err)) {
        // A user's command holds the shells: try again on the next tick, not a whole interval later.
        state.lastAt = 0;
        return;
      }
      state.failures++;
      state.retryAt = now + Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (state.failures - 1));
      if (state.failures === 1) {
        const message = err instanceof Error ? err.message : String(err);
        this.ports.log?.(`[RemoteSignals] ${remote.label || remote.host}: read failed: ${message}`);
      }
    } finally {
      state.running = false;
    }
  }

  private applyRead(read: SignalsReadResult, cursors: Array<{ session: SignalsSession; cursor: SessionCursor }>): void {
    for (const { session, cursor } of cursors) {
      // A cursor replaced or dropped while the read ran (session closed, key changed) is stale.
      if (this.cursors.get(session.id) !== cursor) continue;
      const events = read.events.get(cursor.key);
      const status = read.status.get(cursor.key);
      if ((events && events.size >= 0) || (status && status.mtime >= 0)) {
        if (!cursor.seen) {
          cursor.seen = true;
          this.ports.markSeen(session);
        }
      }

      if (events) {
        if (events.size < 0) {
          // No file yet: everything it will hold is news.
          cursor.offset = 0;
        } else if (cursor.offset === null) {
          // First read: what is there already happened before we were looking.
          cursor.offset = events.size;
        } else {
          // A file smaller than what was read was replaced: its body starts at 0.
          const base = events.size < cursor.offset ? 0 : cursor.offset;
          const { events: lines, consumed } = parseEventLines(events.body);
          cursor.offset = base + consumed;
          for (const line of selectEventsToApply(lines, read.now)) {
            try {
              this.ports.applyEvent(session, line.event);
            } catch (err) {
              this.ports.log?.(`[RemoteSignals] ${session.id.slice(0, 8)}: ${line.event} failed: ${String(err)}`);
            }
          }
        }
      }

      if (status && status.mtime >= 0) {
        cursor.statusMtime = status.mtime;
        const body = status.body.trim();
        if (body) {
          let payload: unknown;
          try {
            payload = JSON.parse(body);
          } catch {
            payload = null; // Caught mid-write or truncated: the next read has it.
            cursor.statusMtime = null;
          }
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            this.ports.applyStatusline(session, payload as Record<string, unknown>);
          }
        }
      }
    }
  }
}

function remoteSignalsKeySafe(session: SignalsSession): string {
  return remoteSignalsKey(session.remote!, session.id);
}
