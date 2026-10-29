/**
 * @fileoverview Past conversations on every machine (fork): the welcome screen's
 * "Resume Conversation" list and the phone overview's PAST SESSIONS get a machine
 * filter. "This server" keeps the existing local list; a machine lists its
 * `~/.claude/projects` conversations from `GET /api/fleet/history/:target`
 * (claude-history.ts: one pooled-shell command per page, cached 30 s), newest first.
 *
 * One click resumes: a new dashboard session on that machine, in the conversation's
 * folder, running `claude --resume <id>` with the machine's own login, through the
 * same remote quick-start path as "Resume here" (`_startRemoteSession`). A row the
 * dashboard already shows selects that tab instead; a row running elsewhere on the
 * machine asks first, since two writers on one log mix up turns.
 *
 * The machine list comes from `GET /api/fleet/running` (one entry per ssh login, so a
 * PC's Windows system is folded into its WSL one). Admin-only routes: when they
 * refuse, the filter simply never appears.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson, _startRemoteSession, _selectWhenPresent),
 *   terminal-ui.js (_renderHistoryList, _shortenHomePath), mobile-overview.js
 * @loadorder after running-claude.js
 */

/** A folder the server's path checks accept (SAFE_PATH_PATTERN, absolute). */
const MACHINE_HISTORY_SAFE_PATH = /^\/[\p{L}\p{N}_/\-. ~]*$/u;
const MACHINE_HISTORY_KEY = 'codeman:historyMachine';
const MACHINE_HISTORY_PAGE = 30;
/** A machine's list is re-read when shown again after this long. */
const MACHINE_HISTORY_STALE_MS = 60_000;
const MACHINE_HISTORY_TARGETS_TTL_MS = 5 * 60_000;

Object.assign(CodemanApp.prototype, {
  // ── Data ────────────────────────────────────────────────────────────────

  /** Remote machines to list. [] when the fleet routes refuse or none are set up. */
  async _machineHistoryTargets(force = false) {
    const fresh = this._mhTargetsAt && Date.now() - this._mhTargetsAt < MACHINE_HISTORY_TARGETS_TTL_MS;
    if (!force && fresh) return this._mhTargets || [];
    if (!this._mhTargetsPromise) {
      this._mhTargetsPromise = this._fetchJson('/api/fleet/running')
        .then((data) => (data?.targets || []).filter((t) => t && t.hostId))
        .catch(() => [])
        .then((targets) => {
          this._mhTargets = targets;
          this._mhTargetsAt = Date.now();
          this._mhTargetsPromise = null;
          return targets;
        });
    }
    return this._mhTargetsPromise;
  },

  _machineHistoryTarget(targetId) {
    return (this._mhTargets || []).find((t) => t.id === targetId) || null;
  },

  /** The machine the lists show: '' for this server. Shared by desktop and phone. */
  _historyMachineSelected() {
    if (this._historyMachine === undefined) {
      try {
        this._historyMachine = localStorage.getItem(MACHINE_HISTORY_KEY) || '';
      } catch {
        this._historyMachine = '';
      }
    }
    // A machine removed since it was picked falls back to this server.
    if (this._historyMachine && this._mhTargets && !this._machineHistoryTarget(this._historyMachine)) return '';
    return this._historyMachine;
  },

  _setHistoryMachine(targetId) {
    this._historyMachine = targetId || '';
    this._historyExpanded = false;
    try {
      localStorage.setItem(MACHINE_HISTORY_KEY, this._historyMachine);
    } catch {
      /* storage blocked: the choice lasts this page load */
    }
    if (this._historyMachine) this._ensureMachineHistory(this._historyMachine);
  },

  _machineHistoryEntry(targetId) {
    if (!this._mhCache) this._mhCache = new Map();
    let entry = this._mhCache.get(targetId);
    if (!entry) {
      entry = { rows: [], total: 0, nextOffset: 0, loading: false, loaded: false, error: '', at: 0 };
      this._mhCache.set(targetId, entry);
    }
    return entry;
  },

  /** Load the first page when nothing is loaded yet, or reload it when stale. */
  _ensureMachineHistory(targetId) {
    const entry = this._machineHistoryEntry(targetId);
    if (entry.loading) return;
    if (!entry.loaded && !entry.error) void this._loadMachineHistory(targetId);
    else if (entry.at && Date.now() - entry.at > MACHINE_HISTORY_STALE_MS) void this._loadMachineHistory(targetId);
  },

  async _loadMachineHistory(targetId, { more = false, fresh = false } = {}) {
    const entry = this._machineHistoryEntry(targetId);
    if (entry.loading) return;
    const offset = more ? entry.nextOffset : 0;
    if (more && offset == null) return;
    entry.loading = true;
    entry.error = '';
    this._onMachineHistoryChange(targetId);
    try {
      const qs = `offset=${offset}&limit=${MACHINE_HISTORY_PAGE}${fresh ? '&fresh=1' : ''}`;
      const page = await this._fetchJson(`/api/fleet/history/${encodeURIComponent(targetId)}?${qs}`);
      const byId = new Map(more ? entry.rows.map((r) => [r.id, r]) : []);
      for (const row of page.rows || []) byId.set(row.id, row);
      entry.rows = [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      entry.total = page.total || 0;
      entry.nextOffset = page.nextOffset ?? null;
      entry.runningKnown = page.runningKnown !== false;
      entry.loaded = true;
      entry.at = Date.now();
    } catch (err) {
      entry.error = err.message || 'Could not load';
      entry.at = Date.now();
    } finally {
      entry.loading = false;
      this._onMachineHistoryChange(targetId);
    }
  },

  _onMachineHistoryChange(targetId) {
    if (this._historyMachineSelected() !== targetId) return;
    this._renderHistoryList?.();
    if (this.isMobileOverviewVisible?.()) this.renderMobileOverview();
  },

  // ── Row text ────────────────────────────────────────────────────────────

  _machineHistoryFolder(row) {
    return (row.cwd || '').split('/').filter(Boolean).pop() || row.cwd || row.projectKey || '';
  },

  _machineHistoryLabel(row) {
    return row.title || row.firstPrompt || row.lastPrompt || this._machineHistoryFolder(row) || row.id.slice(0, 8);
  },

  _machineHistorySize(bytes) {
    if (typeof bytes !== 'number') return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}K`;
    return `${(bytes / 1048576).toFixed(1)}M`;
  },

  _machineHistoryWhen(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return (
      d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
    );
  },

  _machineHistoryPath(row) {
    if (!row.cwd) return row.projectKey || 'folder unknown';
    return this._shortenHomePath ? this._shortenHomePath(row.cwd) : row.cwd;
  },

  /** 'open' (a dashboard tab has it), 'running' (a Claude there has it), or ''. */
  _machineHistoryState(row) {
    if (row.openSessionId && this.sessions?.has(row.openSessionId)) return 'open';
    return row.running ? 'running' : '';
  },

  // ── Resume ──────────────────────────────────────────────────────────────

  async resumeMachineConversation(targetId, conversationId) {
    const target = this._machineHistoryTarget(targetId);
    const row = this._machineHistoryEntry(targetId).rows.find((r) => r.id === conversationId);
    if (!target || !row) return;
    if (this._machineHistoryState(row) === 'open') {
      await this.selectSession(row.openSessionId);
      return;
    }
    if (!row.cwd || !MACHINE_HISTORY_SAFE_PATH.test(row.cwd)) {
      this.showToast?.("This conversation's folder is unknown, so it cannot be resumed here.", 'error');
      return;
    }
    if (
      row.running &&
      !confirm(
        `A Claude on ${target.name} has this conversation open.\n\n` +
          'Resuming starts a second Claude on it. Both write to one log, which can mix up or ' +
          'lose turns. Quit the other one first if you can.\n\nResume anyway?'
      )
    ) {
      return;
    }
    if (this._mhResuming) return;
    this._mhResuming = true;
    this.showToast?.(`Resuming on ${target.name}…`, 'info');
    try {
      const id = await this._startRemoteSession(
        { path: row.cwd, mode: 'claude', resumeSessionId: row.id },
        target.hostId,
        this._machineHistoryFolder(row) || 'resumed'
      );
      row.running = true;
      if (id) row.openSessionId = id;
      await this._selectWhenPresent(id);
    } catch (err) {
      this.showToast?.(`Could not resume: ${err.message}`, 'error');
    } finally {
      this._mhResuming = false;
    }
  },

  // ── Desktop: welcome "Resume Conversation" ──────────────────────────────

  /** Fill the machine select; hidden while no machine is set up. */
  _syncHistoryMachineSelect(targets) {
    const select = document.getElementById('historyMachine');
    if (!select) return;
    if (!targets.length) {
      select.hidden = true;
      return;
    }
    const selected = this._historyMachineSelected();
    const options = [['', this._localMachineLabel?.() || 'This server'], ...targets.map((t) => [t.id, t.name])];
    const sig = JSON.stringify(options);
    if (select.dataset.sig !== sig) {
      select.replaceChildren(
        ...options.map(([value, label]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          return opt;
        })
      );
      select.dataset.sig = sig;
    }
    select.value = selected;
    select.hidden = false;
    if (!select.dataset.wired) {
      select.dataset.wired = '1';
      select.addEventListener('change', () => {
        this._setHistoryMachine(select.value);
        this._renderHistoryList();
      });
    }
  },

  /** The list for one machine; same box, filter and sort as the local list. */
  _renderMachineHistoryList(targetId) {
    const list = document.getElementById('historyList');
    if (!list) return;
    this._ensureMachineHistory(targetId);
    const target = this._machineHistoryTarget(targetId);
    const entry = this._machineHistoryEntry(targetId);
    const countEl = document.getElementById('historyCount');
    const needle = (document.getElementById('historyFilter')?.value || '').trim().toLowerCase();
    const mode = document.getElementById('historySort')?.value || 'recent';

    let rows = needle
      ? entry.rows.filter((r) =>
          [r.title, r.firstPrompt, r.lastPrompt, r.cwd, r.id].some(
            (f) => typeof f === 'string' && f.toLowerCase().includes(needle)
          )
        )
      : entry.rows.slice();
    if (mode !== 'recent') {
      const key = mode === 'name' ? (r) => this._machineHistoryLabel(r) : (r) => this._machineHistoryFolder(r);
      rows.sort((a, b) => key(a).localeCompare(key(b), undefined, { sensitivity: 'base', numeric: true }));
    }
    const expanded = !!this._historyExpanded || needle.length > 0;
    const visible = expanded ? rows : rows.slice(0, this._HISTORY_INITIAL_COUNT);

    list.replaceChildren();
    list.classList.toggle('expanded', expanded);

    const note = (text, cls = 'history-empty') => {
      const el = document.createElement('div');
      el.className = cls;
      el.setAttribute('data-i18n-skip', '');
      el.textContent = text;
      list.appendChild(el);
    };
    if (entry.error) note(`${target?.name || 'Machine'}: ${entry.error}`, 'history-empty history-error');
    if (!rows.length) {
      if (entry.loading || !entry.loaded) note(`Reading ${target?.name || 'machine'}…`);
      else if (!entry.error) note(needle ? `No conversations match "${needle}"` : 'No past conversations there');
    }
    for (const row of visible) list.appendChild(this._buildMachineHistoryItem(targetId, row));

    const hidden = rows.length - visible.length;
    const button = (label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'history-show-more';
      b.textContent = label;
      b.addEventListener('click', onClick);
      list.appendChild(b);
      return b;
    };
    if (hidden > 0) {
      button(`Show ${hidden} more`, () => {
        this._historyExpanded = true;
        this._renderHistoryList();
      });
    } else if (entry.nextOffset != null && entry.loaded && !needle) {
      const more = button(entry.loading ? 'Loading…' : 'Load older', () => {
        this._historyExpanded = true;
        void this._loadMachineHistory(targetId, { more: true });
      });
      more.disabled = entry.loading;
    }

    if (countEl) {
      const shown = needle ? `${rows.length} of ${entry.rows.length}` : String(entry.rows.length);
      countEl.textContent = entry.total > entry.rows.length && !needle ? `${shown} of ${entry.total}` : shown;
    }
  },

  _buildMachineHistoryItem(targetId, row) {
    const state = this._machineHistoryState(row);
    const item = document.createElement('div');
    item.className = 'history-item machine-history-item' + (state ? ` is-${state}` : '');
    item.title = `${row.cwd || row.projectKey}\n${row.id}`;

    const main = document.createElement('div');
    main.className = 'history-item-main';
    main.setAttribute('role', 'button');
    main.tabIndex = 0;
    const activate = () => void this.resumeMachineConversation(targetId, row.id);
    main.addEventListener('click', activate);
    main.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      }
    });

    const text = document.createElement('div');
    text.className = 'history-item-text';
    const title = document.createElement('span');
    title.className = 'history-item-title';
    title.setAttribute('data-i18n-skip', '');
    title.textContent = this._machineHistoryLabel(row);
    text.appendChild(title);

    if (state) {
      const badges = document.createElement('div');
      badges.className = 'history-item-badges';
      const badge = document.createElement('span');
      badge.className = `history-item-badge history-item-badge-${state === 'open' ? 'live' : 'running'}`;
      badge.setAttribute('data-i18n-skip', '');
      badge.textContent = state === 'open' ? 'OPEN' : 'RUNNING';
      badge.title =
        state === 'open' ? 'Open in a dashboard tab: click to switch to it' : 'A Claude on that machine has it open';
      badges.appendChild(badge);
      text.appendChild(badges);
    }

    const sub = document.createElement('span');
    sub.className = 'history-item-subtitle';
    sub.setAttribute('data-i18n-skip', '');
    sub.textContent = [this._machineHistoryPath(row), row.title && row.firstPrompt ? row.firstPrompt : '']
      .filter(Boolean)
      .join(' · ');
    text.appendChild(sub);

    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    meta.setAttribute('data-i18n-skip', '');
    meta.textContent = [this._machineHistoryWhen(row.lastActivityAt), this._machineHistorySize(row.sizeBytes)]
      .filter(Boolean)
      .join(' · ');

    main.append(text, meta);
    item.appendChild(main);
    return item;
  },

  // ── Phone: overview PAST SESSIONS ───────────────────────────────────────

  /**
   * The PAST SESSIONS section with a machine row above it, or null while no machine
   * is set up (the section then renders exactly as before).
   */
  _buildMobileOverviewPastSection(model) {
    if (!this._mhTargets) {
      void this._machineHistoryTargets().then((targets) => {
        if (targets.length && this.isMobileOverviewVisible?.()) this.renderMobileOverview();
      });
      return null;
    }
    const targets = this._mhTargets;
    if (!targets.length) return null;
    const selected = this._historyMachineSelected();
    const chips = this._buildMobileOverviewMachineChips(targets, selected);
    if (!selected) {
      const rows = this._buildMobileOverviewPast(model);
      const children = [chips, ...rows];
      if (!rows.length) {
        children.push(this._moEmpty(this._mobileOverviewHistory ? 'No past conversations yet' : 'Loading…'));
      }
      return this._buildMobileOverviewSection('Past sessions', model.past.length, children);
    }

    this._ensureMachineHistory(selected);
    const entry = this._machineHistoryEntry(selected);
    const target = this._machineHistoryTarget(selected);
    const children = [chips];
    if (entry.error) children.push(this._moEmpty(`${target?.name || 'Machine'}: ${entry.error}`));
    const showAll = !!this._mobileOverviewShowAllPast;
    const visible = showAll ? entry.rows : entry.rows.slice(0, MOBILE_OVERVIEW_PAST_LIMIT);
    for (const row of visible) children.push(this._buildMobileOverviewMachineRow(row));
    if (!entry.rows.length && !entry.error) {
      children.push(this._moEmpty(entry.loaded ? 'No past conversations there' : `Reading ${target?.name || ''}…`));
    }
    const hidden = entry.rows.length - visible.length;
    const more = (label, action, count) => {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mobile-overview-more';
      toggle.dataset.moAction = action;
      const text = document.createElement('span');
      text.textContent = label;
      toggle.appendChild(text);
      if (count) {
        const n = document.createElement('span');
        n.className = 'mobile-overview-more-count';
        n.setAttribute('data-i18n-skip', '');
        n.textContent = String(count);
        toggle.appendChild(n);
      }
      if (entry.loading && action === 'more-machine') toggle.disabled = true;
      children.push(toggle);
    };
    if (hidden > 0) more('Show all past sessions', 'more-past', hidden);
    else if (entry.nextOffset != null && entry.loaded) more(entry.loading ? 'Loading…' : 'Load older', 'more-machine');
    return this._buildMobileOverviewSection('Past sessions', entry.rows.length, children);
  },

  _moEmpty(text) {
    const p = document.createElement('p');
    p.className = 'mobile-overview-empty';
    p.setAttribute('data-i18n-skip', '');
    p.textContent = text;
    return p;
  },

  _buildMobileOverviewMachineChips(targets, selected) {
    const row = document.createElement('div');
    row.className = 'mobile-overview-machines';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Machine');
    const chip = (id, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mobile-overview-machine' + (id === selected ? ' active' : '');
      b.setAttribute('aria-pressed', id === selected ? 'true' : 'false');
      b.setAttribute('data-i18n-skip', '');
      b.dataset.moAction = 'history-machine';
      b.dataset.moMachine = id;
      b.textContent = label;
      row.appendChild(b);
    };
    chip('', this._localMachineLabel?.() || 'This server');
    for (const t of targets) chip(t.id, t.name);
    return row;
  },

  _buildMobileOverviewMachineRow(row) {
    const state = this._machineHistoryState(row);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-overview-row mobile-overview-row--past' + (state ? ` mobile-overview-row--${state}` : '');
    item.dataset.moAction = 'resume-machine';
    item.dataset.moSession = row.id;

    const dot = document.createElement('span');
    dot.className = 'mobile-overview-dot mobile-overview-dot--past';
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const body = document.createElement('span');
    body.className = 'mobile-overview-row-body';
    const title = document.createElement('span');
    title.className = 'mobile-overview-row-title session-name';
    title.setAttribute('data-i18n-skip', '');
    title.textContent = this._machineHistoryLabel(row);
    body.appendChild(title);
    const sub = document.createElement('span');
    sub.className = 'mobile-overview-row-sub';
    sub.setAttribute('data-i18n-skip', '');
    const when = row.lastActivityAt && this._formatTimeAgo ? this._formatTimeAgo(row.lastActivityAt) : '';
    sub.textContent = [this._machineHistoryPath(row), when, this._machineHistorySize(row.sizeBytes)]
      .filter(Boolean)
      .join(' · ');
    body.appendChild(sub);
    item.appendChild(body);

    const pill = document.createElement('span');
    pill.className =
      'mobile-overview-pill ' +
      (state === 'open'
        ? 'mobile-overview-pill--idle'
        : state === 'running'
          ? 'mobile-overview-pill--running'
          : 'mobile-overview-pill--past');
    pill.setAttribute('data-i18n-skip', '');
    pill.textContent = state || 'resume';
    item.appendChild(pill);

    const chevron = document.createElement('span');
    chevron.className = 'mobile-overview-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    item.appendChild(chevron);
    return item;
  },
});
