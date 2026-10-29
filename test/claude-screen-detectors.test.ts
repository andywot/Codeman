/**
 * Claude Code's screen, read by every detector that relies on its exact text or glyphs,
 * on the newest version they were checked against, and what happens when a later version
 * stops matching.
 *
 * Claude Code updates itself on every machine, and the dashboard's working / idle /
 * needs-you readings come partly from its screen. The fixtures under
 * `test/fixtures/claude-screens/<version>/` are verbatim `tmux capture-pane -p` frames of
 * a throwaway Claude Code session (120x40, `--permission-mode default`), only the
 * working-directory path replaced:
 *
 * - `idle.txt`: a fresh pane at its composer (the faint suggestion is plain text here).
 * - `idle-after-turn.txt`: the composer after a turn, under its `✻ Cogitated for 35s` row.
 * - `working.txt`: mid-turn, a foreground Bash call running, `· Cultivating… (7s · …)`.
 * - `permission-write.txt`, `permission-bash.txt`: the Write and Bash permission dialogs.
 * - `question.txt`: an AskUserQuestion dialog.
 * - `trust.txt`: the workspace-trust dialog on first launch.
 *
 * `capabilities.workDetect.testedThroughVersion` must name the newest fixture directory:
 * re-capture the fixtures on a new release, check this file still passes, then bump it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import { CLAUDE_WORKING_LINE_PATTERN } from '../src/utils/regex-patterns.js';
import { isTrustDialogScreen, trustDialogNextKey, TRUST_KEY_DOWN } from '../src/session-trust-dialog.js';
import { normalizeCapturedFrame, parseDialogOptions } from '../src/web/approval-inbox.js';
import { watchingLabel, isAwaitingWorkers, IDLE_SILENCE_MS } from '../src/session-activity.js';
import { isCompletionMessage } from '../src/respawn-patterns.js';
import { promptStillInComposer } from '../src/session-submit-verifier.js';
import {
  COMPOSER_SEARCH_ROWS,
  DETECTION_WATCH_MS,
  UNRECOGNIZED_SCREEN_MS,
  UNVERIFIED_STREAK_MS,
  initialDetectionHealth,
  isNewerThanTested,
  isScreenRecognized,
  noteScreenReading,
  noteStateConfirmed,
  noteVetoedStreak,
  sanitizeCliVersion,
} from '../src/session-detection-health.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/claude-screens');
const workDetect = getCli('claude')!.capabilities.workDetect!;
const TESTED = workDetect.testedThroughVersion!;
const WORKING = compileVersionRegex(workDetect.workingLine)!;
const WATCHING = compileVersionRegex(workDetect.watchingLine!)!;
const AWAITING = compileVersionRegex(workDetect.awaitingLine!)!;
const GLYPH = workDetect.promptGlyph;

function screen(name: string, version: string = TESTED): string {
  return readFileSync(resolve(FIXTURES, version, `${name}.txt`), 'utf8');
}

const IDLE = screen('idle');
const IDLE_AFTER_TURN = screen('idle-after-turn');
const WORKING_SCREEN = screen('working');
const PERMISSION_WRITE = screen('permission-write');
const PERMISSION_BASH = screen('permission-bash');
const QUESTION = screen('question');
const TRUST = screen('trust');

const NOT_WORKING = { IDLE, IDLE_AFTER_TURN, PERMISSION_WRITE, PERMISSION_BASH, QUESTION, TRUST };

describe('fixtures and the tested-version constant', () => {
  it('names the newest fixture directory as testedThroughVersion', () => {
    const versions = readdirSync(FIXTURES).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    const newest = versions.reduce((a, b) => (isNewerThanTested(b, a) ? b : a));
    expect(TESTED).toBe(newest);
  });

  it('were captured from the version they are filed under', () => {
    // The banner of a fresh pane names the build.
    expect(IDLE).toContain(`Claude Code v${TESTED}`);
  });
});

describe(`Claude Code ${TESTED}: the working line (workDetect.workingLine)`, () => {
  it('matches a pane mid-turn', () => {
    expect(WORKING.test(WORKING_SCREEN)).toBe(true);
    // Both alternatives still hold on their own: the timer row and the footer hint.
    expect(/…\s*\(\d+s\b/.test(WORKING_SCREEN)).toBe(true);
    expect(WORKING_SCREEN).toContain('esc to interrupt');
    // The hard-coded fallback copy agrees with the registry's.
    expect(CLAUDE_WORKING_LINE_PATTERN.test(WORKING_SCREEN)).toBe(true);
  });

  it.each(Object.entries(NOT_WORKING))('does not match %s', (_name, text) => {
    expect(WORKING.test(text)).toBe(false);
  });
});

describe(`Claude Code ${TESTED}: the composer glyph (workDetect.promptGlyph)`, () => {
  it.each(Object.entries({ IDLE, IDLE_AFTER_TURN, WORKING_SCREEN }))('draws the composer row in %s', (_n, text) => {
    // Claude draws the composer as the glyph and a NO-BREAK space (U+00A0), not a space.
    expect(text.split('\n').some((row) => row.startsWith(`${GLYPH}\u00a0`))).toBe(true);
  });

  it('reads every fixture as a screen the detectors know', () => {
    for (const text of [IDLE, IDLE_AFTER_TURN, WORKING_SCREEN, PERMISSION_WRITE, PERMISSION_BASH, QUESTION]) {
      expect(isScreenRecognized(text, { promptGlyph: GLYPH, working: WORKING.test(text) })).toBe(true);
    }
  });

  it('finds an unsent prompt on the composer (submit verifier)', () => {
    const typed = IDLE_AFTER_TURN.replace(/^❯\u00a0$/m, '❯\u00a0fix the failing test please');
    expect(promptStillInComposer(typed, 'fix the failing test please', GLYPH)).toBe(true);
    expect(promptStillInComposer(IDLE_AFTER_TURN, 'fix the failing test please', GLYPH)).toBe(false);
  });
});

describe(`Claude Code ${TESTED}: permission and question prompts`, () => {
  it('parses the Write permission options', () => {
    expect(parseDialogOptions(normalizeCapturedFrame(PERMISSION_WRITE))?.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
      'No',
    ]);
  });

  it('parses the Bash permission options', () => {
    const options = parseDialogOptions(normalizeCapturedFrame(PERMISSION_BASH));
    expect(options?.map((o) => o.n)).toEqual([1, 2, 3, 4]);
    expect(options?.[3].label).toBe('No');
  });

  it('parses the AskUserQuestion options, descriptions and separator included', () => {
    expect(parseDialogOptions(normalizeCapturedFrame(QUESTION))?.map((o) => o.label)).toEqual([
      'Red',
      'Green',
      'Blue',
      'Type something.',
      'Chat about this',
    ]);
  });

  it('finds no options on an idle or working pane', () => {
    for (const text of [IDLE, IDLE_AFTER_TURN, WORKING_SCREEN]) {
      expect(parseDialogOptions(normalizeCapturedFrame(text))).toBeUndefined();
    }
  });

  it('parses the same options in the chat view', () => {
    const chat = loadChatView();
    const parsed = chat.parseScreenOptions(QUESTION.split('\n'));
    expect(parsed.title).toBe('Which color do you prefer?');
    expect(parsed.options.map((o: { label: string }) => o.label)).toEqual([
      'Red',
      'Green',
      'Blue',
      'Type something.',
      'Chat about this',
    ]);
    expect(parsed.options[0].selected).toBe(true);
    expect(chat.parseScreenOptions(PERMISSION_BASH.split('\n')).options).toHaveLength(4);
  });
});

describe(`Claude Code ${TESTED}: the workspace-trust dialog`, () => {
  it('is recognized, and the first key moves off "No, exit"', () => {
    expect(isTrustDialogScreen(TRUST)).toBe(true);
    expect(trustDialogNextKey(TRUST)).toBe(TRUST_KEY_DOWN);
  });

  it('is not seen anywhere else', () => {
    for (const text of [IDLE, IDLE_AFTER_TURN, WORKING_SCREEN, PERMISSION_WRITE, QUESTION]) {
      expect(isTrustDialogScreen(text)).toBe(false);
    }
  });
});

describe(`Claude Code ${TESTED}: footer and closing rows`, () => {
  it('reads the background-shell chip off the footer (watchingLine)', () => {
    // Verbatim footer of the same pane while a background shell ran.
    expect(watchingLabel(`${IDLE_AFTER_TURN.trimEnd()}\n  ⏸ manual mode on · 1 shell · ↓ to manage`, WATCHING)).toBe(
      '1 shell'
    );
    for (const text of [IDLE, IDLE_AFTER_TURN, WORKING_SCREEN]) expect(watchingLabel(text, WATCHING)).toBeNull();
  });

  it('does not read an ordinary closing row as waiting for workers (awaitingLine)', () => {
    expect(isAwaitingWorkers(IDLE_AFTER_TURN, AWAITING, GLYPH)).toBe(false);
  });

  it('reads the closing row as a completion message (respawn)', () => {
    expect(IDLE_AFTER_TURN).toContain('✻ Cogitated for 35s');
    expect(isCompletionMessage(IDLE_AFTER_TURN)).toBe(true);
    expect(isCompletionMessage('✻ Brewed for 1m 18s · done 3:04 PM')).toBe(true);
    // The working row itself is not one (the WORKING fixture still shows earlier turns' rows).
    expect(isCompletionMessage('· Cultivating… (7s · ↓ 281 tokens)')).toBe(false);
    expect(isCompletionMessage('✻ Waiting for 1 dynamic workflow to finish')).toBe(false);
    expect(isCompletionMessage('I waited for 5s before retrying')).toBe(false);
  });
});

// ─── Fail-safe: a screen the detectors no longer read ──────────────────────────

/**
 * What a later Claude Code could plausibly draw instead: the same pane with the composer
 * glyph and the working line both redrawn. Nothing here is a real release; it is the
 * fixture with the two strings the detectors key on replaced.
 */
const FUTURE_WORKING = WORKING_SCREEN.replace(/^❯(?=[ \u00a0])/gm, '>')
  .replace('· Cultivating… (7s · ↓ 281 tokens)', '◆ Cultivating 7s ↓281')
  .replace('esc to interrupt', 'esc: stop');
const FUTURE_IDLE = IDLE_AFTER_TURN.replace(/^❯(?=[ \u00a0])/gm, '>');

describe('isScreenRecognized', () => {
  it('rejects a pane with neither composer glyph nor working line', () => {
    expect(isScreenRecognized(FUTURE_WORKING, { promptGlyph: GLYPH, working: WORKING.test(FUTURE_WORKING) })).toBe(
      false
    );
    expect(isScreenRecognized(FUTURE_IDLE, { promptGlyph: GLYPH, working: false })).toBe(false);
  });

  it('does not count an old prompt echoed far up the transcript as the composer', () => {
    const rows = ['❯ an earlier prompt', ...Array.from({ length: COMPOSER_SEARCH_ROWS }, (_, i) => `row ${i}`)];
    expect(isScreenRecognized(rows.join('\n'), { promptGlyph: GLYPH, working: false })).toBe(false);
  });

  it('counts known dialogs and the awaited-workers row as recognized', () => {
    expect(isScreenRecognized('x', { promptGlyph: GLYPH, working: false, trustDialog: true })).toBe(true);
    expect(isScreenRecognized('x', { promptGlyph: GLYPH, working: false, blocked: true })).toBe(true);
    expect(isScreenRecognized('x', { promptGlyph: GLYPH, working: false, awaitingWorkers: true })).toBe(true);
  });
});

describe('detection health (pure)', () => {
  it('turns unknown only after UNRECOGNIZED_SCREEN_MS of unrecognized reads', () => {
    let h = noteScreenReading(initialDetectionHealth(), false, 1000);
    expect(h.unknown).toBeNull();
    h = noteScreenReading(h, false, 1000 + UNRECOGNIZED_SCREEN_MS - 1);
    expect(h.unknown).toBeNull();
    h = noteScreenReading(h, false, 1000 + UNRECOGNIZED_SCREEN_MS);
    expect(h.unknown).toBe('unrecognized-screen');
    h = noteScreenReading(h, true, 1000 + UNRECOGNIZED_SCREEN_MS + 1);
    expect(h.unknown).toBeNull();
  });

  it('a recognized read in between restarts the clock', () => {
    let h = noteScreenReading(initialDetectionHealth(), false, 0);
    h = noteScreenReading(h, true, UNRECOGNIZED_SCREEN_MS - 1);
    h = noteScreenReading(h, false, UNRECOGNIZED_SCREEN_MS);
    expect(h.unknown).toBeNull();
  });

  it('turns unknown after UNVERIFIED_STREAK_MS of vetoed repaints, and only a confirmation clears it', () => {
    let h = noteVetoedStreak(initialDetectionHealth(), 0, 2000);
    expect(h.unknown).toBeNull();
    h = noteVetoedStreak(h, 0, UNVERIFIED_STREAK_MS);
    expect(h.unknown).toBe('unverified-activity');
    // A composer on screen does not prove the working line is readable.
    expect(noteScreenReading(h, true, UNVERIFIED_STREAK_MS + 1).unknown).toBe('unverified-activity');
    expect(noteStateConfirmed(h).unknown).toBeNull();
  });

  it('a new run of repaints restarts the vetoed clock', () => {
    let h = noteVetoedStreak(initialDetectionHealth(), 0, 30_000);
    h = noteVetoedStreak(h, 40_000, 40_000 + UNVERIFIED_STREAK_MS - 1);
    expect(h.unknown).toBeNull();
  });

  it('compares versions strictly', () => {
    expect(isNewerThanTested('2.1.313', '2.1.312')).toBe(true);
    expect(isNewerThanTested('2.2.0', '2.1.312')).toBe(true);
    expect(isNewerThanTested('2.1.312', '2.1.312')).toBe(false);
    expect(isNewerThanTested('2.1.99', '2.1.312')).toBe(false);
    expect(isNewerThanTested('garbage', '2.1.312')).toBe(false);
    expect(isNewerThanTested(undefined, '2.1.312')).toBe(false);
    expect(isNewerThanTested('2.1.400', undefined)).toBe(false);
    expect(sanitizeCliVersion(' 2.1.312 ')).toBe('2.1.312');
    expect(sanitizeCliVersion('2.1.312-beta')).toBeUndefined();
    expect(sanitizeCliVersion(42)).toBeUndefined();
  });
});

// ─── Session integration ───────────────────────────────────────────────────────

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
  _markWorking(): void;
};

function feed(session: Session, data: string): void {
  const internals = session as unknown as SessionInternals;
  internals._handleTerminalOutput(data);
  internals._detectInteractiveActivity(data);
}

function withFakePane(read: () => string): Session {
  const mux = {
    isAvailable: () => true,
    capturePaneText: () => read(),
  } as unknown as NonNullable<ConstructorParameters<typeof Session>[0]>['mux'];
  return new Session({
    workingDir: '/tmp',
    mode: 'claude',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
  } as ConstructorParameters<typeof Session>[0]);
}

/** One repaint chunk carrying the composer glyph, the way Claude repaints every second. */
const COMPOSER_REPAINT = '\x1b[31;1H\x1b[38;5;246m❯\xa0\x1b[39m';
/** The same chunk from a release that redrew its composer glyph. */
const FUTURE_REPAINT = '\x1b[31;1H\x1b[38;5;246m>\xa0\x1b[39m';

/** Repaint once a second for `ms`, then let the pane fall silent. */
function repaint(session: Session, ms: number, chunk: string): void {
  for (let t = 0; t < ms; t += 1000) {
    feed(session, chunk);
    vi.advanceTimersByTime(1000);
  }
}

describe(`Session on Claude Code ${TESTED} screens`, () => {
  afterEach(() => vi.useRealTimers());

  it('reports a working turn as working and its end as idle, never unknown', () => {
    vi.useFakeTimers();
    const pane = { text: WORKING_SCREEN };
    const session = withFakePane(() => pane.text);
    repaint(session, 5000, COMPOSER_REPAINT);
    expect(session.status).toBe('busy');
    // A long silent tool call: the working line keeps it busy.
    vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS * 2);
    expect(session.status).toBe('busy');
    pane.text = IDLE_AFTER_TURN;
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 10_000);
    expect(session.status).toBe('idle');
    expect(session.toState().stateDetection).toBeUndefined();
  });

  it.each(Object.entries({ PERMISSION_WRITE, PERMISSION_BASH, QUESTION }))(
    'leaves a pane parked on %s quiet and readable',
    (_name, text) => {
      vi.useFakeTimers();
      const session = withFakePane(() => text);
      repaint(session, 3000, COMPOSER_REPAINT);
      vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS * 2);
      // Not working (the dialog has no working line), and never unknown: the "needs you"
      // state comes from the permission_prompt hook, which this does not touch.
      expect(session.status).toBe('idle');
      expect(session.toState().stateDetection).toBeUndefined();
    }
  );
});

describe('Session on a screen the detectors no longer read', () => {
  afterEach(() => vi.useRealTimers());

  it('shows unknown, not a stuck "working", once a redrawn composer stops arming the idle check', () => {
    vi.useFakeTimers();
    const pane = { text: WORKING_SCREEN };
    const session = withFakePane(() => pane.text);
    const states: Array<string | undefined> = [];
    session.on('detectionChanged', () => states.push(session.toState().stateDetection));

    // A turn that IS recognized starts, then the pane switches to the future UI.
    repaint(session, 3000, COMPOSER_REPAINT);
    expect(session.status).toBe('busy');
    pane.text = FUTURE_IDLE;
    repaint(session, 3000, FUTURE_REPAINT);
    vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS + 2 * DETECTION_WATCH_MS);

    // Whatever the idle check armed by the earlier glyph concluded, the screen keeps being
    // read and the state is reported unknown.
    expect(session.toState().stateDetection).toBe('unknown');
    expect(session.toState().stateDetectionReason).toBe('unrecognized-screen');
    expect(states).toEqual(['unknown']);

    // The screen becomes readable again: the unknown clears.
    pane.text = WORKING_SCREEN;
    vi.advanceTimersByTime(DETECTION_WATCH_MS + 1000);
    expect(session.toState().stateDetection).toBeUndefined();
  });

  it('keeps reading a busy pane no glyph ever arms, and reports it unknown', () => {
    vi.useFakeTimers();
    const session = withFakePane(() => FUTURE_IDLE);
    (session as unknown as SessionInternals)._markWorking();
    repaint(session, 3000, FUTURE_REPAINT);
    vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS / 2);
    expect(session.toState().stateDetection).toBeUndefined();
    vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS / 2 + 2 * DETECTION_WATCH_MS);
    // Nothing concluded idle (no glyph armed the check), so status is still the stale
    // `busy`; what the dashboard shows is the unknown.
    expect(session.status).toBe('busy');
    expect(session.toState().stateDetection).toBe('unknown');
  });

  it('shows unknown, not "idle", for a long run of repaints whose working line it cannot read', () => {
    vi.useFakeTimers();
    // The working line is redrawn but the composer glyph is not.
    const pane = { text: FUTURE_WORKING.replace(/^>\u00a0$/m, '❯\u00a0') };
    const session = withFakePane(() => pane.text);
    repaint(session, UNVERIFIED_STREAK_MS - 5000, COMPOSER_REPAINT);
    expect(session.toState().stateDetection).toBeUndefined();
    repaint(session, 10_000, COMPOSER_REPAINT);
    expect(session.toState().stateDetection).toBe('unknown');
    expect(session.toState().stateDetectionReason).toBe('unverified-activity');

    // A working line the pattern reads confirms the detectors again.
    pane.text = WORKING_SCREEN;
    repaint(session, 3000, COMPOSER_REPAINT);
    expect(session.toState().stateDetection).toBeUndefined();
    expect(session.status).toBe('busy');
  });

  it('does not count a person typing into the composer', () => {
    vi.useFakeTimers();
    const session = withFakePane(() => IDLE_AFTER_TURN);
    const internals = session as unknown as { _lastHumanInputAt: number };
    for (let t = 0; t < UNVERIFIED_STREAK_MS * 2; t += 1000) {
      internals._lastHumanInputAt = Date.now();
      feed(session, COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    expect(session.toState().stateDetection).toBeUndefined();
  });
});

describe('Claude Code version hint', () => {
  it('flags a session whose CLI reports a version newer than the tested one', () => {
    const session = withFakePane(() => IDLE);
    const [major, minor, patch] = TESTED.split('.').map(Number);
    const events: unknown[] = [];
    session.on('cliInfoUpdated', (data) => events.push(data));

    expect(session.noteReportedCliVersion(TESTED)).toBe(true);
    expect(session.toState().cliVersion).toBe(TESTED);
    expect(session.toState().cliVersionUntested).toBeUndefined();

    const newer = `${major}.${minor}.${patch + 1}`;
    expect(session.noteReportedCliVersion(newer)).toBe(true);
    expect(session.toState()).toMatchObject({
      cliVersion: newer,
      cliVersionUntested: true,
      cliVersionTestedThrough: TESTED,
    });
    expect(events).toHaveLength(2);

    // Repeats and junk change nothing.
    expect(session.noteReportedCliVersion(newer)).toBe(false);
    expect(session.noteReportedCliVersion('not-a-version')).toBe(false);
    expect(session.toState().cliVersion).toBe(newer);
  });
});

// ─── Frontend classification ───────────────────────────────────────────────────

function loadChatView(): any {
  const CodemanApp = function CodemanApp(this: any) {};
  const window: any = { addEventListener() {} };
  const context = vm.createContext({
    CodemanApp,
    window,
    document: { readyState: 'loading', addEventListener() {} },
    history: {},
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout,
    setInterval,
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-view.js'), 'utf8'), context);
  return window.CodemanChat;
}

function loadConstants(): any {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8'), context);
  return context.window;
}

function loadOverviewState(): (session: Record<string, unknown>, hooks?: Set<string>) => string {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({ CodemanApp, window: {}, document: {}, Object });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile-overview.js'), 'utf8'), context);
  return (CodemanApp as any).prototype._mobileOverviewState;
}

describe('dashboard state for an unreadable screen', () => {
  it('shows a neutral unknown dot instead of busy or idle', () => {
    const { CodemanSessionOrder, CodemanTabTriage } = loadConstants();
    const tabStatus = CodemanSessionOrder.tabStatus;
    expect(tabStatus({ status: 'busy' })).toBe('busy');
    expect(tabStatus({ status: 'busy', stateDetection: 'unknown' })).toBe('unknown');
    expect(tabStatus({ status: 'idle', stateDetection: 'unknown' })).toBe('unknown');
    expect(tabStatus({ status: 'error', stateDetection: 'unknown' })).toBe('error');
    expect(tabStatus(undefined)).toBe('idle');
    expect(CodemanSessionOrder.RANK.unknown).toBe(CodemanSessionOrder.RANK.idle);
    expect(CodemanTabTriage.groupFor('unknown', false)).toBe('idle');
  });

  it('classifies the row as unknown, below the hooks', () => {
    const state = loadOverviewState();
    expect(state({ status: 'busy' })).toBe('working');
    expect(state({ status: 'busy', stateDetection: 'unknown' })).toBe('unknown');
    expect(state({ status: 'idle', stateDetection: 'unknown' })).toBe('unknown');
    expect(state({ status: 'stopped', stateDetection: 'unknown' })).toBe('done');
    // Hooks are not screen reads: a permission prompt still needs you.
    expect(state({ status: 'busy', stateDetection: 'unknown' }, new Set(['permission_prompt']))).toBe('needs');
    expect(state({ status: 'idle', stateDetection: 'unknown' }, new Set(['idle_prompt']))).toBe('waiting');
  });
});
