/**
 * The overlay against a Claude Code style `❯ ` composer: hanging indent, right
 * margin, word wrap, and following the CLI's cursor when the composer already
 * holds text the overlay never saw.
 *
 * The bug this pins (fork report, 2026-10-30): with local echo on (the default
 * for remote sessions), typing after a paste or an image path drew the new text
 * from the `❯` OVER the composer's first row, and the CLI's own cursor showed as
 * a second block at the real end of the composer text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createMockTerminal } from './helpers.js';
import { ZerolagInputAddon } from '../src/zerolag-input-addon.js';
import type { ComposerLayout } from '../src/types.js';

const CLAUDE_LAYOUT: ComposerLayout = {
  continuationIndent: 'prompt',
  rightMargin: 2,
  wordWrap: true,
  followCursor: true,
};
const CELL_W = 10;
const CELL_H = 20;

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

/** A 40x12 screen with the composer's `❯` on row 8, a border below it on row
 *  9 + composer rows, and the cursor where the CLI put it. */
function claudeScreen(composer: string[], cursor: { x: number; y: number }, layout: ComposerLayout = CLAUDE_LAYOUT) {
  const lines = Array.from({ length: 12 }, () => '');
  lines[7] = '─'.repeat(40);
  composer.forEach((row, i) => (lines[8 + i] = row));
  lines[8 + composer.length] = '─'.repeat(40);
  lines[9 + composer.length] = '  footer status';
  const mock = createMockTerminal({
    buffer: { lines, cursorX: cursor.x, cursorY: cursor.y },
    cols: 40,
    rows: 12,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
  });
  const addon = new ZerolagInputAddon({ prompt: { type: 'character', char: '❯', offset: 2 }, layout });
  mock.terminal.loadAddon(addon);
  cleanups.push(() => {
    addon.dispose();
    mock.cleanup();
  });
  const overlay = () => mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
  const lineEls = () => [...overlay().children].filter((el) => el.tagName === 'DIV') as HTMLDivElement[];
  const cursorEl = () => [...overlay().children].find((el) => el.tagName === 'SPAN') as HTMLSpanElement | undefined;
  /** [row, textCol, text] of each drawn line, from the DOM. */
  const drawn = () => {
    const top = parseFloat(overlay().style.top) / CELL_H;
    return lineEls().map((el) => {
      const spans = [...el.children] as HTMLSpanElement[];
      const spacer = spans[0] && spans[0].textContent === '' ? parseFloat(spans[0].style.width) / CELL_W : 0;
      return [top + parseFloat(el.style.top) / CELL_H, parseFloat(el.style.left) / CELL_W + spacer, el.textContent];
    });
  };
  const cursorAt = () => {
    const c = cursorEl();
    if (!c) return null;
    const top = parseFloat(overlay().style.top) / CELL_H;
    return [top + parseFloat(c.style.top) / CELL_H, parseFloat(c.style.left) / CELL_W];
  };
  return { addon, mock, overlay, drawn, cursorAt };
}

describe('Claude-style composer layout', () => {
  it('draws typed text from the prompt when the composer is empty', () => {
    const { addon, drawn, cursorAt } = claudeScreen(['❯ '], { x: 2, y: 8 });
    addon.appendText('hello');
    expect(drawn()).toEqual([[8, 2, 'hello']]);
    expect(cursorAt()).toEqual([8, 7]);
  });

  it('hangs wrapped lines at the prompt column and wraps two columns short of the edge', () => {
    const { addon, drawn, cursorAt } = claudeScreen(['❯ '], { x: 2, y: 8 });
    // 36 text columns per line (40 - 2 indent - 2 margin).
    addon.appendText('aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii');
    expect(drawn()).toEqual([
      [8, 2, 'aaaa bbbb cccc dddd eeee ffff gggg '],
      [9, 2, 'hhhh iiii'],
    ]);
    expect(cursorAt()).toEqual([9, 11]);
  });

  it('continues after composer text it never saw, at the CLI cursor (one cursor, nothing covered)', () => {
    // A paste flushed earlier: the CLI drew it over two rows and left its cursor
    // after it. The overlay must draw only what is typed now, from that cursor.
    const { addon, drawn, cursorAt } = claudeScreen(['❯ pasted line one', '  pasted line two'], { x: 17, y: 9 });
    addon.appendText(' then more');
    expect(drawn()).toEqual([[9, 17, ' then more']]);
    expect(cursorAt()).toEqual([9, 27]);
  });

  it('wraps text that continues at the cursor onto hanging continuation lines', () => {
    const { addon, drawn } = claudeScreen(['❯ some text already there'], { x: 26, y: 8 });
    addon.appendText(' and then quite a lot more');
    expect(drawn()).toEqual([
      [8, 26, ' and then '],
      [9, 2, 'quite a lot more'],
    ]);
  });

  it('draws nothing for text the CLI already shows (flushed, then echoed)', () => {
    const { addon, overlay } = claudeScreen(['❯ restored text'], { x: 15, y: 8 });
    addon.setFlushed(13, 'restored text');
    expect(overlay().style.display).toBe('none');
    addon.addChar('!');
    expect(overlay().style.display).toBe('');
  });

  it('still covers flushed text from the prompt while the CLI has not echoed it (cursor at the prompt)', () => {
    const { addon, drawn } = claudeScreen(['❯ '], { x: 2, y: 8 });
    addon.setFlushed(4, 'sent');
    addon.addChar('x');
    expect(drawn()).toEqual([[8, 2, 'sentx']]);
  });

  it('ignores a cursor parked below the composer border', () => {
    // Cursor on the footer row: the border row between it and the prompt is not
    // a continuation row, so the overlay stays at the prompt.
    const { addon, drawn } = claudeScreen(['❯ '], { x: 6, y: 10 });
    addon.appendText('typed');
    expect(drawn()).toEqual([[8, 2, 'typed']]);
  });

  it('follows the cursor to an empty continuation line (after Shift+Enter)', () => {
    const { addon, drawn } = claudeScreen(['❯ first line', '  '], { x: 2, y: 9 });
    addon.appendText('second');
    expect(drawn()).toEqual([[9, 2, 'second']]);
  });

  it('keeps the old behaviour without followCursor (the reported bug)', () => {
    // Buffer detection adopts the prompt ROW only ("pasted") and the typed text
    // is drawn after it from the ❯, over the composer's first row, while the CLI
    // cursor stays at the end of "more": two cursors, text in the wrong place.
    const { addon, drawn } = claudeScreen(['❯ pasted', '  more'], { x: 6, y: 9 }, { continuationIndent: 'prompt' });
    addon.appendText('typed');
    expect(drawn()).toEqual([[8, 2, 'pastedtyped']]);
  });

  it('setLayout switches layouts at runtime', () => {
    const { addon, drawn } = claudeScreen(['❯ '], { x: 2, y: 8 }, {});
    addon.appendText('x'.repeat(45));
    expect(drawn().map((l) => l[1])).toEqual([2, 0]);
    addon.setLayout(CLAUDE_LAYOUT);
    expect(drawn().map((l) => l[1])).toEqual([2, 2]);
    expect(addon.layout).toEqual(CLAUDE_LAYOUT);
  });
});

describe('atomic tokens', () => {
  it('draws the label, sends the value', () => {
    const { addon, drawn } = claudeScreen(['❯ '], { x: 2, y: 8 });
    addon.appendText('look at ');
    addon.appendToken('[Image #1]', '/case/.codeman-uploads/paste-1.png');
    addon.appendText(' please');
    expect(drawn()).toEqual([[8, 2, 'look at [Image #1] please']]);
    expect(addon.pendingText).toBe('look at /case/.codeman-uploads/paste-1.png please');
    expect(addon.pendingDisplayText).toBe('look at [Image #1] please');
    expect(addon.pendingTokens).toEqual([{ label: '[Image #1]', value: '/case/.codeman-uploads/paste-1.png' }]);
    expect(addon.state.pendingText).toBe(addon.pendingText);
    expect(addon.state.pendingDisplayText).toBe('look at [Image #1] please');
  });

  it('Backspace removes a token whole, then plain characters one by one', () => {
    const { addon } = claudeScreen(['❯ '], { x: 2, y: 8 });
    addon.appendText('a ');
    addon.appendToken('[Image #1]', '/p/one.png');
    expect(addon.removeChar()).toBe('pending');
    expect(addon.pendingDisplayText).toBe('a ');
    expect(addon.pendingTokens).toEqual([]);
    expect(addon.removeChar()).toBe('pending');
    expect(addon.pendingText).toBe('a');
  });

  it('a character typed after a token is removed before the token', () => {
    const { addon } = claudeScreen(['❯ '], { x: 2, y: 8 });
    addon.appendToken('[Image #1]', '/p/one.png');
    addon.addChar(' ');
    addon.removeChar();
    expect(addon.pendingText).toBe('/p/one.png');
    addon.removeChar();
    expect(addon.pendingText).toBe('');
  });

  it('clear() drops tokens', () => {
    const { addon } = claudeScreen(['❯ '], { x: 2, y: 8 });
    addon.appendToken('[Image #1]', '/p/one.png');
    addon.clear();
    expect(addon.pendingTokens).toEqual([]);
    expect(addon.pendingText).toBe('');
  });

  it('removes an emoji as one character', () => {
    const { addon } = claudeScreen(['❯ '], { x: 2, y: 8 });
    addon.appendText('ok👍');
    addon.removeChar();
    expect(addon.pendingText).toBe('ok');
  });
});
