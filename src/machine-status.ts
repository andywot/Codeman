/**
 * @fileoverview Machine state and load for the remote fleet (fork).
 *
 * Answers, per machine: is it online, asleep or offline, what to do about it in one
 * line, and its CPU and memory use. `GET /api/fleet/status` (fleet-routes.ts) serves
 * it; the browser asks about once a minute while a page is open, so nothing here runs
 * when no one is looking, and answers are cached ({@link STATUS_MIN_INTERVAL_MS}).
 *
 * The rules that keep the poll gentle:
 * - A sleeping machine is never woken by it: no Wake-on-LAN, and no ssh unless the ssh
 *   port answers a short bare TCP probe first ({@link TCP_PROBE_TIMEOUT_MS}).
 * - It never delays other work: commands go through `remoteExecIfIdle`, which runs only
 *   on an idle pooled shell (or a new one under the host's cap) and otherwise skips.
 * - A host whose key was refused is not retried for {@link AUTH_RETRY_MS}.
 * - tmux and claude are looked up every {@link TOOLS_CHECK_MS}, not every poll.
 *
 * CPU and memory come from one command on the pooled shell: the `cpu` line of
 * /proc/stat (the percentage is the delta between two polls; the first poll takes a
 * second sample 0.3 s later) and MemTotal/MemAvailable from /proc/meminfo. Linux and
 * WSL only: a host without /proc (Windows-native) reports nothing. Systems of one
 * machine (the desktop's WSL and Windows entries) share the hardware, so the figures
 * are read once per machine.
 *
 * Classification and parsing are pure and exported for test/machine-status.test.ts.
 */

import net from 'node:net';
import type { RemoteHost } from './types.js';
import { isProbeable, resolveWakeTarget, DEFAULT_SSH_PORT } from './remote-wake.js';
import { remoteExecIfIdle, remoteShellStatus, RemoteExecError, type RemoteShellStatus } from './remote-shell-pool.js';

export const STATUS_MIN_INTERVAL_MS = 45_000;
/** A forced refresh (after Wake) still waits this long since the last read. */
export const STATUS_FORCE_MIN_INTERVAL_MS = 8_000;
export const TCP_PROBE_TIMEOUT_MS = 1_500;
export const SSH_CHECK_TIMEOUT_MS = 10_000;
export const AUTH_RETRY_MS = 5 * 60_000;
export const TOOLS_CHECK_MS = 10 * 60_000;
/**
 * A machine with Wake-on-LAN that last gave no answer is probed again only this often
 * (unless the user asks): a NIC set to wake on directed packets would otherwise be
 * woken, or kept awake, by the poll itself.
 */
export const ASLEEP_REPROBE_MS = 10 * 60_000;

export type TcpOutcome = 'open' | 'refused' | 'timeout' | 'unreachable' | 'dns' | 'error';
export type MachineState = 'online' | 'asleep' | 'offline';
export type MachineReason =
  | 'connected'
  | 'tools-missing'
  | 'auth'
  | 'host-key'
  | 'ssh-error'
  | 'busy'
  | 'no-sshd'
  | 'no-reply'
  | 'dns'
  | 'unknown';

export interface MachineVerdict {
  state: MachineState;
  reason: MachineReason;
  /** One line saying what to do; empty when nothing needs doing. */
  hint: string;
  /** True for every online reason except `connected`: on, but not usable as is. */
  issue: boolean;
}

export interface CpuSample {
  idle: number;
  total: number;
}

export interface MachineLoad {
  cpu: number | null;
  memPercent: number;
  memUsedMB: number;
  memTotalMB: number;
}

export interface SystemStatus extends MachineVerdict {
  hostId: string;
  label: string;
  system: RemoteHost['system'] | null;
  tmux: boolean | null;
  claude: boolean | null;
}

export interface MachineStatus extends MachineVerdict {
  name: string;
  host: string;
  port: number;
  /** A Wake-on-LAN MAC or wake command is configured; the hostId to wake through. */
  wakeHostId: string | null;
  load: MachineLoad | null;
  systems: SystemStatus[];
  checkedAt: number;
}

// ── Pure: classification ──

/** A Node socket error code as a probe outcome. */
export function classifyTcpError(code: string | undefined): TcpOutcome {
  switch (code) {
    case 'ECONNREFUSED':
      return 'refused';
    case 'ETIMEDOUT':
    case 'TIMEOUT':
      return 'timeout';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return 'unreachable';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns';
    default:
      return 'error';
  }
}

/** Why an ssh login failed, from ssh's own last words. */
export function classifySshFailure(stderr: string): 'auth' | 'host-key' | 'ssh-error' {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return 'host-key';
  if (/Permission denied|Too many authentication failures|no supported authentication methods/i.test(stderr)) {
    return 'auth';
  }
  return 'ssh-error';
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  ).slice(0, 160);
}

/** State and hint for a host whose ssh port did not answer (or answered with a refusal). */
export function classifyUnreachable(
  tcp: TcpOutcome,
  opts: { port: number; host: string; canWake: boolean }
): MachineVerdict {
  if (tcp === 'refused') {
    return {
      state: 'offline',
      reason: 'no-sshd',
      hint: `Up, but nothing listens on port ${opts.port}: start sshd`,
      issue: false,
    };
  }
  if (tcp === 'dns') {
    return { state: 'offline', reason: 'dns', hint: `Cannot resolve ${opts.host}`, issue: false };
  }
  if (opts.canWake) {
    return { state: 'asleep', reason: 'no-reply', hint: 'Asleep or off: Wake sends a magic packet', issue: false };
  }
  return {
    state: 'offline',
    reason: 'no-reply',
    hint: `No answer on port ${opts.port}: off, asleep or firewalled (no Wake-on-LAN set)`,
    issue: false,
  };
}

/** State and hint after an ssh attempt over a port that answered. */
export function classifySsh(input: {
  ok: boolean;
  stderr?: string;
  timedOut?: boolean;
  busy?: boolean;
  tmux?: boolean | null;
  claude?: boolean | null;
  username: string;
}): MachineVerdict {
  if (input.busy) return { state: 'online', reason: 'busy', hint: '', issue: false };
  if (!input.ok) {
    if (input.timedOut) {
      return { state: 'online', reason: 'ssh-error', hint: 'ssh login is slow or stuck: try Test', issue: true };
    }
    const kind = classifySshFailure(input.stderr ?? '');
    if (kind === 'auth') {
      return {
        state: 'online',
        reason: 'auth',
        hint: `Key refused: add the dashboard key to ~/.ssh/authorized_keys; check AllowUsers ${input.username}`,
        issue: true,
      };
    }
    if (kind === 'host-key') {
      return {
        state: 'online',
        reason: 'host-key',
        hint: 'Host key changed: if expected, ssh-keygen -R the host on the dashboard',
        issue: true,
      };
    }
    const detail = lastLine(input.stderr ?? '');
    return { state: 'online', reason: 'ssh-error', hint: `ssh failed${detail ? `: ${detail}` : ''}`, issue: true };
  }
  const missing = [input.tmux === false && 'tmux', input.claude === false && 'claude'].filter(Boolean);
  if (missing.length) {
    return {
      state: 'online',
      reason: 'tools-missing',
      hint: `${missing.join(' and ')} not found: install ${missing.length > 1 ? 'them' : 'it'} on this system`,
      issue: true,
    };
  }
  return { state: 'online', reason: 'connected', hint: '', issue: false };
}

const STATE_RANK: Record<MachineState, number> = { online: 2, asleep: 1, offline: 0 };

/** A machine's verdict from its systems': the best state, and that system's reason. */
export function combineSystems(systems: MachineVerdict[]): MachineVerdict {
  if (!systems.length) return { state: 'offline', reason: 'unknown', hint: '', issue: false };
  const best = [...systems].sort(
    (a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || Number(a.issue) - Number(b.issue)
  )[0];
  return { state: best.state, reason: best.reason, hint: best.hint, issue: best.issue };
}

// ── Pure: parsing ──

/** `cpu  user nice system idle iowait irq softirq steal …` → idle (idle + iowait) and total ticks. */
export function parseCpuLine(line: string): CpuSample | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== 'cpu') return null;
  const nums = parts.slice(1, 9).map((n) => Number(n));
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const idle = nums[3] + (nums[4] ?? 0);
  return { idle, total: nums.reduce((a, b) => a + b, 0) };
}

/** Busy share between two samples, rounded; null when the counters did not advance. */
export function cpuPercent(prev: CpuSample, next: CpuSample): number | null {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 100)));
}

/** MemTotal and MemAvailable (kB) as used/total megabytes. */
export function parseMemInfo(lines: string[]): Omit<MachineLoad, 'cpu'> | null {
  let total: number | undefined;
  let avail: number | undefined;
  for (const line of lines) {
    const m = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s*kB/);
    if (!m) continue;
    if (m[1] === 'MemTotal') total = Number(m[2]);
    else avail = Number(m[2]);
  }
  if (!total || avail === undefined) return null;
  const used = Math.max(0, total - avail);
  return {
    memPercent: Math.round((used / total) * 100),
    memUsedMB: Math.round(used / 1024),
    memTotalMB: Math.round(total / 1024),
  };
}

export interface ProbeOutput {
  ok: boolean;
  tmux: boolean | null;
  claude: boolean | null;
  cpu: CpuSample[];
  mem: string[];
}

/** The `@@` marker lines of {@link buildProbeScript}'s output; anything else is login noise. */
export function parseProbeOutput(stdout: string): ProbeOutput {
  const out: ProbeOutput = { ok: false, tmux: null, claude: null, cpu: [], mem: [] };
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '@@ok') out.ok = true;
    else if (line.startsWith('@@tmux ')) out.tmux = line.slice(7).trim() === 'yes';
    else if (line.startsWith('@@claude ')) out.claude = line.slice(9).trim() === 'yes';
    else if (line.startsWith('@@cpu ')) {
      const sample = parseCpuLine(line.slice(6));
      if (sample) out.cpu.push(sample);
    } else if (line.startsWith('@@mem ')) out.mem.push(line.slice(6));
  }
  return out;
}

/**
 * The one command a poll runs on a system. `tools` adds the tmux/claude lookup (in a
 * login shell, where the user's PATH lives); `stats` the /proc reads, with a second CPU
 * sample when there is no earlier one to diff against.
 */
export function buildProbeScript(opts: {
  tools: boolean;
  stats: boolean;
  secondSample: boolean;
  windows: boolean;
}): string {
  const lines = ['echo @@ok'];
  if (opts.tools) {
    const claude = opts.windows
      ? `/mnt/c/Windows/System32/cmd.exe /c "where claude" >/dev/null 2>&1`
      : 'command -v claude >/dev/null 2>&1';
    lines.push(
      `bash -lc 'command -v tmux >/dev/null 2>&1 && echo "@@tmux yes" || echo "@@tmux no"; ` +
        `${claude.replace(/'/g, `'\\''`)} && echo "@@claude yes" || echo "@@claude no"' 2>/dev/null </dev/null`
    );
  }
  if (opts.stats) {
    lines.push(`[ -r /proc/stat ] && printf '@@cpu %s\\n' "$(head -n1 /proc/stat)"`);
    if (opts.secondSample)
      lines.push(`[ -r /proc/stat ] && sleep 0.3 && printf '@@cpu %s\\n' "$(head -n1 /proc/stat)"`);
    lines.push(`[ -r /proc/meminfo ] && grep -E '^(MemTotal|MemAvailable):' /proc/meminfo | sed 's/^/@@mem /'`);
  }
  lines.push('true');
  return lines.join('\n');
}

/** Machine name the way fleet-routes groups hosts: `machine`, else the label's first part. */
export function machineNameOf(host: Pick<RemoteHost, 'machine' | 'label'>): string {
  return host.machine || host.label.split(' · ')[0] || host.label;
}

/** Order systems so the stats read lands on Linux/WSL first; Windows (forced into WSL) last. */
function statsOrder(a: RemoteHost, b: RemoteHost): number {
  return Number(a.system === 'windows') - Number(b.system === 'windows');
}

// ── IO ──

/** Bare TCP connect to the ssh port, telling refusal from silence. Sends no data. */
export function probeTcp(host: string, port: number, timeoutMs = TCP_PROBE_TIMEOUT_MS): Promise<TcpOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (value: TcpOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish('timeout'));
    socket.once('connect', () => finish('open'));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(classifyTcpError(err.code)));
  });
}

export interface ExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  busy: boolean;
}

export interface MachineStatusDeps {
  readHosts(): Promise<RemoteHost[]>;
  probeTcp(host: string, port: number): Promise<TcpOutcome>;
  shellStatus(host: RemoteHost): RemoteShellStatus;
  exec(host: RemoteHost, script: string): Promise<ExecOutcome>;
  now(): number;
}

export function createDefaultMachineStatusDeps(readHosts: () => Promise<RemoteHost[]>): MachineStatusDeps {
  return {
    readHosts,
    probeTcp: (host, port) => probeTcp(host, port),
    shellStatus: (host) => remoteShellStatus(host),
    exec: (host, script) =>
      remoteExecIfIdle(host, script, { timeout: SSH_CHECK_TIMEOUT_MS, maxBuffer: 256 * 1024 }).then(
        (r) => ({ ok: true, stdout: r.stdout.toString('utf8'), stderr: r.stderr, timedOut: false, busy: false }),
        (err: unknown) => {
          const e = err instanceof RemoteExecError ? err : null;
          return {
            ok: false,
            // A non-zero exit of the probe script itself still means ssh worked.
            stdout: e?.stdout.toString('utf8') ?? '',
            stderr: e?.stderr || (err instanceof Error ? err.message : String(err)),
            timedOut: e?.killed ?? false,
            busy: e?.code === 'EBUSY',
          };
        }
      ),
    now: () => Date.now(),
  };
}

interface HostMemo {
  authFailedAt?: number;
  authVerdict?: MachineVerdict;
  toolsAt?: number;
  tmux: boolean | null;
  claude: boolean | null;
}

/**
 * Reads every machine's state on request, at most once per {@link STATUS_MIN_INTERVAL_MS}
 * (concurrent readers share one read). Owns no timer: with no browser asking, it does
 * nothing.
 */
export class MachineStatusMonitor {
  private cache: { at: number; machines: MachineStatus[] } | null = null;
  private inFlight: Promise<MachineStatus[]> | null = null;
  private readonly memo = new Map<string, HostMemo>();
  private readonly cpuPrev = new Map<string, CpuSample>();
  private readonly loadMemo = new Map<string, MachineLoad>();
  /** Last unanswered probe per address of a wakeable machine. */
  private readonly quiet = new Map<string, { at: number; outcome: TcpOutcome }>();
  private forced = false;

  constructor(private readonly deps: MachineStatusDeps) {}

  async read(opts: { force?: boolean } = {}): Promise<MachineStatus[]> {
    const age = this.cache ? this.deps.now() - this.cache.at : Infinity;
    const minAge = opts.force ? STATUS_FORCE_MIN_INTERVAL_MS : STATUS_MIN_INTERVAL_MS;
    if (this.cache && age < minAge) return this.cache.machines;
    if (this.inFlight) return this.inFlight;
    this.forced = !!opts.force;
    this.inFlight = this.poll()
      .then((machines) => {
        this.cache = { at: this.deps.now(), machines };
        return machines;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Drop the cache so the next read polls (a machine was edited or woken). */
  invalidate(): void {
    this.cache = null;
  }

  private async poll(): Promise<MachineStatus[]> {
    const hosts = await this.deps.readHosts();
    const groups = new Map<string, RemoteHost[]>();
    for (const h of hosts) {
      const name = machineNameOf(h);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(h);
    }
    return Promise.all([...groups.entries()].map(([name, list]) => this.pollMachine(name, list)));
  }

  /** A TCP probe, held back for a wakeable machine that recently gave no answer. */
  private async probeQuietly(addr: string, h: RemoteHost, wakeable: boolean): Promise<TcpOutcome> {
    const last = this.quiet.get(addr);
    if (wakeable && last && !this.forced && this.deps.now() - last.at < ASLEEP_REPROBE_MS) return last.outcome;
    const outcome = await this.deps.probeTcp(h.host, h.port ?? DEFAULT_SSH_PORT);
    if (wakeable && outcome !== 'open') this.quiet.set(addr, { at: this.deps.now(), outcome });
    else this.quiet.delete(addr);
    return outcome;
  }

  private async pollMachine(name: string, hosts: RemoteHost[]): Promise<MachineStatus> {
    const first = hosts[0];
    const port = first.port ?? DEFAULT_SSH_PORT;
    const wakeHost = hosts.find((h) => resolveWakeTarget({ ...h, hostId: h.id }) !== null) ?? null;
    // One probe per distinct address; skipped when a shell to it is already logged in.
    const tcpByAddr = new Map<string, Promise<TcpOutcome | 'connected' | 'proxied'>>();
    const tcpFor = (h: RemoteHost) => {
      const addr = `${h.host}:${h.port ?? DEFAULT_SSH_PORT}`;
      if (!tcpByAddr.has(addr)) {
        const connected = hosts.some(
          (o) => `${o.host}:${o.port ?? DEFAULT_SSH_PORT}` === addr && this.deps.shellStatus(o).ready > 0
        );
        tcpByAddr.set(
          addr,
          connected
            ? Promise.resolve('connected')
            : !isProbeable({ ...h, hostId: h.id })
              ? Promise.resolve('proxied')
              : this.probeQuietly(addr, h, wakeHost !== null)
        );
      }
      return tcpByAddr.get(addr)!;
    };

    const systems: SystemStatus[] = [];
    let load: MachineLoad | null = null;
    let loadTried = false;
    for (const host of [...hosts].sort(statsOrder)) {
      const tcp = await tcpFor(host);
      const base = { hostId: host.id, label: host.label, system: host.system ?? null };
      const memo = this.memoFor(host.id);
      if (tcp !== 'open' && tcp !== 'connected' && tcp !== 'proxied') {
        const verdict = classifyUnreachable(tcp, {
          port: host.port ?? DEFAULT_SSH_PORT,
          host: host.host,
          canWake: wakeHost !== null,
        });
        systems.push({ ...base, ...verdict, tmux: memo.tmux, claude: memo.claude });
        continue;
      }
      const now = this.deps.now();
      if (memo.authFailedAt !== undefined && memo.authVerdict && now - memo.authFailedAt < AUTH_RETRY_MS) {
        systems.push({ ...base, ...memo.authVerdict, tmux: memo.tmux, claude: memo.claude });
        continue;
      }
      const tools = memo.toolsAt === undefined || now - memo.toolsAt >= TOOLS_CHECK_MS;
      const stats = !loadTried;
      const script = buildProbeScript({
        tools,
        stats,
        secondSample: !this.cpuPrev.has(name),
        windows: host.system === 'windows',
      });
      const result = await this.deps.exec(host, script);
      const parsed = parseProbeOutput(result.stdout);
      const ok = result.ok || parsed.ok;
      if (ok && parsed.tmux !== null) {
        memo.tmux = parsed.tmux;
        memo.claude = parsed.claude;
        memo.toolsAt = now;
      }
      const verdict = classifySsh({
        ok,
        stderr: result.stderr,
        timedOut: result.timedOut,
        busy: result.busy,
        tmux: memo.tmux,
        claude: memo.claude,
        username: host.username,
      });
      if (verdict.reason === 'auth' || verdict.reason === 'host-key') {
        memo.authFailedAt = now;
        memo.authVerdict = verdict;
      } else {
        memo.authFailedAt = undefined;
        memo.authVerdict = undefined;
      }
      // A busy pool means a shell is open and working: connected, figures from last time.
      if (verdict.reason === 'busy') {
        systems.push({ ...base, ...verdict, reason: 'connected', tmux: memo.tmux, claude: memo.claude });
        if (stats) load = this.loadMemo.get(name) ?? null;
        continue;
      }
      systems.push({ ...base, ...verdict, tmux: memo.tmux, claude: memo.claude });
      if (stats && ok) {
        loadTried = true;
        load = this.loadFrom(name, parsed);
      }
    }
    // Keep the configured order in the answer.
    systems.sort((a, b) => hosts.findIndex((h) => h.id === a.hostId) - hosts.findIndex((h) => h.id === b.hostId));
    const verdict = combineSystems(systems);
    if (verdict.state !== 'online') {
      load = null;
      this.cpuPrev.delete(name);
      this.loadMemo.delete(name);
    }
    return {
      name,
      host: first.host,
      port,
      wakeHostId: verdict.state === 'online' ? null : (wakeHost?.id ?? null),
      ...verdict,
      load,
      systems,
      checkedAt: this.deps.now(),
    };
  }

  private loadFrom(name: string, parsed: ProbeOutput): MachineLoad | null {
    const mem = parseMemInfo(parsed.mem);
    if (!mem || !parsed.cpu.length) return null;
    const latest = parsed.cpu[parsed.cpu.length - 1];
    const prev = parsed.cpu.length > 1 ? parsed.cpu[0] : this.cpuPrev.get(name);
    this.cpuPrev.set(name, latest);
    const load = { cpu: prev ? cpuPercent(prev, latest) : null, ...mem };
    this.loadMemo.set(name, load);
    return load;
  }

  private memoFor(hostId: string): HostMemo {
    let memo = this.memo.get(hostId);
    if (!memo) {
      memo = { tmux: null, claude: null };
      this.memo.set(hostId, memo);
    }
    return memo;
  }
}
