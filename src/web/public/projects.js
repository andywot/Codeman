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

  renderProjectRail() {
    const host = document.getElementById('tabRailProjects');
    if (!host) return;
    const projects = this._projects || [];
    host.hidden = !projects.length;
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
