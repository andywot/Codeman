/**
 * @fileoverview Whether the screen-read working/idle detection still understands the pane.
 *
 * Codeman tells a working Claude session from an idle one by reading the CLI's own
 * screen: the composer glyph (`❯`) arms the idle check and the working line
 * (`✻ Cultivating… (7s · ↓ 281 tokens)` or the `esc to interrupt` footer) vetoes it
 * (`capabilities.workDetect`, `session-activity.ts`). Claude Code updates itself, and a
 * release that redraws either of those leaves the detectors matching nothing. The two
 * ways that goes wrong are both CONFIDENT wrong answers:
 *
 * 1. **No composer glyph and no working line on screen.** Nothing arms the idle check,
 *    so a session that was working stays "working" forever after its turn ends.
 * 2. **Sustained repaints the screen never confirms.** A working pane repaints about
 *    once a second, which is the trigger to look; a working line the pattern no longer
 *    recognizes vetoes it every time, so a session in the middle of a long turn shows
 *    "idle" the whole way through.
 *
 * This module turns both into a neutral "unknown" instead. It never decides working or
 * idle itself and never touches `status`: it only says, after a sustained run of evidence
 * (`UNRECOGNIZED_SCREEN_MS`, `UNVERIFIED_STREAK_MS`), that the detectors can no longer
 * read this pane, and the dashboard shows that rather than the stale verdict. Hooks
 * (`permission_prompt`, `idle_prompt`) are not screen reads and keep their priority.
 *
 * The same file holds the one version comparison behind the "detection untested on this
 * Claude Code version" hint (`isNewerThanTested`), fed by
 * `capabilities.workDetect.testedThroughVersion`.
 *
 * Pure: no IO, no timers. Tests: `test/claude-screen-detectors.test.ts`.
 *
 * @module session-detection-health
 */

import { stripAnsi } from './utils/regex-patterns.js';
import { asComposerGlyph, composerGlyphOfRow, isFallbackOptionRow, type ComposerGlyph } from './composer-glyph.js';

/**
 * How long a pane may show NONE of the known chrome (composer glyph, working line,
 * awaited-workers row, blocked dialog) before the session is reported as unknown.
 * Long enough that a full-screen view the user opened on purpose (`/config`, a pager)
 * is not flagged on sight, short enough that a stuck "working" is corrected within a
 * minute of the turn ending.
 */
export const UNRECOGNIZED_SCREEN_MS = 45_000;

/**
 * How long an unbroken run of repaints may go without the screen showing a working
 * line before the session is reported as unknown. A user typing into the composer also
 * repaints the pane, which is why this is far longer than any typing burst and why
 * human keystrokes reset the clock (see `Session._noteVetoedStreak`).
 */
export const UNVERIFIED_STREAK_MS = 45_000;

/**
 * How often a session that is `busy` and quiet re-reads its screen when nothing else
 * would. Without this a pane whose composer glyph changed is never looked at again
 * after its turn ends (the glyph is what arms every other read).
 */
export const DETECTION_WATCH_MS = 15_000;

/**
 * How many non-blank rows at the foot of the screen may hold the composer glyph. The
 * composer sits above one rule and a footer or two; a dialog's selected option (`❯ 1.
 * Red`, then descriptions, a separator and the key-hint row) sits about ten rows up.
 * Bounded so the user's own earlier prompts, echoed in the transcript as `❯ …`, do not
 * keep a broken composer looking recognized.
 */
export const COMPOSER_SEARCH_ROWS = 14;

/** Why the detectors gave up on a pane. */
export type DetectionUnknownReason = 'unrecognized-screen' | 'unverified-activity';

/** Running record for one session. Starts as `initialDetectionHealth()`. */
export interface DetectionHealth {
  /** First capture in the current run of unrecognized captures; null when the last one was recognized. */
  unrecognizedSince: number | null;
  /** When the current run of repaints the screen keeps vetoing began; null when none is running. */
  vetoedStreakSince: number | null;
  /** Set once either run lasts long enough; null while detection is trusted. */
  unknown: DetectionUnknownReason | null;
}

export function initialDetectionHealth(): DetectionHealth {
  return { unrecognizedSince: null, vetoedStreakSince: null, unknown: null };
}

/** What a capture showed, as far as the CLI's declared chrome goes. */
export interface ScreenChrome {
  /**
   * The session's composer glyph: the CLI's `capabilities.workDetect.promptGlyph`, or the
   * per-session resolution (`Session.composerGlyph()`, which adds native Windows' `>`).
   */
  promptGlyph: string | ComposerGlyph;
  /** Its working-line pattern matched the capture. */
  working: boolean;
  /** Its awaited-workers row is the newest row above the composer. */
  awaitingWorkers?: boolean;
  /** A dialog it blocks on is on screen (codex's screen-read dialogs). */
  blocked?: boolean;
  /** Claude's workspace-trust dialog is on screen. */
  trustDialog?: boolean;
}

/**
 * Whether a pane capture shows any chrome the detectors know how to read.
 *
 * The composer glyph counts only at the start of a row (after indentation or a box
 * edge) among the last `COMPOSER_SEARCH_ROWS` non-blank rows, where Claude draws both its
 * composer and the selected option of a permission or question dialog.
 */
export function isScreenRecognized(paneText: string, chrome: ScreenChrome): boolean {
  if (chrome.working || chrome.awaitingWorkers || chrome.blocked || chrome.trustDialog) return true;
  const glyph = asComposerGlyph(chrome.promptGlyph);
  if (!glyph.glyph && !glyph.ruledGlyph) return false;
  const rows = stripAnsi(paneText)
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row !== '')
    .slice(-COMPOSER_SEARCH_ROWS);
  const strip = (row: string) => row.replace(/^[\s│]+/, '');
  // Native Windows' `>` counts only as the composer (under its top rule) or as a dialog's
  // numbered, selected option; a transcript quote or prompt echo alone never does.
  return rows.some((row, i) => composerGlyphOfRow(rows, i, glyph, strip) !== null || isFallbackOptionRow(row, glyph));
}

/**
 * Fold one capture's verdict in. A recognized capture ends the unrecognized run and
 * clears an `unrecognized-screen` unknown; an unrecognized one starts or extends it.
 */
export function noteScreenReading(health: DetectionHealth, recognized: boolean, now: number): DetectionHealth {
  if (recognized) {
    if (health.unrecognizedSince === null && health.unknown !== 'unrecognized-screen') return health;
    return {
      ...health,
      unrecognizedSince: null,
      unknown: health.unknown === 'unrecognized-screen' ? null : health.unknown,
    };
  }
  const since = health.unrecognizedSince ?? now;
  const unknown = health.unknown ?? (now - since >= UNRECOGNIZED_SCREEN_MS ? 'unrecognized-screen' : null);
  if (since === health.unrecognizedSince && unknown === health.unknown) return health;
  return { ...health, unrecognizedSince: since, unknown };
}

/**
 * Fold in a run of repaints the screen did NOT confirm as work. `streakStartedAt` is
 * when the current unbroken run began (`ActivityStreak.startedAt`); the run is
 * unverified for as long as every read during it says "no working line".
 */
export function noteVetoedStreak(health: DetectionHealth, streakStartedAt: number, now: number): DetectionHealth {
  // A new run (or the first veto of this one) restarts the clock from the run's own start.
  const since =
    health.vetoedStreakSince !== null && health.vetoedStreakSince >= streakStartedAt
      ? health.vetoedStreakSince
      : streakStartedAt;
  const unknown = health.unknown ?? (now - since >= UNVERIFIED_STREAK_MS ? 'unverified-activity' : null);
  if (since === health.vetoedStreakSince && unknown === health.unknown) return health;
  return { ...health, vetoedStreakSince: since, unknown };
}

/**
 * The screen positively confirmed the session's state: a working line was read, or the
 * pane settled idle at its composer through the ordinary path. Every run and every
 * unknown ends here.
 */
export function noteStateConfirmed(health: DetectionHealth): DetectionHealth {
  if (health.unrecognizedSince === null && health.vetoedStreakSince === null && health.unknown === null) return health;
  return initialDetectionHealth();
}

/** Strict `MAJOR.MINOR.PATCH`, the only shape a CLI version is compared in. */
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** A version string fit to publish and compare, or undefined. */
export function sanitizeCliVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return SEMVER.test(trimmed) ? trimmed : undefined;
}

/**
 * True when `version` is newer than `testedThrough`, the newest CLI version the screen
 * detectors were checked against. Anything unparseable is not "newer": the hint only
 * ever appears on evidence.
 */
export function isNewerThanTested(version: string | undefined | null, testedThrough: string | undefined): boolean {
  if (!version || !testedThrough) return false;
  const a = SEMVER.exec(version.trim());
  const b = SEMVER.exec(testedThrough.trim());
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}
