/**
 * @fileoverview Chat view core (fork): the decisions behind the chat view, with no DOM
 * and no network, so test/chat-core.test.ts runs the code that ships.
 *
 * - Pace: how long to wait before the next read of the log (backoff, adaptive speed).
 * - Link: whether a response means live, signed out, or try again, and the words shown.
 * - Cache merge: what a new chunk of the log does to the saved copy.
 * - Outbox: the states a message goes through, and when it may go out by itself.
 * - ChatCache: the saved copy of each conversation, in IndexedDB, falling back to memory.
 *
 * The outbox holds what the user wants sent. It never delivers anything: delivery is
 * the browser input layer in app.js (clientId + seq, persisted until ACK, applied at
 * most once by the server). See `decideOutbox` for when a message is handed over.
 *
 * @globals {object} CodemanChatCore
 * @loadorder before chat-view.js
 */

(function chatCoreModule(root) {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;

  const LIMITS = {
    /** A queued message older than this needs a tap, never an automatic send. */
    QUEUE_AUTO_SEND_MS: 5 * MINUTE,
    /** Saved conversations across all sessions, then for one session. */
    CACHE_TOTAL_BYTES: 64 * 1024 * 1024,
    CACHE_SESSION_BYTES: 16 * 1024 * 1024,
    /** Above this many chunks a load writes one merged chunk back. */
    CACHE_MAX_CHUNKS: 100,
    /** A delivered message that never shows in the log stops being drawn after this. */
    SENT_FORGET_MS: 10 * MINUTE,
    /** How far the phone's clock may be off the machine's when matching a log entry. */
    CLOCK_SKEW_MS: 15 * MINUTE,
  };

  // ── Pace ────────────────────────────────────────────────────────────────

  /** Delay after `failures` failed reads in a row: doubling, capped, with jitter. */
  function backoffDelay(failures, { base = 1500, max = 60 * SECOND, rand = Math.random } = {}) {
    if (failures <= 0) return 0;
    const ceiling = Math.min(max, base * 2 ** Math.min(failures - 1, 16));
    // Keep at least half, so a burst of tabs spreads out but none retries at once.
    return Math.round(ceiling * (0.5 + rand() * 0.5));
  }

  /**
   * Milliseconds to the next read, or null to stop until something wakes the loop.
   * With a working event stream the stream says when to read, so the timer is only a
   * safety net; without one the timer does the job.
   */
  function nextPollDelay({
    hidden = false,
    online = true,
    failures = 0,
    signedOut = false,
    state = 'idle',
    sse = false,
    background = false,
    rand = Math.random,
  } = {}) {
    if (hidden) return null;
    if (signedOut) return 60 * SECOND;
    // navigator.onLine can be wrong in both directions, so offline still probes, slowly.
    if (!online) return Math.max(30 * SECOND, backoffDelay(failures, { rand }));
    if (failures > 0) return backoffDelay(failures, { rand });
    let delay;
    if (state === 'working') delay = sse ? 5 * SECOND : 2 * SECOND;
    else if (state === 'needs') delay = 5 * SECOND;
    else delay = sse ? 30 * SECOND : 10 * SECOND;
    // Terminal mode only keeps the status bar's context reading fresh.
    return background ? Math.max(delay, 15 * SECOND) : delay;
  }

  /** How long one request may take. A slow link gets longer after each timeout. */
  function requestTimeout(kind, failures = 0) {
    const base = kind === 'delta' ? 10 * SECOND : 30 * SECOND;
    const max = kind === 'delta' ? 45 * SECOND : 90 * SECOND;
    return Math.min(max, Math.round(base * 1.5 ** Math.min(failures, 8)));
  }

  // ── Link ────────────────────────────────────────────────────────────────

  /**
   * What a fetch response means. Fetched with `redirect: 'manual'`, so a login redirect
   * (SWAG + tinyauth answers an unauthenticated request with a 302 to another host)
   * arrives as `opaqueredirect` rather than as a CORS failure that looks like no network.
   */
  function classifyResponse({ type = 'basic', status = 200, contentType = '' } = {}) {
    if (type === 'opaqueredirect' || (status >= 300 && status < 400)) return 'signin';
    if (status === 401 || status === 403) return 'signin';
    if (status === 404 || status === 410) return 'gone';
    if (status >= 400) return 'retry';
    // A login page answered with a 200 on our own host is not the API talking.
    if (!/json/i.test(contentType)) return /html/i.test(contentType) ? 'signin' : 'retry';
    return 'ok';
  }

  function formatAgo(ms) {
    const s = Math.max(0, Math.floor(ms / SECOND));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /**
   * The status line. `kind` is the one thing the rest of the view asks: only `live` may
   * send a message or answer a question.
   */
  function linkStatus({ online = true, failures = 0, signedOut = false, everOk = false, updatedAt = 0, now = 0 } = {}) {
    const age = updatedAt ? now - updatedAt : null;
    const ago = age === null ? '' : formatAgo(age);
    if (signedOut) return { kind: 'signin', text: 'Signed out', detail: ago ? `saved ${ago}` : '' };
    if (!online) return { kind: 'offline', text: 'Offline', detail: ago ? `saved ${ago}` : 'nothing saved here yet' };
    if (failures > 0 || !everOk) {
      return {
        kind: 'reconnecting',
        text: everOk || failures > 0 ? 'Reconnecting' : 'Connecting',
        detail: ago ? `updated ${ago}` : '',
      };
    }
    // Quiet while fresh: a number that changes every second draws the eye for nothing.
    return { kind: 'live', text: 'Live', detail: age !== null && age >= 15 * SECOND ? `updated ${ago}` : '' };
  }

  /** The stored per-device choice, else chat on a phone and terminal on a desktop. */
  function chatModeFor(stored, isPhone) {
    if (stored === 'chat' || stored === 'terminal') return stored;
    return isPhone ? 'chat' : 'terminal';
  }

  // ── Cache merge ─────────────────────────────────────────────────────────

  /**
   * What a response to a read does to the saved copy.
   * - `reset`: the saved copy is no use (another log, or the file shrank): replace it.
   * - `append`: the chunk continues the saved copy exactly.
   * - `touch`: nothing new, only the read position moved (lines the view does not draw).
   * - `none`: nothing changed.
   */
  function mergeChunk(cache, data) {
    if (!cache || !cache.log)
      return { action: 'reset', log: data.log, start: data.start, end: data.end, entries: data.entries };
    const shrunk = typeof data.size === 'number' && data.size < cache.end;
    if (data.log !== cache.log || shrunk || data.start !== cache.end) {
      // The server restarts from the tail when a read goes past the end of the file,
      // which is the one case `start` does not match where we asked to read from.
      return { action: 'reset', log: data.log, start: data.start, end: data.end, entries: data.entries };
    }
    if (data.entries.length)
      return { action: 'append', log: cache.log, start: cache.start, end: data.end, entries: data.entries };
    if (data.end !== cache.end)
      return { action: 'touch', log: cache.log, start: cache.start, end: data.end, entries: [] };
    return { action: 'none', log: cache.log, start: cache.start, end: cache.end, entries: [] };
  }

  /** A "load earlier" response: only usable if it ends exactly where the saved copy starts. */
  function mergeEarlier(cache, data) {
    if (!cache || data.log !== cache.log || data.end !== cache.start || data.start >= cache.start) return null;
    return { start: data.start, entries: data.entries };
  }

  /**
   * Saved chunks back into one run. Ends at the saved read position and keeps only
   * what joins up without a hole (a write that died halfway leaves an unjoined chunk).
   */
  function assembleChunks(meta, chunks) {
    const sorted = [...chunks].sort((a, b) => a.start - b.start);
    const run = [];
    let want = meta.end;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const chunk = sorted[i];
      if (chunk.end !== want) break;
      run.unshift(chunk);
      want = chunk.start;
    }
    return { start: run.length ? run[0].start : meta.end, entries: run.flatMap((c) => c.entries) };
  }

  /** Which sessions to drop, oldest use first, to fit. The open one is never dropped. */
  function planEviction(metas, { maxBytes = LIMITS.CACHE_TOTAL_BYTES, keep = null } = {}) {
    let total = metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
    if (total <= maxBytes) return [];
    const drop = [];
    for (const meta of [...metas].sort((a, b) => (a.at || 0) - (b.at || 0))) {
      if (total <= maxBytes) break;
      if (meta.id === keep) continue;
      drop.push(meta.id);
      total -= meta.bytes || 0;
    }
    return drop;
  }

  /** Oldest chunks to drop so one session fits its share. The newest always stays. */
  function planSessionTrim(chunks, maxBytes = LIMITS.CACHE_SESSION_BYTES) {
    const sorted = [...chunks].sort((a, b) => a.start - b.start);
    let total = sorted.reduce((sum, c) => sum + (c.bytes || 0), 0);
    const drop = [];
    for (let i = 0; i < sorted.length - 1 && total > maxBytes; i++) {
      drop.push(sorted[i].start);
      total -= sorted[i].bytes || 0;
    }
    return { drop, start: sorted.length ? sorted[drop.length].start : 0 };
  }

  // ── Outbox ──────────────────────────────────────────────────────────────

  /**
   * States:
   *   queued   waiting for the link, nothing handed to the input layer. Cancel and Edit work.
   *   hold     waiting for a tap. `handed` says the input layer already holds a copy.
   *   sending  handed to the input layer, no ACK yet.
   *   sent     ACKed, not yet seen in the log.
   *   failed   the server refused it, or the session is gone. Nothing will retry it.
   */
  function newOutboxEntry({ id, sessionId, text, matchText = text, now, state = 'idle', log = '', end = 0 }) {
    return {
      id,
      sessionId,
      text,
      matchText,
      createdAt: now,
      state: 'queued',
      handed: false,
      approved: false,
      reason: '',
      fp: { state, log, end },
    };
  }

  /** Idle, your turn and unknown all mean nothing is running; the words differ, not the fact. */
  function stateBucket(state) {
    return !state || state === 'idle' || state === 'waiting' || state === 'unknown' ? 'rest' : state;
  }

  /** Did the session move on since the message was written? */
  function sessionChanged(fp, cur) {
    if (!fp) return false;
    if (fp.log && cur.log && fp.log !== cur.log) return true;
    const was = stateBucket(fp.state);
    const now = stateBucket(cur.state);
    if (was !== now) return true;
    // At rest both times, but a turn ran in between (the terminal, another device).
    return now === 'rest' && typeof cur.end === 'number' && cur.end > (fp.end || 0);
  }

  /**
   * What to do with a queued message right now: `send`, `wait` (link down), `hold`
   * (needs a tap, with the reason to show) or `fail`.
   *
   * ctx: { link, now, sessionKnown, state, log, end }
   */
  function decideOutbox(entry, ctx) {
    if (entry.state !== 'queued' && entry.state !== 'hold') return { action: 'none' };
    if (ctx.sessionKnown === false) return { action: 'fail', reason: 'This session has ended.' };
    if (ctx.link !== 'live') return { action: 'wait' };
    // A dialog takes keystrokes as answers, so a message must never land in one.
    if (ctx.state === 'needs')
      return { action: 'hold', reason: 'Claude is asking something. Answer that first.', blocked: true };
    if (ctx.state === 'exited' || ctx.state === 'done') {
      return { action: 'hold', reason: 'Claude is not running in this session.', blocked: true };
    }
    if (entry.approved) return { action: 'send' };
    if (entry.state === 'hold') return { action: 'none' };
    if (ctx.now - entry.createdAt > LIMITS.QUEUE_AUTO_SEND_MS) {
      return { action: 'hold', reason: 'This waited over 5 minutes, so it was not sent.' };
    }
    if (sessionChanged(entry.fp, ctx))
      return { action: 'hold', reason: 'The session moved on while this waited, so it was not sent.' };
    return { action: 'send' };
  }

  /**
   * The input layer's rule for a chat message it already holds: it was written too long
   * ago and nobody has said to send it. Kept here so the rule has one home.
   */
  function recordHeld(rec, now) {
    return !!(rec && rec.post && !rec.approved && now - (rec.ts || 0) > LIMITS.QUEUE_AUTO_SEND_MS);
  }

  /** The text of a user log entry, the way it compares with what was typed. */
  function logEntryText(entry) {
    const raw = (entry.blocks || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('\n');
    const command = raw.match(/<command-name>([^<]*)<\/command-name>/);
    if (command) {
      const args = (raw.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || '';
      return normalizeText(`${command[1]} ${args}`);
    }
    return normalizeText(raw.replace(/\[Image #\d+\]/g, ''));
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Which outbox messages the new log entries prove arrived. Each log entry answers for
   * one message, so two identical messages take two entries, oldest first.
   */
  function reconcileOutbox(outbox, entries, now = 0) {
    const pool = entries.filter((e) => e.role === 'user' && !e.meta && !e.sidechain && !e.compactSummary);
    const used = new Set();
    const seen = [];
    for (const message of [...outbox].sort((a, b) => a.createdAt - b.createdAt)) {
      // A message nothing was sent for cannot be in the log.
      if (!message.handed && message.state !== 'sending' && message.state !== 'sent') continue;
      const want = normalizeText(message.matchText);
      const hit = pool.findIndex((e, i) => {
        if (used.has(i)) return false;
        const at = Date.parse(e.timestamp);
        if (Number.isFinite(at) && at < message.createdAt - LIMITS.CLOCK_SKEW_MS) return false;
        const text = logEntryText(e);
        // The server cuts very long text, so a long message matches on what is left.
        const cut = /… \([\d,.\s]+ more characters\)$/.test(text);
        if (want === '') return (e.blocks || []).some((b) => b.type === 'image');
        return cut ? want.startsWith(text.replace(/\s*… \([\d,.\s]+ more characters\)$/, '')) : text === want;
      });
      if (hit >= 0) {
        used.add(hit);
        seen.push(message.id);
      }
    }
    // Delivered long ago and never shown: stop drawing it rather than promise it forever.
    const forgotten = outbox
      .filter((m) => m.state === 'sent' && now && now - (m.sentAt || m.createdAt) > LIMITS.SENT_FORGET_MS)
      .map((m) => m.id);
    return { seen, forgotten };
  }

  /** The words under a message. */
  function outboxLabel(entry) {
    switch (entry.state) {
      case 'sending':
        return 'Sending…';
      case 'sent':
        return 'Delivered';
      case 'queued':
        return 'Waiting for a connection';
      case 'hold':
        return entry.reason || 'Tap Send to send this';
      case 'failed':
        return entry.reason || 'Not sent';
      default:
        return '';
    }
  }

  // ── Saved conversations ─────────────────────────────────────────────────

  function entriesBytes(entries) {
    try {
      return JSON.stringify(entries).length;
    } catch {
      return 0;
    }
  }

  const DB_NAME = 'codeman-chat';
  const DB_VERSION = 1;

  function promised(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * One conversation's saved copy: `meta` (log, start, end, updatedAt, bytes, at) plus
   * chunks keyed by [id, start]. Log lines never change once written, so a new chunk
   * is only added, never rewritten; a tick of polling costs one small put.
   *
   * Every call is safe to make with storage blocked: the first failure moves this object
   * to memory for the rest of the page's life, and the view carries on.
   */
  function createChatCache({ idb = typeof indexedDB !== 'undefined' ? indexedDB : null, limits = LIMITS } = {}) {
    let dbPromise = null;
    let useMemory = !idb;
    const memory = new Map(); // id -> { meta, chunks: Map<start, chunk> }

    const fallBack = () => {
      useMemory = true;
      dbPromise = null;
    };

    const openDb = () => {
      if (useMemory) return Promise.reject(new Error('memory'));
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const request = idb.open(DB_NAME, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['id', 'start'] });
          };
          request.onsuccess = () => {
            const db = request.result;
            // Another tab upgrading must not be blocked by this one.
            db.onversionchange = () => db.close();
            resolve(db);
          };
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('blocked'));
        });
      }
      return dbPromise;
    };

    const range = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

    const tx = async (mode, body) => {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['meta', 'chunks'], mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        Promise.resolve(body(t.objectStore('meta'), t.objectStore('chunks')))
          .then((value) => {
            result = value;
          })
          .catch((err) => {
            try {
              t.abort();
            } catch {
              /* already finished */
            }
            reject(err);
          });
      });
    };

    const memSession = (id) => {
      let session = memory.get(id);
      if (!session) {
        session = { meta: null, chunks: new Map() };
        memory.set(id, session);
      }
      return session;
    };

    const metaFrom = (id, previous, fields, addedBytes, now) => ({
      id,
      log: fields.log,
      start: fields.start,
      end: fields.end,
      updatedAt: fields.updatedAt ?? previous?.updatedAt ?? now,
      bytes: (previous?.bytes || 0) + addedBytes,
      at: now,
    });

    const api = {
      get usingMemory() {
        return useMemory;
      },

      /** The saved copy, or null. Never throws. */
      async load(id, now = Date.now()) {
        if (!useMemory) {
          try {
            const loaded = await tx('readwrite', async (metaStore, chunkStore) => {
              const meta = await promised(metaStore.get(id));
              if (!meta) return null;
              const chunks = await promised(chunkStore.getAll(range(id)));
              meta.at = now;
              metaStore.put(meta);
              return { meta, chunks };
            });
            if (!loaded) return null;
            const { start, entries } = assembleChunks(loaded.meta, loaded.chunks);
            if (loaded.chunks.length > limits.CACHE_MAX_CHUNKS) {
              void api.write(id, 'reset', { ...loaded.meta, start, entries }, now);
            }
            return { ...loaded.meta, start, entries };
          } catch {
            fallBack();
          }
        }
        const session = memory.get(id);
        if (!session?.meta) return null;
        const { start, entries } = assembleChunks(session.meta, [...session.chunks.values()]);
        return { ...session.meta, start, entries };
      },

      /**
       * Save one merge result. `action` is mergeChunk's (or `earlier`); `fields` holds
       * log, start, end, updatedAt and the entries of this chunk (start/end of the whole
       * saved run; `chunkStart`/`chunkEnd` default to it for a reset).
       */
      async write(id, action, fields, now = Date.now()) {
        const entries = fields.entries || [];
        const bytes = entriesBytes(entries);
        const chunk = {
          id,
          start: fields.chunkStart ?? fields.start,
          end: fields.chunkEnd ?? fields.end,
          entries,
          bytes,
        };
        // A read position that moved over undrawn lines still gets a (empty) chunk, so the
        // saved run has no hole in it. Skipped when nothing moved.
        const hasChunk = entries.length > 0 || (!!fields.forceChunk && chunk.end > chunk.start);
        if (!useMemory) {
          try {
            await tx('readwrite', async (metaStore, chunkStore) => {
              let previous = await promised(metaStore.get(id));
              if (action === 'reset') {
                chunkStore.delete(range(id));
                previous = null;
              }
              if (hasChunk) chunkStore.put(chunk);
              metaStore.put(metaFrom(id, previous, fields, hasChunk ? bytes : 0, now));
            });
            await api.trim(id);
            return;
          } catch {
            fallBack();
          }
        }
        const session = memSession(id);
        if (action === 'reset') {
          session.chunks.clear();
          session.meta = null;
        }
        if (hasChunk) session.chunks.set(chunk.start, chunk);
        session.meta = metaFrom(id, session.meta, fields, hasChunk ? bytes : 0, now);
        await api.trim(id);
      },

      /** Hold one session and the whole store to their limits. */
      async trim(id) {
        const trimOne = (chunks) => planSessionTrim(chunks, limits.CACHE_SESSION_BYTES);
        if (!useMemory) {
          try {
            const metas = await tx('readwrite', async (metaStore, chunkStore) => {
              const meta = await promised(metaStore.get(id));
              if (meta && meta.bytes > limits.CACHE_SESSION_BYTES) {
                const chunks = await promised(chunkStore.getAll(range(id)));
                const plan = trimOne(chunks);
                for (const start of plan.drop) chunkStore.delete([id, start]);
                const kept = chunks.filter((c) => !plan.drop.includes(c.start));
                metaStore.put({ ...meta, start: plan.start, bytes: kept.reduce((n, c) => n + (c.bytes || 0), 0) });
              }
              return promised(metaStore.getAll());
            });
            for (const drop of planEviction(metas, { maxBytes: limits.CACHE_TOTAL_BYTES, keep: id }))
              await api.remove(drop);
            return;
          } catch {
            fallBack();
          }
        }
        const session = memory.get(id);
        if (session?.meta && session.meta.bytes > limits.CACHE_SESSION_BYTES) {
          const plan = trimOne([...session.chunks.values()]);
          for (const start of plan.drop) session.chunks.delete(start);
          session.meta.start = plan.start;
          session.meta.bytes = [...session.chunks.values()].reduce((n, c) => n + (c.bytes || 0), 0);
        }
        const metas = [...memory.values()].map((s) => s.meta).filter(Boolean);
        for (const drop of planEviction(metas, { maxBytes: limits.CACHE_TOTAL_BYTES, keep: id })) memory.delete(drop);
      },

      async remove(id) {
        memory.delete(id);
        if (useMemory) return;
        try {
          await tx('readwrite', (metaStore, chunkStore) => {
            metaStore.delete(id);
            chunkStore.delete(range(id));
          });
        } catch {
          fallBack();
        }
      },

      /** Every saved session's meta (for tests and the sweep of sessions that are gone). */
      async list() {
        if (!useMemory) {
          try {
            return await tx('readonly', (metaStore) => promised(metaStore.getAll()));
          } catch {
            fallBack();
          }
        }
        return [...memory.values()].map((s) => s.meta).filter(Boolean);
      },
    };
    return api;
  }

  const api = {
    LIMITS,
    backoffDelay,
    nextPollDelay,
    requestTimeout,
    classifyResponse,
    formatAgo,
    linkStatus,
    chatModeFor,
    mergeChunk,
    mergeEarlier,
    assembleChunks,
    planEviction,
    planSessionTrim,
    newOutboxEntry,
    sessionChanged,
    decideOutbox,
    recordHeld,
    logEntryText,
    reconcileOutbox,
    outboxLabel,
    createChatCache,
  };
  root.CodemanChatCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
