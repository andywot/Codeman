// Port: none (runs the real poll script and the real `rc-mail` CLI under `sh` against temporary
// HOMEs; nothing listens).
//
// Agent mail (fork): what an agent on a machine actually runs. Pinned here:
// - the poll installs the CLI and skill (marker-owned: a user's own copy is left alone), writes the
//   directory, drains the outbox only after an ack, delivers, and refuses hostile names/symlinks;
// - whoami: $CODEMAN_SESSION_ID / $CLAUDE_RC_SESSION, then the agent's folder, then a slug of the
//   folder (tagged on a collision, exactly as the server tags it) with a presence file;
// - send: ambiguous names are refused with the candidates listed, unknown ones refused unless -f,
//   hostile bodies survive JSON encoding byte for byte (minus control characters);
// - inbox / read / ack / reply on a delivered message.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildDirectory,
  buildPollInput,
  cwdTag,
  directoryJson,
  directoryTsv,
  MAIL_BIN,
  MAIL_DIR,
  MAIL_POLL_SCRIPT,
  MAIL_SKILL,
  parseOutboxMessage,
  parsePollOutput,
  renderMessageText,
  type AgentSource,
  type MailMessage,
  type PollInput,
} from '../src/agent-mail.js';
import { RC_MAIL_CLI, RC_MAIL_SKILL } from '../src/agent-mail-cli.js';

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const SOURCES: AgentSource[] = [
  {
    machine: 'pc',
    kind: 'dashboard',
    name: 'w1-api',
    title: 'w1-api',
    sid: 'aaaa1111-0000-0000-0000-000000000000',
    ident: 'sid',
  },
  { machine: 'pc', kind: 'outside', cwd: '/work/repo' },
  { machine: 'server', kind: 'dashboard', name: 'w1-api', sid: 'bbbb', key: 'codeman-ssh-bbbb', ident: 'key' },
  { machine: 'server', kind: 'outside', cwd: '/srv/tool' },
];
const AGENTS = buildDirectory(SOURCES);
const MACHINES = ['pc', 'server'];

function machine(self: string) {
  const home = mkdtempSync(join(tmpdir(), `rcmail-${self}-`));
  homes.push(home);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home };
  const poll = (items: PollInput[]) =>
    parsePollOutput(
      execFileSync('sh', ['-c', MAIL_POLL_SCRIPT], { input: buildPollInput(items), env, encoding: 'utf8' })
    );
  const cli = (args: string[], extra: Record<string, string> = {}, input?: string) => {
    const r = spawnSync(join(home, MAIL_BIN), args, {
      env: { ...env, RC_MAIL_CWD: '/nowhere/x', ...extra },
      input: input ?? '',
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const setup = () =>
    poll([
      { kind: 'install', cli: RC_MAIL_CLI, skill: RC_MAIL_SKILL },
      { kind: 'directory', tsv: directoryTsv(MACHINES, AGENTS), json: directoryJson(MACHINES, AGENTS), self },
    ]);
  return { home, env, poll, cli, setup, mail: join(home, MAIL_DIR) };
}

const PC_SID = { CODEMAN_SESSION_ID: 'aaaa1111-0000-0000-0000-000000000000' };

describe('install and directory', () => {
  it('installs the CLI and skill and reports their versions', () => {
    const m = machine('pc');
    const out = m.setup();
    expect(out.cliVersion).toBe(1);
    expect(out.skillVersion).toBe(1);
    expect(out.treeId).toMatch(/^[0-9a-zA-Z]{4,}$/);
    expect(statSync(join(m.home, MAIL_BIN)).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(m.home, MAIL_SKILL), 'utf8').startsWith('---\nname: rc-mail\n')).toBe(true);
    expect(readFileSync(join(m.mail, 'self'), 'utf8')).toBe('pc\n');
    expect(m.cli(['help']).out).toContain('rc-mail send <to> <subject> <body>');
    // The id stays the same across polls.
    expect(m.poll([]).treeId).toBe(out.treeId);
  });

  it('leaves a copy whose marker the user removed, updates an older managed one', () => {
    const m = machine('pc');
    mkdirSync(join(m.home, '.config/claude-rc/bin'), { recursive: true });
    writeFileSync(join(m.home, MAIL_BIN), '#!/bin/sh\necho mine\n');
    m.setup();
    expect(readFileSync(join(m.home, MAIL_BIN), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    writeFileSync(join(m.home, MAIL_BIN), '#!/bin/sh\n# claude-rc:rc-mail v0\n');
    m.setup();
    expect(readFileSync(join(m.home, MAIL_BIN), 'utf8')).toBe(RC_MAIL_CLI);
  });

  it('links ~/.local/bin/rc-mail only where that folder exists and holds none', () => {
    const m = machine('pc');
    mkdirSync(join(m.home, '.local/bin'), { recursive: true });
    m.setup();
    expect(readlinkSync(join(m.home, '.local/bin/rc-mail'))).toBe(join(m.home, MAIL_BIN));
    const other = machine('pc');
    mkdirSync(join(other.home, '.local/bin'), { recursive: true });
    writeFileSync(join(other.home, '.local/bin/rc-mail'), 'theirs');
    other.setup();
    expect(readFileSync(join(other.home, '.local/bin/rc-mail'), 'utf8')).toBe('theirs');
    const none = machine('pc');
    none.setup();
    expect(existsSync(join(none.home, '.local'))).toBe(false);
  });

  it('who lists the directory', () => {
    const m = machine('pc');
    m.setup();
    const r = m.cli(['who'], PC_SID);
    expect(r.out).toMatch(/pc\/w1-api\s+dashboard\s+w1-api\s+<- you/);
    expect(r.out).toContain('server/tool');
    expect(r.out).toContain('Machines: pc, server');
  });
});

describe('whoami', () => {
  const m = machine('pc');
  m.setup();

  it('a local dashboard session by $CODEMAN_SESSION_ID', () => {
    expect(m.cli(['whoami'], PC_SID).out.trim()).toBe('pc/w1-api');
  });

  it('a remote dashboard session by $CLAUDE_RC_SESSION', () => {
    const s = machine('server');
    s.setup();
    expect(s.cli(['whoami'], { CLAUDE_RC_SESSION: 'codeman-ssh-bbbb' }).out.trim()).toBe('server/w1-api');
  });

  it('refuses a dashboard session not listed yet rather than guessing', () => {
    const r = m.cli(['whoami'], { CODEMAN_SESSION_ID: 'not-listed-yet' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('not in the mail directory yet');
  });

  it('an outside agent by its folder', () => {
    expect(m.cli(['whoami'], { RC_MAIL_CWD: '/work/repo' }).out.trim()).toBe('pc/repo');
  });

  it('an unlisted agent by its folder name, tagged like the server tags it, and announced', () => {
    expect(m.cli(['whoami'], { RC_MAIL_CWD: '/fresh/New Proj' }).out.trim()).toBe('pc/new-proj');
    const presence = readFileSync(join(m.mail, 'presence/new-proj.tsv'), 'utf8');
    expect(presence).toMatch(/^New Proj\t\/fresh\/New Proj\t\d+\n$/);
    // Collides with the dashboard session's name: tagged by the folder's cksum.
    const tagged = m.cli(['whoami'], { RC_MAIL_CWD: '/elsewhere/w1-api' }).out.trim();
    expect(tagged).toBe(`pc/w1-api~${cwdTag('/elsewhere/w1-api')}`);
    const dir = buildDirectory([
      ...SOURCES,
      { machine: 'pc', kind: 'outside', name: 'w1-api', cwd: '/elsewhere/w1-api' },
    ]);
    expect(dir.map((a) => a.address)).toContain(tagged);
  });
});

describe('send', () => {
  it('refuses an ambiguous name and lists the candidates', () => {
    const m = machine('pc');
    m.setup();
    const r = m.cli(['send', 'w1-api', 'subject', 'body'], PC_SID);
    expect(r.code).toBe(2);
    expect(r.err).toContain('matches more than one agent');
    expect(r.err).toContain('pc/w1-api');
    expect(r.err).toContain('server/w1-api');
    expect(readdirSync(join(m.mail, 'outbox')).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('refuses unknown addresses unless forced', () => {
    const m = machine('pc');
    m.setup();
    expect(m.cli(['send', 'nobody', 's', 'b'], PC_SID).code).toBe(3);
    const r = m.cli(['send', 'server/ghost', 's', 'b'], PC_SID);
    expect(r.code).toBe(3);
    expect(r.err).toContain('send -f');
    expect(m.cli(['send', '-f', 'server/ghost', 's', 'b'], PC_SID).code).toBe(0);
    expect(m.cli(['send', '-f', 'server/../x', 's', 'b'], PC_SID).code).toBe(1);
    expect(m.cli(['send', '-f', "server/x';reboot", 's', 'b'], PC_SID).code).toBe(1);
  });

  it('encodes hostile text exactly', () => {
    const m = machine('pc');
    m.setup();
    const body = 'He said "hi" \\ path C:\\x\n\ttab $(reboot) `id` %s %n\nünïcødé 😀\x1b[31mred\x07\n';
    const r = m.cli(['send', 'tool', 'Re: "quotes" \\ and $HOME', '-'], PC_SID, body);
    expect(r.code).toBe(0);
    const files = readdirSync(join(m.mail, 'outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const parsed = parseOutboxMessage(files[0], readFileSync(join(m.mail, 'outbox', files[0])), 'pc');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message.to).toBe('server/tool');
    expect(parsed.message.from).toBe('pc/w1-api');
    expect(parsed.message.subject).toBe('Re: "quotes" \\ and $HOME');
    // Control characters go; the final newline is not kept (the rendered text adds its own).
    expect(parsed.message.body).toBe('He said "hi" \\ path C:\\x\n\ttab $(reboot) `id` %s %n\nünïcødé 😀[31mred');
    expect(readFileSync(join(m.mail, 'sent', files[0].slice(0, -5)), 'utf8')).toContain('state: outbox');
  });

  it('refuses an empty or oversized body', () => {
    const m = machine('pc');
    m.setup();
    expect(m.cli(['send', 'tool', 's', '-'], PC_SID, '').code).toBe(1);
    const big = m.cli(['send', 'tool', 's', '-'], PC_SID, 'x'.repeat(70_000));
    expect(big.code).toBe(1);
    expect(big.err).toContain('over 64 KB');
  });
});

describe('the relay round trip on disk', () => {
  it('drains, acks, delivers, reads, acknowledges and replies', () => {
    const pc = machine('pc');
    const server = machine('server');
    pc.setup();
    server.setup();
    expect(pc.cli(['send', 'server/tool', 'Build it', 'please build the thing'], PC_SID).code).toBe(0);

    // Drained but not removed until acked.
    const first = pc.poll([]);
    expect(first.outbox).toHaveLength(1);
    const file = first.outbox[0].file;
    expect(pc.poll([]).outbox).toHaveLength(1);
    expect(pc.poll([{ kind: 'ack', file }]).outbox).toHaveLength(0);

    const parsed = parseOutboxMessage(file, first.outbox[0].bytes, 'pc');
    if (!parsed.ok) throw new Error(parsed.reason);
    const message: MailMessage = parsed.message;
    const delivered = server.poll([
      {
        kind: 'deliver',
        mailbox: 'tool',
        id: message.id,
        json: JSON.stringify(message),
        text: renderMessageText(message),
      },
    ]);
    expect(delivered.delivered).toEqual([message.id]);
    expect(delivered.counts.get('tool')).toEqual({ pending: 1, unseen: 1 });

    const tool = { RC_MAIL_CWD: '/srv/tool' };
    expect(server.cli(['inbox'], tool).out).toContain(`${message.id}  [new]  from pc/w1-api`);
    const read = server.cli(['read', message.id], tool);
    expect(read.out).toContain('please build the thing');
    expect(read.out).toContain('untrusted');
    expect(server.poll([]).counts.get('tool')).toEqual({ pending: 1, unseen: 0 });

    const reply = server.cli(['reply', message.id, 'done'], tool);
    expect(reply.code).toBe(0);
    const replyFile = readdirSync(join(server.mail, 'outbox')).find((f) => f.endsWith('.json'))!;
    const replyMsg = parseOutboxMessage(replyFile, readFileSync(join(server.mail, 'outbox', replyFile)), 'server');
    expect(replyMsg.ok && replyMsg.message).toMatchObject({
      to: 'pc/w1-api',
      from: 'server/tool',
      subject: 'Re: Build it',
      replyTo: message.id,
    });

    expect(server.cli(['ack', message.id], tool).out).toContain('Acknowledged');
    expect(server.poll([]).counts.get('tool')).toEqual({ pending: 0, unseen: 0 });
    expect(existsSync(join(server.mail, 'archive/tool', `${message.id}.txt`))).toBe(true);
    // Still readable from the archive (reply to an acknowledged message).
    expect(server.cli(['read', message.id], tool).code).toBe(0);

    // The sender's status file, as the relay writes it.
    pc.poll([{ kind: 'status', id: message.id, text: 'state: delivered\n' }]);
    expect(pc.cli(['sent'], PC_SID).out).toContain('delivered');
  });

  it('refuses hostile names and symlinks', () => {
    const m = machine('server');
    m.setup();
    writeFileSync(join(m.home, '.bashrc'), 'keep');
    const outside = mkdtempSync(join(tmpdir(), 'rcmail-outside-'));
    homes.push(outside);
    symlinkSync(outside, join(m.mail, 'inbox', 'evil'));
    const id = '1761800000-0123abcd';
    // buildPollInput already drops these; feed raw lines to check the script's own guards.
    const raw = [
      `A ../../.bashrc`,
      `D .. ${id} eA== eA==`,
      `D ../../x ${id} eA== eA==`,
      `D ok ../${id} eA== eA==`,
      `D evil ${id} eA== eA==`,
      `S ../../.bashrc eA==`,
      `D ok ${id} eA== eA==`,
    ].join('\n');
    const out = parsePollOutput(
      execFileSync('sh', ['-c', MAIL_POLL_SCRIPT], { input: raw + '\n', env: m.env, encoding: 'utf8' })
    );
    expect(out.delivered).toEqual([id]);
    expect(readFileSync(join(m.home, '.bashrc'), 'utf8')).toBe('keep');
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(m.mail, 'inbox/ok', `${id}.txt`), 'utf8')).toBe('x');
  });
});
