/**
 * @fileoverview The tile grid's tmux-style layout, its pure half
 * (window.CodemanPaneTree, constants.js): splitting and closing panes,
 * geometry, focus by direction, resizing, and what a stored tree may be.
 *
 * Real code: constants.js loaded in a `vm` context. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Node = { s: 'p' } | { s: 'h' | 'v'; f: number; a: Node; b: Node };
type Rect = { x: number; y: number; w: number; h: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Helpers = Record<string, any>;

const win: Record<string, unknown> = {};
vm.runInNewContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8'), {
  window: win,
  console,
});
const P = win.CodemanPaneTree as Helpers;
const T = win.CodemanTileGrid as Helpers;
const leaf = (): Node => ({ s: 'p' });
const BOX: Rect = { x: 0, y: 0, w: 1206, h: 806 };

describe('splitting and closing', () => {
  it('splits a pane in two halves, the new pane right of or below the old one', () => {
    const h = P.splitPaneTree(leaf(), 0, 'h');
    expect(h).toEqual({ s: 'h', f: 0.5, a: leaf(), b: leaf() });
    // Split the right half top/bottom: three panes, the new one third in order.
    const t = P.splitPaneTree(h, 1, 'v');
    expect(P.paneTreeLeafCount(t)).toBe(3);
    expect(t).toEqual({ s: 'h', f: 0.5, a: leaf(), b: { s: 'v', f: 0.5, a: leaf(), b: leaf() } });
    // The original is never changed.
    expect(h).toEqual({ s: 'h', f: 0.5, a: leaf(), b: leaf() });
  });

  it('closing a pane gives its room to its sibling, and the last pane leaves nothing', () => {
    const t = P.splitPaneTree(P.splitPaneTree(leaf(), 0, 'h'), 1, 'v');
    expect(P.removePaneLeaf(t, 0)).toEqual({ s: 'v', f: 0.5, a: leaf(), b: leaf() });
    expect(P.removePaneLeaf(t, 1)).toEqual({ s: 'h', f: 0.5, a: leaf(), b: leaf() });
    expect(P.removePaneLeaf(t, 2)).toEqual({ s: 'h', f: 0.5, a: leaf(), b: leaf() });
    expect(P.removePaneLeaf(leaf(), 0)).toBeNull();
    // An index past the panes changes nothing.
    expect(P.removePaneLeaf(t, 7)).toEqual(t);
  });

  it('a count grid becomes a tree that looks the same: its rows, then each row of tiles', () => {
    const tree = P.paneTreeFromGrid(['a', 'b', 'c', 'd', null, 'f'], 3, [1, 2, 1], [1, 3]);
    expect(P.paneTreeLeafCount(tree)).toBe(5);
    expect(tree.s).toBe('v');
    expect(tree.f).toBeCloseTo(0.25);
    // Top row: three tiles with the column fractions.
    expect(tree.a.s).toBe('h');
    expect(tree.a.f).toBeCloseTo(0.25);
    // Bottom row: the hole is dropped, its two tiles side by side.
    expect(tree.b).toEqual({ s: 'h', f: 0.5, a: leaf(), b: leaf() });
  });
});

describe('geometry', () => {
  it('places every pane and divider, with the divider gap between halves', () => {
    const t = P.splitPaneTree(P.splitPaneTree(leaf(), 0, 'h'), 1, 'v');
    const { panes, splits } = P.paneTreeRects(t, BOX, 6);
    expect(panes).toEqual([
      { x: 0, y: 0, w: 600, h: 806 },
      { x: 606, y: 0, w: 600, h: 400 },
      { x: 606, y: 406, w: 600, h: 400 },
    ]);
    expect(splits.map((s: { path: string; s: string }) => [s.path, s.s])).toEqual([
      ['', 'h'],
      ['b', 'v'],
    ]);
    expect(splits[0].divider).toEqual({ x: 600, y: 0, w: 6, h: 806 });
    expect(P.paneTreeFits(panes)).toBe(true);
    expect(P.paneTreeFits([{ x: 0, y: 0, w: P.PANE_MIN_W - 1, h: 500 }])).toBe(true);
    expect(P.paneTreeFits([{ x: 0, y: 0, w: P.PANE_MIN_W - 3, h: 500 }])).toBe(false);
  });

  it('moves focus by geometry, to the nearest pane overlapping on that side, never wrapping', () => {
    const t = P.splitPaneTree(P.splitPaneTree(leaf(), 0, 'h'), 1, 'v');
    const { panes } = P.paneTreeRects(t, BOX, 6);
    expect(P.paneInDirection(panes, 0, 'right')).toBe(1);
    expect(P.paneInDirection(panes, 2, 'left')).toBe(0);
    expect(P.paneInDirection(panes, 1, 'down')).toBe(2);
    expect(P.paneInDirection(panes, 2, 'up')).toBe(1);
    expect(P.paneInDirection(panes, 0, 'left')).toBe(-1);
    expect(P.paneInDirection(panes, 0, 'up')).toBe(-1);
  });

  it('splits a wide pane side by side and a tall or square one top/bottom when nobody said', () => {
    expect(P.paneSplitDirectionFor({ x: 0, y: 0, w: 1200, h: 600 })).toBe('h');
    expect(P.paneSplitDirectionFor({ x: 0, y: 0, w: 600, h: 600 })).toBe('v');
  });
});

describe('resizing', () => {
  const t = P.splitPaneTree(P.splitPaneTree(leaf(), 0, 'h'), 1, 'v');

  it('moves the nearest split on that axis, either way, from either side of it', () => {
    const left = P.resizePaneTree(t, 0, 'right', 100, BOX, 6);
    expect(left.path).toBe('');
    expect(left.tree.f).toBeCloseTo(0.5 + 100 / 1200);
    // From the right-hand side the same split moves the same way.
    expect(P.resizePaneTree(t, 2, 'left', 120, BOX, 6).tree.f).toBeCloseTo(0.4);
    // Up/down on the right column moves its own split, not the root.
    const down = P.resizePaneTree(t, 1, 'down', 80, BOX, 6);
    expect(down.path).toBe('b');
    expect(P.paneTreeAt(down.tree, 'b').f).toBeCloseTo(0.5 + 80 / 800);
    // The left pane has no top/bottom split above it: nothing to resize.
    expect(P.resizePaneTree(t, 0, 'up', 50, BOX, 6)).toBeNull();
  });

  it('never takes a side below its minimum size, so a resize at the limit never zooms', () => {
    for (const [i, dir] of [
      [0, 'left'],
      [0, 'right'],
      [1, 'down'],
      [2, 'up'],
    ] as const) {
      const out = P.resizePaneTree(t, i, dir, 5000, BOX, 6);
      const { panes } = P.paneTreeRects(out.tree, BOX, 6);
      expect(P.paneTreeFits(panes), `${i} ${dir}`).toBe(true);
    }
  });

  it('a divider drag is clamped to what both subtrees need', () => {
    // The right side holds two panes side by side: it needs two minimums and a divider.
    const wide = P.splitPaneTree(P.splitPaneTree(leaf(), 0, 'h'), 1, 'h');
    const f = P.clampPaneFraction(wide, 0.95, 1200, 6);
    expect(f).toBeCloseTo(1 - (2 * P.PANE_MIN_W + 6) / 1200);
  });

  it('names the leaves under a split', () => {
    expect(P.paneLeafRange(t, '')).toEqual([0, 2]);
    expect(P.paneLeafRange(t, 'b')).toEqual([1, 2]);
    expect(P.paneLeafRange(t, 'a')).toEqual([0, 0]);
    expect(P.paneLeafPath(t, 2)).toBe('bb');
  });
});

describe('a stored tree', () => {
  it('keeps only leaves and h/v splits, with fractions clamped', () => {
    expect(P.sanitizePaneTree({ s: 'h', f: 7, a: { s: 'p' }, b: { s: 'p', extra: 1 } })).toEqual({
      s: 'h',
      f: 0.95,
      a: leaf(),
      b: leaf(),
    });
    expect(P.sanitizePaneTree({ s: 'x', a: leaf(), b: leaf() })).toBeNull();
    expect(P.sanitizePaneTree({ s: 'h', f: 0.5, a: leaf() })).toBeNull();
    expect(P.sanitizePaneTree('{"s":"p"}')).toBeNull();
    let deep: Node = leaf();
    for (let i = 0; i < 12; i++) deep = { s: 'h', f: 0.5, a: deep, b: leaf() };
    expect(P.sanitizePaneTree(deep)).toBeNull();
  });

  it('comes back with the grid only when its leaves match the stored cells', () => {
    const live = new Set(['a', 'b', 'c']);
    const tree = P.splitPaneTree(P.splitPaneTree(leaf(), 0, 'h'), 1, 'v');
    const ok = T.sanitizeTileGridState({ v: 1, open: true, ids: ['a', 'b', 'c'], tree }, live);
    expect(ok.tree).toEqual(tree);
    // A session gone since still has its leaf (its cell is null), so the tree stays.
    const gone = T.sanitizeTileGridState({ v: 1, open: true, ids: ['a', 'x', 'c'], tree }, live);
    expect(gone.cells).toEqual(['a', null, 'c']);
    expect(gone.tree).toEqual(tree);
    const mismatch = T.sanitizeTileGridState({ v: 1, open: true, ids: ['a', 'b'], tree }, live);
    expect(mismatch).not.toHaveProperty('tree');
    // No tree stored: no key at all, exactly as before.
    expect(T.sanitizeTileGridState({ v: 1, open: true, ids: ['a'] }, live)).not.toHaveProperty('tree');
  });
});
