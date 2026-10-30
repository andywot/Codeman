// Port: none (runs the real poll script and the Git Bash shim under `sh` against temporary folders,
// with stand-ins for cmd.exe, wslpath and wsl.exe; nothing listens).
//
// Agent mail for native Windows claude (fork). Pinned here:
// - the poll's `W` step finds the Windows profile through cmd.exe + wslpath and installs the
//   Windows skill, `rc-mail.cmd` and the Git Bash shim there, filled with checked values only;
// - no interop, an unusable answer, a symlinked folder or a hostile user/home/distro name writes
//   nothing (or leaves the wrappers out), and a user's own copy (marker removed) is kept;
// - cmd.exe never eats the poll's stdin (later lines still apply);
// - the shim hands its arguments to wsl.exe verbatim and extends WSLENV;
// - the relay sends `W` only to a login with a Windows system, once, and lists a Windows dashboard
//   session by key while keeping the folder fallback; the Windows launch exports the key in WSLENV.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAIL_DIR,
  MAIL_POLL_SCRIPT,
  WIN_MAIL_CMD,
  WIN_MAIL_SHIM,
  WIN_MAIL_SKILL,
  buildPollInput,
  mailEndpoints,
  parsePollOutput,
  type PollInput,
} from '../src/agent-mail.js';
import {
  RC_MAIL_CLI,
  RC_MAIL_SKILL,
  RC_MAIL_WINDOWS_CMD,
  RC_MAIL_WINDOWS_SHIM,
  RC_MAIL_WINDOWS_SKILL,
  RC_MAIL_WRAPPER_WSLENV,
} from '../src/agent-mail-cli.js';
import { AgentMailRelay, type AgentMailPorts, type MailSessionView } from '../src/web/agent-mail-relay.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import type { RemoteHost, SessionRemote } from '../src/types/index.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const WINDOWS_ITEM: PollInput = {
  kind: 'windows',
  skill: RC_MAIL_WINDOWS_SKILL,
  cmd: RC_MAIL_WINDOWS_CMD,
  shim: RC_MAIL_WINDOWS_SHIM,
};

/**
 * A WSL machine: a HOME, a "Windows profile" folder, a stand-in cmd.exe printing `answer` (CRLF,
 * like the real one, and trying to read stdin) and a stand-in wslpath mapping it to the profile.
 */
function wslMachine(opts: { answer?: string; homePrefix?: string; distro?: string; noCmd?: boolean } = {}) {
  const home = tmp(opts.homePrefix ?? 'rcmail-wsl-');
  const profile = tmp('rcmail-winprofile-');
  const bin = tmp('rcmail-bin-');
  const cmd = join(bin, 'cmd.exe');
  const answer = opts.answer ?? 'C:\\Users\\Test';
  writeFileSync(cmd, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\r\\n' '${answer.replace(/'/g, "'\\''")}'\n`);
  chmodSync(cmd, 0o755);
  const wslpath = join(bin, 'wslpath');
  writeFileSync(wslpath, `#!/bin/sh\n[ "$1" = -u ] && [ "$2" = 'C:\\Users\\Test' ] && printf '%s\\n' '${profile}'\n`);
  chmodSync(wslpath, 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: home,
    RC_MAIL_CMD_EXE: opts.noCmd ? join(bin, 'missing.exe') : cmd,
    ...(opts.distro !== undefined ? { WSL_DISTRO_NAME: opts.distro } : {}),
  };
  const raw = (input: string) => execFileSync('sh', ['-c', MAIL_POLL_SCRIPT], { input, env, encoding: 'utf8' });
  const poll = (items: PollInput[]) => parsePollOutput(raw(buildPollInput(items)));
  return { home, profile, env, raw, poll, mail: join(home, MAIL_DIR) };
}

describe('Windows install (the poll W step)', () => {
  it('installs the skill and both wrappers, filled with the user, distro and CLI path', () => {
    const m = wslMachine({ distro: 'Ubuntu-22.04' });
    expect(m.poll([]).windows).toBeNull(); // never installed: `@@wv -`
    const out = m.poll([{ kind: 'install', cli: RC_MAIL_CLI, skill: RC_MAIL_SKILL }, WINDOWS_ITEM]);
    expect(out.windows).toEqual({ cmd: 1, shim: 1, skill: 1 });
    expect(readFileSync(join(m.mail, '.winhome'), 'utf8')).toBe(`${m.profile}\n`);
    expect(readFileSync(join(m.profile, WIN_MAIL_SKILL), 'utf8')).toBe(RC_MAIL_WINDOWS_SKILL);
    const user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
    const args = /^[a-z_][a-z0-9_.-]*$/.test(user) ? `-d Ubuntu-22.04 -u ${user}` : '';
    const cli = `${m.home}/.config/claude-rc/bin/rc-mail`;
    const cmd = readFileSync(join(m.profile, WIN_MAIL_CMD), 'utf8');
    if (args) {
      expect(cmd).toBe(RC_MAIL_WINDOWS_CMD.replace('@@WSLARGS@@', args).replace('@@CLI@@', cli));
      expect(cmd.split('\r\n').length).toBe(RC_MAIL_WINDOWS_CMD.split('\r\n').length); // CRLF kept
      expect(readFileSync(join(m.profile, WIN_MAIL_SHIM), 'utf8')).toBe(
        RC_MAIL_WINDOWS_SHIM.replace('@@WSLARGS@@', args).replace('@@CLI@@', cli)
      );
    }
    // Later polls report without re-running cmd.exe.
    expect(m.poll([]).windows).toEqual({ cmd: 1, shim: 1, skill: 1 });
  });

  it('cmd.exe cannot eat the poll input: lines after W still apply', () => {
    const m = wslMachine();
    const id = '1761800000-0123abcd';
    const out = m.poll([WINDOWS_ITEM, { kind: 'deliver', mailbox: 'ok', id, json: '{}\n', text: 'hello\n' }]);
    expect(out.delivered).toEqual([id]);
  });

  it('writes nothing without interop, or when cmd.exe gives no usable profile', () => {
    for (const opts of [{ noCmd: true }, { answer: '%USERPROFILE%' }, { answer: '/not/a/drive' }, { answer: '' }]) {
      const m = wslMachine(opts);
      const out = m.poll([WINDOWS_ITEM]);
      expect(out.windows).toBe('none');
      expect(readdirSync(m.profile)).toEqual([]);
    }
  });

  it('never writes through a symlinked folder or file, and keeps the user’s own copy', () => {
    const elsewhere = tmp('rcmail-elsewhere-');
    const a = wslMachine();
    symlinkSync(elsewhere, join(a.profile, '.claude'));
    a.poll([WINDOWS_ITEM]);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(a.profile, WIN_MAIL_CMD))).toBe(false);

    const b = wslMachine();
    mkdirSync(join(b.profile, '.config/claude-rc/bin'), { recursive: true });
    const target = join(elsewhere, 'target.cmd');
    writeFileSync(target, 'theirs');
    symlinkSync(target, join(b.profile, WIN_MAIL_CMD));
    writeFileSync(join(b.profile, WIN_MAIL_SHIM), '#!/bin/sh\necho mine\n');
    b.poll([WINDOWS_ITEM]);
    expect(readFileSync(target, 'utf8')).toBe('theirs');
    expect(lstatSync(join(b.profile, WIN_MAIL_CMD)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(b.profile, WIN_MAIL_SHIM), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(readFileSync(join(b.profile, WIN_MAIL_SKILL), 'utf8')).toBe(RC_MAIL_WINDOWS_SKILL);
    // A planted temp-file link is refused too.
    const c = wslMachine();
    mkdirSync(join(c.profile, '.claude/skills/rc-mail'), { recursive: true });
    symlinkSync(target, join(c.profile, `${WIN_MAIL_SKILL}.rcm-tmp`));
    c.poll([WINDOWS_ITEM]);
    expect(readFileSync(target, 'utf8')).toBe('theirs');
    expect(existsSync(join(c.profile, WIN_MAIL_SKILL))).toBe(false);
  });

  it('leaves hostile values out of the wrappers', () => {
    // A distro name that is not a plain word is dropped (wsl.exe then uses the default distro).
    const m = wslMachine({ distro: 'x" & calc & "' });
    m.poll([WINDOWS_ITEM]);
    const cmd = readFileSync(join(m.profile, WIN_MAIL_CMD), 'utf8');
    expect(cmd).not.toContain('calc');
    expect(cmd).not.toContain('-d ');
    // A home with characters the wrappers cannot carry safely: the skill only, no wrappers.
    const h = wslMachine({ homePrefix: 'rcmail win&x%-' });
    const out = h.poll([WINDOWS_ITEM]);
    expect(readFileSync(join(h.profile, WIN_MAIL_SKILL), 'utf8')).toBe(RC_MAIL_WINDOWS_SKILL);
    expect(existsSync(join(h.profile, WIN_MAIL_CMD))).toBe(false);
    expect(out.windows).toEqual({ cmd: 0, shim: 0, skill: 1 });
  });
});

describe('Git Bash shim', () => {
  it('hands arguments and stdin to wsl.exe verbatim and extends WSLENV', () => {
    const bin = tmp('rcmail-wslexe-');
    const log = join(bin, 'log');
    writeFileSync(
      join(bin, 'wsl.exe'),
      `#!/bin/sh\n{ for a in "$@"; do printf '[%s]\\n' "$a"; done; printf 'WSLENV=%s\\nCWD=%s\\nCONV=%s\\nIN=' "$WSLENV" "$RC_MAIL_CWD" "$MSYS2_ARG_CONV_EXCL"; cat; } > '${log}'\n`
    );
    chmodSync(join(bin, 'wsl.exe'), 0o755);
    const shim = join(bin, 'rc-mail');
    writeFileSync(
      shim,
      RC_MAIL_WINDOWS_SHIM.replace('@@WSLARGS@@', '-u test').replace(
        '@@CLI@@',
        '/home/test/.config/claude-rc/bin/rc-mail'
      )
    );
    chmodSync(shim, 0o755);
    const r = spawnSync(shim, ['send', '-f', 'pc/x', 'a & b | "c" $HOME', '-'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, WSLENV: 'FOO/u' },
      cwd: bin,
      input: 'body\nline',
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const seen = readFileSync(log, 'utf8');
    expect(seen).toContain(
      ['-u', 'test', '-e', '/home/test/.config/claude-rc/bin/rc-mail', 'send', '-f', 'pc/x', 'a & b | "c" $HOME', '-']
        .map((a) => `[${a}]`)
        .join('\n')
    );
    expect(seen).toContain(`WSLENV=FOO/u:${RC_MAIL_WRAPPER_WSLENV}\n`);
    expect(seen).toContain(`CWD=${bin}\n`);
    expect(seen).toContain('CONV=*\n');
    expect(seen.endsWith('IN=body\nline')).toBe(true);
  });

  it('the .cmd wrapper forwards the same variables', () => {
    expect(RC_MAIL_WINDOWS_CMD).toContain(`set "RC_MAIL_WSLENV=${RC_MAIL_WRAPPER_WSLENV}"`);
    expect(RC_MAIL_WINDOWS_CMD).toContain('"%SystemRoot%\\System32\\wsl.exe" @@WSLARGS@@ -e @@CLI@@ %*');
    expect(RC_MAIL_WINDOWS_CMD.endsWith('\r\n')).toBe(true);
    expect(RC_MAIL_WINDOWS_CMD.replace(/\r\n/g, '')).not.toContain('\n');
    expect(RC_MAIL_WINDOWS_SKILL).toContain('untrusted data written by another agent');
    expect(RC_MAIL_WINDOWS_SKILL).toContain('\\.config\\claude-rc\\bin\\rc-mail.cmd');
  });
});

// ── Relay and launch ────────────────────────────────────────────────────────

const WSL: RemoteHost = {
  id: 'h-wsl',
  label: 'desktop · WSL',
  host: 'desktop',
  username: 'u',
  machine: 'desktop',
  system: 'wsl',
} as RemoteHost;
const WIN: RemoteHost = { ...WSL, id: 'h-win', label: 'desktop · Windows', system: 'windows' } as RemoteHost;

describe('relay', () => {
  it('marks only a login with a Windows system', () => {
    const eps = mailEndpoints([WSL, WIN, { ...WSL, id: 'h2', host: 'other', machine: 'other' } as RemoteHost], 'srv');
    expect(eps.find((e) => e.machine === 'desktop')?.windows).toBe(true);
    expect(eps.find((e) => e.machine === 'other')?.windows).toBeUndefined();
  });

  it('sends W once after the first answer, and lists a Windows session by key with the folder fallback', async () => {
    const inputs: string[] = [];
    const winRemote = { hostId: 'h-win', system: 'windows', remotePath: '/mnt/c/Users/me/proj' } as SessionRemote;
    const sessions: MailSessionView[] = [
      { id: 'win-session-1', name: 'w5-proj', workingDir: '/x', remote: winRemote },
      {
        id: 'wsl-session-1',
        name: 'w6-api',
        workingDir: '/x',
        remote: { hostId: 'h-wsl', remotePath: '/home/u/api' } as SessionRemote,
      },
    ];
    let windowsAnswer = '-';
    const ports: AgentMailPorts = {
      enabled: () => true,
      endpoints: () => mailEndpoints([WSL, WIN], 'srv').filter((e) => !e.local),
      sessions: () => sessions,
      sessionKey: (s) => `codeman-ssh-${s.id.slice(0, 3)}`,
      browserConnected: () => true,
      hasLink: () => true,
      exec: async (_ep, _script, input) => {
        inputs.push(input);
        const out = `@@id abcd1234\n@@v 1\n@@sv 1\n@@wv ${windowsAnswer}\n@@now 1\n`;
        if (input.includes('\nW ') || input.startsWith('W ')) windowsAnswer = '1 1 1';
        return out;
      },
      nudgeView: () => null,
      nudge: async () => false,
      load: async () => null,
      save: async () => {},
    };
    const relay = new AgentMailRelay(ports);
    let t = 1_000_000;
    for (let i = 0; i < 4; i++) {
      await relay.tick(t);
      t += 10_000;
    }
    const withW = inputs.filter((i) => i.split('\n').some((l) => l.startsWith('W ')));
    expect(inputs.length).toBe(4);
    expect(withW.length).toBe(1);
    expect(inputs[0].split('\n').some((l) => l.startsWith('W '))).toBe(false);
    const status = relay.status();
    expect(status.machines[0].windows).toBe('installed');
    const win = status.agents.find((a) => a.sid === 'win-session-1');
    expect(win).toMatchObject({ address: 'desktop/w5-proj', key: 'codeman-ssh-win', cwd: '/mnt/c/Users/me/proj' });
    expect(win?.ident).toBeUndefined();
    expect(status.agents.find((a) => a.sid === 'wsl-session-1')?.ident).toBe('key');
  });

  it('the Windows launch carries the key into Windows through WSLENV', () => {
    const base = { hostId: 'h', host: 'desktop', username: 'u', remotePath: '/mnt/c/Users/me/proj' };
    const win = buildRemoteLaunchCommand({
      mode: 'claude',
      remote: { ...base, system: 'windows' } as SessionRemote,
      sessionId: 'abcdef12-0000-0000-0000-000000000000',
    });
    expect(win).toContain('export CLAUDE_RC_SESSION=');
    expect(win).toContain('export WSLENV=');
    expect(win).toContain('CLAUDE_RC_SESSION" && ');
    const wsl = buildRemoteLaunchCommand({
      mode: 'claude',
      remote: { ...base, system: 'wsl' } as SessionRemote,
      sessionId: 'abcdef12-0000-0000-0000-000000000000',
    });
    expect(wsl).not.toContain('WSLENV');
  });
});
