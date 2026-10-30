/**
 * @fileoverview Machine state and load (fork): online, asleep or offline per
 * machine, a one-line fix hint, and CPU/MEM.
 *
 * Reads `GET /api/fleet/status` (machine-status.ts) once a minute, and only
 * while this page is visible, so with no browser looking the server polls
 * nothing. Shown in two places:
 * - the desktop top bar (`#headerMachines`, `renderHeaderMachines()`): ONE
 *   entry per machine, a state dot, the name and two rings, CPU then MEM, with
 *   the hint in the tooltip; clicking an asleep machine offers Wake, any other
 *   opens Machines & accounts. The machine the dashboard server runs on
 *   (`isServerHost`, set per machine or found by machine-status.ts) is the
 *   first entry, with a `server` tag, drawn like the others; the server's own
 *   CPU/MEM pill (`#headerSystemStats`) folds away so it is not shown twice;
 * - the New session dialog's machine chips (new-session.js): the same dot,
 *   CPU/MEM as the chip detail, and the selected machine's hint with a Wake
 *   button under the chips (phones see it here).
 *
 * `_serverHostMachine()` is the one answer to "which machine is the server",
 * used by every surface that would otherwise list the server beside it
 * (new-session.js, overview-board.js, app.js tab grouping, machine-history.js,
 * fleet-manager.js).
 *
 * Waking is always a click (`POST /api/fleet/hosts/:id/wake`); the poll never
 * wakes anything. After a Wake the status is re-read a few times while the
 * machine comes up. Everything shown is set with textContent.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson), fleet-manager.js (openFleetManager)
 * @loadorder after fleet-manager.js, before status-bar.js
 */

const MACHINE_STATUS_POLL_MS = 60_000;
/** Re-reads after a Wake, while the machine boots (ms after the click). */
const MACHINE_WAKE_RECHECK_MS = [10_000, 25_000, 45_000, 70_000, 100_000];

/** Short words for the state shown beside the name when there are no figures. */
function machineStateWord(m) {
  if (m.state === 'asleep') return 'asleep';
  if (m.state === 'offline') return m.reason === 'no-sshd' ? 'no ssh' : 'offline';
  switch (m.reason) {
    case 'auth':
      return 'key refused';
    case 'host-key':
      return 'host key';
    case 'tools-missing':
      return m.hint.split(' not found')[0].replace(' and ', '+') + ' missing';
    case 'ssh-error':
      return 'ssh error';
    default:
      return 'online';
  }
}

/** The dot's kind: ok, issue, asleep or offline (CSS data-mstate). */
function machineDotKind(m) {
  if (m.state === 'online') return m.issue ? 'issue' : 'ok';
  return m.state;
}

Object.assign(CodemanApp.prototype, {
  /** Last answer by machine name (empty until the first read). */
  machineStatusFor(name) {
    return (this._machineStatus || []).find((m) => m.name === name) || null;
  },

  /**
   * The machine the dashboard server runs on, `{ name, source, status }`, or null. The
   * status answer decides (a flagged machine, or one found by its kernel boot id); until
   * it arrives, the name a fleet read already carried (`noteFleetServerHost`).
   */
  _serverHostMachine() {
    const m = (this._machineStatus || []).find((x) => x.isServerHost);
    if (m) return { name: m.name, source: m.serverHostSource || 'setting', status: m };
    if (!this._machineStatusAt && this._fleetServerHostName) {
      return { name: this._fleetServerHostName, source: 'setting', status: null };
    }
    return null;
  },

  /** Remember the flagged machine of a `GET /api/fleet` answer (before the first status read). */
  noteFleetServerHost(fleet) {
    this._fleetServerHostName = (fleet?.machines || []).find((m) => m.serverHost)?.name || '';
  },

  async refreshMachineStatus({ fresh = false } = {}) {
    if (this._machineStatusPending) return;
    this._machineStatusPending = true;
    try {
      const res = await fetch(`/api/fleet/status${fresh ? '?fresh=1' : ''}`);
      if (!res.ok) return;
      const json = await res.json();
      const before = this._serverHostMachine()?.name || '';
      this._machineStatus = json?.data?.machines ?? [];
      this._machineStatusAt = Date.now();
      // Where the server's own sessions are listed depends on which machine it is.
      if ((this._serverHostMachine()?.name || '') !== before) this._relabelServerSessions();
      window.dispatchEvent(new CustomEvent('codeman:machine-status'));
    } catch {
      /* not critical: the next poll tries again */
    } finally {
      this._machineStatusPending = false;
    }
  },

  /** One line for a tooltip or the dialog: state, figures, hint. */
  machineStatusSummary(m) {
    const lines = [`${m.name}: ${m.state === 'online' ? (m.issue ? 'online, not usable' : 'online') : m.state}`];
    if (m.load) {
      const used = (m.load.memUsedMB / 1024).toFixed(1);
      const total = (m.load.memTotalMB / 1024).toFixed(1);
      lines.push(
        `CPU ${m.load.cpu == null ? '…' : `${m.load.cpu}%`} · MEM ${m.load.memPercent}% (${used} of ${total} GB)`
      );
    }
    if (m.hint) lines.push(m.hint);
    return lines.join('\n');
  },

  /** Chip detail: figures when online and readable, else the state word. */
  machineStatusDetail(name) {
    const m = this.machineStatusFor(name);
    if (!m) return null;
    if (m.state === 'online' && !m.issue && m.load) {
      return `cpu ${m.load.cpu == null ? '…' : `${m.load.cpu}%`} · mem ${m.load.memPercent}%`;
    }
    return machineStateWord(m);
  },

  machineDotKind(name) {
    const m = this.machineStatusFor(name);
    return m ? machineDotKind(m) : '';
  },

  /** Fill the New session dialog's note for the selected machine (hint + Wake). */
  renderMachineNote(noteEl, name) {
    const m = this.machineStatusFor(name);
    if (!noteEl) return;
    if (!m || (!m.hint && !m.wakeHostId)) {
      noteEl.hidden = true;
      noteEl.replaceChildren();
      return;
    }
    const text = document.createElement('span');
    text.textContent = this._machineWaking?.has(name) ? 'Waking… this can take a minute' : m.hint;
    const parts = [text];
    if (m.wakeHostId && !this._machineWaking?.has(name)) {
      const wake = document.createElement('button');
      wake.type = 'button';
      wake.className = 'ns-wake';
      wake.textContent = 'Wake';
      wake.addEventListener('click', () => this.wakeMachine(m));
      parts.push(wake);
    }
    noteEl.dataset.mstate = machineDotKind(m);
    noteEl.replaceChildren(...parts);
    noteEl.hidden = false;
  },

  async wakeMachine(m) {
    if (!m?.wakeHostId) return;
    this._machineWaking = this._machineWaking || new Set();
    try {
      await this._fetchJson(`/api/fleet/hosts/${encodeURIComponent(m.wakeHostId)}/wake`, { method: 'POST' });
    } catch (err) {
      this.showToast?.(`Could not wake ${m.name}: ${err.message}`, 'error');
      return;
    }
    this._machineWaking.add(m.name);
    this.showToast?.(`Waking ${m.name}…`, 'info');
    window.dispatchEvent(new CustomEvent('codeman:machine-status'));
    for (const delay of MACHINE_WAKE_RECHECK_MS) {
      setTimeout(async () => {
        await this.refreshMachineStatus({ fresh: true });
        const now = this.machineStatusFor(m.name);
        if (now?.state === 'online' || delay === MACHINE_WAKE_RECHECK_MS.at(-1)) {
          if (this._machineWaking.delete(m.name)) window.dispatchEvent(new CustomEvent('codeman:machine-status'));
        }
      }, delay);
    }
  },

  /** Server sessions move under the host machine's name (or back): redraw what groups by machine. */
  _relabelServerSessions() {
    this.renderSessionTabs?.();
    const board = document.getElementById('overviewBoard');
    if (board && !board.hidden) this.renderOverviewBoard?.();
  },

  /** The CPU and MEM rings (with their numbers) appended to `item`. */
  _appendMachineRings(item, load) {
    for (const pct of [load.cpu, load.memPercent]) {
      const ring = document.createElement('span');
      ring.className = `rc-ring${pct >= 80 ? ' rc-ring--high' : pct >= 50 ? ' rc-ring--mid' : ''}`;
      ring.style.setProperty('--p', String(pct ?? 0));
      ring.setAttribute('aria-hidden', 'true');
      const tag = document.createElement('span');
      tag.className = 'rc-ring-key hm-pct';
      tag.textContent = pct == null ? '…' : `${pct}%`;
      item.append(ring, tag);
    }
  },

  _machineTitle(m) {
    const lines = [this.machineStatusSummary(m)];
    if (m.isServerHost) {
      lines.push(
        m.serverHostSource === 'detected'
          ? 'The dashboard server runs on this machine (found automatically).'
          : 'The dashboard server runs on this machine.'
      );
    }
    if (m.wakeHostId) lines.push('Click to wake it');
    return lines.join('\n');
  },

  /**
   * The top bar's machine entries, one per machine, as a list of buttons. The server's own
   * machine is left out while the live CPU/MEM pill is on screen (it is that pill's name).
   */
  _headerMachineItems({ skipServerHost }) {
    const items = [];
    for (const m of this._machineStatus || []) {
      if (skipServerHost && m.isServerHost) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'hm-item rc-machine';
      item.dataset.machine = m.name;
      item.dataset.mstate = this._machineWaking?.has(m.name) ? 'waking' : machineDotKind(m);
      item.setAttribute('data-i18n-skip', '');
      const name = document.createElement('span');
      name.className = 'hm-name';
      name.textContent = m.name;
      item.append(name);
      if (m.isServerHost) {
        const tag = document.createElement('span');
        tag.className = 'hm-tag';
        tag.textContent = 'server';
        item.append(tag);
      }
      if (m.state === 'online' && !m.issue && m.load) {
        this._appendMachineRings(item, m.load);
      } else if (m.state !== 'online' || m.issue) {
        const word = document.createElement('span');
        word.className = 'rc-ring-key';
        word.textContent = this._machineWaking?.has(m.name) ? 'waking…' : machineStateWord(m);
        item.append(word);
      }
      const title = this._machineTitle(m);
      item.title = title;
      item.setAttribute('aria-label', title.replace(/\n/g, '. '));
      items.push(item);
    }
    return items;
  },

  /**
   * Fill the top bar: `#headerMachines`, one entry per machine drawn the same way. The machine
   * the server runs on is one of them (first, with a `server` tag) and the server's own CPU/MEM
   * pill folds away (`header-system-stats--folded`) so it is not drawn twice in a different
   * style. With no machine flagged as the server, the pill stays and is named "This server"
   * (`#statHost`). Desktop only; the phone layouts keep their own surfaces
   * (`data-header-machines="off"`).
   */
  renderHeaderMachines() {
    const box = document.getElementById('headerMachines');
    const host = document.getElementById('statHost');
    if (!box) return;
    const machines = this._machineStatus || [];
    const stats = document.getElementById('headerSystemStats');
    const statsShown = Boolean(stats) && stats.style.display !== 'none';
    const server = machines.find((m) => m.isServerHost) || null;
    const items = this._headerMachineItems({ skipServerHost: false });
    if (server) {
      const at = items.findIndex((item) => item.dataset.machine === server.name);
      if (at > 0) items.unshift(...items.splice(at, 1));
    }
    box.replaceChildren(...items);
    box.hidden = items.length === 0;
    stats?.classList.toggle('header-system-stats--folded', Boolean(server));

    if (host) {
      // A name in front of the pill only helps once there is a machine entry to tell it from.
      const named = machines.length > 0 && statsShown && !server;
      host.hidden = !named;
      delete host.dataset.mstate;
      delete host.dataset.machine;
      host.replaceChildren();
      if (named) {
        const name = document.createElement('span');
        name.className = 'hm-name';
        name.textContent = 'This server';
        host.append(name);
        const title = "This dashboard server's own load (it is not one of the machines listed here).";
        host.title = title;
        host.setAttribute('aria-label', title);
      }
    }
  },

  /** A click on a machine in the top bar: offer Wake when asleep, else open Machines & accounts. */
  _onStatusBarMachine(name) {
    const m = this.machineStatusFor(name);
    if (m?.wakeHostId && !this._machineWaking?.has(name)) {
      if (confirm(`${m.name} looks ${m.state}. Send Wake-on-LAN?`)) this.wakeMachine(m);
      return;
    }
    this.openFleetManager?.();
  },
});

(function wireMachineStatus() {
  const start = () => {
    const app = window.app;
    if (!app) return setTimeout(start, 300);
    const click = (event) => {
      const target = event.target.closest('[data-machine]');
      if (target && target.dataset.machine) app._onStatusBarMachine(target.dataset.machine);
    };
    document.getElementById('headerMachines')?.addEventListener('click', click);
    document.getElementById('statHost')?.addEventListener('click', click);
    window.addEventListener('codeman:machine-status', () => app.renderHeaderMachines());
    const tick = () => {
      if (document.visibilityState === 'visible') app.refreshMachineStatus();
    };
    tick();
    setInterval(tick, MACHINE_STATUS_POLL_MS);
    // Back on a tab that sat hidden: read now rather than wait out the minute.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - (app._machineStatusAt || 0) >= MACHINE_STATUS_POLL_MS) app.refreshMachineStatus();
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
