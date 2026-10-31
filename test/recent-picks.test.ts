/**
 * @fileoverview Recent picks (fork): storage (src/recent-picks.ts), routes (recent-picks-routes.ts)
 * and the browser-side merge and one-time migration (src/web/public/new-session.js).
 * Real files in a temp data dir; routes via app.inject().
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { dirRef } = vi.hoisted(() => ({ dirRef: { dir: '' } }));
vi.mock('../src/config/instance.js', async (orig) => ({
  ...(await orig<typeof import('../src/config/instance.js')>()),
  getDataDir: () => dirRef.dir,
}));

import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { registerRecentPicksRoutes } from '../src/web/routes/recent-picks-routes.js';
import { mergeRecentPicks, readRecentPicks, MAX_RECENT_PICKS, type RecentPick } from '../src/recent-picks.js';

const pick = (n: number, over: Partial<RecentPick> = {}): RecentPick => ({
  target: 'pc-wsl',
  path: `/home/a/p${n}`,
  mode: 'claude',
  at: 1000 + n,
  ...over,
});

describe('recent picks merge (server)', () => {
  it('newest first, one per key, capped', () => {
    const out = mergeRecentPicks([[pick(1), pick(2)], [pick(1, { at: 5000 })]]);
    expect(out.map((p) => p.path)).toEqual(['/home/a/p1', '/home/a/p2']);
    expect(out[0].at).toBe(5000);
    const many = mergeRecentPicks([Array.from({ length: 20 }, (_, i) => pick(i))]);
    expect(many).toHaveLength(MAX_RECENT_PICKS);
    expect(many[0].path).toBe('/home/a/p19');
  });

  it('an account or mode makes a different pick; the model does not', () => {
    expect(mergeRecentPicks([[pick(1), pick(1, { accountId: 'work' }), pick(1, { mode: 'shell' })]])).toHaveLength(3);
    expect(mergeRecentPicks([[pick(1), pick(1, { model: 'opus', at: 9 })]])).toHaveLength(1);
  });
});

describe('recent picks routes', () => {
  let h: RouteTestHarness;
  beforeEach(async () => {
    dirRef.dir = await mkdtemp(join(tmpdir(), 'recent-picks-'));
    h = await createRouteTestHarness((app) => registerRecentPicksRoutes(app));
  });
  afterEach(async () => {
    await h.app.close();
    await rm(dirRef.dir, { recursive: true, force: true });
  });

  const post = (payload: unknown) =>
    h.app.inject({ method: 'POST', url: '/api/recent-picks', payload: payload as object });
  const imp = (payload: unknown) =>
    h.app.inject({ method: 'POST', url: '/api/recent-picks/import', payload: payload as object });
  const list = async () =>
    (await h.app.inject({ method: 'GET', url: '/api/recent-picks' })).json().data.picks as RecentPick[];

  it('starts empty, remembers a pick, and moves a repeat to the top', async () => {
    expect(await list()).toEqual([]);
    expect((await post({ pick: { target: 'pc-wsl', path: '/a', mode: 'claude' } })).statusCode).toBe(200);
    await post({ pick: { target: 'pc-wsl', path: '/b', mode: 'shell' } });
    await post({ pick: { target: 'pc-wsl', path: '/a', mode: 'claude' } });
    expect((await list()).map((p) => p.path)).toEqual(['/a', '/b']);
    expect((await readRecentPicks(dirRef.dir)).map((p) => p.path)).toEqual(['/a', '/b']);
  });

  it('keeps at most 8', async () => {
    for (let i = 0; i < 12; i++) await post({ pick: { target: 'local', path: `/p${i}`, mode: 'claude' } });
    const picks = await list();
    expect(picks).toHaveLength(8);
    expect(picks[0].path).toBe('/p11');
  });

  it('rejects a relative folder, a missing machine and a null field with 400', async () => {
    expect((await post({ pick: { target: 'local', path: 'rel', mode: 'claude' } })).statusCode).toBe(400);
    expect((await post({ pick: { path: '/a', mode: 'claude' } })).statusCode).toBe(400);
    expect((await post({ pick: { target: 'local', path: '/a', accountId: null } })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });

  it('stores nothing beyond the pick fields (no session name, no extras)', async () => {
    await post({ pick: { target: 'local', path: '/a', mode: 'claude', sessionName: 'x', apiKey: 'sk-secret' } });
    const raw = await readFile(join(dirRef.dir, 'recent-picks.json'), 'utf8');
    expect(raw).not.toContain('sk-secret');
    expect(raw).not.toContain('sessionName');
  });

  it('imports local picks once: dedupes against the server, keeps the newest, skips junk', async () => {
    await post({ pick: { target: 'local', path: '/server', mode: 'claude' } });
    const serverAt = (await list())[0].at;
    const r = await imp({
      picks: [
        { target: 'local', path: '/old-local', mode: 'claude', at: 5 },
        { target: 'local', path: '/server', mode: 'claude', at: 1 },
        { target: 'local', path: 'not-absolute', mode: 'claude', at: 9 },
        'garbage',
        { target: 'local', path: '/newer-local', mode: 'shell', at: serverAt + 10 },
      ],
    });
    expect(r.statusCode).toBe(200);
    const picks = await list();
    expect(picks.map((p) => p.path)).toEqual(['/newer-local', '/server', '/old-local']);
    expect(picks.find((p) => p.path === '/server')!.at).toBe(serverAt);
    // A second import of the same picks changes nothing.
    await imp({ picks: [{ target: 'local', path: '/old-local', mode: 'claude', at: 5 }] });
    expect(await list()).toEqual(picks);
  });

  it('rejects a bad import body, and survives a damaged file', async () => {
    expect((await imp({ picks: 'nope' })).statusCode).toBe(400);
    await writeFile(join(dirRef.dir, 'recent-picks.json'), '{nope');
    expect(await list()).toEqual([]);
  });
});

// ---------------------------------------------------------------- browser side

const src = readFileSync(join(process.cwd(), 'src/web/public/new-session.js'), 'utf8');

function loadBrowserSide(opts: { store?: Record<string, string>; fetchImpl: (url: string, init?: any) => any }) {
  const store: Record<string, string> = { ...(opts.store || {}) };
  const localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => void (store[k] = String(v)),
    removeItem: (k: string) => void delete store[k],
  };
  const proto: Record<string, any> = {};
  const win: Record<string, any> = {};
  const fetchFn = async (url: string, init?: any) => {
    const body = await opts.fetchImpl(url, init);
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, data: body }) };
  };
  new Function('window', 'document', 'CodemanApp', 'localStorage', 'fetch', 'setTimeout', `${src}\nreturn 1;`)(
    win,
    { addEventListener() {} },
    { prototype: proto },
    localStorage,
    fetchFn,
    setTimeout
  );
  const app = Object.create(proto);
  return { app, store, win };
}

describe('browser recents: merge and one-time migration', () => {
  const NEW = 'codeman:new-session-recents';
  const CACHE = 'codeman:new-session-recents-cache';

  it('merges newest first, dedupes by key, caps at 8, and drops unusable and secret fields', () => {
    const { win } = loadBrowserSide({ fetchImpl: () => ({}) });
    const R = win.CodemanRecents;
    const out = R.merge([
      [{ target: 'a', path: '/x', mode: 'claude', at: 5, sessionName: 'name', apiKey: 'sk' }],
      [{ target: 'a', path: '/x', mode: 'claude', at: 9 }, { target: 'a', path: 'rel', at: 99 }, null],
    ]);
    expect(out).toEqual([{ target: 'a', path: '/x', mode: 'claude', at: 9 }]);
    const many = R.merge([
      Array.from({ length: 12 }, (_, i) => ({ target: 'a', path: `/p${i}`, mode: 'claude', at: i })),
    ]);
    expect(many).toHaveLength(8);
    expect(many[0].path).toBe('/p11');
  });

  it('pushes local picks once, clears the local key, and shows the server list', async () => {
    const calls: string[] = [];
    const local = [{ target: 'local', path: '/mine', mode: 'claude', at: 10 }];
    const { app, store } = loadBrowserSide({
      store: { [NEW]: JSON.stringify(local) },
      fetchImpl: (url, init) => {
        calls.push(`${init?.method || 'GET'} ${url}`);
        return {
          picks: [
            { target: 'local', path: '/mine', mode: 'claude', at: 10 },
            { target: 'local', path: '/other', mode: 'claude', at: 5 },
          ],
        };
      },
    });
    // Before the server answers, the local pick already shows.
    expect(app._newSessionRecents().map((r: any) => r.path)).toEqual(['/mine']);
    await app.loadRecentPicks();
    expect(calls).toEqual(['POST /api/recent-picks/import']);
    expect(store[NEW]).toBeUndefined();
    expect(app._newSessionRecents().map((r: any) => r.path)).toEqual(['/mine', '/other']);
    // Next load: nothing local to push, so a plain read.
    await app.loadRecentPicks();
    expect(calls[1]).toBe('GET /api/recent-picks');
  });

  it('keeps the local picks and the cached list when the server fails', async () => {
    const local = [{ target: 'local', path: '/mine', mode: 'claude', at: 10 }];
    const cached = [{ target: 'local', path: '/cached', mode: 'claude', at: 7 }];
    const { app, store } = loadBrowserSide({
      store: { [NEW]: JSON.stringify(local), [CACHE]: JSON.stringify(cached) },
      fetchImpl: () => {
        throw new Error('offline');
      },
    });
    await app.loadRecentPicks();
    expect(store[NEW]).toBeDefined();
    expect(app._newSessionRecents().map((r: any) => r.path)).toEqual(['/mine', '/cached']);
  });

  it('remembering a pick shows at once and queues locally when the server is down', async () => {
    const { app, store } = loadBrowserSide({
      fetchImpl: () => {
        throw new Error('offline');
      },
    });
    app._rememberNewSession({ target: 'local', path: '/now', mode: 'shell', sessionName: 'x' });
    expect(app._newSessionRecents().map((r: any) => r.path)).toEqual(['/now']);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(store[NEW])[0]).toMatchObject({ path: '/now', mode: 'shell' });
    expect(store[NEW]).not.toContain('sessionName');
  });
});
