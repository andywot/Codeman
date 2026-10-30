/**
 * @fileoverview Machines & accounts manager (fork).
 *
 * One dialog to add, edit, test and remove the machines Claude RC reaches over
 * ssh, and the Claude accounts sessions run as. Reads and writes the fleet
 * routes (fleet-routes.ts); secrets typed here go to the server once and are
 * never read back (the list shows only whether one is saved).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson, openNewSessionFlow), shared-config.js (openSharedConfig)
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
    this.noteFleetServerHost?.(fleet);
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
      const nameRow = el('div', 'fm-name-row');
      nameRow.append(el('strong', '', m.name));
      title.append(nameRow);
      // The machine the dashboard server runs on: set here, or found by comparing kernels.
      const detected = this._serverHostMachine?.();
      const isServer = m.serverHost || detected?.name === m.name;
      if (isServer) {
        const tag = el('span', 'hm-tag', 'server');
        tag.title =
          !m.serverHost && detected?.source === 'detected'
            ? 'The dashboard server runs on this machine (found automatically).'
            : 'The dashboard server runs on this machine.';
        nameRow.append(tag);
      }
      title.append(el('span', 'fm-addr', `${m.username}@${m.host}${m.port ? ':' + m.port : ''}`));
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

    // ── Shared config (shared-config.js) ──
    const shared = el('section', 'fm-section');
    const sHead = el('div', 'fm-section-head');
    sHead.append(
      el('h3', 'fm-h', 'Shared config'),
      button('Open', () => this.openSharedConfig(dialog))
    );
    shared.append(
      sHead,
      el('p', 'fm-muted', 'Skills, memory, agents, commands and settings keys, copied to the machines you pick.')
    );

    // ── Agent mail (agent-mail-relay.ts) ──
    const mail = el('section', 'fm-section fm-mail');
    mail.append(el('h3', 'fm-h', 'Agent mail'), el('p', 'fm-muted', 'Loading…'));
    void this._renderAgentMail(mail, el, button);

    body.replaceChildren(machines, accounts, shared, mail, key);
  },

  /**
   * Fork: the rc-mail relay's view (GET /api/agent-mail): which machines it reaches, the address
   * book with waiting counts and each dashboard session's wake-up switch, and recent traffic.
   * Subjects come from agents: textContent only (the `el` helper).
   */
  async _renderAgentMail(section, el, button) {
    let data;
    try {
      data = await this._fetchJson('/api/agent-mail');
    } catch (err) {
      section.replaceChildren(el('h3', 'fm-h', 'Agent mail'), el('p', 'fm-muted', `Could not load: ${err.message}`));
      return;
    }
    const head = el('div', 'fm-section-head');
    head.append(
      el('h3', 'fm-h', 'Agent mail'),
      button('Refresh', () => this._renderAgentMail(section, el, button))
    );
    const parts = [head];
    parts.push(
      el(
        'p',
        'fm-muted',
        data.enabled
          ? 'Agents message each other with rc-mail (~/.config/claude-rc/bin/rc-mail and the rc-mail skill, installed on each machine the server reaches). Idle dashboard sessions get a one-line nudge when mail arrives.'
          : 'Off. Turn it on in App Settings → Agent mail.'
      )
    );
    if (data.machines.length) {
      const list = el('div', 'fm-systems');
      for (const m of data.machines) {
        const row = el('div', 'fm-system');
        const state = m.aliasOf
          ? `same mailbox as ${m.aliasOf}`
          : m.state === 'ok'
            ? m.installed
              ? 'reached · rc-mail installed'
              : 'reached'
            : m.state === 'failing'
              ? m.error || 'not reachable'
              : 'not reached yet';
        const status = el('span', 'fm-status', state);
        status.dataset.kind = m.state === 'ok' ? 'ok' : m.state === 'failing' ? 'warn' : '';
        row.append(el('span', 'fm-system-name', m.machine), status);
        list.append(row);
      }
      parts.push(list);
    }
    const agents = el('div', 'fm-systems');
    if (!data.agents.length) agents.append(el('p', 'fm-muted', 'No addresses yet.'));
    for (const a of data.agents) {
      const row = el('div', 'fm-system');
      const counts = a.pending ? `${a.pending} waiting${a.unseen ? ` (${a.unseen} new)` : ''}` : '';
      const where = a.kind === 'outside' ? `outside · ${a.cwd || ''}` : 'dashboard';
      row.append(
        el('span', 'fm-system-name', a.address),
        el('span', 'fm-status', [where, counts].filter(Boolean).join(' · '))
      );
      if (a.kind === 'dashboard' && a.sid && a.nudge !== null) {
        const label = el('label', 'fm-mail-nudge');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = a.nudge;
        box.addEventListener('change', async () => {
          box.disabled = true;
          try {
            await this._fetchJson(`/api/agent-mail/nudge/${encodeURIComponent(a.sid)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: box.checked }),
            });
          } catch (err) {
            box.checked = !box.checked;
            this.showToast?.(err.message, 'error');
          }
          box.disabled = false;
        });
        label.append(box, el('span', '', 'wake'));
        label.title = 'Type a one-line notice into this session when mail arrives and it is idle';
        row.append(label);
      }
      agents.append(row);
    }
    parts.push(el('h4', 'fm-h fm-mail-sub', 'Addresses'), agents);
    if (data.recent.length || data.queued) {
      const recent = el('div', 'fm-systems');
      for (const r of data.recent.slice(0, 12)) {
        const row = el('div', 'fm-system');
        const when = new Date(r.at).toLocaleTimeString();
        row.append(
          el('span', 'fm-system-name', `${r.from} → ${r.to}`),
          el('span', 'fm-status', `${r.state}${r.detail ? ` (${r.detail})` : ''} · ${when} · ${r.subject || ''}`)
        );
        recent.append(row);
      }
      parts.push(
        el('h4', 'fm-h fm-mail-sub', data.queued ? `Recent · ${data.queued} waiting for an offline machine` : 'Recent'),
        recent
      );
    }
    section.replaceChildren(...parts);
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
      <label class="fm-check"><input type="checkbox" name="serverHost"> <span>This is the dashboard's host</span></label>
      <p class="fm-muted fm-check-note">Tick it on the machine the dashboard server itself runs on (for example the Docker host). It then shows as one entry, tagged <em>server</em>, instead of the server and that machine twice. Leave it off if the server runs somewhere that is not in this list.</p>
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
    form.serverHost.checked = Boolean(machine?.serverHost);
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
      if (form.serverHost.checked) payload.serverHost = true;
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
      <label class="ns-field" data-for="shell api"><span class="ns-label">Quota status URL (optional)</span><input class="ns-input" name="quotaUrl" placeholder="http://127.0.0.1:3001/api/status"></label>
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
      form.quotaUrl.value = account.quotaUrl || '';
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
      if ((kind === 'shell' || kind === 'api') && form.quotaUrl.value.trim())
        payload.quotaUrl = form.quotaUrl.value.trim();
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
