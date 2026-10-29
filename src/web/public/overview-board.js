/**
 * @fileoverview Overview board: the desktop home screen as a board of every
 * session, grouped by the machine it runs on.
 *
 * The fork's workbench puts the session list in the explorer (the vertical
 * rail), so the home screen no longer needs a second list down its gutter.
 * Instead it answers the question the owner opens the dashboard with: which
 * agent needs me, and what is every machine doing. A "Needs you" section
 * collects every session blocked on input or in error; below it one section
 * per machine (its remote host, else the server Codeman runs on) lists its
 * sessions with their state, how long they have been in it, folder and model.
 *
 * Rows come from `buildHomeSessionRows()` (home-sessions.js), so the state
 * words, the order and the "since" stamp are exactly the explorer's and the
 * phone overview's. Nothing here fetches or subscribes: it renders from state
 * the page already holds, and re-renders on the same tab-render tail the home
 * rail uses.
 *
 * The welcome screen's "Resume Conversation" block (past conversations on every
 * machine, and search) is moved under the board, which hides the rest of it.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency home-sessions.js (buildHomeSessionRows, _homeSessionsStampText, show/hideHomeSessions)
 * @dependency app.js (this.sessions, this.sessionOrder, selectSession, _localMachineLabel)
 * @loadorder 12.57 of 16, after home-sessions.js, before entrance-animations.js
 */

/** Narrowest window that gets the board; below it the welcome screen stays. */
const OVERVIEW_BOARD_MIN_WIDTH = 900;

/** States that put a session in the "Needs you" section. */
const OVERVIEW_BOARD_ATTENTION = new Set(['needs', 'error', 'waiting']);

Object.assign(CodemanApp.prototype, {
  shouldShowOverviewBoard() {
    if (this.isSoloWindow) return false;
    if (this.shouldUseMobileOverview?.()) return false;
    return window.innerWidth >= OVERVIEW_BOARD_MIN_WIDTH;
  },

  _overviewBoardEl() {
    let el = document.getElementById('overviewBoard');
    if (el) return el;
    const overlay = document.getElementById('welcomeOverlay');
    if (!overlay) return null;
    el = document.createElement('section');
    el.id = 'overviewBoard';
    el.className = 'overview-board';
    el.setAttribute('aria-label', 'Overview');
    el.hidden = true;
    el.addEventListener('click', (event) => {
      const row = event.target.closest('[data-ob-session]');
      if (row) {
        this.selectSession(row.dataset.obSession);
        return;
      }
      if (event.target.closest('[data-ob-action="new"]')) this.openNewSessionFlow?.() ?? this.run?.();
    });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('[data-ob-session]');
      if (!row) return;
      event.preventDefault();
      this.selectSession(row.dataset.obSession);
    });
    overlay.prepend(el);
    return el;
  },

  showOverviewBoard() {
    const el = this._overviewBoardEl();
    if (!el) return;
    const overlay = document.getElementById('welcomeOverlay');
    const show = this.shouldShowOverviewBoard();
    el.hidden = !show;
    overlay?.classList.toggle('has-overview-board', show);
    if (show) this.renderOverviewBoard();
    else this._restoreOverviewHistory();
  },

  /**
   * Fork (machine-history.js): the welcome screen's "Resume Conversation" block
   * (past conversations on every machine, plus search) sits under the board, since
   * the board hides the rest of the welcome screen. The block is MOVED, never
   * copied, so its ids and wiring stay single; it goes back when the board hides.
   */
  _overviewHistoryBlock() {
    const block = document.getElementById('historySessions');
    if (!block) return null;
    if (!this._overviewHistoryHome && !block.closest('.overview-board')) {
      this._overviewHistoryHome = { parent: block.parentElement, next: block.nextSibling };
    }
    return block;
  },

  _restoreOverviewHistory() {
    const home = this._overviewHistoryHome;
    const block = document.getElementById('historySessions');
    if (!home || !block || !block.closest('.overview-board')) return;
    home.parent.insertBefore(block, home.next && home.next.parentNode === home.parent ? home.next : null);
  },

  hideOverviewBoard() {
    const el = document.getElementById('overviewBoard');
    if (el) el.hidden = true;
  },

  /** Machine identity for a session: its remote host, else this server. */
  _overviewMachineFor(session) {
    const machine = this._machineNameOf?.(session?.remote);
    if (machine) return { key: `machine:${machine}`, label: machine, remote: true };
    return { key: 'host:local', label: this._localMachineLabel?.() || 'This server', remote: false };
  },

  /** The last two folders of a path: what tells projects apart at a glance. */
  _overviewShortDir(path) {
    const parts = String(path)
      .split(/[\\/]+/)
      .filter(Boolean);
    if (parts.length <= 2) return path;
    return `…/${parts.slice(-2).join('/')}`;
  },

  renderOverviewBoard() {
    const el = document.getElementById('overviewBoard');
    if (!el) return;
    const rows = this.buildHomeSessionRows();
    const order = Array.isArray(this.sessionOrder) ? this.sessionOrder : [];

    const attention = rows.filter((row) => OVERVIEW_BOARD_ATTENTION.has(row.state));
    const machines = new Map();
    for (const row of rows) {
      const machine = this._overviewMachineFor(this.sessions.get(row.id));
      if (!machines.has(machine.key)) machines.set(machine.key, { ...machine, rows: [] });
      machines.get(machine.key).rows.push(row);
    }
    // This server last: the PCs are where the work happens.
    const sections = [...machines.values()].sort(
      (a, b) => Number(a.key === 'host:local') - Number(b.key === 'host:local')
    );

    const working = rows.filter((row) => row.state === 'working').length;
    const head = document.createElement('header');
    head.className = 'ob-head';
    const title = document.createElement('h1');
    title.className = 'ob-title';
    title.textContent = 'Overview';
    const summary = document.createElement('p');
    summary.className = 'ob-summary';
    summary.textContent = [
      `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}`,
      `${sections.length} ${sections.length === 1 ? 'machine' : 'machines'}`,
      working ? `${working} working` : '',
      attention.length ? `${attention.length} need${attention.length === 1 ? 's' : ''} you` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'ob-new';
    newBtn.dataset.obAction = 'new';
    newBtn.textContent = 'New session';
    head.append(title, summary, newBtn);

    const body = document.createElement('div');
    body.className = 'ob-body';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'ob-empty';
      const line = document.createElement('p');
      line.textContent = 'No sessions running. Start one on any machine.';
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'ob-new';
      start.dataset.obAction = 'new';
      start.textContent = 'New session';
      empty.append(line, start);
      body.appendChild(empty);
    }
    if (attention.length) {
      body.appendChild(this._buildOverviewSection('Needs you', attention, order, { attention: true }));
    }
    for (const section of sections) {
      body.appendChild(
        this._buildOverviewSection(section.label, section.rows, order, { remote: section.remote, machine: true })
      );
    }
    const history = this._overviewHistoryBlock();
    if (history && history.parentElement === el) {
      // Re-rendering must not detach the block: that would drop focus from its filter box.
      for (const child of [...el.children]) if (child !== history) child.remove();
      el.insertBefore(head, history);
      el.insertBefore(body, history);
    } else {
      el.replaceChildren(head, body, ...(history ? [history] : []));
    }
  },

  _buildOverviewSection(label, rows, order, { attention = false, remote = false, machine = false } = {}) {
    const section = document.createElement('section');
    section.className = 'ob-section' + (attention ? ' ob-section--attention' : '');
    const heading = document.createElement('h2');
    heading.className = 'ob-section-title';
    const name = document.createElement('span');
    name.textContent = label;
    name.setAttribute('data-i18n-skip', '');
    heading.appendChild(name);
    if (machine) {
      const kind = document.createElement('span');
      kind.className = 'ob-section-kind';
      kind.textContent = remote ? 'remote' : 'local';
      heading.appendChild(kind);
    }
    const count = document.createElement('span');
    count.className = 'ob-section-count';
    count.textContent = String(rows.length);
    heading.appendChild(count);
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'ob-rows';
    list.setAttribute('role', 'list');
    for (const row of rows) list.appendChild(this._buildOverviewRow(row, order));
    section.appendChild(list);
    return section;
  },

  _buildOverviewRow(row, order) {
    const session = this.sessions.get(row.id) || {};
    const el = document.createElement('div');
    el.className = 'ob-row';
    el.dataset.obSession = row.id;
    el.dataset.state = row.display;
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;

    const index = order.indexOf(row.id);
    const num = document.createElement('span');
    num.className = 'ob-num';
    num.textContent = index >= 0 && index < 9 ? String(index + 1) : '';
    if (num.textContent) num.title = `Alt+${num.textContent}`;

    const mark = document.createElement('span');
    mark.className = 'ob-mark';
    mark.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'ob-name';
    name.textContent = row.name;
    name.setAttribute('data-i18n-skip', '');

    const dir = document.createElement('span');
    dir.className = 'ob-dir';
    dir.textContent = this._overviewShortDir(row.dir || session.workingDir || '');
    dir.title = session.workingDir || '';
    dir.setAttribute('data-i18n-skip', '');

    const model = document.createElement('span');
    model.className = 'ob-model';
    // Which system/account on the machine, then what the agent reports.
    model.textContent = [this._machineVariantOf?.(session.remote), row.modeBadge || session.displayModel]
      .filter(Boolean)
      .join(' · ');
    model.setAttribute('data-i18n-skip', '');

    const state = document.createElement('span');
    state.className = 'ob-state';
    const since = row.since?.at ? this._homeSessionsStampText?.(row.since.at, 'for') : '';
    state.textContent = since ? `${row.pill} ${since}` : row.pill;

    el.append(num, mark, name, dir, model, state);
    el.setAttribute('aria-label', `${row.name}, ${state.textContent}`);
    return el;
  },
});

// Ride the home rail's lifecycle: shown, hidden and refreshed at the same
// moments, so the board can never be stale where the rail would not be.
(function wireOverviewBoard() {
  const proto = CodemanApp.prototype;
  const show = proto.showHomeSessions;
  const hide = proto.hideHomeSessions;
  const refresh = proto._refreshHomeSessionsIfVisible;
  proto.showHomeSessions = function () {
    show?.call(this);
    this.showOverviewBoard();
  };
  proto.hideHomeSessions = function () {
    hide?.call(this);
    this.hideOverviewBoard();
  };
  proto._refreshHomeSessionsIfVisible = function () {
    refresh?.call(this);
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay?.classList.contains('visible')) {
      this._debouncedCall('overviewBoard', () => this.showOverviewBoard(), 150);
    }
  };
})();
