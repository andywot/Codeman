/**
 * @fileoverview Projects (fork): saved "start a session here" links.
 *
 * A project is machine + system + folder (+ account, model, agent) with a name. They are
 * stored on the server (`/api/projects`, src/projects.ts) so every device sees them, shown
 * in the side rail (desktop) and at the top of the New session dialog (every device,
 * the phone's way in), and a click starts a session through the same launch path New
 * session uses (`_startPick` in new-session.js), no dialog.
 *
 * `CodemanProjects` holds the pure helpers (tested in test/projects-ui.test.ts).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson, _startPick, _selectWhenPresent), app.js (showToast)
 * @loadorder 12.59 of 16, after new-session.js
 */

const CodemanProjects = {
  /** Folder name, the default project name. */
  defaultName(path) {
    return (
      String(path || '')
        .split('/')
        .filter(Boolean)
        .pop() ||
      String(path || '') ||
      'Project'
    ).slice(0, 60);
  },

  /** The subtle second line: machine (and system when it has several), account, model, agent. */
  subtitle(project) {
    const model = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }[project.model] || project.model;
    return [
      project.machine || (project.target === 'local' ? 'This server' : project.target),
      project.system,
      project.accountLabel,
      model,
      project.mode === 'shell' ? 'Shell' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  },

  /**
   * `ids` with `dragId` moved next to `targetId` (before it, or after when `after`).
   * Returns null when nothing would change (same row, unknown id, or already there).
   */
  moveId(ids, dragId, targetId, after) {
    if (dragId === targetId || !ids.includes(dragId) || !ids.includes(targetId)) return null;
    const rest = ids.filter((id) => id !== dragId);
    const at = rest.indexOf(targetId) + (after ? 1 : 0);
    rest.splice(at, 0, dragId);
    return rest.every((id, i) => id === ids[i]) ? null : rest;
  },

  /**
   * "New terminal here" / "New Claude session here": where a session runs, as what to start
   * beside it. Local -> `{kind:'pick', pick}` (target 'local', its folder); remote ssh (a
   * system is one host) -> a pick on that host and remote folder; docker -> `{kind:'case'}`
   * (launched through the tab "+" path, the container's case). Null when unknowable.
   * The tab is named `<folder> shell` for a terminal and `<folder>` for Claude.
   */
  hereLaunch(session, mode) {
    if (!session) return null;
    const base = (p) =>
      String(p || '')
        .split('/')
        .filter(Boolean)
        .pop() || '';
    const dir = session.remote ? session.remote.remotePath : session.workingDir;
    const folder = base(dir) || base(session.workingDir) || 'session';
    const sessionName = mode === 'shell' ? `${folder} shell` : folder;
    if (session.docker) return { kind: 'case', mode, sessionName };
    if (session.remote) {
      if (!session.remote.hostId || !session.remote.remotePath) return null;
      return {
        kind: 'pick',
        pick: { target: session.remote.hostId, path: session.remote.remotePath, mode, sessionName },
      };
    }
    if (!session.workingDir) return null;
    return { kind: 'pick', pick: { target: 'local', path: session.workingDir, mode, sessionName } };
  },

  /** What `_startPick` takes. */
  toPick(project) {
    return {
      target: project.target,
      path: project.path,
      mode: project.mode || 'claude',
      accountId: project.accountId || undefined,
      model: project.model || undefined,
    };
  },

  /** The POST body for a pick; null fields become undefined (zod `.optional()` rejects null). */
  fromPick(pick, { name, machine, system, accountLabel }) {
    return {
      name: (name || '').trim() || CodemanProjects.defaultName(pick.path),
      target: pick.target,
      machine: machine || undefined,
      system: system || undefined,
      path: pick.path,
      mode: pick.mode || 'claude',
      accountId: pick.accountId || undefined,
      accountLabel: pick.accountId ? accountLabel || undefined : undefined,
      model: pick.model || undefined,
    };
  },
};
window.CodemanProjects = CodemanProjects;

Object.assign(CodemanApp.prototype, {
  async loadProjects() {
    try {
      const data = await this._fetchJson('/api/projects');
      this._projects = Array.isArray(data?.projects) ? data.projects : [];
    } catch {
      this._projects = this._projects || [];
    }
    this.renderProjectRail();
    return this._projects;
  },

  async saveProject(body) {
    const data = await this._fetchJson('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await this.loadProjects();
    return data?.project;
  },

  async renameProject(id, name) {
    await this._fetchJson(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await this.loadProjects();
  },

  /** Save a new order (optimistic: the rail already shows it; a refusal reloads the server's). */
  async reorderProjects(ids) {
    const current = this._projects || [];
    const byId = new Map(current.map((p) => [p.id, p]));
    this._projects = [...ids.map((id) => byId.get(id)).filter(Boolean), ...current.filter((p) => !ids.includes(p.id))];
    this.renderProjectRail();
    try {
      await this._fetchJson('/api/projects/order', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    } catch (err) {
      this.showToast?.(`Could not save the order: ${err.message}`, 'error');
      await this.loadProjects();
    }
  },

  /**
   * Drag a project to reorder (mouse: press and move; touch: long-press, then move). Pointer
   * events bound once on the rail host, which survives every re-render; a click that ends
   * a drag is swallowed so it does not start a session.
   */
  _bindProjectDrag(host) {
    if (host._projectDragBound) return;
    host._projectDragBound = true;
    let drag = null;
    const clearMarks = () =>
      host
        .querySelectorAll('.drop-before, .drop-after')
        .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    const end = () => {
      if (!drag) return;
      clearTimeout(drag.timer);
      window.removeEventListener('pointerup', drag.up, true);
      window.removeEventListener('pointercancel', drag.cancel, true);
      drag.row.classList.remove('is-dragging');
      host.classList.remove('is-drag-active');
      clearMarks();
      if (drag.active) {
        const swallow = (e) => {
          e.stopPropagation();
          e.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
      drag = null;
    };
    const activate = () => {
      if (!drag) return;
      drag.active = true;
      drag.row.classList.add('is-dragging');
      host.classList.add('is-drag-active');
    };
    const targetAt = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      const row = hit && hit.closest ? hit.closest('.rail-project') : null;
      if (!row || !host.contains(row)) return null;
      const r = row.getBoundingClientRect();
      return { row, id: row.dataset.id, after: y >= r.top + r.height / 2 };
    };
    host.addEventListener('pointerdown', (e) => {
      end();
      if (e.button !== 0) return;
      const row = e.target.closest('.rail-project');
      if (!row || !row.dataset.id || e.target.closest('.rail-project-more, input')) return;
      drag = {
        row,
        id: row.dataset.id,
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        touch: e.pointerType === 'touch',
        active: false,
        target: null,
      };
      drag.up = (ev) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        const t = drag.active ? targetAt(ev.clientX, ev.clientY) || drag.target : null;
        const id = drag.id;
        end();
        if (!t) return;
        const ids = (this._projects || []).map((p) => p.id);
        const next = CodemanProjects.moveId(ids, id, t.id, t.after);
        if (next) this.reorderProjects(next);
      };
      drag.cancel = () => end();
      window.addEventListener('pointerup', drag.up, true);
      window.addEventListener('pointercancel', drag.cancel, true);
      if (drag.touch) drag.timer = setTimeout(activate, 450);
    });
    host.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
      if (!drag.active) {
        if (drag.touch) {
          // Moved before the long-press fired: this is a scroll, not a drag.
          if (moved > 8) end();
          return;
        }
        if ((e.buttons & 1) === 0) return end();
        if (moved < 6) return;
        activate();
      }
      e.preventDefault();
      clearMarks();
      const t = targetAt(e.clientX, e.clientY);
      drag.target = t;
      if (t && t.id !== drag.id) t.row.classList.add(t.after ? 'drop-after' : 'drop-before');
    });
    // Once a long-press drag is live, keep the rail from scrolling under the finger.
    host.addEventListener(
      'touchmove',
      (e) => {
        if (drag && drag.active && e.cancelable) e.preventDefault();
      },
      { passive: false }
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drag) end();
    });
  },

  async removeProject(id) {
    await this._fetchJson(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.loadProjects();
  },

  /** One click: start a session for the project, no dialog. */
  async startProject(project, row) {
    if (row?.dataset.busy) return;
    if (row) {
      row.dataset.busy = '1';
      row.classList.add('is-busy');
    }
    try {
      const id = await this._startPick(CodemanProjects.toPick(project), project.accountLabel);
      await this._selectWhenPresent(id);
    } catch (err) {
      this.showToast?.(`Could not start ${project.name}: ${err.message}`, 'error');
    } finally {
      if (row) {
        delete row.dataset.busy;
        row.classList.remove('is-busy');
      }
    }
  },

  /** Row menu: start a plain terminal / a Claude session on the same machine and folder as `sessionId`. */
  async startSessionHere(sessionId, mode) {
    const session = this.sessions.get(sessionId);
    const plan = CodemanProjects.hereLaunch(session, mode);
    if (!plan) {
      this.showToast?.('Cannot tell where this session runs.', 'info');
      return;
    }
    if (this._hereInFlight) return;
    this._hereInFlight = true;
    try {
      if (plan.kind === 'case') {
        const caseEntry = this._tabCaseOf?.(session);
        if (!caseEntry) {
          this.showToast?.("This session's container is not a case, so nothing can start beside it.", 'info');
          return;
        }
        await this._launchOnce(mode, { caseName: caseEntry.name });
        return;
      }
      const id = await this._startPick(plan.pick, null);
      await this._selectWhenPresent(id);
    } catch (err) {
      this.showToast?.(`Could not start the session: ${err.message}`, 'error');
    } finally {
      this._hereInFlight = false;
    }
  },

  renderProjectRail() {
    const host = document.getElementById('tabRailProjects');
    if (!host) return;
    const projects = this._projects || [];
    host.hidden = !projects.length;
    this._bindProjectDrag(host);
    host.replaceChildren();
    if (!projects.length) return;
    const head = document.createElement('div');
    head.className = 'rail-projects-head';
    head.textContent = 'Projects';
    host.appendChild(head);
    for (const project of projects) {
      const item = document.createElement('div');
      item.className = 'rail-project';
      item.setAttribute('data-i18n-skip', '');
      item.dataset.id = project.id;
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'rail-project-main';
      main.title = `${project.path}\nStart a session here`;
      const name = document.createElement('span');
      name.className = 'rail-project-name';
      name.textContent = project.name;
      const where = document.createElement('span');
      where.className = 'rail-project-where';
      where.textContent = CodemanProjects.subtitle(project);
      main.append(name, where);
      main.addEventListener('click', () => this.startProject(project, item));
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'rail-project-more';
      more.setAttribute('aria-label', `Project menu: ${project.name}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.textContent = '⋯';
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        this._openProjectMenu(project, item, more);
      });
      item.append(main, more);
      host.appendChild(item);
    }
  },

  _closeProjectMenu() {
    document.getElementById('projectMenu')?.remove();
  },

  _openProjectMenu(project, item, anchor) {
    const existing = document.getElementById('projectMenu');
    this._closeProjectMenu();
    if (existing?.dataset.id === project.id) return;
    const menu = document.createElement('div');
    menu.id = 'projectMenu';
    menu.className = 'project-menu';
    menu.dataset.id = project.id;
    menu.setAttribute('role', 'menu');
    const entry = (label, onPick, danger = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'project-menu-item' + (danger ? ' danger' : '');
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.addEventListener('click', () => {
        this._closeProjectMenu();
        onPick();
      });
      return b;
    };
    menu.append(
      entry('Rename', () => this._renameProjectInline(project, item)),
      entry('Remove', () => this.removeProject(project.id).catch((e) => this.showToast?.(e.message, 'error')), true)
    );
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 140;
    menu.style.top = `${Math.round(r.bottom + 2)}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, Math.round(r.right - width)))}px`;
    menu.querySelector('button')?.focus();
    const dismiss = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type !== 'keydown' && menu.contains(event.target)) return;
      this._closeProjectMenu();
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      if (event.type === 'keydown') anchor.focus();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
  },

  _renameProjectInline(project, item) {
    const nameEl = item.querySelector('.rail-project-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'rail-project-edit';
    input.value = project.name;
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Project name');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && next && next !== project.name) {
        try {
          await this.renameProject(project.id, next);
          return;
        } catch (err) {
          this.showToast?.(`Could not rename: ${err.message}`, 'error');
        }
      }
      this.renderProjectRail();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  },
});

// Load once the app exists (app.js builds it on DOMContentLoaded, ahead of this listener).
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.app?.loadProjects?.(), 0);
});
