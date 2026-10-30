/**
 * @fileoverview tmux-style panes: the pane keys (a prefix, then one key) and
 * the tile grid's tree layout they build (tile-grid.js).
 *
 * Ctrl+B then % splits the focused pane left/right, " top/bottom; arrows move
 * focus, Ctrl/Alt+arrows resize (repeatable without the prefix for half a
 * second), x closes a pane (never the session; one pane left is the single
 * view again), z zooms, q shows the numbers (a digit picks one), the prefix
 * twice sends ONE literal prefix through tmux send-keys. Every key the pane
 * keys take is stopped in the capture phase (stopImmediatePropagation) and
 * refused by the xterm key handlers, so it never reaches a PTY: the prefix
 * cannot arm the tmux prefix table behind a browser tab. A pick in the rail
 * takes the focused pane; the layout persists with the grid.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeTile,
  fetchSpy,
  localStore,
  makeGridApp,
  resetGridHarness,
  section,
  tileEl,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d'];
const TERMINAL = { tagName: 'TEXTAREA', classList: { contains: (c: string) => c === 'xterm-helper-textarea' } };

function key(
  k: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; code?: string } = {},
  target: unknown = TERMINAL
) {
  return {
    type: 'keydown',
    key: k,
    code: mods.code ?? '',
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: false,
    target,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
}
const PREFIX = () => key('b', { ctrl: true, code: 'KeyB' });

/** Presses the prefix then `k` through the real handler; returns both events. */
function press(app: GridApp, k: string, mods: Parameters<typeof key>[1] = {}) {
  const p = PREFIX();
  const e = key(k, mods);
  expect(app.handlePaneKeydown(p)).toBe(true);
  // Shift (for % and ") arrives first and must not disarm.
  if (mods.shift) expect(app.handlePaneKeydown(key('Shift', { shift: true }))).toBe(false);
  const taken = app.handlePaneKeydown(e);
  return { p, e, taken };
}

function app4(): GridApp {
  const app = makeGridApp(IDS);
  app.selectSession = CodemanSelect(app);
  return app;
}

/** selectSession as far as the grid needs it: the tile branch, else the active id. */
function CodemanSelect(app: GridApp) {
  const real = app.selectSession.bind(app);
  return vi.fn((id: string, options?: Record<string, unknown>) => {
    if (app._tileGrid?.open) return real(id, options);
    app.activeSessionId = id;
    return undefined;
  });
}

beforeEach(() => {
  resetGridHarness();
  fetchSpy.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the prefix', () => {
  it('is a rebindable registry entry (Ctrl+B), with the keys after it flagged `prefix`', () => {
    const app = app4();
    const reg = app.getShortcutRegistry() as Array<{
      id: string;
      prefix?: boolean;
      bindings: unknown[];
      group: string;
    }>;
    const byId = Object.fromEntries(reg.map((s) => [s.id, s]));
    expect(byId['pane-prefix'].bindings).toEqual([{ modifiers: ['ctrl'], key: 'b', code: 'KeyB' }]);
    for (const [id, k] of [
      ['pane-split-horizontal', '%'],
      ['pane-split-vertical', '"'],
      ['pane-close', 'x'],
      ['pane-zoom', 'z'],
      ['pane-next', 'o'],
      ['pane-show-numbers', 'q'],
    ]) {
      expect(byId[id].prefix).toBe(true);
      expect(byId[id].group).toBe('Panes');
      expect(byId[id].bindings).toEqual([{ modifiers: [], key: k }]);
    }
  });

  it('is taken in the capture phase and never reaches the terminal, nor does the key after it', () => {
    const app = app4();
    const { p, e } = press(app, '%', { shift: true });
    for (const ev of [p, e]) {
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(ev.stopImmediatePropagation).toHaveBeenCalled();
      // The xterm key handlers (main pane and every tile) refuse it too.
      expect(app._paneKeyConsumed(ev)).toBe(true);
    }
    expect(app._paneKeyConsumed(key('a'))).toBe(false);
  });

  it('twice sends ONE literal prefix through tmux send-keys, never as typed input', () => {
    const app = app4();
    app._sendInputAsync = vi.fn();
    const { taken } = press(app, 'b', { ctrl: true, code: 'KeyB' });
    expect(taken).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/sessions/s-a/send-key');
    expect(JSON.parse(init.body)).toEqual({ key: 'C-b' });
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app._tileGrid?.open ?? false).toBe(false);
  });

  it('held down (auto-repeat), it stays one press: nothing is sent and it still waits', () => {
    const app = app4();
    expect(app.handlePaneKeydown(PREFIX())).toBe(true);
    expect(app.handlePaneKeydown({ ...PREFIX(), repeat: true })).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(app._panePrefixArmed).toBe(true);
  });

  it("Escape cancels it; a key with no binding is swallowed (tmux); the next key is the terminal's again", () => {
    const app = app4();
    expect(press(app, 'Escape').taken).toBe(true);
    expect(app._tileGrid?.open ?? false).toBe(false);
    expect(press(app, 'k').taken).toBe(true);
    expect(app.handlePaneKeydown(key('k'))).toBe(false);
  });

  it('does nothing in a text field, on a narrow window, or when disabled', () => {
    const app = app4();
    expect(app.handlePaneKeydown(key('b', { ctrl: true, code: 'KeyB' }, { tagName: 'INPUT' }))).toBe(false);
    windowStub.innerWidth = 1000;
    expect(app.handlePaneKeydown(PREFIX())).toBe(false);
    windowStub.innerWidth = 2400;
    app.loadAppSettingsFromStorage = () => ({ shortcutOverrides: { 'pane-prefix': { disabled: true } } });
    expect(app.handlePaneKeydown(PREFIX())).toBe(false);
  });

  it('follows a rebind (Ctrl+A), and so does its literal', () => {
    const app = app4();
    app.loadAppSettingsFromStorage = () => ({
      shortcutOverrides: { 'pane-prefix': { bindings: [{ modifiers: ['ctrl'], key: 'a', code: 'KeyA' }] } },
    });
    expect(app.handlePaneKeydown(PREFIX())).toBe(false);
    expect(app.handlePaneKeydown(key('a', { ctrl: true, code: 'KeyA' }))).toBe(true);
    expect(app.handlePaneKeydown(key('a', { ctrl: true, code: 'KeyA' }))).toBe(true);
    expect(JSON.parse((fetchSpy.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({ key: 'C-a' });
  });
});

describe('splitting', () => {
  it('% from the single view opens two panes side by side: the session shown and the next one, focused', () => {
    const app = app4();
    const next = app._tileGridRanking().find((id: string) => id !== 's-a');
    press(app, '%', { shift: true });
    const grid = app._tileGrid;
    expect(grid.open).toBe(true);
    expect(grid.tree).toEqual({ s: 'h', f: 0.5, a: { s: 'p' }, b: { s: 'p' } });
    expect(grid.cells).toEqual(['s-a', next]);
    expect(grid.focusedId).toBe(next);
    expect(app.activeSessionId).toBe(next);
    expect(section.classList.contains('tile-grid--tree')).toBe(true);
    // Placed absolutely, side by side, in the section's padding box (2400 x 1200).
    expect(tileEl('s-a').style.position).toBe('absolute');
    expect(tileEl('s-a').style.left).toBe('4px');
    expect(tileEl(next).style.left).toBe(`${4 + 1193 + 6}px`);
  });

  it('" splits the focused pane top/bottom; the new pane follows it and takes focus', () => {
    const app = app4();
    press(app, '%', { shift: true });
    const [left, right] = app._tileGrid.cells;
    press(app, '"', { shift: true });
    const grid = app._tileGrid;
    expect(grid.cells.slice(0, 2)).toEqual([left, right]);
    expect(grid.cells).toHaveLength(3);
    expect(grid.tree).toEqual({ s: 'h', f: 0.5, a: { s: 'p' }, b: { s: 'v', f: 0.5, a: { s: 'p' }, b: { s: 'p' } } });
    expect(grid.focusedId).toBe(grid.cells[2]);
    // A divider per split.
    expect([...grid.dividers.keys()].sort()).toEqual(['pane-', 'pane-b']);
  });

  it('a split of a count grid turns it into a tree that looks the same first', () => {
    const app = app4();
    app.openTileGrid(['s-a', 's-b', 's-c', 's-d'], { focusedId: 's-a' });
    expect(app._tileGrid.tree).toBeNull();
    // The window is full of tiles already (the cap is 6), so there is room for one more.
    press(app, '%', { shift: true });
    const grid = app._tileGrid;
    expect(grid.tree).not.toBeNull();
    expect(grid.cells.slice(0, 2)).toEqual(['s-a', grid.cells[1]]);
    expect(grid.ids).toHaveLength(5);
  });

  it('says so, and splits nothing, when no other session is left to show', () => {
    const app = makeGridApp(['s-a']);
    app.sessions.delete('s-other');
    app.sessionOrder = ['s-a'];
    press(app, '%', { shift: true });
    expect(app._tileGrid?.open ?? false).toBe(false);
    expect(app.showToast).toHaveBeenCalledWith('No other open session to show in a new pane', 'info');
  });
});

describe('moving, closing, zooming', () => {
  function threePanes(): GridApp {
    const app = app4();
    press(app, '%', { shift: true });
    press(app, '"', { shift: true });
    return app;
  }

  it('arrows move focus by geometry', () => {
    const app = threePanes();
    const [left, topRight, bottomRight] = app._tileGrid.cells;
    expect(app._tileGrid.focusedId).toBe(bottomRight);
    press(app, 'ArrowUp');
    expect(app._tileGrid.focusedId).toBe(topRight);
    press(app, 'ArrowLeft');
    expect(app._tileGrid.focusedId).toBe(left);
    press(app, ';');
    expect(app._tileGrid.focusedId).toBe(topRight);
  });

  it('x closes the focused pane only: the session keeps running, its sibling takes the room', () => {
    const app = threePanes();
    const [left, topRight, bottomRight] = app._tileGrid.cells;
    const tile = FakeTile.all.find((t) => t.sessionId === bottomRight)!;
    press(app, 'x');
    expect(tile.destroy).toHaveBeenCalled();
    expect(app.sessions.has(bottomRight)).toBe(true);
    expect(app._tileGrid.cells).toEqual([left, topRight]);
    expect(app._tileGrid.tree).toEqual({ s: 'h', f: 0.5, a: { s: 'p' }, b: { s: 'p' } });
  });

  it('closing down to one pane is the single view again, the layout forgotten', () => {
    const app = threePanes();
    press(app, 'x');
    const left = app._tileGrid.cells[0];
    press(app, 'x');
    expect(app._tileGrid.open).toBe(false);
    expect(app.selectSession).toHaveBeenLastCalledWith(left, { forceReload: true, auto: true });
    expect(localStore.has('codeman:tile-grid')).toBe(false);
  });

  it('z zooms the focused pane and again restores it', () => {
    const app = threePanes();
    const focused = app._tileGrid.focusedId;
    press(app, 'z');
    expect(app._tileGrid.zoomedId).toBe(focused);
    expect(section.classList.contains('tile-grid--zoomed')).toBe(true);
    expect(tileEl(focused).style.width).toBe('2392px');
    press(app, 'z');
    expect(app._tileGrid.zoomedId).toBeNull();
  });

  it('q shows the numbers and a digit then picks that pane', () => {
    const app = threePanes();
    press(app, 'q');
    expect(tileEl(app._tileGrid.cells[0]).querySelector('.tile-pane-number')).not.toBeNull();
    expect(app.handlePaneKeydown(key('0'))).toBe(true);
    expect(app._tileGrid.focusedId).toBe(app._tileGrid.cells[0]);
    expect(tileEl(app._tileGrid.cells[0]).querySelector('.tile-pane-number')).toBeNull();
  });

  it('{ and } swap the focused pane with its neighbours without remounting anything', () => {
    const app = threePanes();
    const before = app._tileGrid.cells.slice();
    const created = FakeTile.all.length;
    press(app, '{', { shift: true });
    expect(app._tileGrid.cells).toEqual([before[0], before[2], before[1]]);
    expect(FakeTile.all.length).toBe(created);
  });

  it('Ctrl+arrow resizes, and repeats without the prefix for a moment', () => {
    const app = threePanes();
    press(app, 'ArrowLeft');
    const f0 = app._tileGrid.tree.f;
    press(app, 'ArrowRight', { ctrl: true });
    const f1 = app._tileGrid.tree.f;
    expect(f1).toBeGreaterThan(f0);
    // Repeat: the same key again, no prefix.
    expect(app.handlePaneKeydown(key('ArrowRight', { ctrl: true }))).toBe(true);
    expect(app._tileGrid.tree.f).toBeGreaterThan(f1);
    // Alt is five cells at once.
    const f2 = app._tileGrid.tree.f;
    expect(app.handlePaneKeydown(key('ArrowRight', { alt: true }))).toBe(true);
    expect(app._tileGrid.tree.f - f2).toBeCloseTo(5 * (f1 - f0), 5);
    // The window has passed: the key is the terminal's again.
    app._paneRepeatUntil = 1;
    expect(app.handlePaneKeydown(key('ArrowRight', { ctrl: true }))).toBe(false);
  });
});

describe('the rail and persistence', () => {
  it('a session picked in the rail takes the focused pane; the layout stays', () => {
    const app = app4();
    press(app, '%', { shift: true });
    const [left, right] = app._tileGrid.cells;
    const other = IDS.find((id) => id !== left && id !== right)!;
    app.selectSession(other);
    const grid = app._tileGrid;
    expect(grid.open).toBe(true);
    expect(grid.cells).toEqual([left, other]);
    expect(grid.focusedId).toBe(other);
    expect(grid.tree).toEqual({ s: 'h', f: 0.5, a: { s: 'p' }, b: { s: 'p' } });
    expect(FakeTile.all.find((t) => t.sessionId === right)!.destroy).toHaveBeenCalled();
  });

  it('the layout is stored per device, tree and all, and comes back on reload', () => {
    const app = app4();
    press(app, '%', { shift: true });
    press(app, '"', { shift: true });
    const cells = app._tileGrid.cells.slice();
    const stored = JSON.parse(localStore.get('codeman:tile-grid')!);
    expect(stored.open).toBe(true);
    expect(stored.ids).toEqual(cells);
    expect(stored.tree).toEqual(app._tileGrid.tree);

    // A fresh page: the stored grid restores in place of the single view.
    const reloaded = app4();
    expect(reloaded._restoreTileGrid()).toBe(true);
    expect(reloaded._tileGrid.cells).toEqual(cells);
    expect(reloaded._tileGrid.tree).toEqual(stored.tree);
    expect(section.classList.contains('tile-grid--tree')).toBe(true);
  });

  it('a pane whose session is gone by the reload closes, its sibling taking the room', () => {
    const app = app4();
    press(app, '%', { shift: true });
    press(app, '"', { shift: true });
    const [left, , bottomRight] = app._tileGrid.cells;
    const stored = JSON.parse(localStore.get('codeman:tile-grid')!);
    const reloaded = makeGridApp(IDS);
    reloaded.sessions.delete(stored.ids[1]);
    reloaded.sessionOrder = reloaded.sessionOrder.filter((id: string) => id !== stored.ids[1]);
    // Every other session is already shown or would refill: keep the count at what is left.
    localStore.set('codeman:tile-grid', JSON.stringify({ ...stored, count: 2 }));
    expect(reloaded._restoreTileGrid()).toBe(true);
    expect(reloaded._tileGrid.cells).toEqual([left, bottomRight]);
    expect(reloaded._tileGrid.tree).toEqual({ s: 'h', f: 0.5, a: { s: 'p' }, b: { s: 'p' } });
  });

  it('a count picked in the Tiles menu turns the tree back into a count grid', () => {
    const app = app4();
    press(app, '%', { shift: true });
    app._pickTileCount(4);
    expect(app._tileGrid.tree).toBeNull();
    expect(section.classList.contains('tile-grid--tree')).toBe(false);
    expect(tileEl(app._tileGrid.cells[0]).style.position).toBe('');
  });
});

describe('the xterm key handlers refuse a key the pane keys took', () => {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  it('in the main terminal and in every tile, above every other branch but IME', () => {
    for (const [file, needle] of [
      ['terminal-ui.js', 'if (this._paneKeyConsumed?.(ev)) return false;'],
      ['terminal-tile.js', 'if (global.app?._paneKeyConsumed?.(ev)) return false;'],
    ]) {
      const src = read(file);
      const at = src.indexOf(needle);
      expect(at, file).toBeGreaterThan(-1);
      const handler = src.lastIndexOf('attachCustomKeyEventHandler', at);
      const ime = src.indexOf('ev.keyCode === 229) return true;', handler);
      expect(ime).toBeLessThan(at);
      expect(src.indexOf('tileShortcutFor', handler)).toBeGreaterThan(at);
    }
  });

  it('the capture handler asks the pane keys first, after the raw-key and IME guards', () => {
    const src = read('app.js');
    const at = src.indexOf('if (this.handlePaneKeydown?.(e)) return;');
    expect(at).toBeGreaterThan(src.indexOf("if (e.target?.closest?.('[data-raw-keys]')) return;"));
    expect(at).toBeGreaterThan(src.indexOf('if (e.isComposing || e.keyCode === 229) return;'));
    expect(at).toBeLessThan(src.indexOf('if (this.shouldOpenCommandPaletteFromShortcut?.(e)) {'));
  });
});
