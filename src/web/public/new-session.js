/**
 * @fileoverview New session dialog: start Claude on any machine, system, folder,
 * account and model from one place, with recent picks first.
 *
 * Machines, their systems (WSL, Windows, Linux) and the accounts come from
 * `GET /api/fleet` (fleet-routes.ts). A system is one remote host; the account
 * and model ride the launch (`fleetAccountId`/`fleetModel` on quick-start), so
 * one host serves every account. "This server" runs the agent where Claude RC
 * itself runs.
 *
 * The folder field browses the machine over ssh
 * (`GET /api/fleet/hosts/:id/folders`): the list shows the folders under what
 * is typed, typing narrows it, and the hint says whether the folder exists
 * before anything starts.
 *
 * Launching reuses the existing paths: a local folder goes through
 * `POST /api/sessions` + `/interactive|/shell`; a remote folder reuses the
 * remote case for that host and path (or links one with
 * `POST /api/cases/remote-link`) and starts it with `POST /api/quick-start`.
 *
 * Recent picks live in this browser only (`codeman:new-session-recents`).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (selectSession, showToast), fleet-manager.js (openFleetManager)
 * @loadorder 12.58 of 16, after overview-board.js
 */

const NEW_SESSION_RECENTS_KEY = 'codeman:new-session-recents';
const NEW_SESSION_RECENTS_MAX = 8;
const NEW_SESSION_LOCAL = 'local';
const NEW_SESSION_MODELS = [
  ['', 'Default'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];
const SYSTEM_NAMES = { wsl: 'WSL', windows: 'Windows', linux: 'Linux' };

/** `/mnt/c/Users/x` → `C:\Users\x`, the way Windows shows it. */
function windowsPathOf(path) {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(path || '');
  return m ? `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}` : null;
}

/** `C:\Users\x` → `/mnt/c/Users/x`; anything else unchanged. */
function wslPathOf(path) {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(path || '');
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/+$/, '') : path;
}

Object.assign(CodemanApp.prototype, {
  _newSessionRecents() {
    try {
      const list = JSON.parse(localStorage.getItem(NEW_SESSION_RECENTS_KEY) || '[]');
      return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string' && r.target) : [];
    } catch {
      return [];
    }
  },

  _rememberNewSession(pick) {
    const key = (r) => `${r.target}\n${r.path}\n${r.mode}\n${r.accountId || ''}`;
    const list = [pick, ...this._newSessionRecents().filter((r) => key(r) !== key(pick))].slice(
      0,
      NEW_SESSION_RECENTS_MAX
    );
    try {
      localStorage.setItem(NEW_SESSION_RECENTS_KEY, JSON.stringify(list));
    } catch {
      /* storage blocked: recents are a convenience */
    }
  },

  async _fetchJson(url, init) {
    const res = await fetch(url, init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.success === false) {
      throw new Error(json?.error || `${res.status} ${res.statusText}`);
    }
    return json && 'data' in json ? json.data : json;
  },

  /** Fleet machines plus this server, each with its systems. */
  _newSessionMachines(fleet) {
    const list = (fleet?.machines || []).map((m) => ({
      name: m.name,
      address: m.host,
      systems: m.systems.map((s) => ({
        id: s.hostId,
        system: s.system || (/windows/i.test(s.label) ? 'windows' : 'linux'),
        label: SYSTEM_NAMES[s.system] || s.label.split(' · ').slice(1).join(' · ') || 'Default',
      })),
    }));
    list.push({
      name: this._localMachineLabel?.() || 'This server',
      address: 'local',
      systems: [{ id: NEW_SESSION_LOCAL, system: 'linux', label: 'Local' }],
    });
    return list;
  },

  async openNewSessionFlow() {
    let fleet = null;
    try {
      fleet = await this._fetchJson('/api/fleet');
    } catch (err) {
      this.showToast?.(`Could not load machines: ${err.message}`, 'error');
    }
    this._renderNewSessionDialog(this._newSessionMachines(fleet), fleet?.accounts || []);
  },

  _renderNewSessionDialog(machines, accounts) {
    document.getElementById('newSessionDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'newSessionDialog';
    dialog.className = 'ns-dialog';
    dialog.setAttribute('aria-labelledby', 'nsTitle');

    const systemById = new Map();
    for (const m of machines) for (const s of m.systems) systemById.set(s.id, { machine: m, system: s });
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const recents = this._newSessionRecents().filter((r) => systemById.has(r.target));
    const first = recents[0];
    const state = {
      machine: systemById.get(first?.target)?.machine || machines[0],
      target: first?.target || machines[0].systems[0].id,
      mode: first?.mode || 'claude',
      accountId: first?.accountId && accountById.has(first.accountId) ? first.accountId : '',
      model: first?.model || '',
    };

    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ns-form';
    form.innerHTML = `
      <header class="ns-head">
        <h2 id="nsTitle">New session</h2>
        <button type="button" class="ns-manage">Machines &amp; accounts</button>
        <button type="button" class="ns-close" aria-label="Close">×</button>
      </header>
      <section class="ns-recents" hidden>
        <h3 class="ns-label">Recent</h3>
        <div class="ns-recent-list" role="list"></div>
      </section>
      <div class="ns-field">
        <span class="ns-label" id="nsMachineLabel">Machine</span>
        <div class="ns-chips" data-ns="machine" role="radiogroup" aria-labelledby="nsMachineLabel"></div>
      </div>
      <div class="ns-field" data-ns-row="system">
        <span class="ns-label" id="nsSystemLabel">System</span>
        <div class="ns-chips" data-ns="system" role="radiogroup" aria-labelledby="nsSystemLabel"></div>
      </div>
      <div class="ns-field">
        <label class="ns-label" for="nsPath">Folder</label>
        <div class="ns-path-row">
          <input class="ns-input" id="nsPath" name="path" required autocomplete="off" spellcheck="false" placeholder="~/project">
          <button type="button" class="ns-browse-up" title="Parent folder" aria-label="Parent folder">↑</button>
        </div>
        <span class="ns-hint" aria-live="polite"></span>
        <div class="ns-browse" role="listbox" aria-label="Folders"></div>
      </div>
      <div class="ns-field" data-ns-row="account">
        <span class="ns-label" id="nsAccountLabel">Account</span>
        <div class="ns-chips" data-ns="account" role="radiogroup" aria-labelledby="nsAccountLabel"></div>
      </div>
      <div class="ns-field" data-ns-row="model">
        <span class="ns-label" id="nsModelLabel">Model</span>
        <div class="ns-chips" data-ns="model" role="radiogroup" aria-labelledby="nsModelLabel"></div>
      </div>
      <div class="ns-field">
        <span class="ns-label" id="nsModeLabel">Agent</span>
        <div class="ns-chips" data-ns="mode" role="radiogroup" aria-labelledby="nsModeLabel"></div>
      </div>
      <p class="ns-error" role="alert" hidden></p>
      <footer class="ns-foot">
        <button type="button" class="ns-cancel">Cancel</button>
        <button type="submit" class="ns-start">Start session</button>
      </footer>`;
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    const $ = (sel) => form.querySelector(sel);
    const pathInput = $('#nsPath');
    const errorEl = $('.ns-error');
    const hintEl = $('.ns-hint');
    const browseEl = $('.ns-browse');

    const chip = (label, selected, onPick, detail = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ns-chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(selected));
      b.setAttribute('data-i18n-skip', '');
      b.textContent = label;
      if (detail) {
        const d = document.createElement('span');
        d.className = 'ns-chip-detail';
        d.textContent = detail;
        b.appendChild(d);
      }
      b.addEventListener('click', onPick);
      return b;
    };

    const current = () => systemById.get(state.target);
    const isWindows = () => current()?.system.system === 'windows';
    const recentPathsFor = (target) =>
      this._newSessionRecents()
        .filter((r) => r.target === target)
        .map((r) => r.path);
    const defaultPath = (target) =>
      recentPathsFor(target)[0] || (systemById.get(target)?.system.system === 'windows' ? '/mnt/c/Users' : '~');
    // What the server is asked for: the WSL form of a typed Windows path.
    const typedPath = () => {
      const raw = pathInput.value.trim();
      return isWindows() ? wslPathOf(raw) : raw;
    };

    // ── Folder browsing ──
    let browseSeq = 0;
    let browseTimer = null;
    const listing = { dir: null, dirs: [], exists: null };

    const renderBrowse = () => {
      const raw = typedPath();
      const endsSlash = raw.endsWith('/');
      const prefix = endsSlash ? '' : raw.split('/').pop();
      const exactDir = listing.dir && (raw.replace(/\/+$/, '') === listing.dir || raw === '~');
      // Hidden folders only once a typed "." asks for them.
      const shown = exactDir
        ? listing.dirs.filter((d) => !d.startsWith('.'))
        : listing.dirs.filter(
            (d) => d.toLowerCase().startsWith(prefix.toLowerCase()) && (prefix.startsWith('.') || !d.startsWith('.'))
          );
      browseEl.replaceChildren(
        ...shown.slice(0, 200).map((name) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'ns-browse-row';
          row.setAttribute('role', 'option');
          row.setAttribute('data-i18n-skip', '');
          row.textContent = name;
          row.addEventListener('click', () => {
            const base = listing.dir === '/' ? '' : listing.dir;
            const next = `${base}/${name}`;
            pathInput.value = isWindows() ? windowsPathOf(next) || next : next;
            queueBrowse(0);
            pathInput.focus();
          });
          return row;
        })
      );
      browseEl.hidden = !shown.length;
    };

    const setHint = (text, kind = '') => {
      hintEl.textContent = text;
      hintEl.dataset.kind = kind;
    };

    const browse = async () => {
      const seq = ++browseSeq;
      errorEl.hidden = true;
      if (state.target === NEW_SESSION_LOCAL) {
        listing.dir = null;
        listing.dirs = [];
        browseEl.hidden = true;
        setHint('A folder on the server Claude RC runs on.');
        return;
      }
      const raw = typedPath() || '~';
      // Look at the folder itself; if it is not there, at its parent (for completion).
      const asked = raw.endsWith('/') ? raw.replace(/\/+$/, '') || '/' : raw;
      setHint(`Checking ${current().machine.name}…`);
      try {
        let result = await this._fetchJson(
          `/api/fleet/hosts/${encodeURIComponent(state.target)}/folders?path=${encodeURIComponent(asked)}`
        );
        if (seq !== browseSeq) return;
        let exists = result.exists;
        if (!exists && asked.includes('/')) {
          const parent = asked.slice(0, asked.lastIndexOf('/')) || '/';
          result = await this._fetchJson(
            `/api/fleet/hosts/${encodeURIComponent(state.target)}/folders?path=${encodeURIComponent(parent)}`
          );
          if (seq !== browseSeq) return;
        }
        listing.dir = result.exists ? result.path : null;
        listing.dirs = result.exists ? result.dirs : [];
        listing.exists = exists;
        const shownPath = isWindows() ? windowsPathOf(asked) || asked : asked;
        if (exists) setHint(`${shownPath} exists on ${current().machine.name}.`, 'ok');
        else setHint(`${shownPath} does not exist on ${current().machine.name}.`, 'missing');
        renderBrowse();
      } catch (err) {
        if (seq !== browseSeq) return;
        listing.exists = null;
        browseEl.hidden = true;
        setHint(`Could not reach ${current().machine.name}: ${err.message}`, 'missing');
      }
    };

    const queueBrowse = (delay = 350) => {
      clearTimeout(browseTimer);
      browseTimer = setTimeout(browse, delay);
    };

    pathInput.addEventListener('input', () => {
      renderBrowse();
      queueBrowse();
    });
    pathInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.shiftKey) return;
      const first = browseEl.querySelector('.ns-browse-row');
      if (!first || browseEl.hidden) return;
      // Tab completes to the first matching folder, like a shell.
      event.preventDefault();
      first.click();
    });
    $('.ns-browse-up').addEventListener('click', () => {
      const raw = typedPath().replace(/\/+$/, '');
      const up = raw === '~' || raw === '' ? '/' : raw.slice(0, raw.lastIndexOf('/')) || '/';
      pathInput.value = isWindows() ? windowsPathOf(up) || up : up;
      queueBrowse(0);
    });

    // ── Choices ──
    const accountsFor = () => {
      const windows = isWindows();
      return accounts.filter((a) => !(windows && a.kind === 'cswap' && !a.hasSecret));
    };

    const usageText = (a) => {
      const u = a.usage;
      if (!u) return '';
      const parts = [];
      if (u.fiveHour != null) parts.push(`5h ${Math.round(u.fiveHour)}%`);
      if (u.sevenDay != null) parts.push(`7d ${Math.round(u.sevenDay)}%`);
      return parts.join(' · ');
    };

    const render = () => {
      $('[data-ns="machine"]').replaceChildren(
        ...machines.map((m) =>
          chip(
            m.name,
            m === state.machine,
            () => {
              state.machine = m;
              state.target = m.systems[0].id;
              pathInput.value = this._displayPath(defaultPath(state.target), m.systems[0].system);
              render();
              queueBrowse(0);
            },
            m.address === 'local' ? '' : m.address
          )
        )
      );
      $('[data-ns-row="system"]').hidden = state.machine.systems.length < 2;
      $('[data-ns="system"]').replaceChildren(
        ...state.machine.systems.map((s) =>
          chip(s.label, s.id === state.target, () => {
            state.target = s.id;
            pathInput.value = this._displayPath(defaultPath(s.id), s.system);
            render();
            queueBrowse(0);
          })
        )
      );
      const claude = state.mode === 'claude';
      const remote = state.target !== NEW_SESSION_LOCAL;
      const available = accountsFor();
      if (state.accountId && !available.some((a) => a.id === state.accountId)) state.accountId = '';
      $('[data-ns-row="account"]').hidden = !(claude && remote);
      $('[data-ns="account"]').replaceChildren(
        chip("Machine's login", state.accountId === '', () => {
          state.accountId = '';
          render();
        }),
        ...available.map((a) =>
          chip(
            a.label,
            a.id === state.accountId,
            () => {
              state.accountId = a.id;
              render();
            },
            usageText(a)
          )
        )
      );
      const account = accountById.get(state.accountId);
      $('[data-ns-row="model"]').hidden = !(claude && remote) || account?.kind === 'api';
      $('[data-ns="model"]').replaceChildren(
        ...NEW_SESSION_MODELS.map(([value, label]) =>
          chip(label, value === state.model, () => {
            state.model = value;
            render();
          })
        )
      );
      $('[data-ns="mode"]').replaceChildren(
        ...[
          ['claude', 'Claude Code'],
          ['shell', 'Shell'],
        ].map(([mode, label]) =>
          chip(label, mode === state.mode, () => {
            state.mode = mode;
            render();
          })
        )
      );
      pathInput.placeholder = isWindows() ? 'C:\\Users\\you\\project' : '~/project';
    };

    const list = $('.ns-recent-list');
    if (recents.length) {
      $('.ns-recents').hidden = false;
      for (const r of recents) {
        const { machine, system } = systemById.get(r.target);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ns-recent';
        row.setAttribute('role', 'listitem');
        row.setAttribute('data-i18n-skip', '');
        const name = document.createElement('span');
        name.className = 'ns-recent-name';
        name.textContent = r.path.split('/').filter(Boolean).pop() || r.path;
        const where = document.createElement('span');
        where.className = 'ns-recent-where';
        where.textContent = [
          machine.name,
          machine.systems.length > 1 ? system.label : '',
          accountById.get(r.accountId)?.label || '',
          NEW_SESSION_MODELS.find(([v]) => v && v === r.model)?.[1] || '',
          r.mode === 'shell' ? 'Shell' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const path = document.createElement('span');
        path.className = 'ns-recent-path';
        path.textContent = this._displayPath(r.path, system.system);
        row.append(name, where, path);
        row.addEventListener('click', () => this._launchNewSession(dialog, r, systemById, accountById, errorEl));
        list.appendChild(row);
      }
    }

    pathInput.value = this._displayPath(defaultPath(state.target), current()?.system.system);
    render();
    queueBrowse(0);

    const close = () => dialog.close();
    $('.ns-close').addEventListener('click', close);
    $('.ns-cancel').addEventListener('click', close);
    $('.ns-manage').addEventListener('click', () => {
      close();
      this.openFleetManager?.();
    });
    dialog.addEventListener('close', () => {
      clearTimeout(browseTimer);
      dialog.remove();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (listing.exists === false && state.target !== NEW_SESSION_LOCAL) {
        errorEl.textContent = 'That folder does not exist on the machine. Pick one from the list, or fix the path.';
        errorEl.hidden = false;
        return;
      }
      const path = (typedPath().replace(/\/+$/, '') || '/').replace(/^~$/, listing.dir || '~');
      this._launchNewSession(
        dialog,
        {
          target: state.target,
          path: path.startsWith('~') && listing.dir && listing.exists ? listing.dir : path,
          mode: state.mode,
          accountId: state.accountId || undefined,
          model: state.model || undefined,
        },
        systemById,
        accountById,
        errorEl
      );
    });

    dialog.showModal();
    (recents.length ? list.firstElementChild : pathInput)?.focus();
  },

  _displayPath(path, system) {
    return system === 'windows' ? windowsPathOf(path) || path : path;
  },

  async _launchNewSession(dialog, pick, systemById, accountById, errorEl) {
    const startBtn = dialog.querySelector('.ns-start');
    if (startBtn.disabled) return;
    errorEl.hidden = true;
    if (!pick.path.startsWith('/')) {
      errorEl.textContent = 'Pick the folder from the list so its full path is known.';
      errorEl.hidden = false;
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    try {
      const account = accountById.get(pick.accountId);
      const folder = pick.path.split('/').filter(Boolean).pop() || pick.path;
      const sessionName = pick.mode === 'claude' && account ? `${folder} · ${account.label}` : folder;
      const id =
        pick.target === NEW_SESSION_LOCAL
          ? await this._startLocalSession(pick, sessionName)
          : await this._startRemoteSession(pick, pick.target, sessionName);
      this._rememberNewSession({ ...pick, at: Date.now() });
      dialog.close();
      await this._selectWhenPresent(id);
    } catch (err) {
      errorEl.textContent = `Could not start the session: ${err.message}`;
      errorEl.hidden = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Start session';
    }
  },

  async _startLocalSession({ path, mode }, name) {
    const created = await this._fetchJson('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: path, mode, name }),
    });
    const id = created?.session?.id || created?.id;
    await this._fetchJson(`/api/sessions/${encodeURIComponent(id)}/${mode === 'shell' ? 'shell' : 'interactive'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return id;
  },

  /** Reuse the remote case for this host and folder, or link one, then start it. */
  async _startRemoteSession({ path, mode, accountId, model }, hostId, sessionName) {
    const cases = await this._fetchJson('/api/cases');
    const all = Array.isArray(cases) ? cases : [];
    let match = all.find((c) => c.location === 'remote' && c.remote?.hostId === hostId && c.remote?.path === path);
    if (!match) {
      const stem = `${hostId}-${path.split('/').filter(Boolean).pop() || 'root'}`
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .slice(0, 60);
      const taken = new Set(all.map((c) => c.name));
      let name = stem;
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
      const linked = await this._fetchJson('/api/cases/remote-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, hostId, remotePath: path }),
      });
      match = linked?.case || { name };
    }
    const body = { caseName: match.name, mode, sessionName };
    if (mode === 'claude') {
      if (accountId) body.fleetAccountId = accountId;
      if (model) body.fleetModel = model;
    }
    const started = await this._fetchJson('/api/quick-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return started?.sessionId;
  },

  /** Select a just-created session once its SSE upsert has landed. */
  async _selectWhenPresent(id) {
    if (!id) return;
    for (let i = 0; i < 50 && !this.sessions.has(id); i++) await new Promise((r) => setTimeout(r, 100));
    if (this.sessions.has(id)) this.selectSession(id);
  },
});
