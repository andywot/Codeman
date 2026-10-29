/**
 * @fileoverview Fork: discovery of Claude sessions the dashboard did not start
 * (src/claude-discovery.ts).
 *
 * The remote output is recorded, never fetched: the parser and classifier run on a
 * transcript shaped like the script's stdout, the machine orchestration runs on
 * injected fake runners, and the shell script itself runs under the real `sh` with
 * stub `tmux` and `ps` on PATH and a throwaway HOME. Nothing here touches a real tmux
 * server, process or ssh connection.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADOPTED_TMUX_NAME_RE,
  PANE_SEP,
  classifyDiscovery,
  claudeProcessKind,
  claudeProjectKey,
  conversationIdFromArgs,
  discoverTarget,
  discoveryCommand,
  discoveryScriptBody,
  discoveryTargets,
  isPrintRun,
  knownForTarget,
  parseDiscoveryOutput,
  type DiscoveryRun,
} from '../src/claude-discovery.js';
import { remoteTmuxLocation } from '../src/tmux-manager.js';
import type { RemoteHost, SessionRemote } from '../src/types.js';

const S = PANE_SEP;
const pane = (fields: Array<string | number>) => `@@pane ${fields.join(S)}`;

const ID_WORK = 'aaaaaaaa-1111-4111-8111-111111111111';
const ID_OUT = 'bbbbbbbb-2222-4222-8222-222222222222';
const ID_OLD_NEW = 'cccccccc-3333-4333-8333-333333333333';
const ID_OLD_OLD = 'dddddddd-4444-4444-8444-444444444444';
const ID_WIN = 'eeeeeeee-5555-4555-8555-555555555555';
const ID_LOST = 'ffffffff-6666-4666-8666-666666666666';

/**
 * A desktop's WSL as the script reports it:
 * - `default` socket: `work` runs claude (pane 2001 → claude 2002); `notes` is a shell.
 * - `codeman-remote`: the dashboard's own session (aaaa1111) and a lost one (bbbb2222).
 * - outside tmux: a native claude with a session record (4001), an npm-installed one
 *   with no record or id (4101), a Windows claude via cmd.exe (6001).
 * - noise: a `claude -p` one-shot (4201), a wrapper whose child is the real binary
 *   (5001 → 5002), Claude's embedded ugrep (5003, a version-named comm).
 */
const RECORDED = [
  '@@sockdir /tmp/tmux-1000',
  pane(['default', 'work', 0, 0, 2001, 'claude', 1, 2, 1700000000, '/home/andy/proj']),
  pane(['default', 'notes', 0, 0, 2101, 'bash', 0, 1, 1700000100, `/home/andy/odd${S}dir`]),
  pane(['codeman-remote', 'codeman-ssh-aaaa1111', 0, 0, 3001, 'claude', 1, 1, 1700000200, '/home/andy/site']),
  pane(['codeman-remote', 'codeman-ssh-bbbb2222', 0, 0, 3101, 'claude', 0, 1, 1700000300, '/home/andy/lost']),
  '@@pc     1     0 systemd',
  '@@pc  2001  1999 bash',
  '@@pc  2002  2001 claude',
  '@@pc  2101  1999 bash',
  '@@pc  3001  1999 sh',
  '@@pc  3002  3001 claude',
  '@@pc  3101  1999 sh',
  '@@pc  3102  3101 claude',
  '@@pc  4000     1 bash',
  '@@pc  4001  4000 claude',
  '@@pc  4100     1 bash',
  '@@pc  4101  4100 node',
  '@@pc  4201  4000 claude',
  '@@pc  5000     1 bash',
  '@@pc  5001  5000 claude',
  '@@pc  5002  5001 2.1.312',
  '@@pc  5003  4001 2.1.312',
  '@@pc  6000     1 bash',
  '@@pc  6001  6000 cmd.exe',
  '@@pc  7000     1 tmux: server',
  `@@args 2002 claude --permission-mode auto`,
  `@@args 3002 claude --session-id 99999999-0000-4000-8000-000000000000`,
  `@@args 3102 claude --resume ${ID_LOST}`,
  `@@args 4001 claude`,
  `@@args 4101 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
  `@@args 4201 claude -p summarize this`,
  `@@args 5001 /home/andy/.local/bin/claude`,
  `@@args 5002 /home/andy/.local/share/claude/versions/2.1.312`,
  `@@args 5003 ugrep -G --ignore-files -vE x`,
  `@@args 6001 /mnt/c/Windows/System32/cmd.exe /c claude --resume ${ID_WIN}`,
  '@@start 2002 1111',
  '@@cwd 2002 /home/andy/proj',
  '@@start 4001 2222',
  '@@cwd 4001 /home/andy/out',
  '@@cwd 4101 /home/andy/other',
  '@@cwd 5001 /home/andy/wrapped',
  '@@cwd 6001 /mnt/c/Users/andy/win',
  `@@sess 2002 {"pid":2002,"sessionId":"${ID_WORK}","cwd":"/home/andy/proj","procStart":"1111","name":"proj-1a","status":"busy","version":"2.1.312","kind":"interactive"}`,
  `@@sess 4001 {"pid":4001,"sessionId":"${ID_OUT}","cwd":"/home/andy/out","procStart":"2222","status":"idle","kind":"interactive"}`,
  `@@log 1700000500 /home/andy/.claude/projects/-home-andy-proj/${ID_WORK}.jsonl`,
  `@@log 1700000600 /home/andy/.claude/projects/-home-andy-out/${ID_OUT}.jsonl`,
  `@@log 1700000900 /home/andy/.claude/projects/-home-andy-other/${ID_OLD_NEW}.jsonl`,
  `@@log 1700000100 /home/andy/.claude/projects/-home-andy-other/${ID_OLD_OLD}.jsonl`,
  `@@log 1700000900 /home/andy/.claude/projects/-home-andy-other/${ID_OLD_NEW}.jsonl`,
  'garbage line',
  '@@pane too|@|few',
  '@@end',
].join('\n');

describe('parseDiscoveryOutput', () => {
  const raw = parseDiscoveryOutput(RECORDED);

  it('reads panes, processes, records and logs, and notices the end marker', () => {
    expect(raw.complete).toBe(true);
    expect(raw.sockDir).toBe('/tmp/tmux-1000');
    expect(raw.panes).toHaveLength(4);
    expect(raw.processes.get(2002)).toMatchObject({
      ppid: 2001,
      comm: 'claude',
      cwd: '/home/andy/proj',
      startTime: '1111',
    });
    expect(raw.processes.get(7000)?.comm).toBe('tmux: server');
    expect(raw.records.get(4001)?.sessionId).toBe(ID_OUT);
    // The duplicate log line is kept once.
    expect(raw.logs.filter((l) => l.path.endsWith(`${ID_OLD_NEW}.jsonl`))).toHaveLength(1);
  });

  it('keeps a pane path that contains the field separator whole', () => {
    expect(raw.panes.find((p) => p.sessionName === 'notes')?.currentPath).toBe(`/home/andy/odd${S}dir`);
  });

  it('reports output that stopped before @@end as incomplete', () => {
    expect(parseDiscoveryOutput(RECORDED.replace('@@end', '')).complete).toBe(false);
  });

  it('drops a session record that names a different pid or holds a malformed id', () => {
    const out = parseDiscoveryOutput(
      [
        '@@sess 10 {"pid":11,"sessionId":"aaaaaaaa-0000-4000-8000-000000000000"}',
        '@@sess 12 {"pid":12,"sessionId":"$(rm -rf ~)"}',
        '@@sess 13 not json',
        '@@end',
      ].join('\n')
    );
    expect(out.records.has(10)).toBe(false);
    expect(out.records.get(12)?.sessionId).toBeUndefined();
    expect(out.records.has(13)).toBe(false);
  });

  it('ignores Windows line endings', () => {
    expect(parseDiscoveryOutput('@@sockdir /tmp/x\r\n@@end\r\n')).toMatchObject({ sockDir: '/tmp/x', complete: true });
  });
});

describe('claudeProcessKind', () => {
  it('recognises the CLI by its process name or its program, never by an argument', () => {
    expect(claudeProcessKind({ comm: 'claude', args: 'claude' })).toBe('linux');
    expect(claudeProcessKind({ comm: '2.1.312', args: '/home/a/.local/share/claude/versions/2.1.312' })).toBe('linux');
    expect(
      claudeProcessKind({ comm: 'node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' })
    ).toBe('linux');
    expect(claudeProcessKind({ comm: 'cmd.exe', args: 'cmd.exe /c claude --resume x' })).toBe('windows');
    expect(claudeProcessKind({ comm: 'cmd.exe', args: 'cmd.exe /c "claude --version"' })).toBe('windows');
    expect(claudeProcessKind({ comm: '2.1.312', args: 'ugrep -G x' })).toBeNull();
    expect(claudeProcessKind({ comm: 'bash', args: 'bash -c cat ~/.claude/x' })).toBeNull();
    expect(claudeProcessKind({ comm: 'cmd.exe', args: 'cmd.exe /c dir' })).toBeNull();
  });

  it('tells one-shot runs and conversation ids apart', () => {
    expect(isPrintRun('claude -p hi')).toBe(true);
    expect(isPrintRun('claude --print')).toBe(true);
    expect(isPrintRun('claude --permission-mode auto')).toBe(false);
    expect(conversationIdFromArgs(`claude --resume ${ID_WIN}`)).toBe(ID_WIN);
    expect(conversationIdFromArgs(`claude --session-id=${ID_WIN}`)).toBe(ID_WIN);
    expect(conversationIdFromArgs(`claude -r ${ID_WIN}`)).toBe(ID_WIN);
    expect(conversationIdFromArgs('claude --continue')).toBeUndefined();
    expect(claudeProjectKey('/home/andy/my proj.v2')).toBe('-home-andy-my-proj-v2');
  });
});

describe('classifyDiscovery', () => {
  const raw = parseDiscoveryOutput(RECORDED);

  it('places each Claude in its pane by ancestry, or outside tmux', () => {
    const result = classifyDiscovery(raw);
    expect(result.tmux.map((t) => `${t.socket}/${t.sessionName}:${t.pid}`)).toEqual([
      'codeman-remote/codeman-ssh-aaaa1111:3002',
      'codeman-remote/codeman-ssh-bbbb2222:3102',
      'default/work:2002',
    ]);
    expect(result.outside.map((o) => o.pid).sort()).toEqual([4001, 4101, 5001, 6001]);
  });

  it('leaves out one-shot runs, a wrapper child and the embedded ugrep', () => {
    const pids = [...classifyDiscovery(raw).tmux, ...classifyDiscovery(raw).outside].map((x) => x.pid);
    expect(pids).not.toContain(4201);
    expect(pids).not.toContain(5002);
    expect(pids).not.toContain(5003);
  });

  it('takes the conversation id from the session record, then the command line', () => {
    const { tmux, outside } = classifyDiscovery(raw);
    const work = tmux.find((t) => t.sessionName === 'work')!;
    expect(work).toMatchObject({
      conversationId: ID_WORK,
      conversationSource: 'session-file',
      logPath: `/home/andy/.claude/projects/-home-andy-proj/${ID_WORK}.jsonl`,
      title: 'proj-1a',
      status: 'busy',
      cwd: '/home/andy/proj',
      attachedClients: 1,
      windows: 2,
    });
    expect(tmux.find((t) => t.sessionName === 'codeman-ssh-bbbb2222')).toMatchObject({
      conversationId: ID_LOST,
      conversationSource: 'argv',
    });
    expect(outside.find((o) => o.pid === 4001)).toMatchObject({
      kind: 'process',
      cwd: '/home/andy/out',
      conversationId: ID_OUT,
      conversationSource: 'session-file',
    });
    expect(outside.find((o) => o.pid === 6001)).toMatchObject({
      system: 'windows',
      conversationId: ID_WIN,
      conversationSource: 'argv',
      cwd: '/mnt/c/Users/andy/win',
    });
  });

  it('guesses the newest log in the folder when nothing names the conversation', () => {
    const old = classifyDiscovery(raw).outside.find((o) => o.pid === 4101)!;
    expect(old).toMatchObject({ conversationId: ID_OLD_NEW, conversationSource: 'newest-log' });
    expect(old.ambiguous).toBeUndefined();
  });

  it('flags the guess when two unnamed Claudes share a folder', () => {
    const twin = parseDiscoveryOutput(
      RECORDED.replace('@@end', ['@@pc  4102  4100 claude', '@@cwd 4102 /home/andy/other', '@@end'].join('\n'))
    );
    const out = classifyDiscovery(twin).outside.filter((o) => o.cwd === '/home/andy/other');
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.ambiguous === true && o.conversationId === ID_OLD_NEW)).toBe(true);
  });

  it('distrusts a session record whose start time does not match the process (pid reuse)', () => {
    const reused = parseDiscoveryOutput(RECORDED.replace('@@start 4001 2222', '@@start 4001 9999'));
    const out = classifyDiscovery(reused).outside.find((o) => o.pid === 4001)!;
    expect(out.conversationSource).not.toBe('session-file');
  });

  it('hides sessions the dashboard already has, and whole hidden sockets', () => {
    const result = classifyDiscovery(raw, {
      knownSessions: [{ socket: 'codeman-remote', sessionName: 'codeman-ssh-aaaa1111' }],
    });
    expect(result.tmux.map((t) => t.sessionName)).toEqual(['codeman-ssh-bbbb2222', 'work']);
    expect(result.hiddenCount).toBe(1);

    const local = classifyDiscovery(raw, { hiddenSockets: ['codeman-remote'] });
    expect(local.tmux.map((t) => t.sessionName)).toEqual(['work']);
    expect(local.hiddenCount).toBe(2);
    // A Claude in a hidden socket's pane is still in tmux, never "outside tmux".
    expect(local.outside.map((o) => o.pid)).not.toContain(3002);
  });
});

describe('machines', () => {
  const hosts: RemoteHost[] = [
    {
      id: 'desktop-wsl',
      label: 'Desktop · WSL',
      host: '192.168.0.28',
      username: 'AndyWu',
      machine: 'Desktop',
      system: 'wsl',
    },
    {
      id: 'desktop-windows',
      label: 'Desktop · Windows',
      host: '192.168.0.28',
      username: 'AndyWu',
      machine: 'Desktop',
      system: 'windows',
    },
    { id: 'laptop-wsl', label: 'Laptop · WSL', host: '10.10.10.2', username: 'andy', machine: 'Laptop', system: 'wsl' },
    { id: 'server-80-linux', label: 'Server 80 · Linux', host: '192.168.0.80', username: 'andy', system: 'linux' },
  ] as RemoteHost[];

  it('looks once per ssh login, through the non-Windows system, remembering the Windows one', () => {
    const targets = discoveryTargets(hosts);
    expect(targets.map((t) => t.id)).toEqual(['local', 'desktop-wsl', 'laptop-wsl', 'server-80-linux']);
    expect(targets[1]).toMatchObject({ name: 'Desktop', hostId: 'desktop-wsl', windowsHostId: 'desktop-windows' });
    expect(targets[0]).toMatchObject({ hostId: null });
    expect(targets[3].name).toBe('Server 80');
  });

  it("knows the dashboard's sessions on each login, wherever their tmux lives", () => {
    const remoteOn = (over: Partial<SessionRemote>): SessionRemote => ({
      hostId: 'desktop-windows',
      label: 'Desktop · Windows',
      host: '192.168.0.28',
      username: 'AndyWu',
      remotePath: '/home/andy',
      ...over,
    });
    const sessions = [
      { id: '11112222-0000-4000-8000-000000000000', remote: remoteOn({}) },
      {
        id: '33334444-0000-4000-8000-000000000000',
        remote: remoteOn({ owned: false, remoteSessionName: 'work', remoteTmuxSocket: 'default' }),
      },
      { id: '55556666-0000-4000-8000-000000000000', remote: remoteOn({ host: '10.10.10.2', username: 'andy' }) },
      { id: '77778888-0000-4000-8000-000000000000', adoptedTmux: { socket: 'default', sessionName: 'mine' } },
    ];
    const [local, desktop] = discoveryTargets(hosts);
    expect(knownForTarget(desktop, hosts, sessions, 'codeman', remoteTmuxLocation)).toEqual({
      knownSessions: [
        { socket: 'codeman-remote', sessionName: 'codeman-ssh-11112222' },
        { socket: 'default', sessionName: 'work' },
      ],
    });
    expect(knownForTarget(local, hosts, sessions, 'codeman', remoteTmuxLocation)).toEqual({
      hiddenSockets: ['codeman'],
      knownSessions: [{ socket: 'default', sessionName: 'mine' }],
    });
  });

  it('discovers a machine through the injected runner and marks what can be attached', async () => {
    const odd = RECORDED.replace(
      '@@pc  7000     1 tmux: server',
      ['@@pc  7000     1 tmux: server', '@@pc  8002  8001 claude'].join('\n')
    ).replace('@@end', [pane(['default', 'we$ird', 0, 0, 8001, 'claude', 0, 1, 1, '/x']), '@@end'].join('\n'));
    const calls: string[] = [];
    const deps = {
      runLocal: async (): Promise<DiscoveryRun> => ({ ok: false, error: 'unused' }),
      runRemote: async (h: RemoteHost): Promise<DiscoveryRun> => {
        calls.push(h.id);
        return { ok: true, raw: parseDiscoveryOutput(odd) };
      },
    };
    const target = discoveryTargets(hosts)[1];
    const found = await discoverTarget(target, hosts, { knownSessions: [] }, deps);
    expect(calls).toEqual(['desktop-wsl']);
    expect(found.ok).toBe(true);
    expect(found.tmux.find((t) => t.sessionName === 'work')?.attachable).toBe(true);
    expect(found.tmux.find((t) => t.sessionName === 'we$ird')?.attachable).toBe(false);
    expect(found.outside.length).toBe(4);
  });

  it('reports an unreachable machine as an error, not as "nothing running"', async () => {
    const deps = {
      runLocal: async (): Promise<DiscoveryRun> => ({ ok: false, error: 'unused' }),
      runRemote: async (): Promise<DiscoveryRun> => ({ ok: false, error: 'Laptop · WSL: timed out' }),
    };
    const found = await discoverTarget(discoveryTargets(hosts)[2], hosts, {}, deps);
    expect(found).toMatchObject({ ok: false, error: 'Laptop · WSL: timed out', tmux: [], outside: [] });
  });

  it('only offers names that survive the pane command quoting', () => {
    expect(ADOPTED_TMUX_NAME_RE.test('work 2')).toBe(true);
    expect(ADOPTED_TMUX_NAME_RE.test('my-session_1.x')).toBe(true);
    for (const bad of ['a$b', 'a`b', 'a"b', "a'b", 'a\\b', 'a;b', ''])
      expect(ADOPTED_TMUX_NAME_RE.test(bad)).toBe(false);
  });
});

describe('discovery script (real sh, stub tmux and ps)', () => {
  let dir: string;
  let server: Server;
  // pids above any real pid_max, so /proc/<pid> can never be a real process here.
  const P = 9000001;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-discovery-'));
    const home = join(dir, 'home');
    // The script puts $HOME/bin ahead of the system directories on PATH (see
    // withRemoteTmuxPath), so the stubs there win over a real tmux and ps.
    const bin = join(home, 'bin');
    const uid = String(process.getuid?.() ?? 0);
    const sockDir = join(dir, 'tmux', `tmux-${uid}`);
    mkdirSync(bin, { recursive: true });
    mkdirSync(sockDir, { recursive: true });
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    mkdirSync(join(home, '.claude', 'projects', '-home-u-proj'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'sessions', `${P + 1}.json`),
      JSON.stringify({ pid: P + 1, sessionId: ID_WORK, cwd: '/home/u/proj', kind: 'interactive' })
    );
    writeFileSync(join(home, '.claude', 'sessions', `${P + 1}.abc.key`), 'SECRET-KEY-MATERIAL');
    writeFileSync(join(home, '.claude', 'sessions', 'notapid.json'), '{"sessionId":"x"}');
    writeFileSync(join(home, '.claude', 'projects', '-home-u-proj', `${ID_WORK}.jsonl`), '{}\n');

    const log = join(dir, 'calls.log');
    writeFileSync(
      join(bin, 'tmux'),
      `#!/bin/sh\necho "tmux $*" >> ${log}\ncase "$3" in list-panes) ;; *) exit 1;; esac\n` +
        `n=$(basename "$2")\necho "@@pane $n${S}work${S}0${S}0${S}${P}${S}claude${S}0${S}1${S}1700000000${S}/home/u/proj"\n`
    );
    writeFileSync(
      join(bin, 'ps'),
      `#!/bin/sh\necho "ps $*" >> ${log}\ncase "$*" in\n` +
        `  "-eo pid=,ppid=,comm=") printf ' ${P} 1 bash\\n ${P + 1} ${P} claude\\n' ;;\n` +
        `  "-eo pid=,args=") printf ' ${P} -bash\\n ${P + 1} claude --resume ${ID_WORK}\\n' ;;\n` +
        `  "-eo pid=,comm=") printf ' ${P} bash\\n ${P + 1} claude\\n' ;;\n` +
        `  "-eo args=") printf -- '-bash\\nclaude --resume ${ID_WORK}\\n' ;;\n` +
        'esac\n'
    );
    chmodSync(join(bin, 'tmux'), 0o755);
    chmodSync(join(bin, 'ps'), 0o755);
    // A real unix socket, so the script's `[ -S ]` test sees one.
    server = createServer();
    await new Promise<void>((resolve) => server.listen(join(sockDir, 'default'), resolve));
    writeFileSync(join(sockDir, 'not-a-socket'), '');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (): string =>
    execFileSync('sh', ['-c', discoveryCommand()], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: join(dir, 'home'),
        TMUX_TMPDIR: join(dir, 'tmux'),
      },
    });

  it('produces output the parser and classifier understand', () => {
    const raw = parseDiscoveryOutput(run());
    expect(raw.complete).toBe(true);
    expect(raw.panes).toHaveLength(1);
    expect(raw.records.get(P + 1)?.sessionId).toBe(ID_WORK);
    expect(raw.logs.map((l) => l.path)).toEqual([
      join(dir, 'home', '.claude', 'projects', '-home-u-proj', `${ID_WORK}.jsonl`),
    ]);
    const { tmux } = classifyDiscovery(raw);
    expect(tmux).toHaveLength(1);
    expect(tmux[0]).toMatchObject({ socket: 'default', sessionName: 'work', conversationId: ID_WORK });
  });

  it('only lists: no tmux command but list-panes, never a session key file', () => {
    const out = run();
    expect(out).not.toContain('SECRET-KEY-MATERIAL');
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    const tmuxCalls = calls.filter((c) => c.startsWith('tmux '));
    expect(tmuxCalls.length).toBeGreaterThan(0);
    expect(tmuxCalls.every((c) => / list-panes -a -F /.test(c))).toBe(true);
  });

  it('carries no command that could change a session or a process', () => {
    const body = discoveryScriptBody();
    for (const word of [
      /\bkill\b/,
      /\bpkill\b/,
      /send-keys/,
      /rename/,
      /new-session/,
      /\battach(-session)?\b/,
      /respawn/,
      /set-option/,
      /\bset -t\b/,
      /\brm\s/,
    ]) {
      expect(body).not.toMatch(word);
    }
  });
});
