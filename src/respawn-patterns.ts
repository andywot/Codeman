/**
 * @fileoverview Pure utility functions for terminal pattern detection in respawn controller.
 *
 * Extracted from respawn-controller.ts for modularity. These are stateless functions
 * and constants used to detect completion messages, working patterns, and token counts
 * in terminal output.
 *
 * @module respawn-patterns
 */

import { TOKEN_PATTERN, CLAUDE_WORKING_LINE_PATTERN } from './utils/index.js';

// ========== Constants ==========

/**
 * Pattern to detect completion messages from Claude Code.
 * Requires "Worked for" prefix to avoid false positives from bare time durations
 * in regular text (e.g., "wait for 5s", "run for 2m").
 *
 * Matches: "Worked for 2m 46s", "Worked for 46s", "Worked for 1h 2m 3s"
 * Does NOT match: "wait for 5s", "run for 2m", "for 3s the system..."
 */
const COMPLETION_TIME_PATTERN = /\bWorked\s+for\s+\d+[hms](\s*\d+[hms])*/i;

/**
 * The closing row current Claude Code draws instead: a randomized past-tense verb behind
 * the turn glyph, `✻ Cogitated for 35s · done 1:20 AM` (2.1.312, verbatim fixture in
 * test/fixtures/claude-screens/2.1.312/idle-after-turn.txt), `✻ Brewed for 1m 18s`.
 * "Worked for" survives only in older builds. Anchored on the glyph (the working line's
 * glyph set) so prose that says "waited for 5s" never matches, and the duration needs its
 * unit right after the digits so `✻ Waiting for 1 dynamic workflow` does not either.
 */
const COMPLETION_ROW_PATTERN = /[✻✽✶✳✢∗·*]\s*[A-Z][a-z]+\s+for\s+\d+[hms](?:\s*\d+[hms])*\b/;

/**
 * Patterns indicating Claude is ready for input (legacy fallback).
 * Used as secondary signals, not primary detection.
 */
export const PROMPT_PATTERNS = [
  '❯', // Standard prompt
  '\u276f', // Unicode variant
  '⏵', // Claude Code prompt variant
];

/**
 * Patterns indicating Claude is actively working.
 * When detected, resets all idle detection timers.
 * Note: ✻ and ✽ removed - they appear in completion messages too.
 */
export const WORKING_PATTERNS = [
  'Thinking',
  'Writing',
  'Reading',
  'Running',
  'Searching',
  'Editing',
  'Creating',
  'Deleting',
  'Analyzing',
  'Executing',
  'Synthesizing',
  'Brewing', // Claude's processing indicators
  'Compiling',
  'Building',
  'Installing',
  'Fetching',
  'Downloading',
  'Processing',
  'Generating',
  'Loading',
  'Starting',
  'Updating',
  'Checking',
  'Validating',
  'Testing',
  'Formatting',
  'Linting',
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏', // Spinner chars
  '◐',
  '◓',
  '◑',
  '◒', // Alternative spinners
  '⣾',
  '⣽',
  '⣻',
  '⢿',
  '⡿',
  '⣟',
  '⣯',
  '⣷', // Braille spinners
];

/**
 * Check if data contains a completion message pattern.
 * Matches "Worked for Xh Xm Xs" and the current `✻ <Verb> for 35s` closing row.
 *
 * @param data - Raw terminal output data
 * @returns True if completion message pattern is found
 */
export function isCompletionMessage(data: string): boolean {
  return COMPLETION_TIME_PATTERN.test(data) || COMPLETION_ROW_PATTERN.test(data);
}

/**
 * Check if a rolling window of terminal output contains working patterns.
 * The rolling window catches patterns split across chunks (e.g., "Thin" + "king").
 *
 * @param window - Rolling window of recent terminal output (already includes current data)
 * @returns True if any working pattern is found in the window
 */
export function hasWorkingPattern(window: string): boolean {
  // Current Claude randomizes the gerund ("Actualizing…", "Finagling…"), so the
  // list above catches only a fraction of turns. The live status line's own shape
  // (`… (13m 23s · ↓ 47.5k tokens)`) is what identifies the rest. Kept as an
  // extra signal rather than a replacement: this window is RAW terminal data, and
  // a partial repaint can split the line across chunks.
  return CLAUDE_WORKING_LINE_PATTERN.test(window) || WORKING_PATTERNS.some((pattern) => window.includes(pattern));
}

/**
 * Extract token count from data if present.
 * Parses patterns like "123.4k tokens" or "1.5M tokens".
 *
 * @param data - Raw terminal output data
 * @returns Parsed token count, or null if no token pattern found
 */
export function extractTokenCount(data: string): number | null {
  const match = data.match(TOKEN_PATTERN);
  if (!match) return null;

  let count = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') count *= 1000;
  else if (suffix === 'm') count *= 1000000;

  return Math.round(count);
}
