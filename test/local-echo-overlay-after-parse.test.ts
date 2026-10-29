/**
 * Local-echo overlay row after live output (the "one-line cursor drift").
 *
 * The overlay draws the unsent prompt text, and its own caret, on the row of
 * Claude Code's ❯ composer. `flushPendingWrites()` repositions it after every
 * live write, but xterm.js PARSES WRITES ASYNCHRONOUSLY: when `write()` returns,
 * the buffer still holds the previous frame. Repositioning at that moment reads
 * the old ❯ row, and if that write was the one that moved the composer, nothing
 * moves the overlay again until the next output or keystroke. Claude pins its
 * composer to the bottom of the pane, so any height change (a browser resize,
 * the phone keyboard, a footer line coming or going) moves the ❯ row by a row,
 * and the overlay was left a row below it (shrink) or on the border above it
 * (grow). Remote sessions saw it most: local echo is on by default there, and
 * the redraw comes back over ssh as a separate, late chunk with no keystroke
 * after it.
 *
 * This replays a real stream (a tmux attach client on a pane hosting a nested
 * tmux running Claude Code 2.1.312, i.e. a remote session's local pane) through
 * the shipped `flushPendingWrites()` into a real `@xterm/headless` terminal,
 * which parses asynchronously exactly as the browser's does, and the overlay's
 * prompt finder is the one `_updateLocalEchoState()` installs for a remote
 * Claude session.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

interface StreamFixture {
  cols: number;
  rowsBefore: number;
  rowsAfter: number;
  before: string[];
  after: string[];
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/claude-remote-composer-resize.json'), 'utf8')
) as StreamFixture;

/** The live strip a claude session's stream gets (session.ts, strip-full). */
function stripFull(data: string): string {
  return data
    .replace(/\x1b\[\?(?:47|1047|1049)[hl]/g, '')
    .replace(/\x1b\[3J/g, '')
    .replace(/\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g, '');
}

type PromptFinder = { find: (terminal: unknown) => { row: number; col: number } | null };

function loadHarness() {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const windowObj: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowObj,
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance,
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout,
    clearTimeout,
    MobileDetection: { isTouchDevice: () => false },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    OSC52_STRIP_RE: /\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const terminal = new Terminal({
    cols: fixture.cols,
    rows: fixture.rowsBefore,
    scrollback: 5000,
    allowProposedApi: true,
  });

  // Stand-in for LocalEchoOverlay: it holds unsent text, and every reposition
  // runs the installed prompt finder against the buffer as it is AT THAT MOMENT,
  // which is exactly what the real addon's _render() does.
  let prompt: PromptFinder | null = null;
  const placements: Array<{ row: number; col: number } | null> = [];
  const overlay = {
    hasPending: true,
    setPrompt: (p: PromptFinder) => {
      prompt = p;
    },
    clear: vi.fn(),
    rerender: () => {
      placements.push(prompt ? prompt.find(terminal) : null);
    },
  };

  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.activeSessionId = 'remote-1';
  // A remote Claude session on a desktop browser: local echo defaults ON (fork).
  app.sessions = new Map([['remote-1', { id: 'remote-1', mode: 'claude', remote: { hostId: 'h1' } }]]);
  app.loadAppSettingsFromStorage = () => ({});
  app.pendingWrites = [];
  app.writeFrameScheduled = false;
  app._wasAtBottomBeforeWrite = true;
  app._safeYield = (fn: () => void) => setTimeout(fn, 0);
  app.terminal = terminal;
  app._localEchoOverlay = overlay;
  app._predictiveEcho = null;
  app._updateLocalEchoState();

  return { app, terminal, placements, hasPrompt: () => prompt !== null };
}

/** Wait until xterm has parsed everything handed to it so far. */
function parsed(terminal: InstanceType<typeof Terminal>): Promise<void> {
  return new Promise((done) => terminal.write('', done));
}

/** Where the ❯ composer is once everything is parsed, as a screen row. */
function composerRow(terminal: InstanceType<typeof Terminal>): number {
  const buf = terminal.buffer.active;
  for (let row = terminal.rows - 1; row >= 0; row--) {
    const text = buf.getLine(buf.viewportY + row)?.translateToString(true) ?? '';
    if (/^❯/.test(text)) return row;
  }
  return -1;
}

/** Live output arriving as its own frame, flushed the way the page flushes it. */
async function liveFrame(app: Record<string, any>, terminal: InstanceType<typeof Terminal>, data: string) {
  app.pendingWrites.push(stripFull(data));
  app.flushPendingWrites();
  await parsed(terminal);
  // A flush the first one deferred (frame budget) runs on the next tick.
  while (app.pendingWrites.length > 0 || app._terminalWriteInFlight) {
    await new Promise((r) => setTimeout(r, 0));
    await parsed(terminal);
  }
}

describe('local-echo overlay follows the ❯ row after live output', () => {
  it('installs the claude prompt finder for a remote session (local echo on by default)', () => {
    const { app, hasPrompt } = loadHarness();
    expect(app._localEchoEnabled).toBe(true);
    expect(app._localEchoPolicy).toBe('buffer');
    expect(hasPrompt()).toBe(true);
  });

  it('lands on the composer row once a redraw that moved it has been parsed', async () => {
    const { app, terminal, placements } = loadHarness();
    for (const chunk of fixture.before) await liveFrame(app, terminal, chunk);
    const rowBefore = composerRow(terminal);
    expect(rowBefore).toBe(fixture.rowsBefore - 3);
    expect(placements.at(-1)).toEqual({ row: rowBefore, col: 2 });

    // The browser terminal loses a row (window resize, keyboard, a header line):
    // xterm resizes at once, Claude's redraw arrives later as separate chunks.
    terminal.resize(fixture.cols, fixture.rowsAfter);
    for (const chunk of fixture.after) await liveFrame(app, terminal, chunk);

    const rowAfter = composerRow(terminal);
    // The redraw really moved the composer up a row: this is the case that drifted.
    expect(rowAfter).toBe(fixture.rowsAfter - 3);
    expect(rowAfter).toBe(rowBefore - 1);
    // Drawn on the ❯ row, never on the border below it (the stale pre-parse row).
    expect(placements.at(-1)).toEqual({ row: rowAfter, col: 2 });
  });

  it('never positions the overlay against a write xterm has not parsed yet', async () => {
    const { app, terminal, placements } = loadHarness();
    for (const chunk of fixture.before) await liveFrame(app, terminal, chunk);
    const seen = placements.length;
    const writeSpy = vi.spyOn(terminal, 'write');

    app.pendingWrites.push(stripFull(fixture.after.join('')));
    app.flushPendingWrites();
    // write() has returned, the parse has not run: nothing may be placed yet.
    expect(writeSpy).toHaveBeenCalled();
    expect(placements.length).toBe(seen);
    await parsed(terminal);
    expect(placements.length).toBeGreaterThan(seen);
  });
});
