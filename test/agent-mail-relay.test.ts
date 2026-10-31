// Port: none (the relay's ports are fakes; each "machine" is a temporary HOME the real poll script
// runs against under a local `sh`, and the real `rc-mail` CLI sends and reads there).
//
// Agent mail relay (fork, src/web/agent-mail-relay.ts). Pinned here:
// - a message sent on one machine is drained, queued, delivered to the other machine's mailbox and
//   the sender's `rc-mail sent` reads queued, then delivered;
// - an unreachable machine keeps its mail queued (persisted) and gets it once it answers again,
//   from a relay restored from that snapshot;
// - an idle dashboard recipient gets ONE nudge line (sender + subject, no body), rate-limited, and
//   none when it is working, switched off, or has already read the mail;
// - unknown machines are rejected back to the sender; a disabled relay touches nothing;
// - two names for one mailbox tree (the server is a fleet machine too) collapse into one.
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAIL_BIN, MAIL_DIR, type MailEndpoint } from '../src/agent-mail.js';
import {
  AgentMailRelay,
  type AgentMailPorts,
  type AgentMailSnapshot,
  type MailSessionView,
  type NudgeView,
} from '../src/web/agent-mail-relay.js';
import type { RemoteHost, SessionRemote } from '../src/types.js';

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'rcmail-relay-'));
  homes.push(h);
  return h;
};

const PC_HOST = { id: 'pc-wsl', label: 'PC · WSL', host: 'pc', username: 'u', system: 'wsl' } as RemoteHost;
const LOCAL_SID = 'aaaa1111-0000-0000-0000-000000000000';
const REMOTE_SID = 'bbbb2222-0000-0000-0000-000000000000';
const REMOTE_KEY = 'codeman-ssh-bbbb2222';

interface World {
  relay: AgentMailRelay;
  homes: Record<string, string>;
  offline: Set<string>;
  nudges: Array<{ id: string; text: string }>;
  views: Record<string, NudgeView>;
  saved: AgentMailSnapshot[];
  execs: string[];
  enabled: { value: boolean };
  cli(
    endpoint: string,
    args: string[],
    env: Record<string, string>,
    input?: string
  ): { code: number | null; out: string; err: string };
}

function world(opts: { sameTree?: boolean; restore?: AgentMailSnapshot } = {}): World {
  const local = newHome();
  const homesBy: Record<string, string> = { local, 'u@pc:22': newHome() };
  const endpoints: MailEndpoint[] = [
    { id: 'local', machine: 'server', local: true, hostIds: [] },
    { id: 'u@pc:22', machine: 'pc', local: false, host: PC_HOST, hostIds: ['pc-wsl'] },
  ];
  if (opts.sameTree) {
    const srv = { ...PC_HOST, id: 'srv', host: 'srv', machine: 'srv' } as RemoteHost;
    endpoints.push({ id: 'u@srv:22', machine: 'srv', local: false, host: srv, hostIds: ['srv'] });
    homesBy['u@srv:22'] = local;
  }
  const sessions: MailSessionView[] = [
    { id: LOCAL_SID, name: 'w1-api', workingDir: '/work/api' },
    {
      id: REMOTE_SID,
      name: 'builder',
      workingDir: '/tmp',
      remote: { hostId: 'pc-wsl', host: 'pc', username: 'u', remotePath: '/home/u/proj' } as SessionRemote,
    },
  ];
  const w = {
    homes: homesBy,
    offline: new Set<string>(),
    nudges: [] as Array<{ id: string; text: string }>,
    views: {
      [LOCAL_SID]: { idle: true, composerEmpty: true, lastHumanInputAt: 0 },
      [REMOTE_SID]: { idle: true, composerEmpty: true, lastHumanInputAt: 0 },
    } as Record<string, NudgeView>,
    saved: [] as AgentMailSnapshot[],
    execs: [] as string[],
    enabled: { value: true },
  } as World;
  const ports: AgentMailPorts = {
    enabled: () => w.enabled.value,
    endpoints: () => endpoints,
    sessions: () => sessions,
    sessionKey: (s) => (s.id === REMOTE_SID ? REMOTE_KEY : undefined),
    browserConnected: () => true,
    hasLink: () => true,
    exec: (ep, script, input) =>
      new Promise((resolve, reject) => {
        w.execs.push(ep.id);
        if (w.offline.has(ep.id)) return reject(Object.assign(new Error('ssh: connect timed out'), { code: 255 }));
        const child = execFile(
          'sh',
          ['-c', script],
          { env: { PATH: process.env.PATH, HOME: homesBy[ep.id] } },
          (err, stdout) => (err ? reject(err) : resolve(stdout))
        );
        child.stdin?.end(input);
      }),
    nudgeView: (id) => w.views[id] ?? null,
    nudge: async (id, text) => {
      w.nudges.push({ id, text });
      return true;
    },
    load: async () => opts.restore ?? null,
    save: async (snapshot) => {
      w.saved.push(JSON.parse(JSON.stringify(snapshot)) as AgentMailSnapshot);
    },
  };
  w.relay = new AgentMailRelay(ports);
  w.cli = (endpoint, args, env, input) => {
    const home = homesBy[endpoint];
    const r = spawnSync(join(home, MAIL_BIN), args, {
      env: { PATH: process.env.PATH, HOME: home, RC_MAIL_CWD: '/nowhere', ...env },
      input: input ?? '',
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return w;
}

const AS_BUILDER = { CLAUDE_RC_SESSION: REMOTE_KEY };
const AS_API = { CODEMAN_SESSION_ID: LOCAL_SID };

/** Run ticks far enough apart that every machine is due. */
async function ticks(w: World, n: number, start: { t: number }) {
  for (let i = 0; i < n; i++) {
    start.t += 5_000;
    await w.relay.tick(start.t);
  }
}

describe('agent mail relay', () => {
  it('carries a message across machines and wakes the idle recipient once', async () => {
    const w = world();
    const clock = { t: Date.now() };
    await ticks(w, 1, clock);
    // Installed and listed on both machines.
    expect(w.cli('u@pc:22', ['whoami'], AS_BUILDER).out.trim()).toBe('pc/builder');
    expect(w.cli('local', ['whoami'], AS_API).out.trim()).toBe('server/w1-api');

    expect(w.cli('u@pc:22', ['send', 'w1-api', 'Need review', 'The secret body text'], AS_BUILDER).code).toBe(0);
    await ticks(w, 3, clock);

    const inbox = w.cli('local', ['inbox'], AS_API).out;
    expect(inbox).toContain('from pc/builder');
    expect(inbox).toContain('subject: Need review');
    expect(readdirSync(join(w.homes['u@pc:22'], MAIL_DIR, 'outbox')).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(w.cli('u@pc:22', ['sent'], AS_BUILDER).out).toContain('delivered');

    expect(w.nudges).toHaveLength(1);
    expect(w.nudges[0].id).toBe(LOCAL_SID);
    expect(w.nudges[0].text).toContain('pc/builder');
    expect(w.nudges[0].text).toContain('Need review');
    expect(w.nudges[0].text).not.toContain('secret body');

    // A second message within the rate limit: no second nudge yet; once read, none at all.
    expect(w.cli('u@pc:22', ['send', 'server/w1-api', 'Again', 'x'], AS_BUILDER).code).toBe(0);
    await ticks(w, 3, clock);
    expect(w.nudges).toHaveLength(1);
    const ids = w
      .cli('local', ['inbox'], AS_API)
      .out.split('\n')
      .map((l) => l.split(' ')[0])
      .filter((x) => /^\d+-/.test(x));
    for (const id of ids) w.cli('local', ['read', id], AS_API);
    clock.t += 3 * 60_000;
    await ticks(w, 2, clock);
    expect(w.nudges).toHaveLength(1);

    const status = w.relay.status();
    expect(status.agents.find((a) => a.address === 'server/w1-api')).toMatchObject({
      pending: 2,
      unseen: 0,
      nudge: true,
    });
    expect(status.recent[0]).toMatchObject({ from: 'pc/builder', to: 'server/w1-api', state: 'delivered' });
  });

  it('does not nudge a working session, nor one switched off', async () => {
    const w = world();
    const clock = { t: Date.now() };
    await ticks(w, 1, clock);
    w.views[REMOTE_SID] = { idle: false, composerEmpty: true, lastHumanInputAt: 0 };
    w.cli('local', ['send', 'builder', 'hi', 'b'], AS_API);
    await ticks(w, 3, clock);
    expect(w.nudges).toEqual([]);
    w.relay.setNudge(REMOTE_SID, false);
    w.views[REMOTE_SID] = { idle: true, composerEmpty: true, lastHumanInputAt: 0 };
    await ticks(w, 2, clock);
    expect(w.nudges).toEqual([]);
    w.relay.setNudge(REMOTE_SID, true);
    w.cli('local', ['send', 'builder', 'again', 'b'], AS_API);
    await ticks(w, 3, clock);
    expect(w.nudges.map((n) => n.id)).toEqual([REMOTE_SID]);
  });

  describe('after a server restart', () => {
    /** Mail delivered to w1-api while it was busy, then a fresh relay restored from the snapshot. */
    async function restarted(readFirst: boolean) {
      const w = world();
      const clock = { t: Date.now() };
      await ticks(w, 1, clock);
      w.views[LOCAL_SID] = { idle: false, composerEmpty: true, lastHumanInputAt: 0 };
      w.cli('u@pc:22', ['send', 'w1-api', 'Deploy lost this', 'body'], AS_BUILDER);
      await ticks(w, 3, clock);
      expect(w.nudges).toEqual([]);
      if (readFirst) {
        const ids = w
          .cli('local', ['inbox'], AS_API)
          .out.split('\n')
          .map((l) => l.split(' ')[0])
          .filter((x) => /^\d+-/.test(x));
        for (const id of ids) w.cli('local', ['read', id], AS_API);
      }
      const w2 = world({ restore: w.saved[w.saved.length - 1] });
      Object.assign(w2.homes, w.homes);
      return { w2, clock };
    }

    it('nudges an idle session about unseen mail once, never twice', async () => {
      const { w2, clock } = await restarted(false);
      await ticks(w2, 3, clock);
      expect(w2.nudges).toHaveLength(1);
      expect(w2.nudges[0].id).toBe(LOCAL_SID);
      expect(w2.nudges[0].text).toContain('Deploy lost this');
      expect(w2.nudges[0].text).not.toContain('body');
      // Unread still, long after the rate limit: the same message is not nudged again.
      clock.t += 60 * 60_000;
      await ticks(w2, 4, clock);
      expect(w2.nudges).toHaveLength(1);
    });

    it('waits for an idle, empty composer, and never nudges mail already read', async () => {
      const { w2, clock } = await restarted(false);
      w2.views[LOCAL_SID] = { idle: false, composerEmpty: true, lastHumanInputAt: 0 };
      await ticks(w2, 3, clock);
      expect(w2.nudges).toEqual([]);
      w2.views[LOCAL_SID] = { idle: true, composerEmpty: true, lastHumanInputAt: 0 };
      await ticks(w2, 2, clock);
      expect(w2.nudges).toHaveLength(1);

      const read = await restarted(true);
      await ticks(read.w2, 3, read.clock);
      expect(read.w2.nudges).toEqual([]);
    });

    it('does not nudge when the session switch is off', async () => {
      const { w2, clock } = await restarted(false);
      await w2.relay.tick(clock.t + 1); // loads the snapshot
      w2.relay.setNudge(LOCAL_SID, false);
      await ticks(w2, 3, clock);
      expect(w2.nudges.length).toBeLessThanOrEqual(1);
      const before = w2.nudges.length;
      w2.cli('u@pc:22', ['send', 'w1-api', 'More', 'b'], AS_BUILDER);
      await ticks(w2, 3, clock);
      expect(w2.nudges).toHaveLength(before);
    });
  });

  it('keeps mail for an offline machine, persisted, and delivers it later', async () => {
    const w = world();
    const clock = { t: Date.now() };
    await ticks(w, 1, clock);
    w.offline.add('u@pc:22');
    expect(w.cli('local', ['send', 'pc/builder', 'Later', 'body'], AS_API).code).toBe(0);
    await ticks(w, 3, clock);
    expect(w.relay.status().queued).toBe(1);
    expect(w.cli('local', ['sent'], AS_API).out).toContain('queued');
    const snapshot = w.saved[w.saved.length - 1];
    expect(snapshot.queue).toHaveLength(1);
    expect(w.relay.status().machines.find((m) => m.machine === 'pc')?.state).toBe('failing');

    // A restarted server, the machine back.
    const w2 = world({ restore: snapshot });
    // Point the new world's machines at the old HOMEs.
    Object.assign(w2.homes, w.homes);
    await ticks(w2, 3, { t: clock.t + 60 * 60_000 });
    expect(w2.cli('u@pc:22', ['inbox'], AS_BUILDER).out).toContain('subject: Later');
    expect(w2.relay.status().queued).toBe(0);
    await ticks(w2, 2, { t: clock.t + 2 * 60 * 60_000 });
    expect(w2.cli('local', ['sent'], AS_API).out).toContain('delivered');
  });

  it('rejects mail for a machine it does not know', async () => {
    const w = world();
    const clock = { t: Date.now() };
    await ticks(w, 1, clock);
    expect(w.cli('local', ['send', '-f', 'mars/rover', 'x', 'y'], AS_API).code).toBe(0);
    await ticks(w, 2, clock);
    expect(w.cli('local', ['sent'], AS_API).out).toContain('rejected (no machine named mars)');
    expect(w.relay.status().queued).toBe(0);
  });

  it('does nothing while disabled', async () => {
    const w = world();
    w.enabled.value = false;
    await ticks(w, 3, { t: Date.now() });
    expect(w.execs).toEqual([]);
  });

  it('treats a fleet machine that is this server as one mailbox', async () => {
    const w = world({ sameTree: true });
    const clock = { t: Date.now() };
    await ticks(w, 2, clock);
    const before = w.execs.length;
    await ticks(w, 2, clock);
    expect(w.execs.slice(before)).not.toContain('u@srv:22');
    const machines = w.relay.status().machines;
    expect(machines.find((m) => m.endpoint === 'u@srv:22')?.aliasOf).toBe('this server');
    // The server's own sessions are addressed by the fleet machine's name.
    expect(w.cli('local', ['whoami'], AS_API).out.trim()).toBe('srv/w1-api');
    expect(readFileSync(join(w.homes.local, MAIL_DIR, 'self'), 'utf8')).toBe('srv\n');
  });
});

describe('agent mail routes', () => {
  it('serves the status and switches a session nudge', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerAgentMailRoutes } = await import('../src/web/routes/agent-mail-routes.js');
    const w = world();
    const app = Fastify();
    registerAgentMailRoutes(app, w.relay);
    const get = await app.inject({ method: 'GET', url: '/api/agent-mail' });
    expect(get.json()).toMatchObject({ success: true, data: { enabled: true, queued: 0 } });
    const bad = await app.inject({ method: 'PUT', url: '/api/agent-mail/nudge/x', payload: { enabled: false } });
    expect(bad.statusCode).toBe(400);
    const badBody = await app.inject({
      method: 'PUT',
      url: `/api/agent-mail/nudge/${LOCAL_SID}`,
      payload: { enabled: 'no' },
    });
    expect(badBody.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/agent-mail/nudge/${LOCAL_SID}`,
      payload: { enabled: false },
    });
    expect(put.json()).toMatchObject({ success: true, data: { enabled: false } });
    expect(w.relay.nudgeEnabled(LOCAL_SID)).toBe(false);
    await app.close();
  });

  it('rewrites a directory that something else replaced on the machine', async () => {
    const w = world();
    await w.relay.tick(0);
    await w.relay.tick(60_000);
    const mail = join(w.homes['u@pc:22'], MAIL_DIR);
    const good = readFileSync(join(mail, 'directory.tsv'), 'utf8');
    writeFileSync(join(mail, 'self'), 'server\n');
    writeFileSync(join(mail, 'directory.tsv'), 'stale\n');
    await w.relay.tick(120_000);
    await w.relay.tick(180_000);
    expect(readFileSync(join(mail, 'self'), 'utf8').trim()).toBe('pc');
    expect(readFileSync(join(mail, 'directory.tsv'), 'utf8')).toBe(good);
  });
});

describe('named instances', () => {
  it('never run the relay: the mail folder belongs to the machine, not the instance', async () => {
    vi.resetModules();
    process.env.CODEMAN_INSTANCE = 'mailtest';
    try {
      const { readAgentMailEnabled } = await import('../src/web/agent-mail-wiring.js');
      expect(readAgentMailEnabled()).toBe(false);
    } finally {
      delete process.env.CODEMAN_INSTANCE;
      vi.resetModules();
    }
  });
});
