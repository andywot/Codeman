/**
 * @fileoverview Service worker for PWA install + Web Push notifications.
 *
 * App-shell caching: on install, precaches the core UI assets so the app
 * launches instantly and works offline (or on flaky connections). Navigations
 * and static files are network-first but wait only briefly when a saved copy
 * exists; content-hashed files are cache-first. Only a response that proves it
 * is the app is saved as the app, so a login page can never be (see isAppShell).
 * API calls are not cached here, except pasted chat images; the chat view keeps
 * conversations itself (chat-core.js).
 *
 * Push notifications: receives push events from the Codeman server (via
 * web-push library) and displays OS-level notifications. Handles notification
 * clicks to focus an existing Codeman tab or open a new one.
 *
 * Lifecycle: skipWaiting on install, claim clients on activate -- ensures the
 * latest service worker takes control immediately without waiting for tab
 * refresh.
 *
 * @dependency None (runs in ServiceWorkerGlobalScope, isolated from page scripts)
 * @see src/push-store.ts -- server-side VAPID key management and subscription CRUD
 */

// Build identity. scripts/build.mjs rewrites this declaration after it content-
// hashes the assets; the literal below is what dev serves, and dev wants a
// stable key.
//
// Why the cache key MUST carry it: `activate` deletes every cache whose key is
// not the current one, so the old constant key meant that cleanup never deleted
// anything — hashed assets from every release ever deployed accumulated in one
// bucket until the origin hit its storage quota.
const BUILD_ID = 'dev';
const CACHE_NAME = `codeman-${BUILD_ID}`;

// Reverse-proxy base path: the worker is served at `<base>/sw.js`, so its own
// location tells us the mount prefix ('' at root, or '/codeman'). Every URL below
// is prefixed through B() so the cached shell, icons and API calls resolve under
// the mount instead of escaping to the origin root.
const SW_BASE = self.location.pathname.replace(/\/sw\.js$/, '');
const B = (p) => (p && p[0] === '/' ? SW_BASE + p : p);

// Content-hashed assets. scripts/build.mjs rewrites this declaration with the
// filenames it actually emitted; dev has no hashing, so the empty literal below
// is correct there and the unhashed modules are simply cached on first use by
// the runtime handler further down.
//
// This list used to be maintained by hand with the PRE-hash names, which the
// build then renamed — so in production every entry 404'd and the silent
// `.catch()` in install swallowed all of it. Measured against a running
// instance: 15 of 23 entries failed. Offline still worked, because the fetch
// handler caches every successful GET at runtime, but the precache warmed
// nothing while looking like it did. Deriving it from the same manifest that
// renames the files is the only thing that keeps the two from drifting again.
const HASHED_ASSETS = [];

// Core app shell -- cached on install for instant startup. The page itself is
// checked (isAppShell) and the modules it names are added from it; the page then
// posts whatever else it loaded ('cache-assets').
const APP_SHELL = [
  ...HASHED_ASSETS.map((p) => '/' + p),
  '/vendor/xterm.min.js',
  '/vendor/xterm-addon-fit.min.js',
  '/vendor/xterm-addon-unicode11.min.js',
  '/vendor/xterm.css',
  '/icon-rc-192.png',
  '/icon-rc-512.png',
  '/manifest.json',
].map(B);
const SHELL_URL = B('/');
const HASHED_URLS = new Set(HASHED_ASSETS.map((p) => B('/' + p)));

// Pasted images in the chat view: a log line never changes, so neither does the image at
// its offset. Their own bucket, so a deploy (which empties CACHE_NAME) keeps them.
const IMAGE_CACHE = 'codeman-chat-images';
const IMAGE_CACHE_MAX = 200;

// How long a slow network is waited for when a saved copy could be shown instead.
const NAV_WAIT_MS = 1500;
const ASSET_WAIT_MS = 4000;

/**
 * Is this response really the app? `/`, `/index.html` and `/session/:id` say so with a
 * header. Behind SWAG + tinyauth a signed-out request is redirected to a login page, and
 * a login page saved as the app would open instead of the app from then on.
 */
function isAppShell(response) {
  return (
    !!response &&
    response.ok &&
    response.type === 'basic' &&
    !response.redirected &&
    response.headers.get('x-codeman-shell') === '1'
  );
}

/**
 * Save the shell only once it has arrived whole. A cut connection can end a compressed
 * response cleanly partway through, and half a page saved here would be what opens from
 * then on (measured: 256 KiB of the page, ending in the middle of the settings markup).
 */
async function saveShell(cache, key, response) {
  const text = await response.text();
  if (!isCompleteShell(text)) return;
  await cache.put(
    key,
    new Response(text, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-codeman-shell': '1' } })
  );
}

function isCompleteShell(text) {
  return /<\/html>\s*$/i.test(text);
}

/** Safe to keep as a static file: our own, not a redirect, and not a page in disguise. */
function isCacheableAsset(response) {
  if (!response || !response.ok || response.type !== 'basic' || response.redirected) return false;
  return !/text\/html/i.test(response.headers.get('content-type') || '');
}

// The modules a shell names, as the page would ask for them.
function assetsNamedBy(html) {
  const urls = [];
  const pattern = /<(?:script|link)\b[^>]*?\b(?:src|href)="([^"#]+)"/g;
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    let url;
    try {
      url = new URL(m[1], self.location.origin + SHELL_URL);
    } catch {
      continue;
    }
    if (url.origin !== self.location.origin || !/\.(js|css|woff2|png|svg|json)$/i.test(url.pathname)) continue;
    urls.push(url.pathname + url.search);
  }
  return urls;
}

async function cacheAsset(cache, url) {
  try {
    const response = await fetch(url);
    if (isCacheableAsset(response)) await cache.put(url, response);
  } catch {
    /* Offline or refused: the runtime handler picks it up later. */
  }
}

// --- Install: precache app shell ---

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Don't fail install if some assets are missing: a signed-out or offline install
      // still has to leave a working worker behind.
      await Promise.allSettled(APP_SHELL.map((url) => cacheAsset(cache, url)));
      try {
        const shell = await fetch(SHELL_URL);
        if (isAppShell(shell)) {
          const named = assetsNamedBy(await shell.clone().text());
          await saveShell(cache, SHELL_URL, shell);
          await Promise.allSettled(named.map((url) => cacheAsset(cache, url)));
        }
      } catch {
        /* Offline: the next navigation that reaches the server saves it. */
      }
    })()
  );
  self.skipWaiting();
});

// --- Activate: clean old caches, claim clients ---

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== IMAGE_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// --- Messages: the page lists what it loaded, so the next start needs no network ---

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache-assets' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const url of event.data.urls.slice(0, 300)) {
        if (typeof url !== 'string' || !url.startsWith(self.location.origin)) continue;
        if (url.includes('/api/') || url.includes('/html-view/') || url.includes('/webview/')) continue;
        if (await cache.match(url)) continue;
        await cacheAsset(cache, url);
      }
    })()
  );
});

// --- Fetch ---
// Network-first ensures deploys take effect immediately when the network answers, but a
// slow network is only waited for so long when a saved copy exists: a blank screen for
// 30 s on a bad link is worse than a page one deploy old.

function timeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** The server's answer if it comes in time, else the saved copy, else whenever it comes. */
async function raceSavedCopy(networkPromise, savedPromise, waitMs) {
  const network = networkPromise.catch(() => null);
  const first = await Promise.race([network, timeout(waitMs)]);
  if (first) return first;
  const saved = await savedPromise;
  if (saved) return saved;
  const late = await network;
  return late || Response.error();
}

async function handleNavigation(event) {
  const { request } = event;
  const url = new URL(request.url);
  // "Sign in again": past any saved copy, so the login redirect can happen.
  if (url.searchParams.get('signin') === '1') return fetch(request);
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(request).then((response) => {
    // A redirect to a login page arrives here as `opaqueredirect` and goes back to the
    // browser as it is. Only a response that proves it is the app is saved.
    if (isAppShell(response)) {
      const copy = response.clone();
      const key = url.pathname.startsWith(B('/session/')) ? url.pathname : SHELL_URL;
      // Not waitUntil: by the time this body is whole the page may have the saved copy already.
      saveShell(cache, key, copy).catch(() => {});
    }
    return response;
  });
  const saved = (async () =>
    (await cache.match(url.pathname, { ignoreSearch: true })) || cache.match(SHELL_URL))();
  return raceSavedCopy(network, saved, NAV_WAIT_MS);
}

async function handleAsset(event) {
  const { request } = event;
  const url = new URL(request.url);
  const cache = await caches.open(CACHE_NAME);
  // ignoreSearch, or the precache can never be hit. `renderIndexHtml` runs
  // `cacheBustAssets`, which appends `?v=<mtime>` to EVERY same-origin
  // `.js`/`.css` reference — content-hashed names included, so the page asks
  // for `/app.556be563.js?v=1789423735875` while the precache stored
  // `/app.556be563.js`. `caches.match` is query-sensitive by default, so
  // every precached entry was unreachable and only `/`, the icons and the
  // manifest could ever be served offline.
  //
  // It also makes runtime-cached entries survive an mtime change: the same
  // file re-requested under a new `?v=` still matches the copy already held.
  const saved = cache.match(request, { ignoreSearch: true });
  // A content-hashed name never changes meaning, and neither does an exact `?v=<mtime>`,
  // so a saved copy of either is the answer: no reason to wait on a slow link for it.
  if (HASHED_URLS.has(url.pathname)) {
    const hit = await saved;
    if (hit) return hit;
  } else if (url.searchParams.has('v')) {
    const exact = await cache.match(request);
    if (exact) return exact;
  }
  const network = fetch(request).then((response) => {
    if (isCacheableAsset(response)) {
      const copy = response.clone();
      event.waitUntil(cache.put(request, copy));
    }
    return response;
  });
  return raceSavedCopy(network, saved, ASSET_WAIT_MS);
}

async function handleChatImage(event) {
  const { request } = event;
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic' && !response.redirected && /^image\//i.test(response.headers.get('content-type') || '')) {
    const copy = response.clone();
    event.waitUntil(
      cache.put(request, copy).then(async () => {
        const keys = await cache.keys();
        for (const key of keys.slice(0, Math.max(0, keys.length - IMAGE_CACHE_MAX))) await cache.delete(key);
      })
    );
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET, WebSocket upgrades, and SSE streams
  if (request.method !== 'GET') return;
  if (request.headers.get('upgrade') === 'websocket') return;
  if (request.headers.get('accept') === 'text/event-stream') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/\/api\/sessions\/[^/]+\/chat\/image$/.test(url.pathname)) {
    event.respondWith(handleChatImage(event));
    return;
  }
  if (request.url.includes('/api/')) return;
  // A rendered HTML page is served `no-store` behind a capability that logout
  // revokes; caching a popped-out page here would let the offline fallback
  // serve it after the capability is gone.
  if (request.url.includes('/html-view/')) return;
  // A web tab is another site's pages behind a capability; it has no place in our shell.
  if (request.url.includes('/webview/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  event.respondWith(handleAsset(event));
});

// --- Push notifications ---

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const { title, hostTitle, body, tag, sessionId, approvalId, urgency, actions } = payload;

  const options = {
    body: body || '',
    tag: tag || 'codeman-default',
    icon: B('/icon-rc-192.png'),
    badge: B('/icon-rc-192.png'),
    data: { sessionId, approvalId, url: sessionId ? B(`/?session=${sessionId}`) : B('/') },
    renotify: true,
    requireInteraction: urgency === 'critical',
  };

  if (actions && actions.length > 0) {
    options.actions = actions;
  }

  // Match the in-page Notification format: "codeman:<host>: <event title>".
  // hostTitle is sent by servers >= the hostname-aware push payload change;
  // older servers omit it and we fall back to the bare title.
  const displayTitle = hostTitle && title
    ? `${hostTitle}: ${title}`
    : (title || hostTitle || 'Codeman');

  event.waitUntil(
    self.registration.showNotification(displayTitle, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { sessionId, approvalId, url } = event.notification.data || {};
  const targetUrl = url || B('/');
  const action = event.action || null;

  // Approve/Deny action buttons answer the Approvals Inbox item directly from
  // the worker, so they work with NO Codeman tab open (lock-screen approvals).
  // Same-origin POST with cookie credentials; the CSRF Origin check passes
  // because a service worker fetch carries the worker's own (same) origin.
  if ((action === 'approve' || action === 'deny') && approvalId) {
    event.waitUntil(
      fetch(B(`/api/approvals/${encodeURIComponent(approvalId)}/answer`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }).then((res) => {
        if (res && res.ok) return undefined;
        // 401/404/409: let the human see the state by falling back to a tab.
        return openOrFocus(sessionId, action, approvalId, targetUrl);
      }).catch(() => openOrFocus(sessionId, action, approvalId, targetUrl))
    );
    return;
  }

  event.waitUntil(openOrFocus(sessionId, action, approvalId, targetUrl));
});

function openOrFocus(sessionId, action, approvalId, targetUrl) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    // Try to find an existing Codeman tab
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        client.postMessage({
          type: 'notification-click',
          sessionId,
          approvalId,
          action,
        });
        return client.focus();
      }
    }
    // No existing tab -- open a new one
    return self.clients.openWindow(targetUrl);
  });
}
