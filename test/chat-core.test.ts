// Port: none (pure functions, no browser and no server).
//
// The decisions behind the chat view on a bad network (src/web/public/chat-core.js):
// the read pace, what a response means, how a new chunk changes the saved copy, when a
// message may go out by itself, and the service worker's rule for what counts as the app.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadCore(): any {
  const window: any = {};
  vm.runInContext(
    readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-core.js'), 'utf8'),
    vm.createContext({ window, Math, JSON, Date, Promise, Map, Set })
  );
  return window.CodemanChatCore;
}
const core = loadCore();
const norm = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('pace', () => {
  it('backs off by doubling, with a cap and jitter that keeps at least half', () => {
    const low = (n: number) => core.backoffDelay(n, { rand: () => 0 });
    const high = (n: number) => core.backoffDelay(n, { rand: () => 0.999999 });
    expect(core.backoffDelay(0)).toBe(0);
    expect(high(1)).toBe(1500);
    expect(high(2)).toBe(3000);
    expect(low(2)).toBe(1500);
    expect(high(30)).toBe(60_000);
    expect(low(30)).toBe(30_000);
  });

  it('stops while hidden and is fast only while Claude works', () => {
    expect(core.nextPollDelay({ hidden: true })).toBeNull();
    const working = core.nextPollDelay({ state: 'working' });
    const idle = core.nextPollDelay({ state: 'idle' });
    expect(working).toBeLessThan(idle);
    // A live event stream says when to read, so the timer can relax.
    expect(core.nextPollDelay({ state: 'idle', sse: true })).toBeGreaterThan(idle);
    expect(core.nextPollDelay({ state: 'working', sse: true })).toBeGreaterThan(working);
  });

  it('prefers the backoff over the pace, and offline still probes slowly', () => {
    expect(core.nextPollDelay({ state: 'working', failures: 3, rand: () => 0.999999 })).toBe(6000);
    expect(core.nextPollDelay({ online: false })).toBe(30_000);
    expect(core.nextPollDelay({ signedOut: true })).toBe(60_000);
  });

  it('gives a slow link longer after each timeout, up to a limit', () => {
    expect(core.requestTimeout('delta', 0)).toBe(15_000);
    expect(core.requestTimeout('delta', 1)).toBe(22_500);
    expect(core.requestTimeout('delta', 20)).toBe(45_000);
    expect(core.requestTimeout('tail', 0)).toBeGreaterThan(core.requestTimeout('delta', 0));
  });
});

describe('what a response means', () => {
  const classify = core.classifyResponse;
  it('reads a login redirect as signed out, not as no network', () => {
    expect(classify({ type: 'opaqueredirect', status: 0 })).toBe('signin');
    expect(classify({ status: 401, contentType: 'application/json' })).toBe('signin');
    expect(classify({ status: 200, contentType: 'text/html; charset=utf-8' })).toBe('signin');
  });
  it('tells the other answers apart', () => {
    expect(classify({ status: 200, contentType: 'application/json; charset=utf-8' })).toBe('ok');
    expect(classify({ status: 404, contentType: 'application/json' })).toBe('gone');
    expect(classify({ status: 502, contentType: 'text/html' })).toBe('retry');
    expect(classify({ status: 200, contentType: 'text/plain' })).toBe('retry');
  });
});

describe('status line', () => {
  const now = 1_000_000;
  it('stays quiet while fresh and names the age once stale', () => {
    expect(core.linkStatus({ everOk: true, updatedAt: now - 3000, now })).toMatchObject({ kind: 'live', detail: '' });
    expect(core.linkStatus({ everOk: true, updatedAt: now - 120_000, now })).toMatchObject({
      kind: 'live',
      detail: 'updated 2m ago',
    });
  });
  it('separates reconnecting, offline and signed out', () => {
    expect(core.linkStatus({ everOk: true, failures: 2, updatedAt: now - 5000, now })).toMatchObject({
      kind: 'reconnecting',
      text: 'Reconnecting',
      detail: 'updated 5s ago',
    });
    expect(core.linkStatus({ online: false, updatedAt: now - 840_000, now })).toMatchObject({
      kind: 'offline',
      detail: 'saved 14m ago',
    });
    expect(core.linkStatus({ signedOut: true, online: false, now }).kind).toBe('signin');
    expect(core.linkStatus({ now })).toMatchObject({ kind: 'reconnecting', text: 'Connecting' });
  });
});

describe('default view', () => {
  it('is chat on a phone, the terminal on a desktop, and the stored choice wins', () => {
    expect(core.chatModeFor(null, true)).toBe('chat');
    expect(core.chatModeFor(null, false)).toBe('terminal');
    expect(core.chatModeFor('terminal', true)).toBe('terminal');
    expect(core.chatModeFor('chat', false)).toBe('chat');
    expect(core.chatModeFor('nonsense', true)).toBe('chat');
  });
});

describe('cache merge', () => {
  const cache = { log: 'a', start: 100, end: 500 };
  const chunk = (o: object) => ({ log: 'a', start: 500, end: 500, size: 500, entries: [], ...o });

  it('appends what continues the saved copy exactly', () => {
    const merged = core.mergeChunk(cache, chunk({ end: 700, size: 700, entries: [{ uuid: '1' }] }));
    expect(merged).toMatchObject({ action: 'append', start: 100, end: 700 });
  });
  it('moves the position over lines the view does not draw', () => {
    expect(core.mergeChunk(cache, chunk({ end: 600, size: 600 })).action).toBe('touch');
  });
  it('does nothing when nothing changed', () => {
    expect(core.mergeChunk(cache, chunk({})).action).toBe('none');
  });
  it('discards the saved copy when the log changed', () => {
    expect(core.mergeChunk(cache, chunk({ log: 'b', start: 0, end: 50, size: 50 })).action).toBe('reset');
  });
  it('discards the saved copy when the file shrank', () => {
    // The server answers a read past the end of the file with its tail.
    expect(core.mergeChunk(cache, chunk({ start: 0, end: 200, size: 200, entries: [{ uuid: 'x' }] })).action).toBe(
      'reset'
    );
    expect(core.mergeChunk(cache, chunk({ start: 500, end: 500, size: 300 })).action).toBe('reset');
  });
  it('starts over with no saved copy', () => {
    expect(core.mergeChunk(null, chunk({})).action).toBe('reset');
  });
  it('takes an earlier chunk only if it joins up', () => {
    const data = { log: 'a', start: 40, end: 100, entries: [{ uuid: '0' }] };
    expect(core.mergeEarlier(cache, data)).toMatchObject({ start: 40 });
    expect(core.mergeEarlier(cache, { ...data, end: 90 })).toBeNull();
    expect(core.mergeEarlier(cache, { ...data, log: 'b' })).toBeNull();
  });
  it('joins saved chunks in order and stops at a hole', () => {
    const entries = (uuid: string) => [{ uuid }];
    const chunks = [
      { start: 100, end: 200, entries: entries('b') },
      { start: 200, end: 300, entries: [] },
      { start: 300, end: 400, entries: entries('c') },
      { start: 0, end: 90, entries: entries('a') },
    ];
    const run = core.assembleChunks({ end: 400 }, chunks);
    expect(run.start).toBe(100);
    expect(norm(run.entries).map((e: any) => e.uuid)).toEqual(['b', 'c']);
  });
});

describe('eviction', () => {
  it('drops the least recently used until it fits, and never the open one', () => {
    const metas = [
      { id: 'open', bytes: 50, at: 1 },
      { id: 'old', bytes: 40, at: 2 },
      { id: 'newer', bytes: 40, at: 3 },
    ];
    expect(norm(core.planEviction(metas, { maxBytes: 100, keep: 'open' }))).toEqual(['old']);
    expect(norm(core.planEviction(metas, { maxBytes: 200 }))).toEqual([]);
  });
  it('trims one session from its oldest chunk and keeps the newest', () => {
    const chunks = [
      { start: 0, bytes: 40 },
      { start: 10, bytes: 40 },
      { start: 20, bytes: 40 },
    ];
    expect(norm(core.planSessionTrim(chunks, 60))).toEqual({ drop: [0, 10], start: 20 });
    expect(norm(core.planSessionTrim([{ start: 0, bytes: 900 }], 60))).toEqual({ drop: [], start: 0 });
  });
});

describe('saved conversations without IndexedDB', () => {
  const chunk = (uuid: string) => [{ uuid, role: 'user', blocks: [] }];
  it('works in memory, and holds to its limits', async () => {
    const cache = core.createChatCache({
      idb: null,
      limits: { ...core.LIMITS, CACHE_TOTAL_BYTES: 200, CACHE_SESSION_BYTES: 100 },
    });
    expect(cache.usingMemory).toBe(true);
    await cache.write('s1', 'reset', { log: 'a', start: 0, end: 10, entries: chunk('1'), updatedAt: 5 }, 1);
    await cache.write(
      's1',
      'append',
      { log: 'a', start: 0, end: 20, chunkStart: 10, chunkEnd: 20, entries: chunk('2') },
      2
    );
    const saved = await cache.load('s1');
    expect(saved).toMatchObject({ log: 'a', start: 0, end: 20, updatedAt: 5 });
    expect(saved.entries.map((e: any) => e.uuid)).toEqual(['1', '2']);

    // A third chunk pushes s1 past its share: the oldest goes, and the start moves up.
    await cache.write(
      's1',
      'append',
      { log: 'a', start: 0, end: 30, chunkStart: 20, chunkEnd: 30, entries: chunk('3') },
      3
    );
    const trimmed = await cache.load('s1');
    expect(trimmed.start).toBeGreaterThan(0);
    expect(trimmed.entries.at(-1).uuid).toBe('3');

    // Another session pushes the store past its limit: the least recently used goes.
    await cache.write('s2', 'reset', { log: 'b', start: 0, end: 10, entries: chunk('x'.repeat(120)) }, 4);
    expect(await cache.load('s1')).toBeNull();
    expect((await cache.load('s2')).log).toBe('b');
  });
  it('falls back to memory when IndexedDB refuses to open', async () => {
    const idb = {
      open() {
        const request: any = {};
        setTimeout(() => {
          request.error = new Error('SecurityError');
          request.onerror?.();
        }, 0);
        return request;
      },
    };
    const cache = core.createChatCache({ idb });
    expect(await cache.load('s1')).toBeNull();
    expect(cache.usingMemory).toBe(true);
    await cache.write('s1', 'reset', { log: 'a', start: 0, end: 10, entries: chunk('1') });
    expect((await cache.load('s1')).entries).toHaveLength(1);
  });
});

describe('outbox', () => {
  const NOW = 10_000_000;
  const entry = (over: object = {}) => ({
    ...core.newOutboxEntry({ id: 'm1', sessionId: 's', text: 'hi', now: NOW, state: 'idle', log: 'a', end: 100 }),
    ...over,
  });
  const ctx = (over: object = {}) => ({
    link: 'live',
    now: NOW + 1000,
    sessionKnown: true,
    state: 'idle',
    log: 'a',
    end: 100,
    ...over,
  });
  const action = (e: object, c: object = {}) => core.decideOutbox(e, ctx(c)).action;

  it('sends straight away on a live link with nothing changed', () => {
    expect(action(entry())).toBe('send');
  });
  it('waits for the link', () => {
    for (const link of ['offline', 'reconnecting', 'signin']) expect(action(entry(), { link })).toBe('wait');
  });
  it('needs a tap after 5 minutes', () => {
    expect(action(entry(), { now: NOW + 5 * 60_000 - 1 })).toBe('send');
    expect(action(entry(), { now: NOW + 5 * 60_000 + 1 })).toBe('hold');
  });
  it('needs a tap when the session changed', () => {
    expect(action(entry(), { state: 'working' })).toBe('hold');
    expect(action(entry(), { log: 'b' })).toBe('hold');
    // Idle both times, but a turn ran in between.
    expect(action(entry(), { end: 200 })).toBe('hold');
  });
  it('treats idle, your turn and unknown as the same rest', () => {
    expect(action(entry(), { state: 'waiting' })).toBe('send');
    expect(action(entry({ fp: { state: 'waiting', log: 'a', end: 100 } }), { state: 'waiting', end: 300 })).toBe(
      'hold'
    );
  });
  it('lets a message queued mid-turn go while the same turn runs', () => {
    const queued = entry({ fp: { state: 'working', log: 'a', end: 100 } });
    expect(action(queued, { state: 'working', end: 900 })).toBe('send');
  });
  it('never lands in a dialog, even after a tap', () => {
    const decision = core.decideOutbox(entry({ approved: true }), ctx({ state: 'needs' }));
    expect(decision).toMatchObject({ action: 'hold', blocked: true });
  });
  it('sends after a tap despite the age and the change', () => {
    expect(action(entry({ state: 'hold', approved: true }), { now: NOW + 3_600_000, state: 'working' })).toBe('send');
  });
  it('stays held with no tap, even once things settle', () => {
    expect(action(entry({ state: 'hold' }))).toBe('none');
  });
  it('fails when the session is gone, and stays waiting while that is unknown', () => {
    expect(action(entry(), { sessionKnown: false })).toBe('fail');
    expect(action(entry(), { sessionKnown: undefined, link: 'offline' })).toBe('wait');
  });
  it('leaves anything handed over to the input layer alone', () => {
    for (const state of ['sending', 'sent', 'failed']) expect(action(entry({ state }))).toBe('none');
  });

  it('holds a chat record in the input layer once it is old, until tapped', () => {
    const rec = { post: true, ts: NOW };
    expect(core.recordHeld(rec, NOW + 1000)).toBe(false);
    expect(core.recordHeld(rec, NOW + 5 * 60_000 + 1)).toBe(true);
    expect(core.recordHeld({ ...rec, approved: true }, NOW + 5 * 60_000 + 1)).toBe(false);
    // Terminal keystrokes keep their old behaviour.
    expect(core.recordHeld({ ts: NOW }, NOW + 3_600_000)).toBe(false);
  });

  describe('matching the log', () => {
    const logUser = (text: string, over: object = {}) => ({
      role: 'user',
      timestamp: new Date(NOW + 5000).toISOString(),
      blocks: [{ type: 'text', text }],
      ...over,
    });
    const sending = (id: string, matchText: string, over: object = {}) => ({
      ...entry({ id, matchText, state: 'sending', handed: true }),
      ...over,
    });
    const seen = (outbox: object[], log: object[]) => norm(core.reconcileOutbox(outbox, log, NOW + 6000).seen);

    it('removes a message once the log shows it, ignoring spacing', () => {
      expect(seen([sending('m1', 'fix  the\nbug')], [logUser('fix the bug')])).toEqual(['m1']);
    });
    it('takes one log entry per message, oldest first', () => {
      const outbox = [sending('m1', 'again'), sending('m2', 'again', { createdAt: NOW + 1 })];
      expect(seen(outbox, [logUser('again')])).toEqual(['m1']);
      expect(seen(outbox, [logUser('again'), logUser('again')])).toEqual(['m1', 'm2']);
    });
    it('ignores a message nothing was sent for', () => {
      expect(seen([entry({ matchText: 'hi' })], [logUser('hi')])).toEqual([]);
    });
    it('ignores an old entry with the same words', () => {
      const old = logUser('hi', { timestamp: new Date(NOW - 3_600_000).toISOString() });
      expect(seen([sending('m1', 'hi')], [old])).toEqual([]);
    });
    it('matches a slash command and a very long message the server cut', () => {
      expect(
        seen(
          [sending('m1', '/compact now')],
          [logUser('<command-name>/compact</command-name><command-args>now</command-args>')]
        )
      ).toEqual(['m1']);
      const long = 'a'.repeat(50);
      expect(seen([sending('m1', `${long}bbbb`)], [logUser(`${long}\n… (4 more characters)`)])).toEqual(['m1']);
    });
    it('matches a message that was only an image', () => {
      const image = { role: 'user', timestamp: new Date(NOW + 5000).toISOString(), blocks: [{ type: 'image', n: 0 }] };
      expect(seen([sending('m1', '')], [image])).toEqual(['m1']);
    });
    it('skips what is not a person typing', () => {
      expect(seen([sending('m1', 'hi')], [logUser('hi', { meta: true }), logUser('hi', { sidechain: true })])).toEqual(
        []
      );
    });
    it('stops drawing a delivered message the log never showed', () => {
      const sent = entry({ state: 'sent', sentAt: NOW });
      expect(norm(core.reconcileOutbox([sent], [], NOW + 1000).forgotten)).toEqual([]);
      expect(norm(core.reconcileOutbox([sent], [], NOW + 11 * 60_000).forgotten)).toEqual(['m1']);
    });
  });

  it('says what state a message is in', () => {
    expect(core.outboxLabel(entry({ state: 'sending' }))).toBe('Sending…');
    expect(core.outboxLabel(entry())).toBe('Waiting for a connection');
    expect(core.outboxLabel(entry({ state: 'hold', reason: 'why' }))).toBe('why');
  });
});

describe('service worker: what counts as the app', () => {
  const sw = readFileSync(resolve(import.meta.dirname, '../src/web/public/sw.js'), 'utf8');
  function loadWorker(): any {
    const listeners: Record<string, unknown> = {};
    const context = vm.createContext({
      self: {
        location: { pathname: '/sw.js', origin: 'https://x' },
        addEventListener: (n: string, f: unknown) => (listeners[n] = f),
        skipWaiting() {},
        clients: {},
      },
      caches: {},
      URL,
    });
    vm.runInContext(`${sw};globalThis.__t={isAppShell,isCacheableAsset,assetsNamedBy,isCompleteShell};`, context);
    return (context as any).__t;
  }
  const response = (o: { ok?: boolean; type?: string; redirected?: boolean; headers?: Record<string, string> }) => ({
    ok: true,
    type: 'basic',
    redirected: false,
    ...o,
    headers: { get: (k: string) => o.headers?.[k.toLowerCase()] ?? null },
  });
  const t = loadWorker();

  it('saves only a response that says it is the app', () => {
    expect(t.isAppShell(response({ headers: { 'x-codeman-shell': '1' } }))).toBe(true);
    // A login page on our own host, however it arrived.
    expect(t.isAppShell(response({ headers: { 'content-type': 'text/html' } }))).toBe(false);
    expect(t.isAppShell(response({ redirected: true, headers: { 'x-codeman-shell': '1' } }))).toBe(false);
    expect(t.isAppShell(response({ type: 'opaqueredirect', ok: false }))).toBe(false);
    expect(t.isAppShell(response({ ok: false, headers: { 'x-codeman-shell': '1' } }))).toBe(false);
  });
  it('saves a page only once it arrived whole', () => {
    expect(t.isCompleteShell('<html><body></body></html>\n')).toBe(true);
    expect(t.isCompleteShell('<html><body><div class="event-label">Task comp')).toBe(false);
  });
  it('never saves a page as a script', () => {
    expect(t.isCacheableAsset(response({ headers: { 'content-type': 'application/javascript' } }))).toBe(true);
    expect(t.isCacheableAsset(response({ headers: { 'content-type': 'text/html' } }))).toBe(false);
    expect(t.isCacheableAsset(response({ redirected: true, headers: { 'content-type': 'text/css' } }))).toBe(false);
  });
  it('reads the modules a shell names, ours only', () => {
    const html =
      '<link rel="stylesheet" href="chat.css?v=1"><script defer src="app.abc.js"></script><script src="https://cdn.x/y.js"></script><link rel="preconnect" href="/">';
    expect(norm(t.assetsNamedBy(html))).toEqual(['/chat.css?v=1', '/app.abc.js']);
  });
  it('keeps the two lines the build rewrites', () => {
    expect(sw.match(/const BUILD_ID = 'dev';/g)).toHaveLength(1);
    expect(sw.match(/const HASHED_ASSETS = \[\];/g)).toHaveLength(1);
  });
});
