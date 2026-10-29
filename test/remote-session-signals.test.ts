// Port: none (pure functions, a fake pooled shell that runs scripts under a local `sh`, and the
// route-context mock; nothing listens).
//
// Alerts and statusline figures for remote (ssh) sessions (fork): the launch's hooks and
// statusLine record to files on the machine, and the server reads them back over the pooled
// shell (src/remote-session-signals.ts). Pinned here:
// - the hook commands really append `<seconds> <event>` lines when a shell runs them the way
//   Claude does (stdin = the hook JSON, temporary HOME), print nothing and write no prompt text;
//   without $CLAUDE_RC_SESSION they write nothing;
// - the statusLine saves the JSON per session, beside the per-account usage reading;
// - the `--settings` JSON survives the launch's single quoting and one more shellescape layer;
// - the remote pane exports $CLAUDE_RC_SESSION for claude only;
// - the read script, run under `sh` against those files, and its parser: first read skips old
//   events, later reads tail only new bytes, a replaced file restarts at 0;
// - the service: polling cadence with and without a browser, backoff, busy shells;
// - the mapping: events go through the same handler as `/api/hook-event` (Approvals Inbox,
//   broadcast, push), statuslines through the same applier as `/api/status-telemetry`.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLaunch,
  buildRemoteSignalsSettings,
  buildWindowsSignalsSettings,
  REMOTE_HOOK_EVENTS,
  REMOTE_SIGNALS_VERSION,
  WINDOWS_CLAUDE_BINARY,
  WINDOWS_SIGNALS_DIR,
  WINDOWS_SIGNALS_SCRIPT,
  type FleetAccount,
} from '../src/fleet.js';
import { shellescape } from '../src/remote-hosts.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import {
  buildSignalsReadScript,
  FIRST_BACKOFF_MS,
  parseEventLines,
  parseSignalsReadOutput,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  remoteSignalsKey,
  remoteSignalsSupport,
  RemoteSessionSignals,
  selectEventsToApply,
  STALE_EVENT_S,
  type RemoteSignalsPorts,
  type SignalsSession,
} from '../src/remote-session-signals.js';
import { parseStatusUsage } from '../src/usage-telemetry.js';
import { handleHookEvent } from '../src/web/routes/hook-event-routes.js';
import { createStatuslineApplier } from '../src/web/status-telemetry-apply.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { SessionStatusTelemetry } from '../src/web/sse-events.js';
import { createMockRouteContext } from './mocks/index.js';
import { Session } from '../src/session.js';
import type { SessionRemote } from '../src/types.js';

const account: FleetAccount = { id: 'personal', label: 'Personal', kind: 'token', secret: 'x' };
const KEY = 'codeman-ssh-abcdef12';
const SESSION_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
const STATUSLINE = JSON.stringify({
  model: { display_name: 'Opus' },
  version: '2.1.300',
  context_window: {
    used_percentage: 42,
    total_input_tokens: 1_250_000,
    total_output_tokens: 34_000,
    context_window_size: 200_000,
    current_usage: { input_tokens: 4_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 70_000 },
  },
  cost: { total_cost_usd: 1.234 },
  rate_limits: { five_hour: { used_percentage: 11, resets_at: 1793301000 } },
});
const HOOK_INPUT = JSON.stringify({
  session_id: 'conv',
  hook_event_name: 'Notification',
  message: 'Claude needs your permission to use Bash',
  prompt: 'SECRET PROMPT TEXT',
  tool_input: { command: 'rm -rf SECRET' },
});

function home(): string {
  return mkdtempSync(join(tmpdir(), 'rc-signals-'));
}

function settingsOf(args: string): ReturnType<typeof buildRemoteSignalsSettings> {
  const json = args.match(/--settings '([^']*)'/)?.[1];
  expect(json).toBeTruthy();
  return JSON.parse(json as string);
}

function hookCommand(settings: ReturnType<typeof buildRemoteSignalsSettings>, event: string): string {
  const spec = REMOTE_HOOK_EVENTS.find((e) => e.event === event)!;
  const entry = settings.hooks[spec.hook].find((h) => ('matcher' in spec ? h.matcher === spec.matcher : !h.matcher));
  return entry!.hooks[0].command;
}

function runSh(command: string, env: Record<string, string>, input = ''): string {
  return execFileSync('sh', ['-c', command], { input, env: { ...process.env, ...env } }).toString();
}

const remote = (extra: Partial<SessionRemote> = {}): SessionRemote => ({
  hostId: 'desk-wsl',
  label: 'Desktop WSL',
  host: '192.168.0.28',
  username: 'andy',
  remotePath: '/home/andy/project',
  system: 'wsl',
  launch: { setup: '', binary: 'claude', args: '', signals: REMOTE_SIGNALS_VERSION },
  ...extra,
});

describe('the launch records hook events and statuslines on the machine', () => {
  it('hook commands append `<seconds> <event>` per hook, print nothing and write no prompt text', () => {
    const launch = buildLaunch({ system: 'linux' }, account, undefined);
    expect(launch.signals).toBe(REMOTE_SIGNALS_VERSION);
    const settings = settingsOf(launch.args);
    const h = home();
    const before = Math.floor(Date.now() / 1000);
    for (const { event } of REMOTE_HOOK_EVENTS) {
      expect(runSh(hookCommand(settings, event), { HOME: h, CLAUDE_RC_SESSION: KEY }, HOOK_INPUT)).toBe('');
    }
    const log = readFileSync(join(h, '.config/claude-rc/events', `${KEY}.log`), 'utf8');
    expect(log).not.toContain('SECRET');
    expect(log).not.toContain('permission to use');
    const lines = log.trimEnd().split('\n');
    expect(lines.map((l) => l.split(' ')[1])).toEqual(REMOTE_HOOK_EVENTS.map((e) => e.event));
    for (const line of lines) {
      expect(line).toMatch(/^\d+ [a-z_]+$/);
      expect(Number(line.split(' ')[0])).toBeGreaterThanOrEqual(before);
    }
    // The settings carry the matchers Claude Code dispatches Notification hooks on.
    expect(settings.hooks.Notification.map((e) => e.matcher)).toEqual([
      'permission_prompt',
      'idle_prompt',
      'elicitation_dialog',
      'elicitation_complete',
      'elicitation_response',
    ]);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('writes nothing without $CLAUDE_RC_SESSION (a pane that does not export it)', () => {
    const settings = settingsOf(buildLaunch({ system: 'linux' }, undefined, undefined).args);
    const h = home();
    const env = { ...process.env, HOME: h };
    delete env.CLAUDE_RC_SESSION;
    execFileSync('sh', ['-c', hookCommand(settings, 'stop')], { input: HOOK_INPUT, env });
    execFileSync('sh', ['-c', settings.statusLine.command], { input: STATUSLINE, env });
    expect(existsSync(join(h, '.config/claude-rc/events'))).toBe(false);
    expect(existsSync(join(h, '.config/claude-rc/session', `${KEY}.json`))).toBe(false);
    // The per-account usage reading still lands, as before.
    expect(existsSync(join(h, '.config/claude-rc/status/_machine.json'))).toBe(true);
  });

  it('the statusLine saves the JSON per session beside the per-account reading, and prints nothing', () => {
    const h = home();
    const token = settingsOf(buildLaunch({ system: 'linux' }, account, undefined).args);
    expect(runSh(token.statusLine.command, { HOME: h, CLAUDE_RC_SESSION: KEY }, STATUSLINE)).toBe('');
    expect(readFileSync(join(h, '.config/claude-rc/session', `${KEY}.json`), 'utf8')).toBe(STATUSLINE);
    expect(readFileSync(join(h, '.config/claude-rc/status/personal.json'), 'utf8')).toBe(STATUSLINE);

    // An api account: the per-session figures only, no account usage, no temp file left behind.
    const h2 = home();
    const api = settingsOf(
      buildLaunch(
        { system: 'linux' },
        { id: 'glm', label: 'GLM', kind: 'api', baseUrl: 'https://api.example.com', secret: 'k' },
        undefined
      ).args
    );
    runSh(api.statusLine.command, { HOME: h2, CLAUDE_RC_SESSION: KEY }, STATUSLINE);
    expect(readFileSync(join(h2, '.config/claude-rc/session', `${KEY}.json`), 'utf8')).toBe(STATUSLINE);
    expect(execFileSync('ls', ['-A', join(h2, '.config/claude-rc/status')]).toString()).toBe('');
    expect(
      execFileSync('ls', ['-A', join(h2, '.config/claude-rc')])
        .toString()
        .split('\n')
        .filter(Boolean)
    ).toEqual(['session', 'status']);
  });

  it('carries no quote or backslash, so the JSON survives the single-quoted launch and another shellescape', () => {
    const launch = buildLaunch({ system: 'linux' }, undefined, undefined);
    const json = launch.args.match(/--settings '([^']*)'/)?.[1] as string;
    expect(json).not.toMatch(/['\\]/);
    expect(json.replace(/\\"/g, '')).not.toContain('\\');
    // A fake `claude` records its argv; the launch runs through two shell layers, like the
    // remote login shell's `-c` around it.
    const bin = home();
    const out = join(bin, 'argv');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${out}\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const inner = `${launch.setup}claude${launch.args} --session-id ${SESSION_ID}`;
    execFileSync('sh', ['-c', `sh -c ${shellescape(inner)}`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const argv = readFileSync(out, 'utf8').trimEnd().split('\n');
    expect(argv[0]).toBe('--settings');
    expect(JSON.parse(argv[1])).toEqual(buildRemoteSignalsSettings('_machine'));
    expect(argv.slice(2)).toEqual(['--session-id', SESSION_ID]);
  });

  it('the remote pane exports $CLAUDE_RC_SESSION (its tmux name) for claude only', () => {
    const r = remote();
    const claude = buildRemoteLaunchCommand({ mode: 'claude', remote: r, sessionId: SESSION_ID });
    expect(claude).toContain(`export CLAUDE_RC_SESSION=${KEY}`);
    expect(remoteSignalsKey(r, SESSION_ID)).toBe(KEY);
    expect(buildRemoteLaunchCommand({ mode: 'shell', remote: r, sessionId: SESSION_ID })).not.toContain(
      'CLAUDE_RC_SESSION'
    );
    expect(
      buildRemoteLaunchCommand({
        mode: 'claude',
        remote: remote({ commands: { claude: 'claude --foo' } }),
        sessionId: SESSION_ID,
      })
    ).not.toContain('CLAUDE_RC_SESSION');
    // A re-attached session keeps its old remote name, and so its files.
    expect(remoteSignalsKey(remote({ owned: false, remoteSessionName: 'codeman-ssh-0badf00d' }), SESSION_ID)).toBe(
      'codeman-ssh-0badf00d'
    );
  });

  it('keeps the whole ssh/tmux launch line well inside tmux command limits', () => {
    // tmux refuses a command over its 16 KiB message size; the launch names claude twice
    // (`--session-id … || --resume …`) and every layer re-quotes, so keep a wide margin.
    const launch = buildLaunch({ system: 'wsl' }, account, 'opus');
    const line = buildRemoteLaunchCommand({ mode: 'claude', remote: remote({ launch }), sessionId: SESSION_ID });
    expect(line).toContain('CLAUDE_RC_SESSION');
    expect(line.length).toBeLessThan(10_000);
  });
});

// Windows-native sessions (fleet.ts `buildWindowsSignalsSetup`). Windows claude runs statusLine
// and hook commands in Git Bash, else PowerShell, so the commands call wsl.exe back into WSL.
// Neither Windows shell nor wsl.exe can run here, so the tests pin what they depend on:
// - the launch, run through the same shell layers as the pane, writes the script and the
//   session's settings file and hands claude only the file's `\\wsl.localhost\…` path;
// - every command is plain words (nothing Git Bash, PowerShell or cmd would expand or
//   re-quote, no argument starting with `/`, which Git Bash rewrites into a Windows path);
// - what wsl.exe would then run (`sh <relative script> …`, from a Windows working directory
//   mapped under /mnt/c, with another HOME) writes the files the server's read script finds.
describe('Windows-native sessions record through wsl.exe', () => {
  const DISTRO = 'Ubuntu-22.04';
  const USER = execFileSync('id', ['-un']).toString().trim();

  /** A fake `wslpath -w` and `claude` (records argv) on PATH. */
  function fakeBin(): { bin: string; argvFile: string } {
    const bin = home();
    const argvFile = join(bin, 'argv');
    writeFileSync(
      join(bin, 'wslpath'),
      `#!/bin/sh\nprintf '%s\\n' "\\\\\\\\wsl.localhost\\\\${DISTRO}$2" | tr / '\\\\'\n`
    );
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${argvFile}\n`);
    chmodSync(join(bin, 'wslpath'), 0o755);
    chmodSync(join(bin, 'claude'), 0o755);
    return { bin, argvFile };
  }

  /** Runs a launch the way the pane does (a login shell's `-c` around it), with `claude` faked. */
  function runLaunch(
    launch: ReturnType<typeof buildLaunch>,
    env: Record<string, string | undefined>,
    shell = 'sh'
  ): { argv: string[]; h: string } {
    const { bin, argvFile } = fakeBin();
    const h = home();
    // The token/api accounts' keys, which the launch reads from the machine.
    execFileSync('mkdir', ['-p', join(h, '.config/claude-rc')]);
    for (const id of ['personal', 'glm']) writeFileSync(join(h, `.config/claude-rc/${id}.secret`), 'k\n');
    const inner = `${launch.setup}claude${launch.args} --session-id ${SESSION_ID}`;
    const fullEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: h,
      PATH: `${bin}:${process.env.PATH}`,
      WSL_DISTRO_NAME: DISTRO,
      CLAUDE_RC_SESSION: KEY,
      ...env,
    };
    for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
    execFileSync('sh', ['-c', `${shell} -c ${shellescape(inner)}`], { env: fullEnv as NodeJS.ProcessEnv });
    return { argv: readFileSync(argvFile, 'utf8').trimEnd().split('\n'), h };
  }

  /** What wsl.exe would run for one command: checks its words, then runs `sh <script> …`. */
  function runAsWsl(command: string, h: string, input: string): string {
    expect(command).toMatch(/^[A-Za-z0-9 ._/-]+$/);
    const words = command.split(' ');
    expect(words.some((w) => w.startsWith('/'))).toBe(false);
    expect(words.slice(0, 7)).toEqual(['wsl.exe', '-d', DISTRO, '-u', USER, '-e', 'sh']);
    // The Windows working directory, as WSL maps it (deep, under a stand-in for /mnt/c), and a
    // HOME that is not the session's: the script must find its folder from its own path.
    const cwd = join(home(), 'mnt/c/Users/me/source/repos/some/project');
    execFileSync('mkdir', ['-p', cwd]);
    return execFileSync('sh', words.slice(7), { cwd, input, env: { ...process.env, HOME: home() } }).toString();
  }

  function settingsFile(h: string): ReturnType<typeof buildRemoteSignalsSettings> {
    return JSON.parse(readFileSync(join(h, WINDOWS_SIGNALS_DIR, `${KEY}.json`), 'utf8'));
  }

  it('the launch writes the settings to a file and passes only its Windows path', () => {
    const launch = buildLaunch({ system: 'windows' }, account, 'opus');
    expect(launch.binary).toBe(WINDOWS_CLAUDE_BINARY);
    expect(launch.signals).toBe(REMOTE_SIGNALS_VERSION);
    // No JSON reaches the Windows command line.
    expect(launch.args).not.toContain('{');
    for (const shell of ['sh', 'bash']) {
      const { argv, h } = runLaunch(launch, {}, shell);
      const file = join(h, WINDOWS_SIGNALS_DIR, `${KEY}.json`);
      expect(argv).toEqual([
        '--model',
        'opus',
        '--settings',
        `\\\\wsl.localhost\\${DISTRO}${file.replace(/\//g, '\\')}`,
        '--session-id',
        SESSION_ID,
      ]);
      // A path claude.exe can take through cmd.exe and the claude.cmd shim: no quote, space or metacharacter.
      expect(argv[3]).toMatch(/^[A-Za-z0-9\\._-]+$/);
      const script = `${'../'.repeat(31)}..${h}/${WINDOWS_SIGNALS_DIR}/rc.sh`;
      expect(settingsFile(h)).toEqual(
        buildWindowsSignalsSettings('personal', `wsl.exe -d ${DISTRO} -u ${USER} -e sh ${script} ${KEY}`)
      );
      expect(readFileSync(join(h, WINDOWS_SIGNALS_DIR, 'rc.sh'), 'utf8').trim()).toBe(WINDOWS_SIGNALS_SCRIPT);
    }
  });

  it('hooks append `<seconds> <event>` and the statusLine saves per session and per account, via wsl.exe', () => {
    const { h } = runLaunch(buildLaunch({ system: 'windows' }, account, undefined), {});
    const settings = settingsFile(h);
    const before = Math.floor(Date.now() / 1000);
    for (const { event } of REMOTE_HOOK_EVENTS) {
      expect(runAsWsl(hookCommand(settings, event), h, HOOK_INPUT)).toBe('');
    }
    const log = readFileSync(join(h, '.config/claude-rc/events', `${KEY}.log`), 'utf8');
    expect(log).not.toContain('SECRET');
    const lines = log.trimEnd().split('\n');
    expect(lines.map((l) => l.split(' ')[1])).toEqual(REMOTE_HOOK_EVENTS.map((e) => e.event));
    for (const line of lines) {
      expect(line).toMatch(/^\d+ [a-z_]+$/);
      expect(Number(line.split(' ')[0])).toBeGreaterThanOrEqual(before);
    }
    expect(settings.hooks.Notification.map((e) => e.matcher)).toEqual(
      REMOTE_HOOK_EVENTS.filter((e) => e.hook === 'Notification').map((e) => e.matcher)
    );

    expect(runAsWsl(settings.statusLine.command, h, STATUSLINE)).toBe('');
    expect(readFileSync(join(h, '.config/claude-rc/session', `${KEY}.json`), 'utf8')).toBe(STATUSLINE);
    expect(readFileSync(join(h, '.config/claude-rc/status/personal.json'), 'utf8')).toBe(STATUSLINE);
    // No temp file left behind.
    const entries = execFileSync('ls', ['-A', join(h, '.config/claude-rc')])
      .toString()
      .split('\n');
    expect(entries.filter((e) => e && !e.endsWith('.secret'))).toEqual(['events', 'session', 'status', 'win']);

    // The server's read script, run on the machine, finds them like a WSL session's.
    const read = parseSignalsReadOutput(
      execFileSync('sh', ['-c', buildSignalsReadScript([{ key: KEY, offset: 0, statusMtime: null }])], {
        env: { ...process.env, HOME: h },
      }).toString()
    );
    expect(parseEventLines(read.events.get(KEY)!.body).events.map((e) => e.event)).toEqual(
      REMOTE_HOOK_EVENTS.map((e) => e.event)
    );
    expect(JSON.parse(read.status.get(KEY)!.body)).toEqual(JSON.parse(STATUSLINE));
  });

  it('saves no account usage for the Windows login or an api account, only the session figures', () => {
    const api: FleetAccount = { id: 'glm', label: 'GLM', kind: 'api', baseUrl: 'https://a.example', secret: 'k' };
    for (const acct of [undefined, api]) {
      const { h } = runLaunch(buildLaunch({ system: 'windows' }, acct, undefined), {});
      const settings = settingsFile(h);
      expect(settings.statusLine.command.endsWith(`${KEY} s -`)).toBe(true);
      runAsWsl(settings.statusLine.command, h, STATUSLINE);
      expect(readFileSync(join(h, '.config/claude-rc/session', `${KEY}.json`), 'utf8')).toBe(STATUSLINE);
      expect(execFileSync('ls', ['-A', join(h, '.config/claude-rc/status')]).toString()).toBe('');
    }
  });

  it('starts claude with empty settings, writing nothing, when the key, distro or home is missing or odd', () => {
    const launch = buildLaunch({ system: 'windows' }, undefined, undefined);
    for (const env of [
      { CLAUDE_RC_SESSION: undefined },
      { CLAUDE_RC_SESSION: 'bad key' },
      { WSL_DISTRO_NAME: undefined },
      { WSL_DISTRO_NAME: 'My Distro' },
    ]) {
      const { argv, h } = runLaunch(launch, env);
      expect(argv).toEqual(['--settings', '{}', '--session-id', SESSION_ID]);
      expect(existsSync(join(h, WINDOWS_SIGNALS_DIR))).toBe(false);
    }
    // A HOME with a space would split the command words.
    const { argv } = runLaunch(launch, { HOME: join(home(), 'my home') });
    expect(argv.slice(0, 2)).toEqual(['--settings', '{}']);
  });

  it('the script never fails a hook and ignores a bad key or event', () => {
    const h = home();
    const dir = join(h, WINDOWS_SIGNALS_DIR);
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 'rc.sh'), WINDOWS_SIGNALS_SCRIPT);
    const run = (...args: string[]) =>
      execFileSync('sh', [join(dir, 'rc.sh'), ...args], { input: HOOK_INPUT, cwd: h, stdio: 'pipe' }).toString();
    expect(run('bad/key', 'e', 'stop')).toBe('');
    expect(run(KEY, 'e', 'Stop;rm')).toBe('');
    expect(existsSync(join(h, '.config/claude-rc/events'))).toBe(false);
    // A folder it cannot write still exits 0 (a Stop hook exiting 2 would block the turn).
    writeFileSync(join(h, '.config/claude-rc/events'), 'not a folder');
    expect(run(KEY, 'e', 'stop')).toBe('');
  });

  it('keeps the Windows launch line well inside tmux command limits', () => {
    const launch = buildLaunch({ system: 'windows' }, account, 'opus');
    const line = buildRemoteLaunchCommand({
      mode: 'claude',
      remote: remote({ system: 'windows', launch }),
      sessionId: SESSION_ID,
    });
    expect(line).toContain(`export CLAUDE_RC_SESSION=${KEY}`);
    expect(line.length).toBeLessThan(10_000);
  });
});

describe('reading the files back', () => {
  /** Run the read script on the "machine" (a local sh with that HOME). */
  const read = (h: string, entries: Parameters<typeof buildSignalsReadScript>[0]) =>
    parseSignalsReadOutput(runSh(buildSignalsReadScript(entries), { HOME: h }));

  it('reports sizes on a first read, then only the bytes past the offset; a replaced file restarts at 0', () => {
    const h = home();
    const settings = settingsOf(buildLaunch({ system: 'linux' }, account, undefined).args);
    const env = { HOME: h, CLAUDE_RC_SESSION: KEY };
    expect(read(h, [{ key: KEY, offset: null, statusMtime: null }]).events.get(KEY)).toEqual({ size: -1, body: '' });

    runSh(hookCommand(settings, 'idle_prompt'), env, HOOK_INPUT);
    const first = read(h, [{ key: KEY, offset: null, statusMtime: null }]);
    expect(first.now).toBeGreaterThan(0);
    const size = first.events.get(KEY)!.size;
    expect(size).toBeGreaterThan(0);
    expect(first.events.get(KEY)!.body).toBe('');

    runSh(hookCommand(settings, 'permission_prompt'), env, HOOK_INPUT);
    const next = read(h, [{ key: KEY, offset: size, statusMtime: null }]).events.get(KEY)!;
    expect(parseEventLines(next.body).events.map((e) => e.event)).toEqual(['permission_prompt']);
    expect(parseEventLines(next.body).consumed).toBe(next.size - size);

    writeFileSync(join(h, '.config/claude-rc/events', `${KEY}.log`), '1 stop\n');
    const replaced = read(h, [{ key: KEY, offset: next.size, statusMtime: null }]).events.get(KEY)!;
    expect(replaced).toEqual({ size: 7, body: '1 stop\n' });
  });

  it('sends the statusline when it changed (or was just written), with its mtime', () => {
    const h = home();
    const settings = settingsOf(buildLaunch({ system: 'linux' }, account, undefined).args);
    runSh(settings.statusLine.command, { HOME: h, CLAUDE_RC_SESSION: KEY }, STATUSLINE);
    const first = read(h, [{ key: KEY, offset: 0, statusMtime: null }]).status.get(KEY)!;
    expect(first.mtime).toBeGreaterThan(0);
    expect(JSON.parse(first.body)).toEqual(JSON.parse(STATUSLINE));
    // Same mtime and well in the past: nothing to send.
    execFileSync('touch', ['-d', '@1000000000', join(h, '.config/claude-rc/session', `${KEY}.json`)]);
    expect(read(h, [{ key: KEY, offset: 0, statusMtime: 1000000000 }]).status.get(KEY)).toEqual({
      mtime: 1000000000,
      body: '',
    });
    expect(read(h, [{ key: 'codeman-ssh-none', offset: 0, statusMtime: null }]).status.get('codeman-ssh-none')).toEqual(
      { mtime: -1, body: '' }
    );
  });

  it('leaves out keys that are not plain names', () => {
    const script = buildSignalsReadScript([
      { key: 'codeman-ssh-ok', offset: 0, statusMtime: null },
      { key: 'bad; rm -rf ~', offset: 0, statusMtime: null },
    ]);
    expect(script).toContain('rce codeman-ssh-ok 0');
    expect(script).not.toContain('rm -rf');
  });

  it('parses complete lines only and skips unknown events', () => {
    expect(parseEventLines('10 stop\n11 bogus\n12 idle_prompt\n13 perm')).toEqual({
      events: [
        { at: 10, event: 'stop' },
        { at: 12, event: 'idle_prompt' },
      ],
      consumed: '10 stop\n11 bogus\n12 idle_prompt\n'.length,
    });
    expect(parseEventLines('13 perm')).toEqual({ events: [], consumed: 0 });
  });

  it('drops stale events by the remote clock, but keeps a last prompt that is still standing', () => {
    const now = 10_000;
    const old = now - STALE_EVENT_S - 1;
    expect(
      selectEventsToApply(
        [
          { at: old, event: 'permission_prompt' },
          { at: old, event: 'stop' },
          { at: now - 5, event: 'idle_prompt' },
        ],
        now
      ).map((e) => e.event)
    ).toEqual(['idle_prompt']);
    expect(selectEventsToApply([{ at: old, event: 'permission_prompt' }], now).map((e) => e.event)).toEqual([
      'permission_prompt',
    ]);
    expect(selectEventsToApply([{ at: old, event: 'stop' }], now)).toEqual([]);
    expect(selectEventsToApply([{ at: old, event: 'stop' }], null)).toHaveLength(1);
  });
});

describe('RemoteSessionSignals', () => {
  function setup(opts: { browser?: boolean } = {}) {
    const h = home();
    const settings = settingsOf(buildLaunch({ system: 'linux' }, account, undefined).args);
    const session: SignalsSession = { id: SESSION_ID, mode: 'claude', remote: remote() };
    let browser = opts.browser ?? true;
    const ports = {
      sessions: () => [session],
      browserConnected: () => browser,
      exec: vi.fn(async (_r: SessionRemote, script: string) => runSh(script, { HOME: h })),
      applyEvent: vi.fn(),
      applyStatusline: vi.fn(),
      markSeen: vi.fn(),
    } satisfies RemoteSignalsPorts;
    const service = new RemoteSessionSignals(ports);
    const hook = (event: string) =>
      runSh(hookCommand(settings, event), { HOME: h, CLAUDE_RC_SESSION: KEY }, HOOK_INPUT);
    const status = (json: string) => runSh(settings.statusLine.command, { HOME: h, CLAUDE_RC_SESSION: KEY }, json);
    return { h, ports, service, hook, status, setBrowser: (v: boolean) => (browser = v) };
  }

  it('skips what was there before the first read, then feeds each new event and the statusline', async () => {
    const { ports, service, hook, status } = setup();
    hook('permission_prompt'); // before the server was looking
    status(STATUSLINE);
    const t0 = 1_000_000;
    await service.tick(t0);
    expect(ports.exec).toHaveBeenCalledTimes(1);
    expect(ports.applyEvent).not.toHaveBeenCalled();
    expect(ports.markSeen).toHaveBeenCalledTimes(1);
    expect(ports.applyStatusline).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID }),
      JSON.parse(STATUSLINE)
    );

    hook('idle_prompt');
    hook('stop');
    await service.tick(t0 + 1_000); // inside the interval: no read
    expect(ports.exec).toHaveBeenCalledTimes(1);
    await service.tick(t0 + POLL_ACTIVE_MS);
    expect(ports.exec).toHaveBeenCalledTimes(2);
    expect(ports.applyEvent.mock.calls.map(([, e]) => e)).toEqual(['idle_prompt', 'stop']);

    // Nothing new: nothing applied again.
    await service.tick(t0 + 2 * POLL_ACTIVE_MS);
    expect(ports.applyEvent).toHaveBeenCalledTimes(2);
    expect(ports.markSeen).toHaveBeenCalledTimes(1);
  });

  it('polls slowly with no browser connected, and backs off a host that fails', async () => {
    const { ports, service } = setup({ browser: false });
    const t0 = 2_000_000;
    await service.tick(t0);
    await service.tick(t0 + POLL_ACTIVE_MS);
    expect(ports.exec).toHaveBeenCalledTimes(1);
    await service.tick(t0 + POLL_IDLE_MS);
    expect(ports.exec).toHaveBeenCalledTimes(2);

    ports.exec.mockRejectedValueOnce(Object.assign(new Error('ssh: connect timed out'), { code: 255 }));
    await service.tick(t0 + 2 * POLL_IDLE_MS);
    expect(ports.exec).toHaveBeenCalledTimes(3);
    await service.tick(t0 + 2 * POLL_IDLE_MS + FIRST_BACKOFF_MS - 1);
    expect(ports.exec).toHaveBeenCalledTimes(3);
    await service.tick(t0 + 3 * POLL_IDLE_MS + FIRST_BACKOFF_MS);
    expect(ports.exec).toHaveBeenCalledTimes(4);
  });

  it('retries on the next tick when the shells were busy with a user command', async () => {
    const { ports, service } = setup();
    ports.exec.mockRejectedValueOnce(Object.assign(new Error('shells busy'), { code: 'EBUSY' }));
    await service.tick(3_000_000);
    await service.tick(3_001_000);
    expect(ports.exec).toHaveBeenCalledTimes(2);
  });

  it('reads nothing for sessions launched before this (Windows ones too), or not claude', async () => {
    const reads = vi.fn(async () => '');
    const oldWindows = { setup: '', binary: WINDOWS_CLAUDE_BINARY, args: '' };
    const sessions: SignalsSession[] = [
      { id: 'a', mode: 'claude', remote: remote({ launch: { setup: '', binary: 'claude', args: '' } }) },
      { id: 'b', mode: 'claude', remote: remote({ system: 'windows', launch: oldWindows }) },
      { id: 'c', mode: 'shell', remote: remote() },
      { id: 'd', mode: 'claude' },
    ];
    const service = new RemoteSessionSignals({
      sessions: () => sessions,
      browserConnected: () => true,
      exec: reads,
      applyEvent: vi.fn(),
      applyStatusline: vi.fn(),
      markSeen: vi.fn(),
    });
    await service.tick(1);
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('who gets it', () => {
  it('remoteSignalsSupport', () => {
    expect(remoteSignalsSupport({ mode: 'claude', remote: remote() })).toBe('on');
    expect(
      remoteSignalsSupport({ mode: 'claude', remote: remote({ launch: { setup: '', binary: 'claude', args: '' } }) })
    ).toBe('relaunch');
    expect(remoteSignalsSupport({ mode: 'claude', remote: remote({ launch: undefined }) })).toBe('relaunch');
    // Windows-native: told apart by its launch record like the others (wsl.exe route).
    expect(remoteSignalsSupport({ mode: 'claude', remote: remote({ system: 'windows' }) })).toBe('on');
    const oldWindows = remote({ system: 'windows', launch: { setup: '', binary: WINDOWS_CLAUDE_BINARY, args: '' } });
    expect(remoteSignalsSupport({ mode: 'claude', remote: oldWindows })).toBe('relaunch');
    expect(
      remoteSignalsSupport({ mode: 'claude', remote: remote({ system: 'windows', commands: { claude: 'x' } }) })
    ).toBe('unsupported');
    expect(remoteSignalsSupport({ mode: 'claude', remote: remote({ commands: { claude: 'x' } }) })).toBe('unsupported');
    const adopted = remote({ owned: false, remoteSessionName: 'main', remoteTmuxSocket: 'default' });
    expect(remoteSignalsSupport({ mode: 'claude', remote: adopted })).toBe('unsupported');
    // A re-attached session of ours: its launch record is gone, its files may not be.
    const reclaimed = remote({ owned: false, remoteSessionName: 'codeman-ssh-0badf00d', launch: undefined });
    expect(remoteSignalsSupport({ mode: 'claude', remote: reclaimed })).toBe('relaunch');
    expect(remoteSignalsSupport({ mode: 'claude', remote: reclaimed }, true)).toBe('on');
    expect(remoteSignalsSupport({ mode: 'shell', remote: remote() })).toBeUndefined();
    expect(remoteSignalsSupport({ mode: 'claude' })).toBeUndefined();
    expect(remoteSignalsSupport({ mode: 'claude', remote: remote(), docker: {} })).toBeUndefined();
  });

  it('a Session publishes it, and its statusline figures, in its state', () => {
    const on = new Session({ workingDir: '/home/andy/project', remote: remote() });
    expect(on.toState().remoteSignals).toBe('on');
    const old = new Session({
      workingDir: '/home/andy/project',
      remote: remote({ launch: { setup: '', binary: 'claude', args: '' } }),
    });
    expect(old.toState().remoteSignals).toBe('relaunch');
    expect(new Session({ workingDir: '/tmp' }).toState().remoteSignals).toBeUndefined();

    const reclaimed = new Session({
      workingDir: '/home/andy/project',
      remote: remote({ owned: false, remoteSessionName: 'codeman-ssh-0badf00d', launch: undefined }),
    });
    expect(reclaimed.markRemoteSignalsSeen()).toBe(true);
    expect(reclaimed.toState().remoteSignals).toBe('on');
    expect(reclaimed.markRemoteSignalsSeen()).toBe(false);

    const usage = parseStatusUsage(JSON.parse(STATUSLINE), 5)!;
    expect(on.noteStatusUsage(usage)).toBe(true);
    expect(on.noteStatusUsage({ ...usage, at: 6 })).toBe(false); // the read time alone is no change
    expect(on.noteStatusUsage({ ...usage, costUsd: 2 })).toBe(true);
    expect(on.toState().statusUsage).toMatchObject({ contextTokens: 84_000, costUsd: 2 });
  });
});

describe('statusline figures', () => {
  it('parseStatusUsage reads context, totals and cost; null without any', () => {
    expect(parseStatusUsage(JSON.parse(STATUSLINE), 7)).toEqual({
      at: 7,
      contextTokens: 84_000,
      contextWindow: 200_000,
      contextPercent: 42,
      totalInputTokens: 1_250_000,
      totalOutputTokens: 34_000,
      costUsd: 1.234,
    });
    // Percent derived when Claude Code does not send it.
    expect(
      parseStatusUsage({ context_window: { context_window_size: 1000, current_usage: { input_tokens: 250 } } }, 1)
        ?.contextPercent
    ).toBe(25);
    expect(parseStatusUsage({ model: { display_name: 'Opus' } }, 1)).toBeNull();
    expect(parseStatusUsage({ context_window: { current_usage: null }, cost: { total_cost_usd: -1 } }, 1)).toBeNull();
    expect(parseStatusUsage(undefined, 1)).toBeNull();
  });
});

describe('mapping onto session state (the same paths as the local POSTs)', () => {
  afterEach(() => {
    approvalInbox.resolveForSession('test-session-1', 'dismissed');
  });

  it('events open and clear the Approvals Inbox item, broadcast `hook:<event>` and push', () => {
    const ctx = createMockRouteContext();
    const sid = ctx._sessionId;
    handleHookEvent(ctx as never, 'permission_prompt', sid, undefined);
    expect(approvalInbox.getForSession(sid)?.kind).toBe('permission');
    expect(ctx.broadcast).toHaveBeenCalledWith('hook:permission_prompt', expect.objectContaining({ sessionId: sid }));
    expect(ctx.sendPushNotifications).toHaveBeenCalledWith(
      'hook:permission_prompt',
      expect.objectContaining({ sessionId: sid })
    );
    handleHookEvent(ctx as never, 'stop', sid, undefined);
    expect(approvalInbox.getForSession(sid)).toBeUndefined();

    handleHookEvent(ctx as never, 'idle_prompt', sid, undefined);
    expect(approvalInbox.getForSession(sid)?.kind).toBe('idle');
    expect(ctx.broadcast).toHaveBeenCalledWith('hook:idle_prompt', expect.objectContaining({ sessionId: sid }));
  });

  it('a remote statusline updates the model, version and figures, never the plan chip or the cache', () => {
    const ctx = createMockRouteContext();
    const session = ctx._session;
    const applier = createStatuslineApplier(ctx as never);
    const payload = JSON.parse(STATUSLINE);
    applier.apply(session as never, payload, { promptCache: false, planUsage: false });
    expect(session.noteReportedModel).toHaveBeenCalledWith('statusline', 'Opus');
    expect(session.noteReportedCliVersion).toHaveBeenCalledWith('2.1.300');
    expect(session.statusUsage).toMatchObject({ contextTokens: 84_000, contextWindow: 200_000, costUsd: 1.234 });
    expect(ctx.broadcastSessionStateDebounced).toHaveBeenCalledTimes(1);
    expect(ctx.broadcast).not.toHaveBeenCalled();
    // The same report again: no rebroadcast.
    applier.apply(session as never, payload, { promptCache: false, planUsage: false });
    expect(ctx.broadcastSessionStateDebounced).toHaveBeenCalledTimes(1);

    // The local exporter's path still feeds the plan chip.
    applier.apply(session as never, payload, { promptCache: true, planUsage: true });
    expect(ctx.broadcast).toHaveBeenCalledWith(
      SessionStatusTelemetry,
      expect.objectContaining({ sessionId: ctx._sessionId })
    );
  });
});
