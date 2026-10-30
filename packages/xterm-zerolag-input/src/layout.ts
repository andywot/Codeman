/**
 * Where each visual line of the overlay text goes: the column its text starts
 * at, the column its opaque background starts at, and the code-point offset of
 * its first character in the whole text.
 *
 * Pure (no DOM, no terminal), so the wrap rules are tested on their own.
 */

/** One visual line of overlay text. */
export interface LaidOutLine {
  text: string;
  /** Terminal column the first character is drawn at. */
  col: number;
  /**
   * Terminal column the line's opaque background starts at. The first line
   * starts its background where its text starts, so composer text the CLI
   * already drew to the left of it stays visible. A continuation line covers
   * its row from column 0, so nothing the CLI drew in the indent shows through.
   */
  bgCol: number;
  /** Code-point offset of `text` in the whole laid-out text. */
  offset: number;
}

export interface LineLayoutOptions {
  /** Column the first line starts at (the prompt's text column, or the CLI cursor). */
  firstCol: number;
  /** Column every continuation line starts at (a hanging indent; 0 for none). */
  indentCol: number;
  /** Exclusive right edge of the text area: no character is drawn at or past it. */
  rightCol: number;
  /** Break at the last space of a line rather than mid-word, as Ink's composers do. */
  wordWrap: boolean;
  /** Cell width of one character (CJK wide characters are 2). */
  cellWidth: (ch: string) => number;
}

/**
 * Lay `text` out as visual lines.
 *
 * A line break in the text (`\n`, `\r\n` or `\r`) always starts a new line at
 * the indent. A line that runs out of room wraps to a new line at the indent:
 * with `wordWrap`, after its last space (a space that itself overflows is
 * dropped, the way Claude Code's composer drops it), otherwise at the
 * character. A word longer than a whole line is broken at the character.
 *
 * Always returns at least one line (an empty first line for empty text), so a
 * caller can draw the cursor after the last one.
 */
export function layoutLines(text: string, options: LineLayoutOptions): LaidOutLine[] {
  const { firstCol, wordWrap, cellWidth } = options;
  const rightCol = Math.max(1, options.rightCol);
  // A hanging indent past the right edge would leave no room on any line.
  const indentCol = Math.max(0, Math.min(options.indentCol, rightCol - 1));
  const chars = [...text];
  const lines: LaidOutLine[] = [];

  let col = Math.max(0, firstCol);
  let bgCol = col;
  let current: string[] = [];
  let widths: number[] = [];
  let used = 0;
  let offset = 0;

  const push = () => {
    lines.push({ text: current.join(''), col, bgCol, offset });
  };
  const startContinuation = (nextOffset: number) => {
    col = indentCol;
    bgCol = 0;
    current = [];
    widths = [];
    used = 0;
    offset = nextOffset;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\r' || ch === '\n') {
      push();
      // \r\n is one break.
      if (ch === '\r' && chars[i + 1] === '\n') i++;
      startContinuation(i + 1);
      continue;
    }
    const cw = cellWidth(ch);
    if (used + cw <= rightCol - col) {
      current.push(ch);
      widths.push(cw);
      used += cw;
      continue;
    }
    // No room for this character on the current line.
    if (wordWrap && ch === ' ') {
      // The overflowing space is the break itself: drop it.
      push();
      startContinuation(i + 1);
      continue;
    }
    if (current.length === 0 && lines.length === 0 && col > indentCol) {
      // The first line starts too far right for anything (the CLI's cursor sits
      // at the right edge): leave it empty and start at the indent below.
      push();
      startContinuation(i);
      i--;
      continue;
    }
    if (current.length === 0) {
      // A line too narrow for even one character takes it anyway rather than
      // wrapping forever.
      current.push(ch);
      widths.push(cw);
      used += cw;
      continue;
    }
    const lastSpace = wordWrap ? current.lastIndexOf(' ') : -1;
    if (lastSpace >= 0 && lastSpace < current.length - 1) {
      // Move the partial word after the last space down to the next line. It
      // holds no space, so if it still does not fit with this character, the
      // next pass breaks it at the character instead of carrying it again.
      const carried = current.slice(lastSpace + 1);
      const carriedWidths = widths.slice(lastSpace + 1);
      current = current.slice(0, lastSpace + 1);
      widths = widths.slice(0, lastSpace + 1);
      push();
      startContinuation(i - carried.length);
      current = carried;
      widths = carriedWidths;
      used = carriedWidths.reduce((a, b) => a + b, 0);
    } else {
      // A word wider than the line, a line ending in its space, or no word
      // wrap: break before this character.
      push();
      startContinuation(i);
    }
    // Place this character again, on the new line.
    i--;
  }
  push();
  return lines;
}
