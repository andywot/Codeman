/**
 * @fileoverview Agent mail relay (fork): carries `rc-mail` messages between the fleet's machines
 * (the model and the on-machine layout are in agent-mail.ts, the CLI in agent-mail-cli.ts).
 *
 * Per mailbox tree (this server, and one per fleet login) the relay runs ONE pooled-shell command
 * per poll, {@link MAIL_POLL_SCRIPT}, with everything variable on stdin. One poll:
 *
 * 1. removes outbox files drained by the previous poll (`A`, only after the relay saved them),
 * 2. delivers queued messages for that machine (`D`) and updates senders' `sent/<id>` files (`S`),
 * 3. rewrites the directory when it changed (`R`) and installs the CLI and skill when the machine
 *    reports an older version (`I`, marker-owned, add-only),
 * 4. reads back: drained outbox messages, presence lines, per-mailbox counts, delivery receipts.
 *
 * Cadence: like remote-session-signals.ts, every {@link POLL_ACTIVE_MS} with a browser connected,
 * {@link POLL_IDLE_MS} without, sooner while mail waits for a machine, through `remoteExecIfIdle`
 * (a poll never queues behind a user's command). A failing machine backs off up to
 * {@link MAX_BACKOFF_MS}. A remote machine is only polled while something already talks to it (a
 * live session there or an open pooled shell, `hasLink`) or it answered within {@link RECENT_OK_MS}
 * and has not failed since:
 * the relay never wakes a sleeping machine (no Wake-on-LAN, no probing of machines nobody uses).
 * Mail for an unreachable machine waits in the relay's queue (persisted, bounded, {@link
 * MESSAGE_TTL_MS}) and the sender's `rc-mail sent` says `queued`.
 *
 * Two names for one tree (the server is also a fleet machine, same user, same home) are found by the
 * tree's random `.id`: the remote one becomes an alias of the local one and is no longer polled.
 *
 * Wake-up: a message delivered to a dashboard session queues a nudge; when that session is idle (no
 * turn running, no dialog, empty composer, nobody typing) one line goes into its composer via the
 * normal `writeViaMux` path ({@link buildNudgeText}: sender and a cleaned subject, never the body),
 * at most once per {@link NUDGE_MIN_INTERVAL_MS}, batching what arrived meanwhile. Per-session
 * switch, default on. Outside agents are never typed into.
 *
 * `AgentMailRelay` owns scheduling and state; the server lends it IO through ports, so the tests
 * drive it with a fake machine that runs the real script under `sh`.
 *
 * @module web/agent-mail-relay
 */

import { createHash } from 'node:crypto';
import {
  LOCAL_ENDPOINT_ID,
  MAIL_POLL_SCRIPT,
  MAX_DELIVER_BYTES,
  buildDirectory,
  buildNudgeText,
  buildPollInput,
  decideNudge,
  directoryJson,
  directoryTsv,
  loginOf,
  parseAddress,
  parseOutboxMessage,
  parsePollOutput,
  parsePresence,
  renderMessageText,
  renderSentStatus,
  MESSAGE_ID_RE,
  type AgentSource,
  type MailAgent,
  type MailEndpoint,
  type MailMessage,
  type PendingNudge,
  type PollInput,
  type PollOutput,
  type SentState,
} from '../agent-mail.js';
import {
  RC_MAIL_CLI,
  RC_MAIL_CLI_VERSION,
  RC_MAIL_SKILL,
  RC_MAIL_SKILL_VERSION,
  RC_MAIL_WINDOWS_CMD,
  RC_MAIL_WINDOWS_SHIM,
  RC_MAIL_WINDOWS_SKILL,
  RC_MAIL_WINDOWS_VERSION,
} from '../agent-mail-cli.js';
import type { SessionRemote } from '../types/index.js';

export const POLL_ACTIVE_MS = 4_000;
export const POLL_IDLE_MS = 30_000;
/** Floor between two polls of one machine while it has mail or receipts waiting. */
export const POLL_URGENT_MS = 1_500;
export const FIRST_BACKOFF_MS = 15_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
/** A machine that answered this recently is polled even without an open link. */
export const RECENT_OK_MS = 30 * 60_000;
/** Outside agents are looked up (claude-discovery) this often per machine. */
export const DISCOVERY_INTERVAL_MS = 10 * 60_000;
export const MESSAGE_TTL_MS = 7 * 24 * 3600_000;
export const MAX_QUEUE = 500;
export const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_LOG = 100;
const MAX_SEEN = 5_000;
const MAX_STATUS_PER_ENDPOINT = 500;
const POLL_TIMEOUT_MS = 20_000;

export interface MailSessionView {
  readonly id: string;
  readonly name: string;
  readonly workingDir: string;
  readonly remote?: SessionRemote;
  readonly docker?: unknown;
}

export interface NudgeView {
  /** Live pane, no turn running, no dialog open. */
  idle: boolean;
  composerEmpty: boolean | null;
  lastHumanInputAt: number;
}

export interface AgentMailPorts {
  /** The app setting `agentMailEnabled` (read fresh each tick). */
  enabled(): boolean;
  endpoints(): MailEndpoint[];
  sessions(): Iterable<MailSessionView>;
  /** The remote file key a session's pane exports as `$CLAUDE_RC_SESSION`, when it does. */
  sessionKey(session: MailSessionView): string | undefined;
  browserConnected(): boolean;
  /** Something already talks to this machine (a live session there, an open pooled shell). */
  hasLink(endpoint: MailEndpoint): boolean;
  /** Run the poll; rejects with `code: 'EBUSY'` when the machine's shells are busy. */
  exec(endpoint: MailEndpoint, script: string, input: string, timeoutMs: number): Promise<string>;
  /** Claude processes the dashboard does not show on that machine (folder, title). Optional. */
  discover?(endpoint: MailEndpoint): Promise<Array<{ cwd: string; title?: string }> | null>;
  /** The facts a nudge needs; null when the session is gone. */
  nudgeView(sessionId: string): NudgeView | null;
  nudge(sessionId: string, text: string): Promise<boolean>;
  load(): Promise<unknown>;
  save(snapshot: AgentMailSnapshot): Promise<void>;
  log?(message: string): void;
}

interface QueuedMail {
  message: MailMessage;
  /** Endpoint id the message was drained from (its `sent/` file lives there). */
  fromEndpoint: string;
  receivedAt: number;
}

export interface MailLogEntry {
  id: string;
  from: string;
  to: string;
  subject: string;
  state: SentState | 'received';
  detail?: string;
  at: number;
}

export interface AgentMailSnapshot {
  v: 1;
  queue: QueuedMail[];
  statuses: Record<string, Record<string, string>>;
  acks: Record<string, string[]>;
  seen: Array<[string, number]>;
  log: MailLogEntry[];
  nudgeOff: string[];
}

interface EndpointState {
  running: boolean;
  lastAt: number;
  lastOkAt: number;
  failures: number;
  retryAt: number;
  error: string | null;
  treeId: string | null;
  cliVersion: number | null;
  skillVersion: number | null;
  /** The Windows side's state: installed at our version, `none` (no profile), or not yet. */
  windows: 'ok' | 'none' | null;
  writtenDirHash: string | null;
  counts: Map<string, { pending: number; unseen: number }>;
  presence: Array<{ name: string; cwd: string; at: number }>;
  discovered: Array<{ cwd: string; title?: string }>;
  discoveryAt: number;
  discovering: boolean;
}

/** What the UI is shown: names, states and counts. */
export interface AgentMailStatus {
  enabled: boolean;
  machines: Array<{
    machine: string;
    endpoint: string;
    state: 'ok' | 'failing' | 'idle';
    lastOkAt: number | null;
    error: string | null;
    installed: boolean;
    /** The Windows side of a WSL machine (absent: no Windows system there). */
    windows?: 'installed' | 'unavailable' | 'pending';
    aliasOf?: string;
  }>;
  agents: Array<MailAgent & { pending: number; unseen: number; nudge: boolean | null }>;
  queued: number;
  recent: MailLogEntry[];
}

function isBusy(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'EBUSY';
}

export class AgentMailRelay {
  private readonly states = new Map<string, EndpointState>();
  private queue: QueuedMail[] = [];
  private statuses = new Map<string, Map<string, string>>();
  private acks = new Map<string, Set<string>>();
  private seen = new Map<string, number>();
  private log: MailLogEntry[] = [];
  private nudgeOff = new Set<string>();
  private readonly pendingNudges = new Map<string, PendingNudge>();
  private readonly lastNudgeAt = new Map<string, number>();
  /** Message ids behind each pending nudge. */
  private readonly pendingIds = new Map<string, Set<string>>();
  /** Message ids already nudged (or given up on) in this server run: never nudged twice. */
  private readonly nudgedIds = new Set<string>();
  /** Remote endpoint id → the endpoint whose tree it shares (`local`). */
  private readonly aliases = new Map<string, string>();
  private directory: MailAgent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private loaded = false;
  private ticking = false;
  private dirty = false;

  constructor(private readonly ports: AgentMailPorts) {}

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

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.restore(await this.ports.load());
    } catch (err) {
      this.ports.log?.(`[AgentMail] could not read saved state: ${String(err)}`);
    }
  }

  setNudge(sessionId: string, enabled: boolean): void {
    if (enabled) this.nudgeOff.delete(sessionId);
    else {
      this.nudgeOff.add(sessionId);
      this.pendingNudges.delete(sessionId);
      this.pendingIds.delete(sessionId);
    }
    this.dirty = true;
    void this.persist();
  }

  nudgeEnabled(sessionId: string): boolean {
    return !this.nudgeOff.has(sessionId);
  }

  /** Session deleted: forget its switch and any pending nudge. */
  remove(sessionId: string): void {
    this.pendingNudges.delete(sessionId);
    this.pendingIds.delete(sessionId);
    this.lastNudgeAt.delete(sessionId);
    if (this.nudgeOff.delete(sessionId)) {
      this.dirty = true;
      void this.persist();
    }
  }

  // ── The tick ──────────────────────────────────────────────────────────────

  async tick(now = Date.now()): Promise<void> {
    if (this.stopped || this.ticking) return;
    if (!this.ports.enabled()) return;
    this.ticking = true;
    try {
      await this.load();
      const endpoints = this.ports.endpoints();
      for (const id of [...this.states.keys()]) if (!endpoints.some((e) => e.id === id)) this.states.delete(id);
      for (const id of [...this.aliases.keys()]) if (!endpoints.some((e) => e.id === id)) this.aliases.delete(id);
      this.expire(now);
      this.directory = this.buildDirectory(endpoints);
      const machines = this.activeEndpoints(endpoints).map((e) => this.machineOf(e, endpoints));
      const tsv = directoryTsv(machines, this.directory);
      const json = directoryJson(machines, this.directory);
      const dirHash = createHash('sha256').update(tsv).digest('hex');

      const interval = this.ports.browserConnected() ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      const polls: Promise<void>[] = [];
      for (const ep of this.activeEndpoints(endpoints)) {
        const st = this.stateOf(ep.id);
        if (st.running || now < st.retryAt) continue;
        // Without a link, only a machine that answered recently and has not failed since: one that
        // went quiet is left alone until something else (a session, the machine poll) reaches it.
        if (!ep.local && !this.ports.hasLink(ep) && (st.failures > 0 || now - st.lastOkAt > RECENT_OK_MS)) continue;
        const urgent = this.hasWork(ep, endpoints, dirHash);
        if (now - st.lastAt < (urgent ? POLL_URGENT_MS : interval)) continue;
        polls.push(this.poll(ep, endpoints, { tsv, json, hash: dirHash }, now));
        this.maybeDiscover(ep, now);
      }
      await Promise.all(polls);
      await this.runNudges(endpoints, now);
      if (this.dirty) await this.persist();
    } finally {
      this.ticking = false;
    }
  }

  private stateOf(id: string): EndpointState {
    let st = this.states.get(id);
    if (!st) {
      st = {
        running: false,
        lastAt: 0,
        lastOkAt: 0,
        failures: 0,
        retryAt: 0,
        error: null,
        treeId: null,
        cliVersion: null,
        skillVersion: null,
        windows: null,
        writtenDirHash: null,
        counts: new Map(),
        presence: [],
        discovered: [],
        discoveryAt: 0,
        discovering: false,
      };
      this.states.set(id, st);
    }
    return st;
  }

  private activeEndpoints(endpoints: readonly MailEndpoint[]): MailEndpoint[] {
    return endpoints.filter((e) => !this.aliases.has(e.id));
  }

  /** A machine's address name: the local tree takes the name of the fleet machine it turned out to be. */
  private machineOf(ep: MailEndpoint, endpoints: readonly MailEndpoint[]): string {
    if (ep.local) {
      for (const [remoteId, target] of this.aliases) {
        if (target !== ep.id) continue;
        const remote = endpoints.find((e) => e.id === remoteId);
        if (remote) return remote.machine;
      }
    }
    return ep.machine;
  }

  private endpointForMachine(machine: string, endpoints: readonly MailEndpoint[]): MailEndpoint | undefined {
    return this.activeEndpoints(endpoints).find((e) => this.machineOf(e, endpoints) === machine);
  }

  private resolveEndpoint(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  private endpointOfSession(s: MailSessionView, endpoints: readonly MailEndpoint[]): MailEndpoint | undefined {
    if (s.docker) return undefined;
    let ep: MailEndpoint | undefined;
    if (!s.remote) ep = endpoints.find((e) => e.local);
    else {
      const remote = s.remote;
      ep =
        endpoints.find((e) => !e.local && e.hostIds.includes(remote.hostId)) ??
        endpoints.find((e) => !e.local && e.id === loginOf(remote));
    }
    if (!ep) return undefined;
    const target = this.resolveEndpoint(ep.id);
    return endpoints.find((e) => e.id === target);
  }

  private buildDirectory(endpoints: readonly MailEndpoint[]): MailAgent[] {
    const sources: AgentSource[] = [];
    for (const s of this.ports.sessions()) {
      const ep = this.endpointOfSession(s, endpoints);
      if (!ep) continue;
      const key = s.remote ? this.ports.sessionKey(s) : undefined;
      // A native Windows session is told by its key when its launch carried it into Windows (via
      // WSLENV, tmux-manager.ts), and keeps the folder as a fallback: one launched before that, or
      // whose claude does not pass it on, still finds its address by folder.
      const exclusiveKey = !!key && s.remote?.system !== 'windows';
      sources.push({
        machine: this.machineOf(ep, endpoints),
        kind: 'dashboard',
        name: s.name,
        sid: s.id,
        ...(key ? { key } : {}),
        ...(s.remote ? (exclusiveKey ? { ident: 'key' as const } : {}) : { ident: 'sid' as const }),
        cwd: s.remote ? s.remote.remotePath : s.workingDir,
        title: s.name,
      });
    }
    for (const ep of this.activeEndpoints(endpoints)) {
      const st = this.states.get(ep.id);
      if (!st) continue;
      const machine = this.machineOf(ep, endpoints);
      for (const d of st.discovered) sources.push({ machine, kind: 'outside', cwd: d.cwd, title: d.title });
      for (const p of st.presence) sources.push({ machine, kind: 'outside', name: p.name, cwd: p.cwd });
    }
    return buildDirectory(sources);
  }

  private hasWork(ep: MailEndpoint, endpoints: readonly MailEndpoint[], dirHash: string): boolean {
    const machine = this.machineOf(ep, endpoints);
    if ((this.acks.get(ep.id)?.size ?? 0) > 0 || (this.statuses.get(ep.id)?.size ?? 0) > 0) return true;
    if (this.queue.some((q) => parseAddress(q.message.to)?.machine === machine)) return true;
    const st = this.states.get(ep.id);
    return !!st && st.lastOkAt > 0 && st.writtenDirHash !== dirHash;
  }

  private maybeDiscover(ep: MailEndpoint, now: number): void {
    const discover = this.ports.discover;
    if (!discover) return;
    const st = this.stateOf(ep.id);
    if (st.discovering || st.lastOkAt === 0 || now - st.discoveryAt < DISCOVERY_INTERVAL_MS) return;
    st.discovering = true;
    st.discoveryAt = now;
    discover(ep)
      .then((found) => {
        if (found) st.discovered = found.filter((f) => f.cwd.startsWith('/')).slice(0, 200);
      })
      .catch(() => {})
      .finally(() => {
        st.discovering = false;
      });
  }

  // ── One poll ──────────────────────────────────────────────────────────────

  private async poll(
    ep: MailEndpoint,
    endpoints: readonly MailEndpoint[],
    dir: { tsv: string; json: string; hash: string },
    now: number
  ): Promise<void> {
    const st = this.stateOf(ep.id);
    st.running = true;
    st.lastAt = now;
    const machine = this.machineOf(ep, endpoints);
    const items: PollInput[] = [];
    const ackFiles = [...(this.acks.get(ep.id) ?? [])];
    for (const file of ackFiles) items.push({ kind: 'ack', file });
    const statusIds = [...(this.statuses.get(ep.id)?.entries() ?? [])];
    for (const [id, text] of statusIds) items.push({ kind: 'status', id, text });
    const dirSent = st.writtenDirHash !== dir.hash;
    if (dirSent) items.push({ kind: 'directory', tsv: dir.tsv, json: dir.json, self: machine });
    const install = st.cliVersion !== RC_MAIL_CLI_VERSION || st.skillVersion !== RC_MAIL_SKILL_VERSION;
    if (install) items.push({ kind: 'install', cli: RC_MAIL_CLI, skill: RC_MAIL_SKILL });
    // Native Windows claude on the same machine: after the first answer says the Windows side is
    // missing or older, at most once per server run (whatever came of it stands until a restart).
    const winInstall = !!ep.windows && st.windows === null && st.lastOkAt > 0;
    if (winInstall) {
      items.push({
        kind: 'windows',
        skill: RC_MAIL_WINDOWS_SKILL,
        cmd: RC_MAIL_WINDOWS_CMD,
        shim: RC_MAIL_WINDOWS_SHIM,
      });
    }
    let budget = MAX_DELIVER_BYTES;
    for (const q of this.queue) {
      const to = parseAddress(q.message.to);
      if (!to || to.machine !== machine) continue;
      const json = JSON.stringify(q.message) + '\n';
      const text = renderMessageText(q.message);
      const size = Buffer.byteLength(json) + Buffer.byteLength(text);
      if (size > budget && budget < MAX_DELIVER_BYTES) break;
      budget -= size;
      items.push({ kind: 'deliver', mailbox: to.mailbox, id: q.message.id, json, text });
    }

    let out: PollOutput;
    try {
      out = parsePollOutput(await this.ports.exec(ep, MAIL_POLL_SCRIPT, buildPollInput(items), POLL_TIMEOUT_MS));
    } catch (err) {
      if (isBusy(err)) st.lastAt = 0;
      else {
        st.failures++;
        st.retryAt = now + Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (st.failures - 1));
        st.error = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);
        if (st.failures === 1) this.ports.log?.(`[AgentMail] ${machine}: poll failed: ${st.error}`);
      }
      st.running = false;
      return;
    }
    st.running = false;
    st.failures = 0;
    st.retryAt = 0;
    st.error = null;
    st.lastOkAt = now;
    if (out.cliVersion) st.cliVersion = out.cliVersion;
    if (out.skillVersion) st.skillVersion = out.skillVersion;
    if (install && (!out.cliVersion || !out.skillVersion)) {
      // The user owns the file (marker removed): do not try again every poll.
      st.cliVersion = RC_MAIL_CLI_VERSION;
      st.skillVersion = RC_MAIL_SKILL_VERSION;
    }
    if (ep.windows) {
      const w = out.windows;
      const current =
        w !== null &&
        w !== 'none' &&
        w.cmd === RC_MAIL_WINDOWS_VERSION &&
        w.shim === RC_MAIL_WINDOWS_VERSION &&
        w.skill === RC_MAIL_WINDOWS_VERSION;
      // A user's own file (marker removed), a symlinked folder or missing interop is not retried
      // every poll: one attempt per run.
      if (winInstall) st.windows = w === 'none' ? 'none' : 'ok';
      else if (current) st.windows = 'ok';
    }
    if (dirSent) st.writtenDirHash = dir.hash;
    // Rewritten behind our back (another server on the machine): write it again on the next poll.
    if (out.directory && (out.directory.bytes !== Buffer.byteLength(dir.tsv) || out.directory.self !== machine)) {
      st.writtenDirHash = null;
    }
    st.counts = out.counts;
    st.presence = parsePresence(out.presence, out.now);
    st.treeId = out.treeId;
    this.noteAlias(ep, endpoints);

    // What the machine applied.
    const acked = this.acks.get(ep.id);
    for (const f of ackFiles) acked?.delete(f);
    const statusMap = this.statuses.get(ep.id);
    for (const [id, text] of statusIds) if (statusMap?.get(id) === text) statusMap.delete(id);
    if (ackFiles.length || statusIds.length) this.dirty = true;

    for (const id of out.delivered) this.onDelivered(id, ep, endpoints, now);
    this.deriveNudges(ep, endpoints, out.unseenIds, now);
    for (const r of out.rejected) {
      const id = r.file.slice(0, -5);
      this.setStatus(ep.id, id, renderSentStatus({ to: '?', subject: '?' }, 'rejected', new Date(), r.reason));
      this.addLog({ id, from: `${machine}/?`, to: '?', subject: '', state: 'rejected', detail: r.reason, at: now });
    }
    for (const o of out.outbox) this.onDrained(ep, machine, o.file, o.bytes, endpoints, now);
  }

  private noteAlias(ep: MailEndpoint, endpoints: readonly MailEndpoint[]): void {
    if (ep.local) return;
    const local = endpoints.find((e) => e.local);
    const localTree = local ? this.states.get(local.id)?.treeId : null;
    const st = this.states.get(ep.id);
    if (local && localTree && st?.treeId === localTree && !this.aliases.has(ep.id)) {
      this.aliases.set(ep.id, local.id);
      this.ports.log?.(`[AgentMail] ${ep.machine} is this server's own mailbox; reading it locally`);
    }
  }

  private onDelivered(id: string, ep: MailEndpoint, endpoints: readonly MailEndpoint[], now: number): void {
    const index = this.queue.findIndex((q) => q.message.id === id);
    if (index < 0) return;
    const [q] = this.queue.splice(index, 1);
    this.dirty = true;
    this.setStatus(q.fromEndpoint, id, renderSentStatus(q.message, 'delivered', new Date(now)));
    this.addLog({ ...this.logBase(q.message), state: 'delivered', at: now });
    // Wake the recipient if it is a dashboard session.
    const to = parseAddress(q.message.to);
    const machine = this.machineOf(ep, endpoints);
    const agent = this.directory.find(
      (a) => a.machine === machine && a.mailbox === to?.mailbox && a.kind === 'dashboard' && a.sid
    );
    if (agent?.sid && !this.nudgeOff.has(agent.sid)) {
      this.noteId(agent.sid, id);
      const prev = this.pendingNudges.get(agent.sid);
      this.pendingNudges.set(agent.sid, {
        count: (prev?.count ?? 0) + 1,
        from: q.message.from,
        subject: q.message.subject,
        since: prev?.since ?? now,
      });
    }
  }

  private noteId(sid: string, id: string): void {
    const ids = this.pendingIds.get(sid) ?? new Set<string>();
    ids.add(id);
    this.pendingIds.set(sid, ids);
  }

  /**
   * Durable-state nudges: unseen mail in a dashboard session's inbox that no nudge in this server
   * run has covered (the "just delivered" event is lost by a restart) queues one, naming the newest
   * unseen message. The usual gates in {@link runNudges} still apply; read mail never appears here.
   */
  private deriveNudges(
    ep: MailEndpoint,
    endpoints: readonly MailEndpoint[],
    unseenIds: ReadonlyMap<string, string[]>,
    now: number
  ): void {
    const machine = this.machineOf(ep, endpoints);
    for (const [mailbox, ids] of unseenIds) {
      const agent = this.directory.find(
        (a) => a.machine === machine && a.mailbox === mailbox && a.kind === 'dashboard' && a.sid
      );
      const sid = agent?.sid;
      if (!sid || this.nudgeOff.has(sid)) continue;
      const known = this.pendingIds.get(sid);
      const fresh = ids.filter((id) => !this.nudgedIds.has(id) && !known?.has(id));
      if (!fresh.length) continue;
      for (const id of fresh) this.noteId(sid, id);
      const newest = this.log.find((e) => e.id === fresh[fresh.length - 1]);
      const prev = this.pendingNudges.get(sid);
      this.pendingNudges.set(sid, {
        count: (prev?.count ?? 0) + fresh.length,
        from: newest?.from ?? prev?.from ?? 'another agent',
        subject: newest?.subject ?? prev?.subject ?? 'see inbox',
        since: prev?.since ?? now,
      });
    }
  }

  private markNudged(sid: string): void {
    for (const id of this.pendingIds.get(sid) ?? []) this.nudgedIds.add(id);
    this.pendingIds.delete(sid);
    if (this.nudgedIds.size > 5000) {
      let drop = this.nudgedIds.size - 4000;
      for (const id of this.nudgedIds) {
        if (drop-- <= 0) break;
        this.nudgedIds.delete(id);
      }
    }
  }

  private onDrained(
    ep: MailEndpoint,
    machine: string,
    file: string,
    bytes: Buffer,
    endpoints: readonly MailEndpoint[],
    now: number
  ): void {
    // Removed from the machine on the next poll, after the state below is saved.
    this.addAck(ep.id, file);
    const id = file.slice(0, -5);
    if (this.seen.has(id)) return;
    this.seen.set(id, now);
    const parsed = parseOutboxMessage(file, bytes, machine);
    if (!parsed.ok) {
      if (parsed.id) {
        const detail = parsed.reason;
        this.setStatus(
          ep.id,
          parsed.id,
          renderSentStatus({ to: parsed.to ?? '?', subject: '?' }, 'rejected', new Date(now), detail)
        );
      }
      this.addLog({
        id,
        from: `${machine}/?`,
        to: parsed.to ?? '?',
        subject: '',
        state: 'rejected',
        detail: parsed.reason,
        at: now,
      });
      return;
    }
    const m = parsed.message;
    const to = parseAddress(m.to)!;
    const target = this.endpointForMachine(to.machine, endpoints);
    const reject = (detail: string) => {
      this.setStatus(ep.id, m.id, renderSentStatus(m, 'rejected', new Date(now), detail));
      this.addLog({ ...this.logBase(m), state: 'rejected', detail, at: now });
    };
    if (!target) return reject(`no machine named ${to.machine}`);
    const bytesQueued = this.queue.reduce((n, q) => n + q.message.body.length + q.message.subject.length, 0);
    if (this.queue.length >= MAX_QUEUE || bytesQueued + m.body.length > MAX_QUEUE_BYTES) {
      return reject('the relay queue is full; try again later');
    }
    this.queue.push({ message: m, fromEndpoint: ep.id, receivedAt: now });
    this.setStatus(
      ep.id,
      m.id,
      renderSentStatus(m, 'queued', new Date(now), target.id === ep.id ? undefined : `for ${to.machine}`)
    );
    this.addLog({ ...this.logBase(m), state: 'queued', at: now });
  }

  private logBase(m: MailMessage): Pick<MailLogEntry, 'id' | 'from' | 'to' | 'subject'> {
    return { id: m.id, from: m.from, to: m.to, subject: m.subject };
  }

  private addLog(entry: MailLogEntry): void {
    const existing = this.log.findIndex((e) => e.id === entry.id);
    if (existing >= 0) this.log.splice(existing, 1);
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.dirty = true;
  }

  private addAck(endpointId: string, file: string): void {
    let set = this.acks.get(endpointId);
    if (!set) this.acks.set(endpointId, (set = new Set()));
    set.add(file);
    this.dirty = true;
  }

  private setStatus(endpointId: string, id: string, text: string): void {
    if (!MESSAGE_ID_RE.test(id)) return;
    let map = this.statuses.get(endpointId);
    if (!map) this.statuses.set(endpointId, (map = new Map()));
    map.delete(id);
    map.set(id, text);
    while (map.size > MAX_STATUS_PER_ENDPOINT) map.delete(map.keys().next().value as string);
    this.dirty = true;
  }

  private expire(now: number): void {
    const keep: QueuedMail[] = [];
    for (const q of this.queue) {
      if (now - q.receivedAt <= MESSAGE_TTL_MS) {
        keep.push(q);
        continue;
      }
      this.setStatus(
        q.fromEndpoint,
        q.message.id,
        renderSentStatus(q.message, 'expired', new Date(now), 'never reachable')
      );
      this.addLog({ ...this.logBase(q.message), state: 'expired', at: now });
    }
    if (keep.length !== this.queue.length) {
      this.queue = keep;
      this.dirty = true;
    }
    for (const [id, at] of this.seen) if (now - at > MESSAGE_TTL_MS) this.seen.delete(id);
    while (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value as string);
  }

  // ── Nudges ────────────────────────────────────────────────────────────────

  private async runNudges(endpoints: readonly MailEndpoint[], now: number): Promise<void> {
    for (const [sid, pending] of [...this.pendingNudges]) {
      const agent = this.directory.find((a) => a.sid === sid);
      const view = agent ? this.ports.nudgeView(sid) : null;
      if (!agent || !view) {
        this.pendingNudges.delete(sid);
        this.pendingIds.delete(sid);
        continue;
      }
      const ep = this.endpointForMachine(agent.machine, endpoints);
      const counts = ep ? this.states.get(ep.id)?.counts.get(agent.mailbox) : undefined;
      const decision = decideNudge({
        now,
        pending,
        enabled: !this.nudgeOff.has(sid),
        lastNudgeAt: this.lastNudgeAt.get(sid) ?? 0,
        unseen: counts ? counts.unseen : null,
        idle: view.idle,
        composerEmpty: view.composerEmpty,
        lastHumanInputAt: view.lastHumanInputAt,
      });
      if (decision === 'drop') {
        this.pendingNudges.delete(sid);
        this.markNudged(sid);
      }
      if (decision !== 'nudge') continue;
      this.pendingNudges.delete(sid);
      this.markNudged(sid);
      this.lastNudgeAt.set(sid, now);
      const ok = await this.ports.nudge(sid, buildNudgeText(pending)).catch(() => false);
      this.ports.log?.(`[AgentMail] ${ok ? 'nudged' : 'could not nudge'} ${sid.slice(0, 8)} (${pending.count} new)`);
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  snapshot(): AgentMailSnapshot {
    return {
      v: 1,
      queue: this.queue,
      statuses: Object.fromEntries([...this.statuses].map(([ep, m]) => [ep, Object.fromEntries(m)])),
      acks: Object.fromEntries([...this.acks].map(([ep, s]) => [ep, [...s]])),
      seen: [...this.seen],
      log: this.log,
      nudgeOff: [...this.nudgeOff],
    };
  }

  private restore(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const s = raw as Partial<AgentMailSnapshot>;
    if (s.v !== 1) return;
    if (Array.isArray(s.queue)) {
      this.queue = s.queue
        .filter(
          (q) =>
            q &&
            typeof q.fromEndpoint === 'string' &&
            typeof q.receivedAt === 'number' &&
            q.message &&
            MESSAGE_ID_RE.test(q.message.id) &&
            parseAddress(q.message.to) &&
            typeof q.message.body === 'string' &&
            typeof q.message.subject === 'string' &&
            typeof q.message.from === 'string' &&
            typeof q.message.sentAt === 'string'
        )
        .slice(-MAX_QUEUE);
    }
    if (s.statuses && typeof s.statuses === 'object') {
      for (const [ep, m] of Object.entries(s.statuses)) {
        if (!m || typeof m !== 'object') continue;
        const map = new Map<string, string>();
        for (const [id, text] of Object.entries(m))
          if (MESSAGE_ID_RE.test(id) && typeof text === 'string') map.set(id, text);
        if (map.size) this.statuses.set(ep, map);
      }
    }
    if (s.acks && typeof s.acks === 'object') {
      for (const [ep, files] of Object.entries(s.acks)) {
        if (Array.isArray(files)) this.acks.set(ep, new Set(files.filter((f) => typeof f === 'string')));
      }
    }
    if (Array.isArray(s.seen)) {
      for (const e of s.seen)
        if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number') this.seen.set(e[0], e[1]);
    }
    if (Array.isArray(s.log)) this.log = s.log.filter((e) => e && typeof e.id === 'string').slice(-MAX_LOG);
    if (Array.isArray(s.nudgeOff)) this.nudgeOff = new Set(s.nudgeOff.filter((x) => typeof x === 'string'));
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.ports.save(this.snapshot());
    } catch (err) {
      this.dirty = true;
      this.ports.log?.(`[AgentMail] could not save state: ${String(err)}`);
    }
  }

  // ── For the UI ────────────────────────────────────────────────────────────

  status(): AgentMailStatus {
    const endpoints = this.ports.endpoints();
    const enabled = this.ports.enabled();
    return {
      enabled,
      machines: endpoints.map((ep) => {
        const st = this.states.get(ep.id);
        const alias = this.aliases.get(ep.id);
        return {
          machine: this.machineOf(ep, endpoints),
          endpoint: ep.local ? 'this server' : ep.id,
          state: !st || st.lastOkAt === 0 ? 'idle' : st.failures > 0 ? 'failing' : 'ok',
          lastOkAt: st?.lastOkAt || null,
          error: st?.error ?? null,
          installed: !!st?.cliVersion,
          ...(ep.windows
            ? { windows: st?.windows === 'ok' ? 'installed' : st?.windows === 'none' ? 'unavailable' : 'pending' }
            : {}),
          ...(alias ? { aliasOf: 'this server' } : {}),
        };
      }),
      agents: this.directory.map((a) => {
        const ep = this.endpointForMachine(a.machine, endpoints);
        const c = ep ? this.states.get(ep.id)?.counts.get(a.mailbox) : undefined;
        return {
          ...a,
          pending: c?.pending ?? 0,
          unseen: c?.unseen ?? 0,
          nudge: a.sid ? !this.nudgeOff.has(a.sid) : null,
        };
      }),
      queued: this.queue.length,
      recent: [...this.log].reverse().slice(0, 50),
    };
  }
}

export { LOCAL_ENDPOINT_ID };
