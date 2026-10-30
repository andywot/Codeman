/**
 * Native Windows Claude Code (a remote session whose `remote.system` is `windows`): its
 * composer glyph is the `figures` fallback `>`, not `❯`, and every reader of the composer
 * must see it there, but ONLY there.
 *
 * Fixtures under `test/fixtures/claude-screens/windows/2.1.314/`:
 * - `idle.txt`: a live `tmux capture-pane -p` of an idle Windows session (2026-10-30), as
 *   reported, padded back to a full screen with blank rows.
 * - `working.txt`, `idle-after-turn.txt`: DERIVED from that frame and the 2.1.312 Linux
 *   fixtures (Windows draws the same layout; the spinner's `*` is the non-macOS spinner
 *   set's own glyph). The transcript quotes and the prompt echo start with `> ` on purpose.
 * - `transcript-only.txt`: the same transcript with no composer on screen, its last row a
 *   column-0 `> ` line: what a transcript quote must never be mistaken for.
 *
 * Kept out of the version directories `claude-screen-detectors.test.ts` walks, so they do
 * not take part in the `testedThroughVersion` check.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import { chunkMayShowComposer, resolveComposerGlyph } from '../src/composer-glyph.js';
import { isScreenRecognized, UNRECOGNIZED_SCREEN_MS, DETECTION_WATCH_MS } from '../src/session-detection-health.js';
import { isAwaitingWorkers, IDLE_SILENCE_MS } from '../src/session-activity.js';
import { composerIsEmpty, promptStillInComposer } from '../src/session-submit-verifier.js';
import {
  isTrustDialogScreen,
  trustDialogNextKey,
  TRUST_KEY_CONFIRM,
  TRUST_KEY_DOWN,
} from '../src/session-trust-dialog.js';
import { decideNudge } from '../src/agent-mail.js';
import { createAgentMailRelay } from '../src/web/agent-mail-wiring.js';
import type { SessionRemote } from '../src/types/index.js';

const DIR = resolve(import.meta.dirname, 'fixtures/claude-screens/windows/2.1.314');
const screen = (name: string): string => readFileSync(resolve(DIR, `${name}.txt`), 'utf8');

const IDLE = screen('idle');
const IDLE_AFTER_TURN = screen('idle-after-turn');
const WORKING_SCREEN = screen('working');
const TRANSCRIPT_ONLY = screen('transcript-only');

const workDetect = getCli('claude')!.capabilities.workDetect!;
const WORKING = compileVersionRegex(workDetect.workingLine)!;
const AWAITING = compileVersionRegex(workDetect.awaitingLine!)!;
const WIN = resolveComposerGlyph(workDetect, 'windows', '');
const LINUX = resolveComposerGlyph(workDetect, 'linux', '');

describe('resolving the composer glyph per session', () => {
  it('adds the ASCII fallback for native Windows claude only', () => {
    expect(workDetect.windowsPromptGlyph).toBe('>');
    expect(WIN).toEqual({ glyph: '❯', ruledGlyph: '>' });
    for (const system of ['linux', 'wsl', undefined]) {
      expect(resolveComposerGlyph(workDetect, system, '')).toEqual({ glyph: '❯' });
    }
  });

  it('leaves a CLI that declares no Windows glyph alone, and keeps each fallback', () => {
    const codex = getCli('codex')!.capabilities.workDetect!;
    expect(resolveComposerGlyph(codex, 'windows', '')).toEqual({ glyph: codex.promptGlyph });
    expect(resolveComposerGlyph(undefined, 'windows', '❯')).toEqual({ glyph: '❯' });
    expect(resolveComposerGlyph(undefined, undefined, '')).toEqual({ glyph: '' });
  });
});

describe('Claude Code 2.1.314 on Windows: the screens', () => {
  it('draws `>` on the composer row, between two rules, and the working line unchanged', () => {
    const rows = IDLE.split('\n');
    const at = rows.findIndex((r) => r.startsWith('>'));
    expect(rows[at - 1]).toMatch(/^─{100,}$/);
    expect(rows[at + 1]).toMatch(/^─{100,}$/);
    expect(IDLE).not.toContain('❯');
    expect(WORKING.test(WORKING_SCREEN)).toBe(true);
    for (const text of [IDLE, IDLE_AFTER_TURN, TRANSCRIPT_ONLY]) expect(WORKING.test(text)).toBe(false);
  });

  it('is recognized with the Windows glyph, and was not with the Linux one (the bug)', () => {
    for (const text of [IDLE, IDLE_AFTER_TURN]) {
      expect(isScreenRecognized(text, { promptGlyph: WIN, working: false })).toBe(true);
      expect(isScreenRecognized(text, { promptGlyph: LINUX, working: false })).toBe(false);
      expect(isScreenRecognized(text, { promptGlyph: workDetect.promptGlyph, working: false })).toBe(false);
    }
  });

  it('never counts a transcript `> ` quote or prompt echo as the composer', () => {
    expect(isScreenRecognized(TRANSCRIPT_ONLY, { promptGlyph: WIN, working: false })).toBe(false);
    expect(composerIsEmpty(TRANSCRIPT_ONLY, WIN)).toBeUndefined();
    expect(promptStillInComposer(TRANSCRIPT_ONLY, 'Week 4: slope-intercept form', WIN)).toBeUndefined();
    // A quote directly under an INDENTED rule (a transcript horizontal rule) is not one either.
    const quoted = `  ${'─'.repeat(40)}\n> quoted\n`;
    expect(composerIsEmpty(`${quoted}${'─'.repeat(40)}\n`, WIN)).toBeUndefined();
  });

  it('counts a numbered dialog option drawn with `>` as recognized (health only)', () => {
    const dialog = `${TRANSCRIPT_ONLY}\n Do you want to proceed?\n > 1. Yes\n   2. No\n Esc to cancel\n`;
    expect(isScreenRecognized(dialog, { promptGlyph: WIN, working: false })).toBe(true);
    expect(isScreenRecognized(dialog, { promptGlyph: LINUX, working: false })).toBe(false);
  });

  it('reads the composer: empty, holding a draft, holding an unsent prompt', () => {
    expect(composerIsEmpty(IDLE, WIN)).toBe(true);
    expect(composerIsEmpty(IDLE_AFTER_TURN, WIN)).toBe(true);
    const typed = IDLE_AFTER_TURN.replace(/^> $/m, '> fix the failing test please');
    expect(composerIsEmpty(typed, WIN)).toBe(false);
    expect(promptStillInComposer(typed, 'fix the failing test please', WIN)).toBe(true);
    expect(promptStillInComposer(IDLE_AFTER_TURN, 'fix the failing test please', WIN)).toBe(false);
    // The prompt echoed in the transcript is not "still in the composer".
    expect(promptStillInComposer(IDLE_AFTER_TURN, 'Summarize the notes in this folder', WIN)).toBe(false);
    // With the Linux glyph nothing can be said: the bug, which also blocked the mail nudge.
    expect(composerIsEmpty(IDLE, LINUX)).toBeUndefined();
  });

  it('reads the awaited-workers row above the `>` composer', () => {
    const awaiting = IDLE_AFTER_TURN.replace('✻ Cooked for 12s', '✻ Waiting for 1 dynamic workflow to finish');
    expect(isAwaitingWorkers(awaiting, AWAITING, WIN)).toBe(true);
    expect(isAwaitingWorkers(IDLE_AFTER_TURN, AWAITING, WIN)).toBe(false);
    expect(isAwaitingWorkers(awaiting, AWAITING, LINUX)).toBe(false);
  });

  it('steers the trust dialog with a `>` selection pointer', () => {
    const trust = [
      ' Quick safety check: Is this a project you created or one you trust?',
      ' Security guide',
      ' > No, exit',
      '   Yes, I trust this folder',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(isTrustDialogScreen(trust)).toBe(true);
    expect(trustDialogNextKey(trust)).toBeNull();
    expect(trustDialogNextKey(trust, ['>'])).toBe(TRUST_KEY_DOWN);
    const onYes = trust.replace(' > No, exit', '   No, exit').replace('   Yes, I trust', ' > Yes, I trust');
    expect(trustDialogNextKey(onYes, ['>'])).toBe(TRUST_KEY_CONFIRM);
  });
});

describe('the stream-level idle arm', () => {
  it('arms on a composer repaint carrying `>`, never on an escape sequence alone', () => {
    expect(chunkMayShowComposer('\x1b[31;1H\x1b[38;5;246m>\xa0\x1b[39m', WIN)).toBe(true);
    expect(chunkMayShowComposer('\x1b[>4;2m\x1b[>c', WIN)).toBe(false);
    expect(chunkMayShowComposer('plain output', WIN)).toBe(false);
  });

  it('is unchanged for a non-Windows session', () => {
    const linux = resolveComposerGlyph(workDetect, undefined, '❯');
    expect(chunkMayShowComposer('\x1b[31;1H>\xa0', linux)).toBe(false);
    expect(chunkMayShowComposer('\x1b[31;1H❯\xa0', linux)).toBe(true);
  });
});

// ─── Session integration ───────────────────────────────────────────────────────

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
  _markWorking(): void;
};

const WINDOWS_REMOTE: SessionRemote = {
  hostId: 'desktop-windows',
  label: 'Desktop (Windows)',
  host: 'desktop.lan',
  username: 'andy',
  remotePath: 'C:/Users/andy/tutoring',
  system: 'windows',
};

function withFakePane(read: () => string, remote?: SessionRemote): Session {
  const mux = {
    isAvailable: () => true,
    capturePaneText: () => read(),
  } as unknown as NonNullable<ConstructorParameters<typeof Session>[0]>['mux'];
  return new Session({
    workingDir: '/tmp',
    mode: 'claude',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    ...(remote ? { remote } : {}),
  } as ConstructorParameters<typeof Session>[0]);
}

function feed(session: Session, data: string): void {
  const internals = session as unknown as SessionInternals;
  internals._handleTerminalOutput(data);
  internals._detectInteractiveActivity(data);
}

/** Windows claude's composer repaint: its `>` and a no-break space. */
const WINDOWS_REPAINT = '\x1b[31;1H\x1b[38;5;246m>\xa0\x1b[39m';

function repaint(session: Session, ms: number, chunk: string): void {
  for (let t = 0; t < ms; t += 1000) {
    feed(session, chunk);
    vi.advanceTimersByTime(1000);
  }
}

describe('a native Windows claude session', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves its own composer glyph', () => {
    expect(withFakePane(() => IDLE, WINDOWS_REMOTE).composerGlyph()).toEqual({ glyph: '❯', ruledGlyph: '>' });
    expect(withFakePane(() => IDLE).composerGlyph()).toEqual({ glyph: '❯' });
    expect(withFakePane(() => IDLE, { ...WINDOWS_REMOTE, system: 'wsl' }).composerGlyph('❯')).toEqual({ glyph: '❯' });
  });

  it('reports a working turn as working and its end as idle, never unknown', () => {
    vi.useFakeTimers();
    const pane = { text: WORKING_SCREEN };
    const session = withFakePane(() => pane.text, WINDOWS_REMOTE);
    repaint(session, 5000, WINDOWS_REPAINT);
    expect(session.status).toBe('busy');
    vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS * 2);
    expect(session.status).toBe('busy');
    expect(session.toState().stateDetection).toBeUndefined();
    pane.text = IDLE_AFTER_TURN;
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 10_000);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
    expect(session.toState().stateDetection).toBeUndefined();
  });

  it('settles a busy session sitting at its idle composer (the live report)', () => {
    vi.useFakeTimers();
    const session = withFakePane(() => IDLE, WINDOWS_REMOTE);
    (session as unknown as SessionInternals)._markWorking();
    repaint(session, 3000, WINDOWS_REPAINT);
    vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS + 2 * DETECTION_WATCH_MS);
    expect(session.status).toBe('idle');
    expect(session.toState().stateDetection).toBeUndefined();
  });

  it('a Linux session shown the same screen behaves exactly as before (stays busy, unknown)', () => {
    vi.useFakeTimers();
    const session = withFakePane(() => IDLE);
    (session as unknown as SessionInternals)._markWorking();
    repaint(session, 3000, WINDOWS_REPAINT);
    vi.advanceTimersByTime(UNRECOGNIZED_SCREEN_MS + 2 * DETECTION_WATCH_MS);
    expect(session.status).toBe('busy');
    expect(session.toState().stateDetection).toBe('unknown');
  });

  it('is offered the agent-mail nudge once idle at an empty composer', () => {
    vi.useFakeTimers();
    const session = withFakePane(() => IDLE, WINDOWS_REMOTE);
    (session as unknown as SessionInternals)._markWorking();
    repaint(session, 3000, WINDOWS_REPAINT);
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 10_000);
    Object.defineProperty(session, 'pid', { value: 4242 });
    const relay = createAgentMailRelay({
      sessions: () => [session],
      getSession: (id) => (id === session.id ? session : undefined),
      browserConnected: () => true,
      capturePane: () => IDLE,
      busy: () => false,
      log: () => {},
    });
    const view = (relay as unknown as { ports: { nudgeView(id: string): unknown } }).ports.nudgeView(session.id) as {
      idle: boolean;
      composerEmpty: boolean | null;
      lastHumanInputAt: number;
    };
    expect(view).toMatchObject({ idle: true, composerEmpty: true });
    const now = Date.now();
    expect(
      decideNudge({
        now,
        pending: { count: 1, since: now - 1000 } as Parameters<typeof decideNudge>[0]['pending'],
        enabled: true,
        lastNudgeAt: 0,
        unseen: 1,
        idle: view.idle,
        composerEmpty: view.composerEmpty,
        lastHumanInputAt: view.lastHumanInputAt,
      })
    ).toBe('nudge');
  });
});
