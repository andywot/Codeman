// Port: none (pure functions and a monitor with injected IO; nothing touches the network).
//
// Machine state for the fleet (src/machine-status.ts). Pinned here: the TCP and ssh
// outcomes map to online/asleep/offline with the right one-line hint; /proc parsing and
// the CPU delta; and the poll's manners: no ssh to a port that did not answer, a refused
// key is not retried every poll, one machine's systems share one stats read, and the
// answer is cached between polls.
import { describe, expect, it } from 'vitest';
import {
  AUTH_RETRY_MS,
  STATUS_MIN_INTERVAL_MS,
  MachineStatusMonitor,
  buildProbeScript,
  classifySsh,
  classifySshFailure,
  classifyTcpError,
  classifyUnreachable,
  combineSystems,
  cpuPercent,
  parseCpuLine,
  parseMemInfo,
  parseProbeOutput,
  type ExecOutcome,
  type MachineStatusDeps,
  type TcpOutcome,
} from '../src/machine-status.js';
import type { RemoteHost } from '../src/types.js';

describe('classification', () => {
  it('maps socket errors to probe outcomes', () => {
    expect(classifyTcpError('ECONNREFUSED')).toBe('refused');
    expect(classifyTcpError('ETIMEDOUT')).toBe('timeout');
    expect(classifyTcpError('EHOSTUNREACH')).toBe('unreachable');
    expect(classifyTcpError('ENOTFOUND')).toBe('dns');
    expect(classifyTcpError('EWHATEVER')).toBe('error');
  });

  it('a silent port is asleep with Wake, offline without', () => {
    const opts = { port: 22, host: '192.168.0.28' };
    expect(classifyUnreachable('timeout', { ...opts, canWake: true })).toMatchObject({
      state: 'asleep',
      reason: 'no-reply',
    });
    expect(classifyUnreachable('unreachable', { ...opts, canWake: false })).toMatchObject({
      state: 'offline',
      reason: 'no-reply',
    });
    expect(classifyUnreachable('refused', { ...opts, canWake: true })).toMatchObject({
      state: 'offline',
      reason: 'no-sshd',
    });
    expect(classifyUnreachable('dns', { ...opts, canWake: false }).hint).toContain('192.168.0.28');
  });

  it('reads ssh failures', () => {
    expect(classifySshFailure('andy@192.168.0.28: Permission denied (publickey).')).toBe('auth');
    expect(classifySshFailure('Host key verification failed.')).toBe('host-key');
    expect(classifySshFailure('Connection closed by 192.168.0.28 port 22')).toBe('ssh-error');
  });

  it('gives a fix hint for a refused key and for missing tools', () => {
    const auth = classifySsh({ ok: false, stderr: 'Permission denied (publickey)', username: 'andy' });
    expect(auth).toMatchObject({ state: 'online', reason: 'auth', issue: true });
    expect(auth.hint).toMatch(/authorized_keys.*AllowUsers andy/);
    const tools = classifySsh({ ok: true, tmux: false, claude: true, username: 'andy' });
    expect(tools).toMatchObject({ reason: 'tools-missing', issue: true });
    expect(tools.hint).toMatch(/^tmux not found/);
    expect(classifySsh({ ok: true, tmux: true, claude: null, username: 'a' })).toMatchObject({
      reason: 'connected',
      hint: '',
      issue: false,
    });
  });

  it('a machine takes its best system, preferring one without an issue', () => {
    const asleep = classifyUnreachable('timeout', { port: 22, host: 'h', canWake: true });
    const auth = classifySsh({ ok: false, stderr: 'Permission denied', username: 'a' });
    const ok = classifySsh({ ok: true, username: 'a' });
    expect(combineSystems([asleep, auth]).reason).toBe('auth');
    expect(combineSystems([auth, ok]).reason).toBe('connected');
    expect(combineSystems([asleep]).state).toBe('asleep');
  });
});

describe('parsing', () => {
  it('computes CPU busy share from two /proc/stat samples', () => {
    const a = parseCpuLine('cpu  100 0 100 800 0 0 0 0 0 0')!;
    const b = parseCpuLine('cpu  150 0 150 900 0 0 0 0 0 0')!;
    expect(a).toEqual({ idle: 800, total: 1000 });
    expect(cpuPercent(a, b)).toBe(50);
    expect(cpuPercent(b, b)).toBeNull();
    expect(parseCpuLine('cpu0 1 2 3 4')).toBeNull();
  });

  it('reads used memory from MemTotal and MemAvailable', () => {
    expect(parseMemInfo(['MemTotal:       16000000 kB', 'MemAvailable:    4000000 kB'])).toEqual({
      memPercent: 75,
      memUsedMB: 11719,
      memTotalMB: 15625,
    });
    expect(parseMemInfo(['MemTotal: 100 kB'])).toBeNull();
  });

  it('keeps only marker lines, so login noise and CRs do not matter', () => {
    const out = parseProbeOutput(
      'Welcome!\r\n@@ok\r\n@@tmux yes\n@@claude no\n@@cpu cpu  1 0 1 8 0 0 0 0\n@@mem MemTotal: 10 kB\n'
    );
    expect(out).toMatchObject({ ok: true, tmux: true, claude: false, mem: ['MemTotal: 10 kB'] });
    expect(out.cpu).toHaveLength(1);
  });

  it('builds a probe script that reads only what was asked for', () => {
    const bare = buildProbeScript({ tools: false, stats: false, secondSample: false, windows: false });
    expect(bare).not.toMatch(/proc|tmux/);
    const full = buildProbeScript({ tools: true, stats: true, secondSample: true, windows: true });
    expect(full).toContain('/proc/stat');
    expect(full).toContain('sleep 0.3');
    expect(full).toContain('cmd.exe');
  });
});

// ── The monitor, with fake IO ──

function host(id: string, over: Partial<RemoteHost> = {}): RemoteHost {
  return { id, label: id, host: '10.0.0.1', username: 'andy', ...over } as RemoteHost;
}

const PROC = (user: number, idle: number) =>
  `@@ok\n@@tmux yes\n@@claude yes\n@@cpu cpu  ${user} 0 0 ${idle} 0 0 0 0\n` +
  '@@mem MemTotal: 8000000 kB\n@@mem MemAvailable: 2000000 kB\n';

function fakeDeps(over: Partial<MachineStatusDeps> & { hosts: RemoteHost[] }) {
  const calls = { tcp: [] as string[], exec: [] as Array<{ id: string; script: string }> };
  let clock = 1_000_000;
  const deps: MachineStatusDeps = {
    readHosts: async () => over.hosts,
    probeTcp: async (h, p) => {
      calls.tcp.push(`${h}:${p}`);
      return 'open';
    },
    shellStatus: () => ({ ready: 0, connecting: 0, busy: 0, queued: 0 }),
    exec: async (h, script) => {
      calls.exec.push({ id: h.id, script });
      return { ok: true, stdout: PROC(100, 900), stderr: '', timedOut: false, busy: false };
    },
    now: () => clock,
    ...over,
  };
  return { deps, calls, advance: (ms: number) => (clock += ms) };
}

describe('MachineStatusMonitor', () => {
  it('never runs ssh against a machine whose port did not answer', async () => {
    const { deps, calls } = fakeDeps({
      hosts: [host('desk-wsl', { machine: 'Desktop', system: 'wsl', wakeMac: '04:d9:f5:80:c6:58' })],
      probeTcp: async (): Promise<TcpOutcome> => 'timeout',
    });
    const [m] = await new MachineStatusMonitor(deps).read();
    expect(m).toMatchObject({ name: 'Desktop', state: 'asleep', wakeHostId: 'desk-wsl', load: null });
    expect(calls.exec).toHaveLength(0);
  });

  it('skips the TCP probe when a shell is already logged in', async () => {
    const { deps, calls } = fakeDeps({
      hosts: [host('arr', { system: 'linux' })],
      shellStatus: () => ({ ready: 1, connecting: 0, busy: 0, queued: 0 }),
    });
    const [m] = await new MachineStatusMonitor(deps).read();
    expect(calls.tcp).toHaveLength(0);
    expect(m).toMatchObject({ state: 'online', reason: 'connected' });
  });

  it('reads CPU/MEM once for the WSL and Windows systems of one machine', async () => {
    const hosts = [
      host('desk-windows', { machine: 'Desktop', system: 'windows' }),
      host('desk-wsl', { machine: 'Desktop', system: 'wsl' }),
    ];
    const { deps, calls } = fakeDeps({ hosts });
    const [m] = await new MachineStatusMonitor(deps).read();
    const withStats = calls.exec.filter((c) => c.script.includes('/proc/stat'));
    expect(withStats.map((c) => c.id)).toEqual(['desk-wsl']);
    expect(calls.tcp).toEqual(['10.0.0.1:22']);
    expect(m.systems.map((s) => s.hostId)).toEqual(['desk-windows', 'desk-wsl']);
    expect(m.load).toMatchObject({ memPercent: 75 });
  });

  it('takes CPU from the delta between polls, and caches between them', async () => {
    let n = 0;
    const { deps, calls, advance } = fakeDeps({
      hosts: [host('arr', { system: 'linux' })],
      exec: async (_h, script) => {
        calls.exec.push({ id: 'arr', script });
        n += 1;
        return {
          ok: true,
          stdout: n === 1 ? PROC(100, 900) : PROC(150, 950),
          stderr: '',
          timedOut: false,
          busy: false,
        };
      },
    });
    const monitor = new MachineStatusMonitor(deps);
    expect((await monitor.read())[0].load?.cpu).toBeNull(); // one sample in the fake output
    expect(calls.exec[0].script).toContain('sleep 0.3');
    await monitor.read();
    expect(calls.exec).toHaveLength(1); // cached
    advance(STATUS_MIN_INTERVAL_MS);
    expect((await monitor.read())[0].load?.cpu).toBe(50);
    expect(calls.exec[1].script).not.toContain('sleep 0.3');
    expect(calls.exec[1].script).not.toContain('@@tmux'); // tools are not re-checked every poll
  });

  it('does not retry a refused key every poll', async () => {
    const { deps, calls, advance } = fakeDeps({
      hosts: [host('lap', { system: 'wsl' })],
      exec: async (h, script): Promise<ExecOutcome> => {
        calls.exec.push({ id: h.id, script });
        return { ok: false, stdout: '', stderr: 'Permission denied (publickey).', timedOut: false, busy: false };
      },
    });
    const monitor = new MachineStatusMonitor(deps);
    expect((await monitor.read())[0]).toMatchObject({ state: 'online', reason: 'auth', issue: true });
    advance(STATUS_MIN_INTERVAL_MS);
    expect((await monitor.read())[0].reason).toBe('auth');
    expect(calls.exec).toHaveLength(1);
    advance(AUTH_RETRY_MS);
    await monitor.read();
    expect(calls.exec).toHaveLength(2);
  });

  it('a busy pool reads as connected without waiting for a shell', async () => {
    const { deps } = fakeDeps({
      hosts: [host('arr', { system: 'linux' })],
      exec: async () => ({ ok: false, stdout: '', stderr: 'shells busy', timedOut: false, busy: true }),
    });
    expect((await new MachineStatusMonitor(deps).read())[0]).toMatchObject({
      state: 'online',
      reason: 'connected',
      issue: false,
    });
  });

  it('shares one in-flight poll between concurrent readers', async () => {
    const { deps, calls } = fakeDeps({ hosts: [host('arr', { system: 'linux' })] });
    const monitor = new MachineStatusMonitor(deps);
    await Promise.all([monitor.read(), monitor.read({ force: true })]);
    expect(calls.exec).toHaveLength(1);
  });
});
