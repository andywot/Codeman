/**
 * @fileoverview Machines & accounts manager (fork).
 *
 * One dialog to add, edit, test and remove the machines Claude RC reaches over
 * ssh, and the Claude accounts sessions run as. Reads and writes the fleet
 * routes (fleet-routes.ts); secrets typed here go to the server once and are
 * never read back (the list shows only whether one is saved).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson, openNewSessionFlow)
 * @loadorder after new-session.js
 */

const FLEET_KIND_LABELS = {
  machine: "Machine's own login",
  token: 'Shared token (all machines)',
  api: 'API endpoint (GLM, …)',
  shell: 'Shell function on the machine',
};

Object.assign(CodemanApp.prototype, {
  async openFleetManager() {
    document.getElementById('fleetDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'fleetDialog';
    dialog.className = 'ns-dialog fm-dialog';
    dialog.setAttribute('aria-labelledby', 'fmTitle');
    dialog.innerHTML = `
      <div class="ns-form fm-form">
        <header class="ns-head">
          <h2 id="fmTitle">Machines &amp; accounts</h2>
          <button type="button" class="ns-close" aria-label="Close">×</button>
        </header>
        <div class="fm-body"><p class="fm-muted">Loading…</p></div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.querySelector('.ns-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    await this._renderFleetManager(dialog);
  },

  async _renderFleetManager(dialog) {
    const body = dialog.querySelector('.fm-body');
    let fleet;
    try {
      fleet = await this._fetchJson('/api/fleet');
    } catch (err) {
      body.textContent = `Could not load: ${err.message}`;
      return;
    }
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
      b.addEventListener('click', onClick);
      return b;
    };
    const refresh = () => this._renderFleetManager(dialog);

    // ── Machines ──
    const machines = el('section', 'fm-section');
    const mHead = el('div', 'fm-section-head');
    mHead.append(
      el('h3', 'fm-h', 'Machines'),
      button('Add machine', () => this._fleetMachineForm(dialog, null, fleet))
    );
    machines.appendChild(mHead);
    if (!fleet.machines.length) machines.appendChild(el('p', 'fm-muted', 'No machines yet.'));
    for (const m of fleet.machines) {
      const card = el('div', 'fm-card');
      const top = el('div', 'fm-card-top');
      const title = el('div', 'fm-card-title');
      title.append(
        el('strong', '', m.name),
        el('span', 'fm-addr', `${m.username}@${m.host}${m.port ? ':' + m.port : ''}`)
      );
      const slug = (m.systems[0]?.hostId || '').replace(/-(wsl|windows|linux)$/, '').replace(/-wsl-.*$/, '');
      top.append(
        title,
        button('Edit', () => this._fleetMachineForm(dialog, m, fleet)),
        button(
          'Remove',
          async () => {
            if (!confirm(`Remove ${m.name}? Running sessions keep going; new ones can't start there.`)) return;
            try {
              await this._fetchJson(`/api/fleet/machines/${encodeURIComponent(slug)}`, { method: 'DELETE' });
            } catch (err) {
              this.showToast?.(err.message, 'error');
            }
            refresh();
          },
          'fm-btn fm-btn--quiet'
        )
      );
      card.appendChild(top);
      const systems = el('div', 'fm-systems');
      for (const s of m.systems) {
        const row = el('div', 'fm-system');
        const status = el('span', 'fm-status', s.legacyCommand ? 'old variant: re-save the machine to retire it' : '');
        row.append(
          el('span', 'fm-system-name', s.label.split(' · ').slice(1).join(' · ') || s.label),
          status,
          button('Test', async (e) => {
            e.target.disabled = true;
            status.textContent = 'Testing…';
            status.dataset.kind = '';
            try {
              const r = await this._fetchJson(`/api/fleet/hosts/${encodeURIComponent(s.hostId)}/test`, {
                method: 'POST',
              });
              if (!r.ok) {
                status.textContent = r.error;
                status.dataset.kind = 'bad';
              } else {
                const bits = [
                  'ssh ok',
                  r.tmux === 'missing' ? 'tmux missing' : 'tmux ok',
                  r.claude === 'missing' ? 'claude missing' : `claude ${r.claude.replace(/\s*\(.*\)$/, '')}`,
                ].filter(Boolean);
                status.textContent = bits.join(' · ');
                status.dataset.kind = r.tmux === 'missing' || r.claude === 'missing' ? 'warn' : 'ok';
              }
            } catch (err) {
              status.textContent = err.message;
              status.dataset.kind = 'bad';
            }
            e.target.disabled = false;
          })
        );
        systems.appendChild(row);
      }
      card.appendChild(systems);
      machines.appendChild(card);
    }

    // ── Accounts ──
    const accounts = el('section', 'fm-section');
    const aHead = el('div', 'fm-section-head');
    aHead.append(
      el('h3', 'fm-h', 'Accounts'),
      button('Add account', () => this._fleetAccountForm(dialog, null, fleet))
    );
    accounts.appendChild(aHead);
    if (!fleet.accounts.length) {
      accounts.appendChild(el('p', 'fm-muted', "No accounts yet: sessions use each machine's own Claude login."));
    }
    for (const a of fleet.accounts) {
      const card = el('div', 'fm-card fm-card-top');
      const title = el('div', 'fm-card-title');
      const usage = a.usage
        ? [
            a.usage.fiveHour != null ? `5h ${Math.round(a.usage.fiveHour)}%` : '',
            a.usage.sevenDay != null ? `7d ${Math.round(a.usage.sevenDay)}%` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      title.append(
        el('strong', '', a.label),
        el(
          'span',
          'fm-addr',
          [
            FLEET_KIND_LABELS[a.kind],
            a.kind === 'shell' ? a.setupCommand : '',
            a.email || '',
            (a.kind === 'token' || a.kind === 'api') && !a.hasSecret ? 'no token saved' : '',
            usage,
          ]
            .filter(Boolean)
            .join(' · ')
        )
      );
      card.append(
        title,
        button('Edit', () => this._fleetAccountForm(dialog, a, fleet)),
        button(
          'Remove',
          async () => {
            if (!confirm(`Remove the account ${a.label}?`)) return;
            await this._fetchJson(`/api/fleet/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' }).catch(
              (err) => this.showToast?.(err.message, 'error')
            );
            refresh();
          },
          'fm-btn fm-btn--quiet'
        )
      );
      accounts.appendChild(card);
    }

    // ── This server's key ──
    const key = el('section', 'fm-section');
    key.appendChild(el('h3', 'fm-h', 'Connecting a new machine'));
    key.appendChild(
      el(
        'p',
        'fm-muted',
        "Claude RC signs in to machines with this key. Add it to the machine's ~/.ssh/authorized_keys (for Windows + WSL, to C:\\ProgramData\\ssh\\administrators_authorized_keys with the WSL forced command, like the desktop), then press Test."
      )
    );
    const keyRow = el('div', 'fm-key-row');
    const keyText = el('code', 'fm-key', fleet.publicKey || 'No key found on the server.');
    keyRow.append(
      keyText,
      button('Copy', () => {
        navigator.clipboard?.writeText(fleet.publicKey || '').then(
          () => this.showToast?.('Key copied', 'success'),
          () => this.showToast?.('Copy failed: select the key and copy it', 'error')
        );
      })
    );
    key.appendChild(keyRow);

    body.replaceChildren(machines, accounts, usage, key);
  },

  _fleetMachineForm(dialog, machine, fleet) {
    const body = dialog.querySelector('.fm-body');
    const systems = new Set((machine?.systems || []).map((s) => s.system).filter(Boolean));
    if (!systems.size) systems.add('wsl');
    const slug = machine
      ? (machine.systems[0]?.hostId || '').replace(/-(wsl|windows|linux)$/, '').replace(/-wsl-.*$/, '')
      : 'new';
    const form = document.createElement('form');
    form.className = 'fm-edit';
    form.innerHTML = `
      <h3 class="fm-h">${machine ? 'Edit machine' : 'Add machine'}</h3>
      <label class="ns-field"><span class="ns-label">Name</span><input class="ns-input" name="name" required maxlength="60" placeholder="Laptop"></label>
      <div class="fm-grid">
        <label class="ns-field"><span class="ns-label">IP or hostname</span><input class="ns-input" name="host" required placeholder="10.10.10.2"></label>
        <label class="ns-field"><span class="ns-label">SSH user</span><input class="ns-input" name="username" required placeholder="andy"></label>
        <label class="ns-field"><span class="ns-label">Port</span><input class="ns-input" name="port" inputmode="numeric" placeholder="22"></label>
      </div>
      <div class="ns-field"><span class="ns-label">Systems</span>
        <div class="fm-checks">
          <label><input type="checkbox" name="sys" value="wsl"> WSL</label>
          <label><input type="checkbox" name="sys" value="windows"> Windows (runs through WSL)</label>
          <label><input type="checkbox" name="sys" value="linux"> Linux</label>
        </div>
      </div>
      <label class="ns-field"><span class="ns-label">Wake-on-LAN MAC (optional)</span><input class="ns-input" name="wakeMac" placeholder="18:C0:4D:AE:93:C9"></label>
      <p class="ns-error" role="alert" hidden></p>
      <footer class="ns-foot">
        <button type="button" class="ns-cancel">Back</button>
        <button type="submit" class="ns-start">Save machine</button>
      </footer>`;
    form.name.value = machine?.name || '';
    form.host.value = machine?.host || '';
    form.username.value = machine?.username || '';
    form.port.value = machine?.port || '';
    form.wakeMac.value = machine?.wakeMac || '';
    for (const box of form.querySelectorAll('input[name="sys"]')) box.checked = systems.has(box.value);
    form.querySelector('.ns-cancel').addEventListener('click', () => this._renderFleetManager(dialog));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const err = form.querySelector('.ns-error');
      err.hidden = true;
      const payload = {
        name: form.name.value.trim(),
        host: form.host.value.trim(),
        username: form.username.value.trim(),
        systems: [...form.querySelectorAll('input[name="sys"]:checked')].map((b) => b.value),
      };
      if (form.port.value.trim()) payload.port = Number(form.port.value.trim());
      if (form.wakeMac.value.trim()) payload.wakeMac = form.wakeMac.value.trim();
      try {
        await this._fetchJson(`/api/fleet/machines/${encodeURIComponent(slug)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        this._renderFleetManager(dialog);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
    body.replaceChildren(form);
    form.name.focus();
  },

  _fleetAccountForm(dialog, account, fleet) {
    const body = dialog.querySelector('.fm-body');
    const form = document.createElement('form');
    form.className = 'fm-edit';
    form.innerHTML = `
      <h3 class="fm-h">${account ? 'Edit account' : 'Add account'}</h3>
      <label class="ns-field"><span class="ns-label">Name</span><input class="ns-input" name="label" required maxlength="60" placeholder="Work"></label>
      <label class="ns-field"><span class="ns-label">Kind</span>
        <select class="ns-input" name="kind">
          <option value="token">Shared token: one login on every machine</option>
          <option value="api">API endpoint (GLM, …)</option>
          <option value="shell">Shell function on the machine (e.g. use-glm)</option>
          <option value="machine">The machine's own login</option>
        </select>
      </label>
      <p class="fm-muted fm-kind-help"></p>
      <label class="ns-field" data-for="token machine"><span class="ns-label">Email (optional)</span><input class="ns-input" name="email" placeholder="you@example.com"></label>
      <label class="ns-field" data-for="shell"><span class="ns-label">Command</span><input class="ns-input" name="setupCommand" placeholder="use-glm"></label>
      <label class="ns-field" data-for="api"><span class="ns-label">Base URL</span><input class="ns-input" name="baseUrl" placeholder="https://api.z.ai/api/anthropic"></label>
      <div class="fm-grid" data-for="api">
        <label class="ns-field"><span class="ns-label">Model</span><input class="ns-input" name="apiModel" placeholder="glm-5.3"></label>
        <label class="ns-field"><span class="ns-label">Small model</span><input class="ns-input" name="apiSmallModel" placeholder="glm-5.3-flash"></label>
      </div>
      <label class="ns-field" data-for="token api"><span class="ns-label fm-secret-label">Token</span><input class="ns-input" name="secret" type="password" autocomplete="off" spellcheck="false"></label>
      <p class="ns-error" role="alert" hidden></p>
      <footer class="ns-foot">
        <button type="button" class="ns-cancel">Back</button>
        <button type="submit" class="ns-start">Save account</button>
      </footer>`;
    const help = {
      token:
        'Run "claude setup-token" in a shell on any machine (it opens a sign-in link for this account) and paste the token it prints. The server keeps it and copies it to whichever machine starts a session, so one login works everywhere and nothing gets signed out. Its 5-hour and 7-day usage is read with the same token.',
      api: 'An Anthropic-compatible endpoint. Every Claude tier maps to the model below.',
      machine: 'Uses whatever the machine is signed in as. Same as picking "Machine\'s login".',
      shell:
        "Runs this in the machine's login shell before claude, so a function from your .bashrc (like use-glm) sets the endpoint. Only machines that define it can use the account.",
    };
    const sync = () => {
      const kind = form.kind.value;
      form.querySelector('.fm-kind-help').textContent = help[kind];
      for (const node of form.querySelectorAll('[data-for]')) node.hidden = !node.dataset.for.split(' ').includes(kind);
      form.querySelector('.fm-secret-label').textContent = kind === 'api' ? 'API key' : 'Token';
      form.secret.placeholder = account?.hasSecret
        ? 'Saved. Leave empty to keep it'
        : kind === 'api'
          ? 'API key'
          : 'sk-ant-oat01-…';
    };
    if (account) {
      form.label.value = account.label;
      form.kind.value = account.kind;
      form.email.value = account.email || '';
      form.baseUrl.value = account.baseUrl || '';
      form.apiModel.value = account.apiModel || '';
      form.apiSmallModel.value = account.apiSmallModel || '';
      form.setupCommand.value = account.setupCommand || '';
    }
    form.kind.addEventListener('change', sync);
    sync();
    form.querySelector('.ns-cancel').addEventListener('click', () => this._renderFleetManager(dialog));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const err = form.querySelector('.ns-error');
      err.hidden = true;
      const kind = form.kind.value;
      const id =
        account?.id ||
        form.label.value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) ||
        `account-${Date.now()}`;
      const payload = { label: form.label.value.trim(), kind };
      if (form.email.value.trim() && kind !== 'api') payload.email = form.email.value.trim();
      if (kind === 'api') {
        payload.baseUrl = form.baseUrl.value.trim();
        if (form.apiModel.value.trim()) payload.apiModel = form.apiModel.value.trim();
        if (form.apiSmallModel.value.trim()) payload.apiSmallModel = form.apiSmallModel.value.trim();
      }
      if (kind === 'shell') payload.setupCommand = form.setupCommand.value.trim();
      if ((kind === 'token' || kind === 'api') && form.secret.value.trim()) payload.secret = form.secret.value.trim();
      try {
        await this._fetchJson(`/api/fleet/accounts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        this._renderFleetManager(dialog);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
    body.replaceChildren(form);
    form.label.focus();
  },
});
