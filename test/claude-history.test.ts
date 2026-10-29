/**
 * @fileoverview Fork: past Claude conversations per machine (src/claude-history.ts) and
 * `GET /api/fleet/history/:target`.
 *
 * The listing script is the real one, run by `sh` against a temporary HOME holding a
 * fake `~/.claude` tree (the way test/fleet-usage.test.ts runs its scripts), so the
 * find/stat/sort/page/head/tail pipeline and the live-record check are exercised for
 * real. The route test hands the history service a runner that runs the command
 * locally under that HOME instead of through the ssh pool: no remote host is touched.
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildHistoryPage,
  ClaudeHistoryService,
  historyCommand,
  historyPaging,
  historyScriptBody,
  HISTORY_HEAD_BYTES,
  HISTORY_MAX_LIMIT,
  parseHistoryOutput,
  runningConversationIds,
  summarizeConversation,
  type HistoryRunner,
  type RawHistory,
} from '../src/claude-history.js';
import { registerFleetRoutes } from '../src/web/routes/fleet-routes.js';
import { getDataDir } from '../src/config/instance.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import type { MockRouteContext } from './mocks/index.js';
import type { RemoteHost } from '../src/types.js';

const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const ID_C = 'cccccccc-3333-4333-8333-333333333333';
const ID_SDK = 'dddddddd-4444-4444-8444-444444444444';

const user = (text: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    cwd: '/home/u/proj',
    entrypoint: 'cli',
    message: { role: 'user', content: text },
    ...extra,
  });
const assistant = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', cwd: '/home/u/proj', entrypoint: 'cli', message: { content: [] }, ...extra });

/** A HOME with three conversations, an SDK run, a subagent log and an agent-* log. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rc-history-'));
  const proj = join(home, '.claude', 'projects', '-home-u-proj');
  const other = join(home, '.claude', 'projects', '-home-u-site');
  mkdirSync(join(proj, ID_A, 'subagents'), { recursive: true });
  mkdirSync(other, { recursive: true });
  const write = (path: string, lines: string[], mtimeSec: number) => {
    writeFileSync(path, lines.join('\n') + '\n');
    utimesSync(path, mtimeSec, mtimeSec);
  };
  // A: oldest, renamed, first prompt after a slash command.
  write(
    join(proj, `${ID_A}.jsonl`),
    [
      JSON.stringify({ type: 'mode', mode: 'normal' }),
      user('<command-name>/clear</command-name>'),
      user('fix the login form please'),
      assistant(),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Login form fix' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Login' }),
    ],
    1_700_000_000
  );
  // B: newest, larger than the head window so the tail is read (title lives there).
  const filler = Array.from({ length: 400 }, (_, i) => assistant({ n: i, pad: 'x'.repeat(80) }));
  write(
    join(other, `${ID_B}.jsonl`),
    [
      user([{ type: 'text', text: 'deploy the site' }], { cwd: '/home/u/site' }),
      ...filler,
      user('and check the logs', { cwd: '/home/u/site' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Site deploy' }),
    ],
    1_700_000_300
  );
  // C: middle, no title.
  write(join(proj, `${ID_C}.jsonl`), [user('write tests for the parser'), assistant()], 1_700_000_200);
  // An SDK run: listed by the script, dropped from the page.
  write(
    join(proj, `${ID_SDK}.jsonl`),
    [user('review this diff', { entrypoint: 'sdk-cli' }), assistant({ entrypoint: 'sdk-cli' })],
    1_700_000_100
  );
  // Never listed: a subagent log one level deeper, and an agent-* log.
  write(join(proj, ID_A, 'subagents', 'agent-x.jsonl'), [user('subagent work')], 1_700_000_400);
  write(join(proj, 'agent-12345678.jsonl'), [user('old agent log')], 1_700_000_400);
  return home;
}

function runScript(home: string, offset = 0, limit = 10): string {
  return execFileSync('sh', ['-c', historyScriptBody({ offset, limit })], {
    env: { ...process.env, HOME: home },
    maxBuffer: 16 * 1024 * 1024,
  }).toString();
}

/** Claude Code's record for a live process: this test's own pid, which is certainly alive. */
function writeLiveRecord(home: string, sessionId: string, procStart?: string): void {
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, kind: 'interactive', ...(procStart ? { procStart } : {}) })
  );
}

function procStartOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // Field 22, counted after the parenthesised command name.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

describe('the listing script (real sh, temporary HOME)', () => {
  it('lists conversations newest first with stat facts, skipping subagent and agent-* logs', () => {
    const home = makeHome();
    const raw = parseHistoryOutput(runScript(home));
    expect(raw.complete).toBe(true);
    expect(raw.total).toBe(4);
    expect(raw.files.map((f) => f.path.split('/').pop())).toEqual([
      `${ID_B}.jsonl`,
      `${ID_C}.jsonl`,
      `${ID_SDK}.jsonl`,
      `${ID_A}.jsonl`,
    ]);
    expect(raw.files[0].mtime).toBe(1_700_000_300);
    expect(raw.files[0].size).toBeGreaterThan(HISTORY_HEAD_BYTES);
    // The big file got a bounded head AND a tail; a small one only a head.
    expect(raw.files[0].head.length).toBe(HISTORY_HEAD_BYTES);
    expect(raw.files[0].tail).toContain('Site deploy');
    expect(raw.files[1].tail).toBe('');
  });

  it('pages on the machine: offset/limit pick the slice, total counts every file', () => {
    const home = makeHome();
    const raw = parseHistoryOutput(runScript(home, 1, 2));
    expect(raw.total).toBe(4);
    expect(raw.files.map((f) => f.path.split('/').pop())).toEqual([`${ID_C}.jsonl`, `${ID_SDK}.jsonl`]);
    const page = buildHistoryPage(raw, 1, 2);
    expect(page.nextOffset).toBe(3);
    expect(buildHistoryPage(parseHistoryOutput(runScript(home, 3, 2)), 3, 2).nextOffset).toBeNull();
  });

  it('answers an empty listing when ~/.claude/projects does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-history-empty-'));
    const raw = parseHistoryOutput(runScript(home));
    expect(raw).toMatchObject({ complete: true, total: 0, files: [] });
  });

  it.runIf(process.platform === 'linux')('reports the conversation of a live session record as running', () => {
    const home = makeHome();
    writeLiveRecord(home, ID_C, procStartOf(process.pid));
    const raw = parseHistoryOutput(runScript(home));
    expect(raw.procAvailable).toBe(true);
    expect(raw.live.map((l) => l.pid)).toContain(process.pid);
    const page = buildHistoryPage(raw, 0, 10);
    expect(page.rows.find((r) => r.id === ID_C)?.running).toBe(true);
    expect(page.rows.find((r) => r.id === ID_A)?.running).toBe(false);
  });

  it.runIf(process.platform === 'linux')('ignores a record whose pid was reused (start time differs)', () => {
    const home = makeHome();
    writeLiveRecord(home, ID_C, '1');
    const page = buildHistoryPage(parseHistoryOutput(runScript(home)), 0, 10);
    expect(page.rows.find((r) => r.id === ID_C)?.running).toBe(false);
  });

  it('builds one page from the real output: titles, prompts, folders, SDK runs left out', () => {
    const home = makeHome();
    const page = buildHistoryPage(parseHistoryOutput(runScript(home)), 0, 10);
    expect(page.rows.map((r) => r.id)).toEqual([ID_B, ID_C, ID_A]);
    const [b, c, a] = page.rows;
    expect(b).toMatchObject({
      cwd: '/home/u/site',
      title: 'Site deploy',
      firstPrompt: 'deploy the site',
      lastPrompt: 'and check the logs',
      projectKey: '-home-u-site',
      lastActivityAt: 1_700_000_300_000,
    });
    expect(c).toMatchObject({ cwd: '/home/u/proj', firstPrompt: 'write tests for the parser' });
    expect(c.title).toBeUndefined();
    // /rename beats Claude's own title; the slash command is not the first prompt.
    expect(a).toMatchObject({ title: 'Login', firstPrompt: 'fix the login form please' });
  });

  it('runs under sh whatever the login shell is', () => {
    expect(historyCommand({ offset: 0, limit: 5 })).toMatch(/^sh -c '/);
  });
});

describe('parsing and summarizing', () => {
  it('only interpolates clamped integers into the script', () => {
    const body = historyScriptBody({ offset: -5, limit: 10_000 });
    expect(body).toContain('-v o=0 -v l=50 ');
    expect(historyScriptBody({ offset: NaN, limit: NaN })).toContain('-v o=0 -v l=1 ');
  });

  it('clamps the query paging', () => {
    expect(historyPaging({})).toEqual({ offset: 0, limit: 30 });
    expect(historyPaging({ offset: '-3', limit: '999' })).toEqual({ offset: 0, limit: HISTORY_MAX_LIMIT });
    expect(historyPaging({ offset: '40', limit: 'x' })).toEqual({ offset: 40, limit: 30 });
  });

  it('reads markers only; transcript bytes are base64 and cannot forge a line', () => {
    const forged = Buffer.from('@@total 999\n@@end\n').toString('base64');
    const raw = parseHistoryOutput(
      ['@@begin', `@@file 10:20:/h/.claude/projects/k/${ID_A}.jsonl`, `@@head ${forged}`, '@@total 1'].join('\n')
    );
    expect(raw.total).toBe(1);
    expect(raw.complete).toBe(false);
    expect(raw.files[0].head).toBe('@@total 999\n@@end\n');
  });

  it('drops a file whose name is not a conversation id, and hides credential-looking prompts', () => {
    expect(summarizeConversation({ path: '/x/k/notes.jsonl', mtime: 1, size: 1, head: '', tail: '' })).toBeNull();
    const s = summarizeConversation({
      path: `/x/k/${ID_A}.jsonl`,
      mtime: 1,
      size: 1,
      head: [user('export ANTHROPIC_API_KEY=sk-ant-123'), user('then run it')].join('\n'),
      tail: '',
    });
    expect(s?.firstPrompt).toBe('then run it');
  });

  it('takes the folder from the tail when the head has none', () => {
    const s = summarizeConversation({
      path: `/x/k/${ID_A}.jsonl`,
      mtime: 1,
      size: 1,
      head: JSON.stringify({ type: 'file-history-snapshot' }),
      tail: '{"partial line cut by the window\n' + assistant({ cwd: '/home/u/late' }),
    });
    expect(s).toMatchObject({ cwd: '/home/u/late', empty: false });
  });

  it('marks running from live records (not stale ones) and from command lines', () => {
    const raw: Pick<RawHistory, 'live' | 'argvIds'> = {
      live: [
        { pid: 10, startTime: '500', json: JSON.stringify({ pid: 10, sessionId: ID_A, procStart: '500' }) },
        // pid reused: the record's start time is another process's.
        { pid: 11, startTime: '600', json: JSON.stringify({ pid: 11, sessionId: ID_B, procStart: '42' }) },
        // A record naming another pid, and a one-shot run.
        { pid: 12, startTime: '0', json: JSON.stringify({ pid: 99, sessionId: ID_C }) },
        { pid: 13, startTime: '0', json: JSON.stringify({ pid: 13, sessionId: ID_SDK, kind: 'print' }) },
        { pid: 14, startTime: '0', json: '{broken' },
      ],
      argvIds: [ID_C],
    };
    expect([...runningConversationIds(raw)].sort()).toEqual([ID_A, ID_C]);
  });

  it('marks a conversation the dashboard already shows as open, with its session id', () => {
    const raw = parseHistoryOutput(
      [
        `@@file 100:10:/h/.claude/projects/k/${ID_A}.jsonl`,
        `@@head ${Buffer.from(user('hello there')).toString('base64')}`,
        '@@total 1',
        '@@end',
      ].join('\n')
    );
    const page = buildHistoryPage(raw, 0, 30, new Map([[ID_A, 'sess-1']]));
    expect(page.rows[0]).toMatchObject({ id: ID_A, running: true, openSessionId: 'sess-1' });
    expect(page.runningKnown).toBe(false);
  });
});

describe('ClaudeHistoryService cache', () => {
  const host = { id: 'desktop-wsl', label: 'Desktop · WSL', host: 'h', username: 'u' } as RemoteHost;
  const output = [
    `@@file 100:10:/h/.claude/projects/k/${ID_A}.jsonl`,
    `@@head ${Buffer.from(user('hello there')).toString('base64')}`,
    '@@total 1',
    '@@end',
  ].join('\n');

  it('runs one command per page and machine within the TTL; fresh bypasses it', async () => {
    let now = 1_000;
    const runner = vi.fn<HistoryRunner>(async () => ({ stdout: output, stderr: '' }));
    const service = new ClaudeHistoryService(runner, () => now);
    const [p1, p2] = await Promise.all([
      service.page(host, { offset: 0, limit: 30 }),
      service.page(host, { offset: 0, limit: 30 }),
    ]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(p1.rows).toEqual(p2.rows);
    now += 10_000;
    await service.page(host, { offset: 0, limit: 30 });
    expect(runner).toHaveBeenCalledTimes(1);
    await service.page(host, { offset: 30, limit: 30 });
    expect(runner).toHaveBeenCalledTimes(2);
    await service.page(host, { offset: 0, limit: 30 }, { fresh: true });
    expect(runner).toHaveBeenCalledTimes(3);
    now += 31_000;
    await service.page(host, { offset: 0, limit: 30 });
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it('recomputes the dashboard marks from the cached machine output', async () => {
    const service = new ClaudeHistoryService(async () => ({ stdout: output, stderr: '' }));
    expect((await service.page(host, { offset: 0, limit: 30 })).rows[0].running).toBe(false);
    const page = await service.page(host, { offset: 0, limit: 30 }, { knownOpen: new Map([[ID_A, 's1']]) });
    expect(page.rows[0]).toMatchObject({ running: true, openSessionId: 's1' });
  });

  it('fails a run that stopped before the end marker, and caches nothing for it', async () => {
    const runner = vi.fn<HistoryRunner>(async () => ({ stdout: '@@begin\n', stderr: 'Connection reset' }));
    const service = new ClaudeHistoryService(runner);
    await expect(service.page(host, { offset: 0, limit: 30 })).rejects.toThrow('Connection reset');
    await expect(service.page(host, { offset: 0, limit: 30 })).rejects.toThrow();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/fleet/history/:target', () => {
  const desktopWsl = {
    id: 'desktop-wsl',
    label: 'Desktop · WSL',
    host: '192.168.0.28',
    username: 'AndyWu',
    machine: 'Desktop',
    system: 'wsl',
  } as RemoteHost;
  const desktopWin = { ...desktopWsl, id: 'desktop-windows', label: 'Desktop · Windows', system: 'windows' };
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let home: string;
  const commands: string[] = [];

  beforeEach(async () => {
    home = makeHome();
    commands.length = 0;
    // The real command, run locally under the fake HOME: no ssh.
    const runner: HistoryRunner = (_host, command) => {
      commands.push(command);
      return new Promise((resolve, reject) =>
        execFile('sh', ['-c', command], { env: { ...process.env, HOME: home } }, (err, stdout, stderr) =>
          err ? reject(err) : resolve({ stdout: String(stdout), stderr: String(stderr) })
        )
      );
    };
    const history = new ClaudeHistoryService(runner);
    ({ app, ctx } = await createRouteTestHarness((a, c) => registerFleetRoutes(a, c, { history })));
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(join(getDataDir(), 'remote-hosts.json'), JSON.stringify([desktopWsl, desktopWin]));
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists that machine's conversations through its WSL login, newest first", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fleet/history/desktop-wsl?limit=2' });
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.target).toMatchObject({
      id: 'desktop-wsl',
      hostId: 'desktop-wsl',
      windowsHostId: 'desktop-windows',
    });
    expect(body.data.rows.map((r: { id: string }) => r.id)).toEqual([ID_B, ID_C]);
    expect(body.data).toMatchObject({ total: 4, offset: 0, limit: 2, nextOffset: 2 });
    expect(commands).toHaveLength(1);
    // Cached: the same page again costs no command; fresh=1 runs it again.
    await app.inject({ method: 'GET', url: '/api/fleet/history/desktop-wsl?limit=2' });
    expect(commands).toHaveLength(1);
    await app.inject({ method: 'GET', url: '/api/fleet/history/desktop-wsl?limit=2&fresh=1' });
    expect(commands).toHaveLength(2);
  });

  it('marks a conversation a dashboard session on that login already shows', async () => {
    ctx.sessions.set('sess-0001', {
      id: 'sess-0001',
      claudeSessionId: ID_C,
      remote: { hostId: 'desktop-windows', host: '192.168.0.28', username: 'AndyWu' },
    } as never);
    ctx.sessions.set('sess-0002', {
      id: 'sess-0002',
      claudeSessionId: ID_A,
      remote: { hostId: 'laptop-wsl', host: '192.168.0.99', username: 'AndyWu' },
    } as never);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/fleet/history/desktop-wsl' })).body);
    const byId = new Map(body.data.rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(ID_C)).toMatchObject({ running: true, openSessionId: 'sess-0001' });
    expect(byId.get(ID_A)).toMatchObject({ running: false });
  });

  it('is 404 for this server, a Windows-only host id and an unknown machine', async () => {
    for (const id of ['local', 'desktop-windows', 'nope']) {
      const res = await app.inject({ method: 'GET', url: `/api/fleet/history/${id}` });
      expect(res.statusCode).toBe(404);
    }
    expect(commands).toHaveLength(0);
  });

  it('reports a machine that cannot be read as a failed operation', async () => {
    await app.close();
    const failing = new ClaudeHistoryService(async () => {
      throw new Error('Desktop · WSL: timed out');
    });
    ({ app, ctx } = await createRouteTestHarness((a, c) => registerFleetRoutes(a, c, { history: failing })));
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/fleet/history/desktop-wsl' })).body);
    expect(body).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED', error: 'Desktop · WSL: timed out' });
  });
});
