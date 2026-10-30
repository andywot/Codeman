// @vitest-environment jsdom
/**
 * Local-echo overlay after composer text it never saw (fork report, 2026-10-30:
 * "when I paste images, or have multiline stuff, the cursor jumps around").
 *
 * With local echo on (the default for remote sessions), typed text waits in the
 * overlay until Enter, but some text reaches Claude's composer directly: a
 * Ctrl+V text paste flushes what was typed and sends the paste, an upload path
 * went to the PTY, Shift+Enter flushes, a tab switch flushes. Text typed after
 * that was drawn from the `❯` OVER the composer's first row, and Claude's own
 * cursor stayed visible at the real end of the composer text: two cursors, the
 * wrapped rows apparently in the wrong place. The overlay now continues at the
 * CLI cursor (ComposerLayout.followCursor), which Claude Code keeps at its caret.
 *
 * Wiring test: the shipped terminal-ui.js `_updateLocalEchoState()` configures
 * the REAL overlay (package source) on a REAL @xterm/headless buffer.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZerolagInputAddon } from '../packages/xterm-zerolag-input/src/zerolag-input-addon.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

const COLS = 60;
const ROWS = 12;
const CELL_W = 10;
const CELL_H = 20;

let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
});

function loadHarness(mode = 'claude') {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    window: {
      CodemanTerminalInput: {
        cursorViewportRow: (t: any) => {
          const buf = t.buffer.active;
          const row = buf.baseY + buf.cursorY - buf.viewportY;
          return row >= 0 && row < t.rows ? row : null;
        },
      },
    },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
    performance,
    setTimeout,
    clearTimeout,
  });
  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  // What the addon needs from a rendered terminal: the screen element it draws
  // into and the cell size. Headless has neither, so both are supplied here.
  const element = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  element.appendChild(screen);
  document.body.appendChild(element);
  Object.defineProperty(terminal, 'element', { value: element });
  (terminal as any)._core._renderService = {
    dimensions: { css: { cell: { width: CELL_W, height: CELL_H } }, device: { char: { top: 0, height: CELL_H } } },
  };
  const overlay = new ZerolagInputAddon({ prompt: { type: 'character', char: '❯', offset: 2 } });
  overlay.activate(terminal as any);
  disposers.push(() => {
    overlay.dispose();
    terminal.dispose();
    element.remove();
  });

  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.activeSessionId = 'remote-1';
  app.sessions = new Map([['remote-1', { id: 'remote-1', mode, remote: { hostId: 'h1' } }]]);
  app.loadAppSettingsFromStorage = () => ({});
  app.terminal = terminal;
  app._localEchoOverlay = overlay;
  app._predictiveEcho = null;
  app._updateLocalEchoState();

  const box = () => screen.lastElementChild as HTMLDivElement;
  /** [row, col, text] per drawn line, plus the overlay cursor's [row, col]. */
  const drawn = () => {
    const top = parseFloat(box().style.top) / CELL_H;
    const lines = [...box().children].filter((el) => el.tagName === 'DIV') as HTMLDivElement[];
    const cursor = [...box().children].find((el) => el.tagName === 'SPAN') as HTMLSpanElement | undefined;
    return {
      lines: lines.map((el) => {
        const first = el.firstElementChild as HTMLSpanElement | null;
        const pad = first && first.textContent === '' ? parseFloat(first.style.width) / CELL_W : 0;
        return [top + parseFloat(el.style.top) / CELL_H, parseFloat(el.style.left) / CELL_W + pad, el.textContent];
      }),
      cursor: cursor ? [top + parseFloat(cursor.style.top) / CELL_H, parseFloat(cursor.style.left) / CELL_W] : null,
    };
  };
  return { app, terminal, overlay, drawn };
}

/** Paint a Claude Code style screen: composer rows after `❯ `, borders, footer, and the cursor. */
function paint(terminal: InstanceType<typeof Terminal>, composer: string[], cursor: { row: number; col: number }) {
  const rows = Array.from({ length: ROWS }, () => '');
  const top = 6;
  rows[top - 1] = '─'.repeat(COLS);
  composer.forEach((line, i) => (rows[top + i] = line));
  rows[top + composer.length] = '─'.repeat(COLS);
  rows[top + composer.length + 1] = '  ⏵⏵ auto mode on';
  const frame = '\x1b[2J\x1b[H' + rows.join('\r\n') + `\x1b[${cursor.row + 1};${cursor.col + 1}H`;
  return new Promise<void>((done) => terminal.write(frame, done));
}

describe('local-echo overlay continues after composer text it never saw', () => {
  it('configures the Claude composer layout for a claude session', () => {
    const { overlay } = loadHarness();
    expect(overlay.layout).toEqual({
      continuationIndent: 'prompt',
      rightMargin: 2,
      wordWrap: true,
      followCursor: true,
    });
  });

  it('draws typed text at the CLI cursor after a flushed multi-line paste, with one cursor', async () => {
    const { terminal, overlay, drawn } = loadHarness();
    // A Ctrl+V of two lines: the typed prefix and the paste are in Claude's
    // composer, and Claude's cursor sits after "line two".
    await paint(terminal, ['❯ typed before pasted line one', '  pasted line two'], { row: 7, col: 17 });
    overlay.appendText(' then more');
    expect(drawn()).toEqual({ lines: [[7, 17, ' then more']], cursor: [7, 27] });
    // Nothing drawn over the composer's first row.
    expect(drawn().lines.some((l) => l[0] === 6)).toBe(false);
  });

  it('draws from the prompt when the composer is empty, and hangs wrapped lines at the prompt column', async () => {
    const { terminal, overlay, drawn } = loadHarness();
    await paint(terminal, ['❯ '], { row: 6, col: 2 });
    // 56 text columns per row (60 - 2 indent - 2 margin).
    overlay.appendText('one two three four five six seven eight nine ten eleven twelve');
    expect(drawn().lines).toEqual([
      [6, 2, 'one two three four five six seven eight nine ten eleven '],
      [7, 2, 'twelve'],
    ]);
  });

  it('draws an upload token as its label and sends the path', async () => {
    const { terminal, overlay, drawn } = loadHarness();
    await paint(terminal, ['❯ '], { row: 6, col: 2 });
    overlay.appendText('see ');
    overlay.appendToken('[Image #1]', '/w/.codeman-uploads/paste-1.png');
    expect(drawn().lines).toEqual([[6, 2, 'see [Image #1]']]);
    expect(overlay.pendingText).toBe('see /w/.codeman-uploads/paste-1.png');
  });

  // A remote session's pane is a local tmux attach client in front of the remote
  // tmux, and followCursor relies on the cursor still marking Claude's caret after
  // that hop. Replays the captured nested-tmux stream (Claude Code 2.1.312).
  it('the remote (nested tmux) stream keeps the cursor at the composer caret', async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dirname, 'fixtures/claude-remote-composer-resize.json'), 'utf8')
    ) as { cols: number; rowsBefore: number; before: string[] };
    const terminal = new Terminal({ cols: fixture.cols, rows: fixture.rowsBefore, allowProposedApi: true });
    disposers.push(() => terminal.dispose());
    // The live strip a claude session's stream gets (session.ts, strip-full).
    const stream = fixture.before
      .join('')
      .replace(/\x1b\[\?(?:47|1047|1049)[hl]/g, '')
      .replace(/\x1b\[3J/g, '')
      .replace(/\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g, '');
    await new Promise<void>((done) => terminal.write(stream, done));
    const buf = terminal.buffer.active;
    const row = buf.baseY + buf.cursorY - buf.viewportY;
    expect(buf.getLine(buf.viewportY + row)?.translateToString(true)).toMatch(/^\u276f\s/); // a no-break space follows the glyph
    expect(buf.cursorX).toBe(2);
  });

  it('leaves the opencode layout alone', () => {
    const { overlay } = loadHarness('opencode');
    expect(overlay.layout).toEqual({});
  });
});
