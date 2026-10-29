/**
 * @fileoverview Machine state and load (fork): online, asleep or offline per
 * machine, a one-line fix hint, and CPU/MEM.
 *
 * Reads `GET /api/fleet/status` (machine-status.ts) once a minute, and only
 * while this page is visible, so with no browser looking the server polls
 * nothing. Shown in two places:
 * - the desktop status bar (status-bar.js calls `_statusBarMachineItems()`):
 *   a state dot, the name and two rings, CPU then MEM, with the hint in the
 *   tooltip; clicking an asleep machine offers Wake, any other opens
 *   Machines & accounts;
 * - the New session dialog's machine chips (new-session.js): the same dot,
 *   CPU/MEM as the chip detail, and the selected machine's hint with a Wake
 *   button under the chips (phones see it here).
 *
 * Waking is always a click (`POST /api/fleet/hosts/:id/wake`); the poll never
 * wakes anything. After a Wake the status is re-read a few times while the
 * machine comes up. Everything shown is set with textContent.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency new-session.js (_fetchJson), status-bar.js (renderStatusBar),
 *   fleet-manager.js (openFleetManager)
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

  async refreshMachineStatus({ fresh = false } = {}) {
    if (this._machineStatusPending) return;
    this._machineStatusPending = true;
    try {
      const res = await fetch(`/api/fleet/status${fresh ? '?fresh=1' : ''}`);
      if (!res.ok) return;
      const json = await res.json();
      this._machineStatus = json?.data?.machines ?? [];
      this._machineStatusAt = Date.now();
      this.renderStatusBar?.();
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

  /** Status bar entries, one per remote machine (status-bar.js appends them). */
  _statusBarMachineItems() {
    const items = [];
    for (const m of this._machineStatus || []) {
      const item = this._statusBarItem(m.name, { cls: 'rc-machine', action: 'machine' });
      item.dataset.machine = m.name;
      item.dataset.mstate = this._machineWaking?.has(m.name) ? 'waking' : machineDotKind(m);
      if (m.state === 'online' && !m.issue && m.load) {
        for (const pct of [m.load.cpu, m.load.memPercent]) {
          const ring = document.createElement('span');
          ring.className = `rc-ring${pct >= 80 ? ' rc-ring--high' : pct >= 50 ? ' rc-ring--mid' : ''}`;
          ring.style.setProperty('--p', String(pct ?? 0));
          ring.setAttribute('aria-hidden', 'true');
          const tag = document.createElement('span');
          tag.className = 'rc-ring-key';
          tag.textContent = pct == null ? '…' : `${pct}%`;
          item.append(ring, tag);
        }
      } else if (m.state !== 'online' || m.issue) {
        const word = document.createElement('span');
        word.className = 'rc-ring-key';
        word.textContent = this._machineWaking?.has(m.name) ? 'waking…' : machineStateWord(m);
        item.append(word);
      }
      const summary = this.machineStatusSummary(m) + (m.wakeHostId ? '\nClick to wake it' : '');
      item.title = summary;
      item.setAttribute('aria-label', summary.replace(/\n/g, '. '));
      items.push(item);
    }
    return items;
  },

  /** Status bar click on a machine: offer Wake when asleep, else open Machines & accounts. */
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
