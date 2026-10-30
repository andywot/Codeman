import { describe, it, expect } from 'vitest';
import { layoutLines } from '../src/layout.js';
import { charCellWidth } from '../src/overlay-renderer.js';

const cellWidth = (ch: string) => charCellWidth(null, ch);
const lay = (text: string, opts: Partial<Parameters<typeof layoutLines>[1]> = {}) =>
  layoutLines(text, { firstCol: 2, indentCol: 0, rightCol: 20, wordWrap: false, cellWidth, ...opts });

describe('layoutLines', () => {
  it('keeps the historical layout by default: first line at the prompt, the rest at column 0', () => {
    const lines = lay('x'.repeat(40));
    expect(lines.map((l) => [l.text.length, l.col, l.bgCol, l.offset])).toEqual([
      [18, 2, 2, 0],
      [20, 0, 0, 18],
      [2, 0, 0, 38],
    ]);
  });

  it('returns one empty line for empty text, so the cursor has a place', () => {
    expect(lay('')).toEqual([{ text: '', col: 2, bgCol: 2, offset: 0 }]);
  });

  it('hangs continuation lines at the indent, with their background from column 0', () => {
    const lines = lay('x'.repeat(30), { indentCol: 2 });
    expect(lines.map((l) => [l.text.length, l.col, l.bgCol])).toEqual([
      [18, 2, 2],
      [12, 2, 0],
    ]);
  });

  // Claude Code 2.1.314 at 80 columns: `❯ ` + 76 text columns, wrapped at the
  // last space, the breaking space dropped, continuation lines indented 2.
  it('wraps like Claude Code: word wrap at cols - 2 with a 2-column hanging indent', () => {
    const text = 'first part of a longer prompt that should wrap across the eighty column pane width for sure ok';
    const lines = lay(text, { firstCol: 2, indentCol: 2, rightCol: 78, wordWrap: true });
    expect(lines.map((l) => l.text)).toEqual([
      'first part of a longer prompt that should wrap across the eighty column pane',
      'width for sure ok',
    ]);
    expect(lines[1].offset).toBe(text.indexOf('width'));
  });

  it('moves a partial word down to the next line', () => {
    const lines = lay('aaa bbbbbb', { firstCol: 0, rightCol: 8, wordWrap: true });
    expect(lines.map((l) => l.text)).toEqual(['aaa ', 'bbbbbb']);
    expect(lines[1].offset).toBe(4);
  });

  it('breaks a word wider than a line at the character', () => {
    const lines = lay('a ' + 'b'.repeat(20), { firstCol: 0, rightCol: 8, wordWrap: true });
    expect(lines.map((l) => l.text)).toEqual(['a ', 'bbbbbbbb', 'bbbbbbbb', 'bbbb']);
  });

  it('starts a new line at the indent for every line break', () => {
    const lines = lay('one\ntwo\r\nthree\r', { indentCol: 2 });
    expect(lines.map((l) => [l.text, l.col, l.offset])).toEqual([
      ['one', 2, 0],
      ['two', 2, 4],
      ['three', 2, 9],
      ['', 2, 15],
    ]);
  });

  it('leaves the first line empty when it starts at the right edge (cursor at the wrap column)', () => {
    const lines = lay('abc', { firstCol: 20, indentCol: 2 });
    expect(lines.map((l) => [l.text, l.col])).toEqual([
      ['', 20],
      ['abc', 2],
    ]);
  });

  it('counts CJK characters as two cells', () => {
    const lines = lay('中文中文中文', { firstCol: 0, rightCol: 5 });
    expect(lines.map((l) => l.text)).toEqual(['中文', '中文', '中文']);
  });
});
