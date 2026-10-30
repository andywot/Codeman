/**
 * @fileoverview The composer glyph a SESSION's pane draws, resolved in one place, and the
 * row test every screen reader of it shares.
 *
 * `capabilities.workDetect.promptGlyph` names the glyph a CLI draws on its composer row
 * (Claude's `❯`). One CLI can draw a second one depending on where it runs: Claude Code on
 * native Windows takes its glyphs from the `figures` package, whose Windows fallback set
 * (used whenever its `isUnicodeSupported()` says no, which is the case over ssh without
 * `WT_SESSION`) draws `pointer` as an ASCII `>`. Read from the 2.1.314 bundle
 * (`pointer:"❯"` in the main set, `pointer:">"` in the fallback) and a live Windows
 * pane on 2026-10-30. A session whose composer glyph the detectors cannot see is never
 * armed for idle and reads its idle screen as unknown, which is exactly how such sessions
 * stayed "busy" forever.
 *
 * That fallback glyph is declared as data (`workDetect.windowsPromptGlyph`) and applies
 * only to a session whose remote system is native Windows. The primary glyph still
 * applies there too (a Windows terminal that reports unicode support draws `❯`).
 *
 * ⚠️ `>` is far more common than `❯`. Claude's transcript echoes each submitted prompt
 * with the composer glyph, quoted text starts with `> `, and tool output can print
 * anything. So the fallback glyph counts ONLY on a row that starts in column 0 directly
 * under a column-0 horizontal rule: Claude draws its composer between two full-width
 * `────` rules at column 0, while its transcript body is indented two columns, so no
 * transcript row (quote, prompt echo or tool output) ever sits directly under one. The
 * primary glyph keeps its historical, unanchored test, so a non-Windows session reads
 * exactly as before.
 *
 * Pure: no IO, no registry lookups. `Session.composerGlyph()` resolves it per session.
 */

/** The `workDetect` fields this module reads. */
export interface ComposerGlyphSource {
  promptGlyph?: string;
  windowsPromptGlyph?: string;
}

/** The composer glyph(s) one session's pane draws. */
export interface ComposerGlyph {
  /** The CLI's own glyph, tested as every consumer always has. `''` when none is known. */
  glyph: string;
  /**
   * A second glyph this session's CLI may draw instead (native Windows' ASCII fallback),
   * honoured only on a column-0 row directly under a column-0 horizontal rule.
   */
  ruledGlyph?: string;
}

/** Accept a bare glyph string (the historical signature) or a resolved `ComposerGlyph`. */
export function asComposerGlyph(g: string | ComposerGlyph): ComposerGlyph {
  return typeof g === 'string' ? { glyph: g } : g;
}

/**
 * Every escape sequence, private-parameter CSI included (`ESC[>4;2m`, `ESC[>c`, which
 * `stripAnsi` leaves behind), OSC strings and two-byte escapes.
 */
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[\x20-\x7e]/g;

/** A column-0 horizontal rule: the edge Claude draws above and below its composer. */
const RULE_ROW = /^─{8,}/;

/**
 * Resolve the glyph(s) a session draws.
 *
 * @param detect the CLI's `capabilities.workDetect` (undefined when it declares none)
 * @param remoteSystem the session's `remote.system` (`'windows'` for native Windows claude)
 * @param fallback the glyph a consumer assumes when the CLI declares none
 *   (`'❯'` for the idle arm, `''` for readers that must say nothing)
 */
export function resolveComposerGlyph(
  detect: ComposerGlyphSource | undefined,
  remoteSystem: string | undefined,
  fallback: string
): ComposerGlyph {
  const glyph = detect?.promptGlyph ?? fallback;
  const alt = remoteSystem === 'windows' ? detect?.windowsPromptGlyph : undefined;
  return alt && alt !== glyph ? { glyph, ruledGlyph: alt } : { glyph };
}

/**
 * Whether a raw PTY chunk may carry a composer redraw: the trigger that ARMS the idle
 * confirmation, never evidence of idle on its own. The primary glyph is tested on the
 * raw chunk as it always was; the fallback glyph only once the chunk's escape sequences
 * are gone (`ESC[>…` sequences carry a `>`), and only when the raw chunk has one at all,
 * so the strip runs on nothing but chunks that might match. Arming is bounded the way it
 * always was: one confirmation outstanding at a time, and the screen read it ends in is
 * floored per session (`PANE_PROBE_MIN_INTERVAL_MS`).
 */
export function chunkMayShowComposer(data: string, g: ComposerGlyph): boolean {
  if (g.glyph && data.includes(g.glyph)) return true;
  return !!g.ruledGlyph && data.includes(g.ruledGlyph) && data.replace(ESCAPE_SEQUENCE, '').includes(g.ruledGlyph);
}

/**
 * The glyph that opens `rows[i]` as a composer row, or null.
 *
 * @param rows the pane's rows, escapes removed and at most trailing whitespace trimmed
 * @param strip how this consumer reads the PRIMARY glyph's row (indentation, box edge),
 *   kept exactly as that consumer always did
 */
export function composerGlyphOfRow(
  rows: readonly string[],
  i: number,
  g: ComposerGlyph,
  strip: (row: string) => string = (row) => row
): string | null {
  const row = rows[i];
  if (row === undefined) return null;
  if (g.glyph && strip(row).startsWith(g.glyph)) return g.glyph;
  if (g.ruledGlyph && row.startsWith(g.ruledGlyph) && i > 0 && RULE_ROW.test(rows[i - 1])) return g.ruledGlyph;
  return null;
}

/** The LAST composer row (see `composerGlyphOfRow`) and the glyph it opens with, or null. */
export function lastComposerRow(
  rows: readonly string[],
  g: ComposerGlyph,
  strip?: (row: string) => string
): { index: number; glyph: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const glyph = composerGlyphOfRow(rows, i, g, strip);
    if (glyph !== null) return { index: i, glyph };
  }
  return null;
}

/**
 * Whether `row` is a dialog's selected, numbered option drawn with the fallback glyph
 * (`> 1. Yes` on native Windows; `❯ 1. Yes` elsewhere, which the primary glyph already
 * covers). Used only to RECOGNIZE a screen for detection health, where a forged match
 * costs nothing but a missed "unknown" hint.
 */
export function isFallbackOptionRow(row: string, g: ComposerGlyph): boolean {
  if (!g.ruledGlyph) return false;
  const body = row.replace(/^[\s│]+/, '');
  return body.startsWith(`${g.ruledGlyph} `) && /^\d+\.\s/.test(body.slice(g.ruledGlyph.length + 1));
}
