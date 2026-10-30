/**
 * @fileoverview Running dialog (fork): every Claude on every machine, including the
 * ones this dashboard did not start.
 *
 * Lists what `GET /api/fleet/running/:target` finds on this server and on each
 * machine (claude-discovery.ts), one machine at a time so a sleeping one does not
 * hold up the rest:
 *
 * - Claude in a tmux session the dashboard does not show: **Attach** adopts it as a
 *   dashboard session (`POST /api/sessions` with `attachRemoteSession` +
 *   `remoteTmuxSocket`, or `attachLocalTmux` on this server). The session keeps
 *   running as it is; closing the tab only detaches.
 * - Claude running outside tmux, which nothing can attach to: **Resume here** starts
 *   a new session in its folder running `claude --resume <id>`, after a warning that
 *   the original is still running and two writers on one conversation log is what
 *   corrupts it.
 *
 * Discovery is read-only: opening this dialog never attaches, signals or types into
 * anything.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson, _startRemoteSession, _selectWhenPresent)
 * @loadorder after fleet-manager.js
 */

/** A folder the server's path checks accept (SAFE_PATH_PATTERN, absolute). */
const RUNNING_SAFE_PATH = /^\/[\p{L}\p{N}_/\-. ~]*$/u;

Object.assign(CodemanApp.prototype, {
  async openRunningClaudes() {
    document.getElementById('runningDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'runningDialog';
    dialog.className = 'ns-dialog rn-dialog';
    dialog.setAttribute('aria-labelledby', 'rnTitle');
    dialog.innerHTML = `
      <div class="ns-form rn-form">
        <header class="ns-head">
          <h2 id="rnTitle">Running</h2>
          <button type="button" class="ns-manage rn-refresh">Refresh</button>
          <button type="button" class="ns-close" aria-label="Close">×</button>
        </header>
        <p class="rn-intro">Claude on your machines that this dashboard did not start.</p>
        <div class="rn-body" aria-live="polite"></div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.querySelector('.ns-close').addEventListener('click', () => dialog.close());
    dialog.querySelector('.rn-refresh').addEventListener('click', () => this._renderRunningClaudes(dialog));
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    await this._renderRunningClaudes(dialog);
  },

  async _renderRunningClaudes(dialog) {
    const body = dialog.querySelector('.rn-body');
    const seq = (dialog._rnSeq = (dialog._rnSeq || 0) + 1);
    body.replaceChildren(this._rnEl('p', 'fm-muted', 'Loading…'));
    let targets;
    try {
      targets = (await this._fetchJson('/api/fleet/running')).targets || [];
    } catch (err) {
      body.replaceChildren(this._rnEl('p', 'rn-error', `Could not load: ${err.message}`));
      return;
    }
    if (seq !== dialog._rnSeq) return;
    body.replaceChildren();
    for (const target of targets) {
      const section = this._rnEl('section', 'rn-machine');
      const head = this._rnEl('div', 'rn-machine-head');
      const name = target.hostId === null ? this._serverContainerLabel?.() || target.name : target.name;
      head.append(this._rnEl('h3', 'fm-h', name));
      if (target.hostId !== null) head.append(this._rnEl('span', 'rn-addr', target.address));
      const list = this._rnEl('div', 'rn-list');
      list.appendChild(this._rnEl('p', 'fm-muted', 'Looking…'));
      section.append(head, list);
      body.appendChild(section);
      this._fetchJson(`/api/fleet/running/${encodeURIComponent(target.id)}`)
        .then((found) => {
          if (seq === dialog._rnSeq) this._fillRunningMachine(dialog, list, found);
        })
        .catch((err) => {
          if (seq === dialog._rnSeq) list.replaceChildren(this._rnEl('p', 'rn-error', err.message));
        });
    }
  },

  _rnEl(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    node.setAttribute('data-i18n-skip', '');
    return node;
  },

  _rnButton(label, onClick, cls = 'fm-btn') {
    const b = this._rnEl('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  },

  /** `~/x` for paths under the usual home folders, so rows stay short. */
  _rnShortPath(path) {
    if (!path) return 'folder unknown';
    return path.replace(/^\/(home\/[^/]+|root|Users\/[^/]+)(?=\/|$)/, '~');
  },

  _fillRunningMachine(dialog, list, found) {
    list.replaceChildren();
    if (!found.ok) {
      list.appendChild(this._rnEl('p', 'rn-error', found.error || 'Could not look'));
      return;
    }
    const target = found.target;

    // One row per tmux session (a session can hold several Claude panes).
    const bySession = new Map();
    for (const t of found.tmux) {
      const key = `${t.socket}\n${t.sessionName}`;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(t);
    }
    for (const panes of bySession.values()) list.appendChild(this._runningTmuxRow(dialog, target, panes));
    for (const p of found.outside) list.appendChild(this._runningOutsideRow(dialog, target, p));

    if (!bySession.size && !found.outside.length) {
      list.appendChild(this._rnEl('p', 'fm-muted', 'Nothing else running.'));
    }
    if (found.hiddenCount) {
      const n = found.hiddenCount;
      list.appendChild(this._rnEl('p', 'rn-note', `${n} more already in the dashboard.`));
    }
  },

  _runningTmuxRow(dialog, target, panes) {
    const first = panes[0];
    const row = this._rnEl('div', 'rn-row');
    const info = this._rnEl('div', 'rn-info');
    const title = this._rnEl('div', 'rn-title');
    title.append(this._rnEl('span', 'rn-name', first.sessionName));
    title.append(this._rnEl('span', 'rn-tag', first.socket === 'default' ? 'tmux' : `tmux -L ${first.socket}`));
    if (first.system === 'windows') title.append(this._rnEl('span', 'rn-tag', 'Windows'));
    if (first.attachedClients > 0) {
      title.append(
        this._rnEl(
          'span',
          'rn-tag rn-tag--live',
          first.attachedClients > 1 ? `${first.attachedClients} viewers` : 'open elsewhere'
        )
      );
    }
    info.appendChild(title);
    for (const p of panes) {
      const bits = [
        this._rnShortPath(p.cwd),
        p.title,
        panes.length > 1 || p.windows > 1 ? `window ${p.window}.${p.pane}` : '',
        p.status,
      ].filter(Boolean);
      info.appendChild(this._rnEl('div', 'rn-meta', bits.join(' · ')));
    }
    const attach = this._rnButton(
      'Attach',
      () => this._attachRunningClaude(dialog, target, first, attach),
      'fm-btn rn-primary'
    );
    if (!first.attachable) {
      attach.disabled = true;
      attach.title = 'The session name has characters this dashboard cannot pass to tmux safely; rename it to attach.';
    } else {
      attach.title = 'Join this tmux session. It keeps running; closing the tab only detaches.';
    }
    row.append(info, attach);
    return row;
  },

  _runningOutsideRow(dialog, target, p) {
    const row = this._rnEl('div', 'rn-row');
    const info = this._rnEl('div', 'rn-info');
    const title = this._rnEl('div', 'rn-title');
    const folder = p.cwd ? p.cwd.split('/').filter(Boolean).pop() || p.cwd : 'folder unknown';
    title.append(this._rnEl('span', 'rn-name', folder));
    title.append(this._rnEl('span', 'rn-tag rn-tag--outside', 'outside tmux'));
    if (p.system === 'windows') title.append(this._rnEl('span', 'rn-tag', 'Windows'));
    info.appendChild(title);
    const conv = p.conversationId
      ? `${p.conversationSource === 'newest-log' ? 'probably ' : ''}${p.conversationId.slice(0, 8)}${p.ambiguous ? ' (unsure)' : ''}`
      : 'conversation unknown';
    info.appendChild(
      this._rnEl('div', 'rn-meta', [p.title, conv, `pid ${p.pid}`, p.status].filter(Boolean).join(' · '))
    );
    if (p.cwd) info.appendChild(this._rnEl('div', 'rn-path', p.cwd));
    const resume = this._rnButton(
      'Resume here',
      () => this._resumeRunningClaude(dialog, target, p, resume),
      'fm-btn rn-primary'
    );
    const hostForResume = p.system === 'windows' ? target.windowsHostId : target.hostId;
    if (!p.conversationId || !p.cwd) {
      resume.disabled = true;
      resume.title = 'Its conversation or folder could not be found.';
    } else if (target.hostId !== null && !hostForResume) {
      resume.disabled = true;
      resume.title = 'This machine has no Windows system set up in Machines & accounts.';
    } else {
      resume.title = 'Start a new session here running claude --resume on the same conversation.';
    }
    row.append(info, resume);
    return row;
  },

  async _attachRunningClaude(dialog, target, pane, button) {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Attaching…';
    const name = pane.title || pane.sessionName;
    const workingDir = pane.cwd && RUNNING_SAFE_PATH.test(pane.cwd) ? pane.cwd : undefined;
    const body = { mode: 'shell', name: name.slice(0, 100) };
    if (target.hostId === null) {
      body.attachLocalTmux = { socket: pane.socket, sessionName: pane.sessionName };
      if (workingDir) body.workingDir = workingDir;
    } else {
      body.attachRemoteSession = {
        hostId: target.hostId,
        remoteSessionName: pane.sessionName,
        remoteTmuxSocket: pane.socket,
      };
      if (workingDir) body.workingDir = workingDir;
    }
    try {
      const created = await this._fetchJson('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const id = created?.session?.id || created?.id;
      await this._fetchJson(`/api/sessions/${encodeURIComponent(id)}/shell`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      dialog.close();
      this.showToast?.(`Attached to ${pane.sessionName}. Closing the tab detaches; it keeps running.`, 'success');
      await this._selectWhenPresent(id);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Attach';
      this.showToast?.(`Could not attach: ${err.message}`, 'error');
    }
  },

  async _resumeRunningClaude(dialog, target, p, button) {
    if (button.disabled) return;
    const where = target.hostId === null ? this._serverContainerLabel?.() || target.name : target.name;
    const ok = confirm(
      `This Claude is still running on ${where} (pid ${p.pid}) in ${p.cwd}.\n\n` +
        'Resuming starts a second Claude on the same conversation. Both write to one log, ' +
        'which can mix up or lose turns. Quit the original first if you can.\n\n' +
        'Resume here anyway?'
    );
    if (!ok) return;
    button.disabled = true;
    button.textContent = 'Starting…';
    const folder = p.cwd.split('/').filter(Boolean).pop() || p.cwd;
    const name = `${folder} · resumed`;
    try {
      let id;
      if (target.hostId === null) {
        const created = await this._fetchJson('/api/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workingDir: p.cwd, mode: 'claude', name, resumeSessionId: p.conversationId }),
        });
        id = created?.session?.id || created?.id;
        await this._fetchJson(`/api/sessions/${encodeURIComponent(id)}/interactive`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      } else {
        const hostId = p.system === 'windows' ? target.windowsHostId : target.hostId;
        id = await this._startRemoteSession(
          { path: p.cwd, mode: 'claude', resumeSessionId: p.conversationId },
          hostId,
          name
        );
      }
      dialog.close();
      this.showToast?.('Resumed. The original Claude is still running.', 'warning');
      await this._selectWhenPresent(id);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Resume here';
      this.showToast?.(`Could not resume: ${err.message}`, 'error');
    }
  },
});
