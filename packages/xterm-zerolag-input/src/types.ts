/**
 * Minimal terminal interface required by the addon.
 *
 * Compatible with both `xterm` (pre-5.4) and `@xterm/xterm` (5.4+).
 * Consumers pass their real Terminal instance — we only use these properties.
 */
export interface XtermTerminal {
  readonly element: HTMLElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly options: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string | number;
    theme?: {
      background?: string;
      foreground?: string;
      cursor?: string;
    };
  };
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly baseY: number;
      /** Cursor column (0-based). Used by PredictiveEchoAddon. */
      readonly cursorX?: number;
      /** Cursor row, relative to baseY (0-based). Used by PredictiveEchoAddon. */
      readonly cursorY?: number;
      getLine(y: number):
        | {
            translateToString(trimRight?: boolean): string;
            /** Cell access (xterm public API). Optional: mocks/exotic hosts may omit it. */
            getCell?(x: number): { getChars(): string; getWidth(): number } | undefined;
          }
        | undefined;
    };
  };
  /** Unicode addon (e.g. Unicode11Addon) for CJK wide character width */
  readonly unicode?: {
    getStringCellWidth(str: string): number;
    activeVersion?: string;
  };
  /** Fires after the parser finishes a write chunk. Used by PredictiveEchoAddon. */
  onWriteParsed?(cb: () => void): { dispose(): void };
  /** Fires on terminal resize. Used by PredictiveEchoAddon. */
  onResize?(cb: (size: { cols: number; rows: number }) => void): { dispose(): void };
}

/**
 * Minimal addon interface matching xterm.js ITerminalAddon.
 *
 * The consumer calls `terminal.loadAddon(addon)` which invokes `activate()`.
 */
export interface XtermAddon {
  activate(terminal: XtermTerminal): void;
  dispose(): void;
}

/**
 * Position of the prompt in the terminal viewport.
 */
export interface PromptPosition {
  /** Viewport-relative row (0 = top of viewport) */
  row: number;
  /** Column of the prompt marker character */
  col: number;
}

/**
 * Prompt detection strategy.
 *
 * The overlay needs to know where user input starts on the terminal line.
 * Three strategies are supported:
 *
 * - `character`: Scan bottom-up for a specific character (e.g., `$`, `>`, `❯`)
 * - `regex`: Scan each line with a regex pattern
 * - `custom`: Full escape hatch — provide your own finder function
 */
export type PromptFinder =
  | { type: 'character'; char: string; offset?: number }
  | { type: 'regex'; pattern: RegExp; offset?: number }
  | { type: 'custom'; find: (terminal: XtermTerminal) => PromptPosition | null; offset?: number };

/**
 * Configuration options for ZerolagInputAddon.
 */
export interface ZerolagInputOptions {
  /**
   * How to find the prompt in the terminal buffer.
   *
   * The `offset` controls how many characters after the prompt marker
   * the user input begins (e.g., `"> "` = offset 2).
   *
   * @default { type: 'character', char: '>', offset: 2 }
   */
  prompt?: PromptFinder;

  /**
   * Z-index for the overlay element.
   * @default 7
   */
  zIndex?: number;

  /**
   * Background color for the overlay.
   * Set to `'transparent'` to disable the opaque background.
   * @default Read from terminal.options.theme.background
   */
  backgroundColor?: string;

  /**
   * Foreground color for overlay text.
   * @default Read from terminal.options.theme.foreground
   */
  foregroundColor?: string;

  /**
   * Whether to show a block cursor at the end of the overlay text.
   * @default true
   */
  showCursor?: boolean;

  /**
   * Cursor color (block cursor at end of text).
   * @default Read from terminal.options.theme.cursor
   */
  cursorColor?: string;

  /**
   * Scroll debounce time in ms for re-rendering when user scrolls
   * back to the bottom of the terminal.
   * @default 50
   */
  scrollDebounceMs?: number;

  /**
   * How the CLI lays out its composer, so the overlay draws typed text where
   * the CLI will (see `ComposerLayout`). Change it at runtime with `setLayout()`.
   * @default {} (no hanging indent, no right margin, character wrap, prompt anchor)
   */
  layout?: ComposerLayout;
}

/**
 * How a CLI lays out its composer. Every field is optional; the defaults are
 * the overlay's historical layout.
 */
export interface ComposerLayout {
  /**
   * Column wrapped and continued lines start at: a number, or `'prompt'` for
   * the prompt's own text column (a hanging indent, as Claude Code's `❯ `
   * composer draws it).
   * @default 0
   */
  continuationIndent?: number | 'prompt';
  /**
   * Columns the CLI leaves free at the right edge before it wraps.
   * @default 0
   */
  rightMargin?: number;
  /**
   * Wrap after the last space of a line rather than mid-word.
   * @default false
   */
  wordWrap?: boolean;
  /**
   * Continue typed text from the terminal cursor when the CLI's composer
   * already holds text the overlay never saw (a paste, an upload path, text
   * restored on a tab switch, a Shift+Enter line break): the cursor then sits
   * past the prompt start, and the CLI is already drawing everything before
   * it. Without this the overlay draws from the prompt start, over the
   * composer's own text, and the CLI's cursor shows as a second one further on.
   *
   * Only for CLIs that keep the terminal cursor at the composer caret (Claude
   * Code does). The cursor is followed only while it is on the prompt row or a
   * continuation row below it, so a cursor parked outside the composer is
   * ignored.
   * @default false
   */
  followCursor?: boolean;
}

/**
 * Read-only state snapshot of the overlay.
 */
export interface ZerolagInputState {
  /** Characters typed but not yet acknowledged by the server, tokens expanded to their values */
  pendingText: string;
  /** The same text as drawn: tokens as their labels (see `appendToken`) */
  pendingDisplayText: string;
  /** Number of characters flushed to PTY but echo not yet received */
  flushedLength: number;
  /** Text content of the flushed portion */
  flushedText: string;
  /** Whether the overlay is currently visible */
  visible: boolean;
  /** Last detected prompt position, if any */
  promptPosition: PromptPosition | null;
}

/** Cell dimensions in CSS pixels. */
export interface CellDimensions {
  width: number;
  height: number;
  /** Vertical offset (px) from cell top to where characters render. */
  charTop: number;
  /** Height of the character rendering area (px). */
  charHeight: number;
}

/** Parameters for the overlay renderer. */
export interface RenderParams {
  lines: string[];
  /**
   * Index (in code points, across all `lines`) where IME composition text
   * begins. Characters from there on are drawn underlined and marked
   * `data-zerolag-composition`. Omit when nothing is being composed.
   */
  compositionStart?: number;
  startCol: number;
  totalCols: number;
  cellW: number;
  cellH: number;
  /** Vertical offset (px) from cell top to character rendering area. */
  charTop: number;
  /** Height of the character rendering area (px). */
  charHeight: number;
  promptRow: number;
  /**
   * Visible terminal rows. When given, the overlay is kept ON SCREEN: it grows
   * upward instead of running off the bottom edge, and a wrapped prompt taller
   * than the viewport keeps its tail. Omit to lay out straight down from
   * `promptRow` (the historical behaviour).
   */
  totalRows?: number;
  font: FontStyle;
  showCursor: boolean;
  cursorColor: string;
  /** Terminal instance for CJK wide character width detection */
  terminal?: XtermTerminal | null;
  /**
   * Where each of `lines` goes (see layoutLines): its text column, the column
   * its opaque background starts at, and its code-point offset in the whole
   * text. Omit for the historical layout: the first line at `startCol`, every
   * other line at column 0.
   */
  layout?: Array<{ col: number; bgCol: number; offset: number }>;
}

/** Cached font style properties for overlay rendering. */
export interface FontStyle {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  color: string;
  backgroundColor: string;
  letterSpacing: string;
}
