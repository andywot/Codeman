/**
 * @fileoverview New session dialog: start an agent on any machine, system,
 * account and folder from one place, with recent picks first.
 *
 * Machines are the remote hosts grouped by label: a host labelled
 * "Desktop · WSL · GLM" is the "WSL · GLM" variant of the machine "Desktop"
 * (app.js `_machineNameOf`). Each variant is a full Codeman remote host with
 * its own launch command (a cswap account, the GLM gateway, native Windows
 * Claude), so picking one needs no new server concept. "This server" runs the
 * agent where Codeman itself runs.
 *
 * Launching reuses the existing paths: a local folder goes through
 * `POST /api/sessions` + `/interactive|/shell`; a remote folder reuses the
 * remote case for that host and path (or links one with
 * `POST /api/cases/remote-link`) and starts it with `POST /api/quick-start`,
 * the route remote cases are meant to use.
 *
 * Recent picks (machine variant, folder, agent) live in this browser only
 * (`codeman:new-session-recents`): they are a convenience, not shared state.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (selectSession, _machineNameOf, _machineVariantOf, showToast)
 * @loadorder 12.58 of 16, after overview-board.js
 */

const NEW_SESSION_RECENTS_KEY = 'codeman:new-session-recents';
const NEW_SESSION_RECENTS_MAX = 8;
const NEW_SESSION_LOCAL = 'local';

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
    const key = (r) => `${r.target}\n${r.path}\n${r.mode}`;
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

  /** Hosts grouped into machines: [{ name, variants: [{ id, label, host }] }]. */
  _newSessionMachines(hosts) {
    const machines = new Map();
    for (const host of hosts) {
      const remote = { hostId: host.id, label: host.label };
      const name = this._machineNameOf(remote);
      if (!machines.has(name)) machines.set(name, { name, variants: [] });
      machines.get(name).variants.push({ id: host.id, label: this._machineVariantOf(remote) || 'Default', host });
    }
    const list = [...machines.values()];
    list.push({ name: 'This server', variants: [{ id: NEW_SESSION_LOCAL, label: 'Local', host: null }] });
    return list;
  },

  async openNewSessionFlow() {
    let hosts = [];
    try {
      hosts = await this._fetchJson('/api/remote-hosts');
    } catch (err) {
      this.showToast?.(`Could not load machines: ${err.message}`, 'error');
    }
    this._renderNewSessionDialog(this._newSessionMachines(Array.isArray(hosts) ? hosts : []));
  },

  _renderNewSessionDialog(machines) {
    document.getElementById('newSessionDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'newSessionDialog';
    dialog.className = 'ns-dialog';
    dialog.setAttribute('aria-labelledby', 'nsTitle');

    const variantById = new Map();
    for (const m of machines) for (const v of m.variants) variantById.set(v.id, { machine: m, variant: v });
    const recents = this._newSessionRecents().filter((r) => variantById.has(r.target));
    const state = {
      machine: variantById.get(recents[0]?.target)?.machine || machines[0],
      target: recents[0]?.target || machines[0].variants[0].id,
      mode: recents[0]?.mode || 'claude',
    };

    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ns-form';
    form.innerHTML = `
      <header class="ns-head">
        <h2 id="nsTitle">New session</h2>
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
      <div class="ns-field">
        <span class="ns-label" id="nsVariantLabel">System and account</span>
        <div class="ns-chips" data-ns="variant" role="radiogroup" aria-labelledby="nsVariantLabel"></div>
      </div>
      <label class="ns-field">
        <span class="ns-label">Folder</span>
        <input class="ns-input" name="path" required autocomplete="off" spellcheck="false" list="nsPathList" placeholder="/home/andywu/project">
        <datalist id="nsPathList"></datalist>
        <span class="ns-hint"></span>
      </label>
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
    const pathInput = $('input[name="path"]');
    const errorEl = $('.ns-error');

    const chip = (label, selected, onPick, extraClass = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ns-chip${extraClass}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(selected));
      b.textContent = label;
      b.addEventListener('click', onPick);
      return b;
    };

    const pathsFor = (target) =>
      this._newSessionRecents()
        .filter((r) => r.target === target)
        .map((r) => r.path);

    const render = () => {
      $('[data-ns="machine"]').replaceChildren(
        ...machines.map((m) =>
          chip(m.name, m === state.machine, () => {
            state.machine = m;
            state.target = m.variants[0].id;
            pathInput.value = pathsFor(state.target)[0] || '';
            render();
          })
        )
      );
      $('[data-ns="variant"]').replaceChildren(
        ...state.machine.variants.map((v) =>
          chip(v.label, v.id === state.target, () => {
            state.target = v.id;
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
      const datalist = $('#nsPathList');
      datalist.replaceChildren(
        ...pathsFor(state.target).map((p) => Object.assign(document.createElement('option'), { value: p }))
      );
      const variant = variantById.get(state.target)?.variant;
      const command = variant?.host?.commands?.claude;
      $('.ns-hint').textContent =
        state.target === NEW_SESSION_LOCAL
          ? 'A folder on the server Codeman runs on.'
          : /cmd\.exe/i.test(command || '')
            ? 'Windows project: give its WSL path, e.g. /mnt/c/Users/AndyWu/project. Claude runs as a native Windows process.'
            : `A folder on ${state.machine.name}, as ${variant?.host?.username || 'the SSH user'} sees it.`;
    };

    const list = $('.ns-recent-list');
    if (recents.length) {
      $('.ns-recents').hidden = false;
      for (const r of recents) {
        const { machine, variant } = variantById.get(r.target);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ns-recent';
        row.setAttribute('role', 'listitem');
        const name = document.createElement('span');
        name.className = 'ns-recent-name';
        name.textContent = r.path.split('/').filter(Boolean).pop() || r.path;
        const where = document.createElement('span');
        where.className = 'ns-recent-where';
        where.textContent = [
          machine.name,
          variant.label !== 'Default' ? variant.label : '',
          r.mode === 'shell' ? 'Shell' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const path = document.createElement('span');
        path.className = 'ns-recent-path';
        path.textContent = r.path;
        row.append(name, where, path);
        row.addEventListener('click', () =>
          this._launchNewSession(dialog, { target: r.target, path: r.path, mode: r.mode }, variantById, errorEl)
        );
        list.appendChild(row);
      }
    }

    pathInput.value = recents[0]?.path || '';
    render();

    const close = () => dialog.close();
    $('.ns-close').addEventListener('click', close);
    $('.ns-cancel').addEventListener('click', close);
    dialog.addEventListener('close', () => dialog.remove());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const path = pathInput.value.trim().replace(/\/+$/, '') || '/';
      this._launchNewSession(dialog, { target: state.target, path, mode: state.mode }, variantById, errorEl);
    });

    dialog.showModal();
    (recents.length ? list.firstElementChild : pathInput)?.focus();
  },

  async _launchNewSession(dialog, pick, variantById, errorEl) {
    const startBtn = dialog.querySelector('.ns-start');
    if (startBtn.disabled) return;
    errorEl.hidden = true;
    if (!pick.path.startsWith('/')) {
      errorEl.textContent = 'Give the folder as an absolute path, starting with /.';
      errorEl.hidden = false;
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    try {
      const id =
        pick.target === NEW_SESSION_LOCAL
          ? await this._startLocalSession(pick)
          : await this._startRemoteSession(pick, variantById.get(pick.target).variant.host);
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

  async _startLocalSession({ path, mode }) {
    const created = await this._fetchJson('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: path, mode }),
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
  async _startRemoteSession({ path, mode }, host) {
    const cases = await this._fetchJson('/api/cases');
    const all = Array.isArray(cases) ? cases : [];
    let match = all.find((c) => c.location === 'remote' && c.remote?.hostId === host.id && c.remote?.path === path);
    if (!match) {
      const stem = `${host.id}-${path.split('/').filter(Boolean).pop() || 'root'}`
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .slice(0, 60);
      const taken = new Set(all.map((c) => c.name));
      let name = stem;
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
      const linked = await this._fetchJson('/api/cases/remote-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, hostId: host.id, remotePath: path }),
      });
      match = linked?.case || { name };
    }
    const started = await this._fetchJson('/api/quick-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseName: match.name, mode }),
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
