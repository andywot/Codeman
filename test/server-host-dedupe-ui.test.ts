/**
 * @fileoverview One entry for the dashboard server and the machine it runs on (fork).
 *
 * Loads the real machine-status-ui.js, new-session.js and overview-board.js into a JSDOM window
 * against a stub CodemanApp and pins: which machine counts as the server's (`_serverHostMachine`),
 * that New session offers the server's own agent as a system of that machine instead of a second
 * machine, that the Overview puts the server's sessions with that machine's, and that the top bar
 * draws one entry per machine with the server's own machine as the name of the CPU/MEM pill.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');

type App = Record<string, (...args: unknown[]) => any> & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function machine(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    host: '10.0.0.5',
    port: 22,
    isServerHost: false,
    serverHostSource: null,
    wakeHostId: null,
    state: 'online',
    reason: 'connected',
    hint: '',
    issue: false,
    load: { cpu: 12, memPercent: 41, memUsedMB: 6500, memTotalMB: 16000 },
    systems: [],
    checkedAt: 0,
    ...over,
  };
}

function load(): { app: App; window: Window & Record<string, any> } {
  const dom = new JSDOM(
    `<!doctype html><body><div id="headerSystemStats"><button id="statHost" hidden></button></div>
     <div id="headerMachines" hidden></div></body>`,
    { runScripts: 'outside-only', url: 'http://localhost/' }
  );
  const w = dom.window as unknown as Window & Record<string, any>;
  // Stub app: the modules only extend its prototype.
  vm.runInContext(
    `class CodemanApp {
       _machineNameOf(remote) { return remote?.hostId ? String(remote.label || '').split(' · ')[0] || remote.hostId : null; }
       _localMachineLabel() { return this._serverHostMachine?.()?.name || 'This server'; }
       _serverContainerLabel() { const h = this._serverHostMachine?.(); return h ? h.name + ' (server container)' : this._localMachineLabel(); }
     }
     window.CodemanApp = CodemanApp; window.app = new CodemanApp();`,
    dom.getInternalVMContext()
  );
  for (const file of ['machine-status-ui.js', 'new-session.js', 'overview-board.js']) {
    vm.runInContext(`${read(file)}\n`, dom.getInternalVMContext(), { filename: file });
  }
  return { app: w.app as App, window: w };
}

describe('which machine is the server', () => {
  it("is the status answer's flagged machine, else nothing", () => {
    const { app } = load();
    expect(app._serverHostMachine()).toBeNull();
    app._machineStatus = [machine('Laptop'), machine('arr', { isServerHost: true, serverHostSource: 'detected' })];
    app._machineStatusAt = Date.now();
    expect(app._serverHostMachine()).toMatchObject({ name: 'arr', source: 'detected' });
    app._machineStatus = [machine('Laptop')];
    expect(app._serverHostMachine()).toBeNull();
  });

  it('uses the name a fleet read carried until the first status read arrives', () => {
    const { app } = load();
    app.noteFleetServerHost({ machines: [{ name: 'Laptop' }, { name: 'arr', serverHost: true }] });
    expect(app._serverHostMachine()).toMatchObject({ name: 'arr' });
    app._machineStatusAt = Date.now();
    app._machineStatus = [];
    expect(app._serverHostMachine()).toBeNull();
  });
});

describe('New session: the server is one machine, not two', () => {
  const fleet = {
    machines: [
      {
        name: 'arr',
        host: '10.0.0.5',
        serverHost: true,
        systems: [{ hostId: 'arr-linux', system: 'linux', label: 'arr · Linux' }],
      },
      { name: 'Laptop', host: '10.0.0.6', systems: [{ hostId: 'lap-wsl', system: 'wsl', label: 'Laptop · WSL' }] },
    ],
  };

  it('adds the server container as a system of the host machine', () => {
    const { app } = load();
    const list = app._newSessionMachines(fleet);
    expect(list.map((m: { name: string }) => m.name)).toEqual(['arr', 'Laptop']);
    expect(list[0].server).toBe(true);
    expect(list[0].systems.map((s: { id: string; label: string }) => [s.id, s.label])).toEqual([
      ['arr-linux', 'Linux'],
      ['local', 'Server container'],
    ]);
  });

  it('still lists "This server" when no machine is the server', () => {
    const { app } = load();
    const list = app._newSessionMachines({ machines: fleet.machines.map((m) => ({ ...m, serverHost: false })) });
    expect(list.map((m: { name: string }) => m.name)).toEqual(['arr', 'Laptop', 'This server']);
    expect(list.at(-1).systems).toEqual([{ id: 'local', system: 'linux', label: 'Local' }]);
  });
});

describe("Overview: the server's sessions sit with the machine it runs on", () => {
  it('groups them under that machine, labelled server', () => {
    const { app } = load();
    app._machineStatus = [machine('arr', { isServerHost: true })];
    app._machineStatusAt = Date.now();
    const local = app._overviewMachineFor({});
    const viaSsh = app._overviewMachineFor({ remote: { hostId: 'arr-linux', label: 'arr · Linux' } });
    expect(local.key).toBe(viaSsh.key);
    expect(local).toMatchObject({ label: 'arr', server: true });
    expect(viaSsh).toMatchObject({ label: 'arr', remote: true, server: true });
    const other = app._overviewMachineFor({ remote: { hostId: 'lap-wsl', label: 'Laptop · WSL' } });
    expect(other.server).toBe(false);
  });

  it('keeps the old "This server" section when none is flagged', () => {
    const { app } = load();
    expect(app._overviewMachineFor({})).toMatchObject({ key: 'host:local', server: false, remote: false });
  });
});

describe('top bar', () => {
  it("draws one entry per machine and names the server's own pill after its machine", () => {
    const { app, window } = load();
    app._machineStatus = [
      machine('arr', { isServerHost: true, serverHostSource: 'setting' }),
      machine('Laptop', { load: { cpu: 83, memPercent: 62, memUsedMB: 1, memTotalMB: 2 } }),
      machine('Desktop', { state: 'asleep', reason: 'no-reply', wakeHostId: 'desk-wsl', load: null, hint: 'Asleep' }),
    ];
    app.renderHeaderMachines();
    const box = window.document.getElementById('headerMachines')!;
    const names = [...box.querySelectorAll('.hm-name')].map((n) => n.textContent);
    // arr is the pill's name, not a second entry; every other machine has one.
    expect(names).toEqual(['Laptop', 'Desktop']);
    const host = window.document.getElementById('statHost')!;
    expect(host.hidden).toBe(false);
    expect(host.textContent).toBe('arrserver');
    expect(host.dataset.mstate).toBe('ok');
    const laptop = box.querySelector('[data-machine="Laptop"]')!;
    expect(laptop.textContent).toContain('83%');
    expect(laptop.textContent).toContain('62%');
    const desktop = box.querySelector('[data-machine="Desktop"]') as HTMLElement;
    expect(desktop.dataset.mstate).toBe('asleep');
    expect(desktop.textContent).toContain('asleep');
    expect(desktop.title).toContain('Click to wake it');
  });

  it("lists the server's machine as a normal entry while the CPU/MEM pill is hidden", () => {
    const { app, window } = load();
    window.document.getElementById('headerSystemStats')!.style.display = 'none';
    app._machineStatus = [machine('arr', { isServerHost: true })];
    app.renderHeaderMachines();
    expect([...window.document.querySelectorAll('#headerMachines .hm-name')].map((n) => n.textContent)).toEqual([
      'arr',
    ]);
    expect(window.document.getElementById('statHost')!.hidden).toBe(true);
  });

  it('calls an unflagged server "This server" once there is a machine beside it', () => {
    const { app, window } = load();
    app._machineStatus = [machine('Laptop')];
    app.renderHeaderMachines();
    const host = window.document.getElementById('statHost')!;
    expect(host.hidden).toBe(false);
    expect(host.textContent).toBe('This server');
    expect(host.dataset.mstate).toBeUndefined();
  });

  it('draws nothing without machines', () => {
    const { app, window } = load();
    app._machineStatus = [];
    app.renderHeaderMachines();
    expect(window.document.getElementById('headerMachines')!.hidden).toBe(true);
    expect(window.document.getElementById('statHost')!.hidden).toBe(true);
  });
});

describe('wiring', () => {
  it('moves the machines out of the status bar and into the header markup', () => {
    expect(read('status-bar.js')).not.toContain('_statusBarMachineItems');
    const html = read('index.html');
    expect(html).toContain('id="headerMachines"');
    expect(html).toContain('id="statHost"');
    // The app's machine grouping and label read the same answer.
    const app = read('app.js');
    expect(app).toContain('this._serverHostMachine?.()');
    expect(app).toContain('_serverContainerLabel()');
  });
});
