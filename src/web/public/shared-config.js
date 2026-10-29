/**
 * @fileoverview Shared config (fork): the Machines & accounts dialog's view of the
 * shared Claude config store (skills, memory, agents, commands, settings keys).
 *
 * Lists what is in the store and whether it is shared, which machines receive it, and
 * for each machine what it has and each item's state (in sync / differs / missing /
 * only there). Import copies an item from a machine into the store; Sync pushes the
 * shared items to the ticked machines. Everything is a button press: nothing syncs on
 * its own. Routes: shared-config-routes.ts. The page only ever sees names, hashes and
 * states; diffs come from the server with secret-looking lines already hidden, and env
 * shows variable names only.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson), fleet-manager.js (_renderFleetManager)
 * @loadorder after fleet-manager.js
 */

const SC_KIND_LABELS = { skill: 'Skill', memory: 'Memory', agent: 'Agent', command: 'Command', setting: 'Setting' };
const SC_STATE_LABELS = { 'in-sync': 'in sync', differs: 'differs', missing: 'missing', 'machine-only': 'only here' };

Object.assign(CodemanApp.prototype, {
  /** Opens the shared-config view inside the Machines & accounts dialog. */
  async openSharedConfig(dialog) {
    dialog._sc = { store: null, hosts: {}, expanded: new Set(), diff: null, busy: false };
    await this._scLoad(dialog);
  },

  async _scLoad(dialog, { hosts = true } = {}) {
    const st = dialog._sc;
    try {
      st.store = await this._fetchJson('/api/shared-config');
      st.error = null;
    } catch (err) {
      st.error = err.message;
    }
    if (hosts && st.store) {
      for (const m of st.store.machines) if (!m.unsupported) this._scLoadHost(dialog, m.id);
    }
    this._scRender(dialog);
  },

  async _scLoadHost(dialog, hostId) {
    const st = dialog._sc;
    st.hosts[hostId] = { ...(st.hosts[hostId] || {}), loading: true };
    this._scRender(dialog);
    try {
      const data = await this._fetchJson(`/api/shared-config/hosts/${encodeURIComponent(hostId)}`);
      st.hosts[hostId] = { loading: false, data };
    } catch (err) {
      st.hosts[hostId] = { loading: false, error: err.message };
    }
    if (dialog._sc === st) this._scRender(dialog);
  },

  _scReloadHosts(dialog) {
    for (const m of dialog._sc.store?.machines || []) if (!m.unsupported) this._scLoadHost(dialog, m.id);
  },

  _scRender(dialog) {
    if (!dialog.open || !dialog._sc) return;
    const st = dialog._sc;
    const body = dialog.querySelector('.fm-body');
    const scrollTop = dialog.scrollTop;
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      node.setAttribute('data-i18n-skip', '');
      return node;
    };
    const button = (label, onClick, cls = 'fm-btn') => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.disabled = st.busy;
      b.addEventListener('click', onClick);
      return b;
    };
    const run = async (work) => {
      st.busy = true;
      this._scRender(dialog);
      try {
        await work();
      } catch (err) {
        this.showToast?.(err.message, 'error');
      }
      st.busy = false;
      this._scRender(dialog);
    };

    const view = el('div', 'sc-view');
    const head = el('div', 'fm-section-head');
    head.append(
      button(
        '‹ Back',
        () => {
          dialog._sc = null;
          this._renderFleetManager(dialog);
        },
        'fm-btn fm-btn--quiet'
      ),
      el('h3', 'fm-h sc-title', 'Shared config'),
      button('Refresh', () => this._scLoad(dialog))
    );
    view.append(
      head,
      el(
        'p',
        'fm-muted',
        'Skills, memory, agents, commands and settings keys kept the same on the machines you tick. Sync is manual; replaced files are backed up on the machine.'
      )
    );
    if (st.error) view.append(el('p', 'ns-error', `Could not load: ${st.error}`));
    if (!st.store) {
      if (!st.error) view.append(el('p', 'fm-muted', 'Loading…'));
      body.replaceChildren(view);
      return;
    }
    const store = st.store;
    const inStore = new Map(store.items.map((i) => [`${i.kind}:${i.name}`, i]));

    // ── Store ──
    const storeSec = el('section', 'fm-section');
    storeSec.append(el('h3', 'fm-h', `Store · ${store.items.filter((i) => i.shared).length} shared`));
    if (!store.items.length) {
      storeSec.append(el('p', 'fm-muted', 'Empty. Open a machine below and import what to share.'));
    }
    for (const item of store.items) {
      const row = el('div', 'sc-row sc-row--store');
      const label = el('label', 'sc-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = item.shared;
      box.disabled = st.busy;
      box.setAttribute('aria-label', `Share ${item.name}`);
      box.addEventListener('change', () =>
        run(async () => {
          await this._fetchJson(
            `/api/shared-config/items/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.name)}`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ shared: box.checked }),
            }
          );
          item.shared = box.checked;
        })
      );
      const meta = [
        item.files != null ? `${item.files} file${item.files === 1 ? '' : 's'}` : '',
        item.envKeys ? (item.envKeys.length ? item.envKeys.join(', ') : 'no variables') : '',
        item.importedFrom ? `from ${this._scHostLabel(store, item.importedFrom)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const name = el('span', 'sc-name');
      name.append(el('span', 'sc-kind', SC_KIND_LABELS[item.kind]), el('span', 'sc-item', item.name));
      label.append(box, name);
      row.append(
        label,
        el('span', 'sc-meta', meta),
        button(
          'Remove',
          () => {
            if (!confirm(`Remove ${item.name} from the store? Machines keep their copies.`)) return;
            run(async () => {
              await this._fetchJson(
                `/api/shared-config/items/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.name)}`,
                { method: 'DELETE' }
              );
              await this._scLoad(dialog, { hosts: false });
              this._scReloadHosts(dialog);
            });
          },
          'fm-btn fm-btn--quiet'
        )
      );
      storeSec.append(row);
    }
    if (store.items.some((i) => i.envKeys)) {
      storeSec.append(
        el(
          'p',
          'fm-muted sc-note',
          'env values stay on the server. Variables named like tokens or keys are never shared.'
        )
      );
    }

    // ── Machines ──
    const machSec = el('section', 'fm-section');
    machSec.append(el('h3', 'fm-h', 'Machines'));
    if (!store.machines.length) machSec.append(el('p', 'fm-muted', 'No machines yet.'));
    const targets = new Set(store.targets);
    for (const m of store.machines) {
      const card = el('div', 'fm-card sc-machine');
      const top = el('div', 'sc-machine-top');
      const label = el('label', 'sc-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = targets.has(m.id);
      box.disabled = st.busy || Boolean(m.unsupported);
      box.setAttribute('aria-label', `Sync to ${m.label}`);
      box.addEventListener('change', () =>
        run(async () => {
          const next = new Set(store.targets);
          if (box.checked) next.add(m.id);
          else next.delete(m.id);
          await this._fetchJson('/api/shared-config/targets', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hostIds: [...next] }),
          });
          store.targets = [...next];
        })
      );
      const host = st.hosts[m.id];
      const status = el('span', 'sc-summary');
      const text = el('span', 'sc-host');
      text.append(el('strong', 'sc-host-name', m.label), status);
      label.append(box, text);
      top.append(label);
      if (m.unsupported) {
        status.textContent = m.unsupported;
      } else if (!host || (host.loading && !host.data)) {
        status.textContent = 'checking…';
      } else if (host.error) {
        status.textContent = host.error;
        status.dataset.kind = 'bad';
      } else {
        const counts = { 'in-sync': 0, differs: 0, missing: 0 };
        for (const it of host.data.items) if (it.inStore && it.shared) counts[it.state]++;
        const parts = [];
        if (counts.differs) parts.push(`${counts.differs} differ${counts.differs === 1 ? 's' : ''}`);
        if (counts.missing) parts.push(`${counts.missing} missing`);
        if (counts['in-sync']) parts.push(`${counts['in-sync']} in sync`);
        status.textContent = parts.join(' · ') || (host.data.hasClaudeDir ? 'nothing shared yet' : 'no ~/.claude yet');
        status.dataset.kind = counts.differs || counts.missing ? 'warn' : counts['in-sync'] ? 'ok' : '';
      }
      if (!m.unsupported) {
        const open = st.expanded.has(m.id);
        const toggle = button(open ? 'Hide' : 'Items', () => {
          if (open) st.expanded.delete(m.id);
          else st.expanded.add(m.id);
          this._scRender(dialog);
        });
        toggle.setAttribute('aria-expanded', String(open));
        top.append(
          toggle,
          button('Sync', () => this._scSync(dialog, [m.id], run), 'fm-btn sc-sync')
        );
      }
      card.append(top);
      if (st.expanded.has(m.id) && host?.data)
        card.append(this._scMachineItems(dialog, m, host.data, inStore, el, button, run));
      machSec.append(card);
    }

    const foot = el('footer', 'ns-foot sc-foot');
    const syncAll = button(
      `Sync ticked machines (${store.targets.length})`,
      () => this._scSync(dialog, store.targets, run),
      'ns-start'
    );
    syncAll.disabled = st.busy || !store.targets.length || !store.items.some((i) => i.shared);
    foot.append(syncAll);

    view.append(storeSec, machSec, foot);
    body.replaceChildren(view);
    dialog.scrollTop = scrollTop;
  },

  _scHostLabel(store, hostId) {
    return store.machines.find((m) => m.id === hostId)?.label || hostId;
  },

  /** One machine's items: store items with their state, then what only it has. */
  _scMachineItems(dialog, machine, data, inStore, el, button, run) {
    const st = dialog._sc;
    const list = el('div', 'sc-items');
    if (data.settingsError) list.append(el('p', 'fm-muted sc-note', `settings.json: ${data.settingsError}`));
    if (!data.items.length) list.append(el('p', 'fm-muted sc-note', 'Nothing to share here yet.'));
    for (const it of data.items) {
      const key = `${it.kind}:${it.name}`;
      const row = el('div', 'sc-row');
      const name = el('span', 'sc-name');
      name.append(el('span', 'sc-kind', SC_KIND_LABELS[it.kind]), el('span', 'sc-item', it.name));
      const state = el('span', 'sc-state', SC_STATE_LABELS[it.state]);
      state.dataset.state = it.state;
      if (it.inStore && !it.shared) state.textContent += ' · not shared';
      row.append(name, state);
      const notes = [it.symlink ? 'symlink: sync skips it' : '', it.problem || ''].filter(Boolean).join(' · ');
      if (notes) row.append(el('span', 'sc-meta', notes));
      const diffKey = `${machine.id}|${key}`;
      if (it.inStore && it.state === 'differs') {
        row.append(
          button(st.diff?.key === diffKey ? 'Hide diff' : 'Diff', () =>
            run(async () => {
              if (st.diff?.key === diffKey) {
                st.diff = null;
                return;
              }
              const q = `kind=${encodeURIComponent(it.kind)}&name=${encodeURIComponent(it.name)}`;
              st.diff = {
                key: diffKey,
                data: await this._fetchJson(`/api/shared-config/hosts/${encodeURIComponent(machine.id)}/diff?${q}`),
              };
            })
          )
        );
      }
      const importable = !it.problem && (it.state === 'machine-only' || (it.inStore && it.state === 'differs'));
      if (importable) {
        row.append(
          button(it.inStore ? 'Use this' : 'Import', () => {
            if (it.inStore && !confirm(`Replace the store's ${it.name} with the one on ${machine.label}?`)) return;
            run(async () => {
              const r = await this._fetchJson('/api/shared-config/import', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ hostId: machine.id, kind: it.kind, name: it.name }),
              });
              const kept = r.withheld?.length ? ` (kept back: ${r.withheld.join(', ')})` : '';
              this.showToast?.(`Imported ${it.name}${kept}`, 'success');
              st.diff = null;
              await this._scLoad(dialog, { hosts: false });
              this._scReloadHosts(dialog);
            });
          })
        );
      }
      list.append(row);
      if (st.diff?.key === diffKey) list.append(this._scDiffView(st.diff.data, el));
    }
    return list;
  },

  _scDiffView(diff, el) {
    const box = el('div', 'sc-diff');
    box.append(el('p', 'fm-muted sc-note', '− on the machine · + after sync'));
    if (diff.mode === 'env') {
      const states = {
        same: 'same',
        changed: 'value differs',
        'store-only': '+ added',
        'machine-only': 'kept (machine only)',
      };
      for (const v of diff.vars) box.append(el('div', 'sc-diff-line', `${v.name}  ${states[v.state]}  (value hidden)`));
      return box;
    }
    if (diff.mode === 'files') {
      const states = { same: '  ', changed: '~ ', 'store-only': '+ ', 'machine-only': '− ' };
      for (const f of diff.files) {
        const line = el('div', 'sc-diff-line', `${states[f.state]}${f.path}`);
        line.dataset.op =
          f.state === 'store-only' ? '+' : f.state === 'machine-only' ? '-' : f.state === 'changed' ? '~' : ' ';
        box.append(line);
      }
      return box;
    }
    if (diff.binary) box.append(el('p', 'fm-muted sc-note', 'Binary file: no line diff.'));
    else if (diff.tooLarge) box.append(el('p', 'fm-muted sc-note', 'Too large to diff here.'));
    const pre = el('pre', 'sc-diff-pre');
    for (const l of diff.lines || []) {
      const line = el('div', 'sc-diff-line', `${l.op === '@' ? '' : l.op} ${l.text}`);
      line.dataset.op = l.op;
      pre.append(line);
    }
    if (diff.lines?.length) box.append(pre);
    return box;
  },

  _scSync(dialog, hostIds, run) {
    const store = dialog._sc.store;
    if (!hostIds.length) return;
    const names = hostIds.map((id) => this._scHostLabel(store, id)).join(', ');
    if (!confirm(`Sync shared items to ${names}? Changed files are backed up on the machine first.`)) return;
    run(async () => {
      const r = await this._fetchJson('/api/shared-config/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostIds }),
      });
      for (const h of r.hosts) {
        const label = this._scHostLabel(store, h.hostId);
        const written = h.results.filter((x) => x.outcome === 'ok').length;
        const skipped = h.results.filter((x) => x.outcome === 'skip');
        const failed = h.results.filter((x) => x.outcome === 'fail');
        if (h.error) this.showToast?.(`${label}: ${h.error}`, 'error');
        else if (failed.length) {
          this.showToast?.(
            `${label}: failed ${failed.map((x) => `${x.path} (${x.reason || '?'})`).join(', ')}`,
            'error'
          );
        } else {
          const bits = [written ? `${written} written` : 'already in sync'];
          if (skipped.length) bits.push(`skipped ${skipped.map((x) => `${x.path} (${x.reason || '?'})`).join(', ')}`);
          this.showToast?.(`${label}: ${bits.join(' · ')}`, skipped.length ? 'warning' : 'success');
        }
        dialog._sc.diff = null;
        this._scLoadHost(dialog, h.hostId);
      }
    });
  },
});
