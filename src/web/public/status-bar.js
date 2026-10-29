/**
 * @fileoverview Status bar and focus mode (fork).
 *
 * The bottom bar on desktop is an editor-style status line instead of the
 * upstream Run/Shell/case toolbar (starting work lives in the New session
 * dialog). Left to right: the connection to the server, how many sessions need
 * you (click jumps to the first), how many are working, then one entry per
 * Claude account with its 5-hour and 7-day usage when the server reports them
 * (GET /api/fleet; absent until accounts are configured).
 *
 * Focus mode enlarges the active session: the explorer, header and status bar
 * hide and the browser goes full screen. Esc (leaving full screen) or the
 * header button restores the workbench.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency home-sessions.js (buildHomeSessionRows)
 * @loadorder after overview-board.js
 */

/** States counted as "needs you", matching the Overview board. */
const STATUS_BAR_ATTENTION = new Set(['needs', 'error', 'waiting']);
const STATUS_BAR_ACCOUNTS_MS = 60_000;

Object.assign(CodemanApp.prototype, {
  _statusBarEl() {
    let el = document.getElementById('rcStatus');
    if (el) return el;
    const footer = document.querySelector('footer.toolbar');
    if (!footer) return null;
    el = document.createElement('div');
    el.id = 'rcStatus';
    el.className = 'rc-status';
    el.addEventListener('click', (event) => {
      const target = event.target.closest('[data-rc-action]');
      if (!target) return;
      if (target.dataset.rcAction === 'attention') {
        const first = this._statusBarAttention[0];
        if (first) this.selectSession(first.id);
      } else if (target.dataset.rcAction === 'accounts') {
        this.openFleetManager?.();
      }
    });
    footer.prepend(el);
    return el;
  },

  _statusBarItem(text, { cls = '', action = '', title = '' } = {}) {
    const item = document.createElement(action ? 'button' : 'span');
    if (action) {
      item.type = 'button';
      item.dataset.rcAction = action;
    }
    item.className = `rc-status-item ${cls}`.trim();
    item.textContent = text;
    if (title) item.title = title;
    item.setAttribute('data-i18n-skip', '');
    return item;
  },

  renderStatusBar() {
    const el = this._statusBarEl();
    if (!el) return;
    const rows = typeof this.buildHomeSessionRows === 'function' ? this.buildHomeSessionRows() : [];
    this._statusBarAttention = rows.filter((row) => STATUS_BAR_ATTENTION.has(row.state));
    const working = rows.filter((row) => row.state === 'working').length;

    const status = this._connectionStatus || 'connected';
    const parts = [
      this._statusBarItem(
        status === 'connected' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting…' : 'Offline',
        {
          cls: `rc-conn rc-conn--${status}`,
          title: 'Connection to the server',
        }
      ),
    ];
    const waiting = this._statusBarAttention.length;
    parts.push(
      this._statusBarItem(waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : 'Nothing waiting', {
        cls: waiting ? 'rc-attention' : 'rc-quiet',
        action: waiting ? 'attention' : '',
        title: waiting ? 'Jump to the first session that needs you' : '',
      })
    );
    if (working) parts.push(this._statusBarItem(`${working} working`, { cls: 'rc-quiet' }));

    // The active session's context window, read from its conversation log (chat-view.js).
    const ctx = this.chatContextFor?.(this.activeSessionId);
    if (ctx && window.CodemanChat) {
      const pct = Math.min(100, Math.round((ctx.used / ctx.limit) * 100));
      const { chatTokens } = window.CodemanChat;
      const item = this._statusBarItem('context', { cls: 'rc-account rc-context' });
      const ring = document.createElement('span');
      ring.className = `rc-ring${pct >= 80 ? ' rc-ring--high' : pct >= 50 ? ' rc-ring--mid' : ''}`;
      ring.style.setProperty('--p', String(pct));
      ring.setAttribute('aria-hidden', 'true');
      const tag = document.createElement('span');
      tag.className = 'rc-ring-key';
      tag.textContent = `${pct}%`;
      item.append(ring, tag);
      item.title = `This session's context: ${chatTokens(ctx.used)} of ${chatTokens(ctx.limit)} tokens`;
      item.setAttribute('aria-label', item.title);
      parts.push(item);
    }

    const spacer = document.createElement('span');
    spacer.className = 'rc-status-spacer';
    parts.push(spacer);

    for (const account of this._statusBarAccounts || []) {
      const item = this._statusBarItem(account.label, { cls: 'rc-account', action: 'accounts' });
      const lines = [account.label];
      for (const [key, name, pct, resets] of [
        ['5h', '5-hour window', account.fiveHour, account.fiveHourResetsAt],
        ['7d', '7-day window', account.sevenDay, account.resetsAt],
      ]) {
        if (pct == null) continue;
        const value = Math.max(0, Math.min(100, Math.round(pct)));
        const ring = document.createElement('span');
        ring.className = `rc-ring${value >= 80 ? ' rc-ring--high' : value >= 50 ? ' rc-ring--mid' : ''}`;
        ring.style.setProperty('--p', String(value));
        ring.setAttribute('aria-hidden', 'true');
        const tag = document.createElement('span');
        tag.className = 'rc-ring-key';
        tag.textContent = key;
        item.append(ring, tag);
        lines.push(
          `${name}: ${value}% used${resets ? `, resets ${new Date(resets).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`
        );
      }
      item.title = lines.join('\n');
      item.setAttribute('aria-label', lines.join('. '));
      parts.push(item);
    }
    el.replaceChildren(...parts);
  },

  async refreshStatusBarAccounts() {
    try {
      const res = await fetch('/api/fleet');
      if (!res.ok) return;
      const json = await res.json();
      const accounts = json?.data?.accounts ?? [];
      this._statusBarAccounts = accounts
        .filter((a) => a.usage)
        .map((a) => ({
          label: a.label,
          fiveHour: a.usage.fiveHour ?? null,
          fiveHourResetsAt: a.usage.fiveHourResetsAt ?? null,
          sevenDay: a.usage.sevenDay ?? null,
          resetsAt: a.usage.sevenDayResetsAt ?? null,
        }));
      this.renderStatusBar();
    } catch {
      /* no accounts configured yet */
    }
  },

  // ── Focus mode ──────────────────────────────────────────────────────────
  toggleFocusMode(force) {
    const root = document.documentElement;
    const on = typeof force === 'boolean' ? force : root.dataset.focus !== 'on';
    if (on) root.dataset.focus = 'on';
    else delete root.dataset.focus;
    const btn = document.getElementById('focusModeBtn');
    btn?.setAttribute('aria-pressed', String(on));
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    // Let layout settle, then make the terminal fill its new size.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  },
});

(function wireStatusBar() {
  const proto = CodemanApp.prototype;
  const setStatus = proto.setConnectionStatus;
  proto.setConnectionStatus = function (status) {
    setStatus?.call(this, status);
    this.renderStatusBar?.();
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.documentElement.dataset.focus === 'on') {
      window.app?.toggleFocusMode(false);
    }
  });
  const start = () => {
    const app = window.app;
    if (!app) return setTimeout(start, 300);
    app.renderStatusBar();
    app.refreshStatusBarAccounts();
    setInterval(() => app.renderStatusBar(), 2000);
    setInterval(() => app.refreshStatusBarAccounts(), STATUS_BAR_ACCOUNTS_MS);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
