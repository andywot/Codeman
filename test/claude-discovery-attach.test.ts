/**
 * @fileoverview Fork: adopting a discovered Claude session, and the discovery route.
 *
 * - The pane commands that attach an adopted session (remote and local): attach only,
 *   exact name match, the session's own socket, and never a kill on close.
 * - `POST /api/sessions` with `attachRemoteSession.remoteTmuxSocket` / `attachLocalTmux`.
 * - `GET /api/fleet/running/:target` over a MOCKED remote shell pool returning recorded
 *   output, so no ssh connection is opened.
 *
 * Route tests use app.inject(); no port is bound.
 */

import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { getDataDir, resolveTmuxSocketName } from '../src/config/instance.js';
import { PANE_SEP } from '../src/claude-discovery.js';
import { remoteSessionAliveScript, toAttachedSessionRemote, withRemoteTmuxPath } from '../src/remote-hosts.js';
import {
  buildAdoptedLocalAttachCommand,
  buildRemoteAttachCommand,
  isReclaimedRemote,
  remoteTmuxLocation,
} from '../src/tmux-manager.js';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { registerFleetRoutes } from '../src/web/routes/fleet-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext, type MockRouteContext } from './mocks/index.js';
import type { RemoteHost, SessionRemote } from '../src/types.js';

const shellPool = vi.hoisted(() => ({ stdout: '', calls: [] as string[] }));
vi.mock('../src/remote-shell-pool.js', async (orig) => {
  const actual = await orig<typeof import('../src/remote-shell-pool.js')>();
  return {
    ...actual,
    remoteExecStatus: vi.fn(async (_target: unknown, script: string) => {
      shellPool.calls.push(script);
      return { code: 0, stdout: Buffer.from(shellPool.stdout), stderr: '' };
    }),
  };
});

const host: RemoteHost = {
  id: 'desktop-wsl',
  label: 'Desktop · WSL',
  host: '192.168.0.28',
  username: 'AndyWu',
  machine: 'Desktop',
  system: 'wsl',
} as RemoteHost;

describe('attach commands for adopted sessions', () => {
  const adopted: SessionRemote = toAttachedSessionRemote(host, 'work 2', '/home/andy/proj', 'default');

  it('attaches on the socket the session was found on, matching its name exactly', () => {
    const cmd = buildRemoteAttachCommand(adopted, 'work 2');
    expect(cmd).toContain(withRemoteTmuxPath("tmux -L default attach -t '=work 2'").replace(/'/g, "'\\''"));
    expect(cmd).not.toMatch(/new-session|kill-session|send-keys/);
  });

  it('keeps the COD-105 command unchanged when no socket was recorded', () => {
    const legacy = toAttachedSessionRemote(host, 'codeman-disco1', '/x');
    expect(buildRemoteAttachCommand(legacy, 'codeman-disco1')).toContain('tmux -L codeman attach -t ');
    expect(remoteTmuxLocation(legacy, 'abcdef12-0000')).toEqual({ socket: 'codeman', sessionName: 'codeman-disco1' });
  });

  it('never treats an adopted session as one of ours, even with a codeman-ssh name', () => {
    const lookalike = toAttachedSessionRemote(host, 'codeman-ssh-12345678', '/x', 'codeman-remote');
    expect(isReclaimedRemote(lookalike)).toBe(false);
    // Without a recorded socket a codeman-ssh name is still this server's lost session.
    expect(isReclaimedRemote(toAttachedSessionRemote(host, 'codeman-ssh-12345678', '/x'))).toBe(true);
  });

  it('probes liveness on the adopted socket, by exact name', () => {
    expect(remoteTmuxLocation(adopted, 'abcdef12-0000')).toEqual({ socket: 'default', sessionName: 'work 2' });
    expect(remoteSessionAliveScript('work 2', 'default')).toBe(
      withRemoteTmuxPath("tmux -L 'default' has-session -t '=work 2' 2>/dev/null")
    );
    // The private socket keeps its existing probe byte for byte.
    expect(remoteSessionAliveScript('codeman-ssh-abc')).toBe(
      withRemoteTmuxPath("tmux -L codeman-remote has-session -t 'codeman-ssh-abc' 2>/dev/null")
    );
  });

  it('builds the local attach without $TMUX, and refuses names the pane quoting cannot carry', () => {
    expect(buildAdoptedLocalAttachCommand({ socket: 'default', sessionName: 'work' })).toBe(
      "unset TMUX; exec tmux -L default attach -t '=work'"
    );
    expect(() => buildAdoptedLocalAttachCommand({ socket: 'default', sessionName: 'a$(id)' })).toThrow();
    expect(() => buildAdoptedLocalAttachCommand({ socket: '../x y', sessionName: 'work' })).toThrow();
  });
});

describe('schemas', () => {
  it('accepts any attachable name with a socket, and only codeman-* without one', () => {
    const ok = (attachRemoteSession: unknown) => CreateSessionSchema.safeParse({ attachRemoteSession }).success;
    expect(ok({ hostId: 'h', remoteSessionName: 'work 2', remoteTmuxSocket: 'default' })).toBe(true);
    expect(ok({ hostId: 'h', remoteSessionName: 'work 2' })).toBe(false);
    expect(ok({ hostId: 'h', remoteSessionName: 'codeman-abc' })).toBe(true);
    expect(ok({ hostId: 'h', remoteSessionName: 'a"b', remoteTmuxSocket: 'default' })).toBe(false);
    expect(ok({ hostId: 'h', remoteSessionName: 'work', remoteTmuxSocket: 'a b' })).toBe(false);
  });

  it('validates the local attach and the quick-start resume id', () => {
    const local = (attachLocalTmux: unknown) => CreateSessionSchema.safeParse({ attachLocalTmux }).success;
    expect(local({ socket: 'default', sessionName: 'work' })).toBe(true);
    expect(local({ socket: 'default', sessionName: 'w`x`' })).toBe(false);
    const qs = (resumeSessionId: string) => QuickStartSchema.safeParse({ caseName: 'c', resumeSessionId }).success;
    expect(qs('aaaaaaaa-1111-4111-8111-111111111111')).toBe(true);
    expect(qs('--yolo')).toBe(false);
  });
});

async function harness(register: (app: FastifyInstance, ctx: MockRouteContext) => void) {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  // A created mux session, so a start never falls back to spawning a CLI directly.
  ctx.mux.createSession.mockImplementation(async (o: { sessionId: string; workingDir: string; mode: string }) => ({
    sessionId: o.sessionId,
    muxName: `codeman-${o.sessionId.slice(0, 8)}`,
    pid: 99999,
    createdAt: Date.now(),
    workingDir: o.workingDir,
    mode: o.mode,
    attached: false,
  }));
  register(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

async function writeHosts(hosts: RemoteHost[]): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(join(getDataDir(), 'remote-hosts.json'), JSON.stringify(hosts));
}

describe('POST /api/sessions: adopting a discovered session', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let workingDir: string;

  beforeEach(async () => {
    ({ app, ctx } = await harness((a, c) => registerSessionRoutes(a, c)));
    workingDir = await mkdtemp(join(tmpdir(), 'claude-adopt-'));
    await writeHosts([host]);
  });

  afterEach(async () => {
    await app.close();
    await rm(workingDir, { recursive: true, force: true });
  });

  async function createAndStart(payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload });
    const body = JSON.parse(res.body);
    if (res.statusCode !== 200 || body.success === false) return { res, body, options: undefined };
    const id = (body.data?.session ?? body.session).id as string;
    await app.inject({ method: 'POST', url: `/api/sessions/${id}/shell`, payload: {} });
    const calls = ctx.mux.createSession.mock.calls;
    return { res, body, options: calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined };
  }

  it('adopts a remote session on its own socket, not owned', async () => {
    const { res, options } = await createAndStart({
      mode: 'shell',
      workingDir: '/home/andy/proj',
      attachRemoteSession: { hostId: 'desktop-wsl', remoteSessionName: 'work', remoteTmuxSocket: 'default' },
    });
    expect(res.statusCode).toBe(200);
    expect(options).toBeDefined();
    expect(options?.remote).toMatchObject({
      owned: false,
      remoteSessionName: 'work',
      remoteTmuxSocket: 'default',
      remotePath: '/home/andy/proj',
    });
  });

  it('adopts a local tmux session as an attach-only shell pane', async () => {
    const { res, options } = await createAndStart({
      mode: 'shell',
      workingDir,
      attachLocalTmux: { socket: 'default', sessionName: 'work' },
    });
    expect(res.statusCode).toBe(200);
    expect(options).toBeDefined();
    expect(options?.adoptedTmux).toEqual({ socket: 'default', sessionName: 'work' });
    expect(options?.remote).toBeUndefined();
  });

  it("refuses this dashboard's own socket, a non-shell mode, and both attaches at once", async () => {
    const own = await createAndStart({
      mode: 'shell',
      workingDir,
      attachLocalTmux: { socket: resolveTmuxSocketName(), sessionName: 'work' },
    });
    expect(own.body).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    const claude = await createAndStart({
      mode: 'claude',
      workingDir,
      attachLocalTmux: { socket: 'default', sessionName: 'work' },
    });
    expect(claude.body).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    const both = await createAndStart({
      mode: 'shell',
      attachLocalTmux: { socket: 'default', sessionName: 'work' },
      attachRemoteSession: { hostId: 'desktop-wsl', remoteSessionName: 'work', remoteTmuxSocket: 'default' },
    });
    expect(both.body).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(ctx.mux.createSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/quick-start: "Resume here" on a remote machine', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  const RESUME = 'bbbbbbbb-2222-4222-8222-222222222222';

  beforeEach(async () => {
    ({ app, ctx } = await harness((a, c) => registerSessionRoutes(a, c)));
    const windows = { ...host, id: 'desktop-windows', label: 'Desktop · Windows', system: 'windows' } as RemoteHost;
    await writeHosts([host, windows]);
    await writeFile(
      join(getDataDir(), 'remote-cases.json'),
      JSON.stringify([
        { name: 'desk-out', type: 'remote', hostId: 'desktop-wsl', remotePath: '/home/andy/out' },
        { name: 'desk-win', type: 'remote', hostId: 'desktop-windows', remotePath: '/mnt/c/Users/andy/win' },
      ])
    );
  });

  afterEach(async () => {
    await app.close();
  });

  async function launch(payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/api/quick-start', payload });
    const calls = ctx.mux.createSession.mock.calls;
    return { body: JSON.parse(res.body), options: calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined };
  }

  it('launches the remote claude on the conversation it was asked to resume', async () => {
    const { body, options } = await launch({ caseName: 'desk-out', mode: 'claude', resumeSessionId: RESUME });
    // A success here is the raw route payload (the server's envelope hook is not installed).
    expect(body.success).not.toBe(false);
    expect(body.sessionId).toBeTruthy();
    expect(options?.resumeSessionId).toBe(RESUME);
    expect((options?.remote as SessionRemote).owned).toBe(true);
  });

  it('resumes a Windows claude through the Windows claude binary', async () => {
    const { options } = await launch({ caseName: 'desk-win', mode: 'claude', resumeSessionId: RESUME });
    expect((options?.remote as SessionRemote).launch?.binary).toContain('cmd.exe /c claude');
  });

  it('refuses a resume id for a mode without Claude conversation logs, and for a local case', async () => {
    expect((await launch({ caseName: 'desk-out', mode: 'shell', resumeSessionId: RESUME })).body).toMatchObject({
      success: false,
      errorCode: 'INVALID_INPUT',
    });
    expect((await launch({ caseName: 'not-remote', mode: 'claude', resumeSessionId: RESUME })).body).toMatchObject({
      success: false,
    });
  });
});

describe('GET /api/fleet/running (mocked remote output)', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;

  beforeEach(async () => {
    ({ app, ctx } = await harness((a, c) => registerFleetRoutes(a, c)));
    shellPool.calls.length = 0;
    shellPool.stdout = [
      '@@sockdir /tmp/tmux-1000',
      `@@pane default${PANE_SEP}work${PANE_SEP}0${PANE_SEP}0${PANE_SEP}100${PANE_SEP}claude${PANE_SEP}0${PANE_SEP}1${PANE_SEP}1700000000${PANE_SEP}/home/andy/proj`,
      `@@pane codeman-remote${PANE_SEP}codeman-ssh-11112222${PANE_SEP}0${PANE_SEP}0${PANE_SEP}200${PANE_SEP}claude${PANE_SEP}1${PANE_SEP}1${PANE_SEP}1700000000${PANE_SEP}/home/andy/site`,
      '@@pc 100 1 bash',
      '@@pc 101 100 claude',
      '@@pc 200 1 sh',
      '@@pc 201 200 claude',
      '@@pc 300 1 bash',
      '@@pc 301 300 claude',
      '@@cwd 301 /home/andy/out',
      '@@sess 301 {"pid":301,"sessionId":"bbbbbbbb-2222-4222-8222-222222222222","kind":"interactive"}',
      '@@end',
    ].join('\n');
    await writeHosts([host]);
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists the machines to look on', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fleet/running' });
    const body = JSON.parse(res.body);
    expect(body.data.targets.map((t: { id: string }) => t.id)).toEqual(['local', 'desktop-wsl']);
  });

  it("returns that machine's Claudes minus the dashboard's own, through the shell pool", async () => {
    // The dashboard already runs session 11112222… on that login.
    ctx.sessions.set('11112222-0000-4000-8000-000000000000', {
      id: '11112222-0000-4000-8000-000000000000',
      remote: { ...toAttachedSessionRemote(host, 'x', '/x'), owned: true, remoteSessionName: undefined },
      adoptedTmux: undefined,
    } as never);
    const res = await app.inject({ method: 'GET', url: '/api/fleet/running/desktop-wsl' });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(shellPool.calls).toHaveLength(1);
    expect(body.data.ok).toBe(true);
    expect(body.data.tmux.map((t: { sessionName: string }) => t.sessionName)).toEqual(['work']);
    expect(body.data.tmux[0]).toMatchObject({ socket: 'default', attachable: true, cwd: '/home/andy/proj' });
    expect(body.data.outside).toEqual([
      expect.objectContaining({
        pid: 301,
        cwd: '/home/andy/out',
        conversationId: 'bbbbbbbb-2222-4222-8222-222222222222',
      }),
    ]);
    expect(body.data.hiddenCount).toBe(1);
  });

  it('404s an unknown machine without running anything', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fleet/running/nope' });
    expect(JSON.parse(res.body).success).toBe(false);
    expect(shellPool.calls).toHaveLength(0);
  });
});
