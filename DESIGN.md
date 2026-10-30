---
name: Claude RC
description: A Monokai Pro Light editor window for watching and steering Claude Code agents across several machines.
colors:
  accent: '#e14775'
  accent-fill: '#cf416c'
  accent-deep: '#c73a63'
  accent-deeper: '#a82f53'
  accent-ink: '#ffffff'
  accent-text: '#a43455'
  state-green: '#269d69'
  state-yellow: '#cc7a0a'
  state-red: '#e14775'
  info-cyan: '#1c8ca8'
  state-green-text: '#1a6c48'
  state-yellow-text: '#8b5307'
  state-red-text: '#a73557'
  info-cyan-text: '#15687c'
  session-orange: '#e16032'
  session-purple: '#7058be'
  session-purple-text: '#644ea9'
  paper: '#faf4f2'
  terminal-paper: '#fefaf9'
  card: '#ede7e5'
  rule: '#e0dad9'
  rule-strong: '#d3cdcc'
  rule-hover: '#a59fa0'
  ink: '#29242a'
  ink-dim: '#605c5f'
  ink-muted: '#6a6668'
  mark-muted: '#918c8e'
  scrim: 'rgba(41, 36, 42, 0.26)'
typography:
  headline:
    fontFamily: 'Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '20px'
    fontWeight: 700
    letterSpacing: '-0.015em'
  title:
    fontFamily: 'Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '14px'
    fontWeight: 600
  body:
    fontFamily: 'Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '13px'
    fontWeight: 400
  body-small:
    fontFamily: 'Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '12px'
    fontWeight: 400
  label:
    fontFamily: 'Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    fontSize: '11px'
    fontWeight: 700
    letterSpacing: '0.06em'
  data:
    fontFamily: 'JetBrains Mono, Fira Code, SF Mono, Menlo, Monaco, monospace'
    fontSize: '12px'
    fontWeight: 400
    fontFeature: 'tnum'
  data-small:
    fontFamily: 'JetBrains Mono, Fira Code, SF Mono, Menlo, Monaco, monospace'
    fontSize: '11px'
    fontWeight: 400
    lineHeight: 1
  micro:
    fontFamily: 'JetBrains Mono, Fira Code, SF Mono, Menlo, Monaco, monospace'
    fontSize: '10px'
    fontWeight: 600
    lineHeight: 1.5
rounded:
  hairline: '1px'
  pill: '3px'
  control: '4px'
  surface: '6px'
  dot: '50%'
spacing:
  xxs: '2px'
  xs: '4px'
  sm: '6px'
  md: '8px'
  lg: '12px'
  xl: '18px'
  xxl: '26px'
components:
  button-primary:
    backgroundColor: '{colors.accent-fill}'
    textColor: '{colors.accent-ink}'
    rounded: '{rounded.control}'
    padding: '0 16px'
    height: '32px'
  button-primary-hover:
    backgroundColor: '{colors.accent-deep}'
  button-outline:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '0 16px'
    height: '32px'
  chip:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0 12px'
    height: '28px'
  chip-selected:
    backgroundColor: 'rgba(225, 71, 117, 0.12)'
    textColor: '{colors.accent-text}'
  input:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0 10px'
    height: '32px'
  explorer-row:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '3px 8px'
    height: '28px'
  explorer-row-active:
    backgroundColor: 'rgba(41, 36, 42, 0.05)'
    textColor: '{colors.accent-text}'
  status-bar:
    backgroundColor: '{colors.card}'
    textColor: '{colors.ink-dim}'
    typography: '{typography.data-small}'
    height: '24px'
    padding: '0 8px'
  board-row:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    height: '36px'
    padding: '0 10px'
  dialog:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.surface}'
    padding: '20px 22px 18px'
    width: '620px'
  toast:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.surface}'
    padding: '8px 10px 8px 12px'
  state-pill:
    typography: '{typography.micro}'
    rounded: '{rounded.pill}'
    padding: '1px 6px'
---

# Design System: Claude RC

## Overview

**Creative North Star: "The Light Workbench"**

Claude RC is drawn as a Monokai Pro Light editor window, not a dashboard. A card-tinted title bar sits on top, an explorer of machines and sessions runs down the left (264px), the terminal fills the editor area flush on the ground, and a 24px status line closes the bottom edge. The home screen is an Overview board: every session as a ruled row, grouped by machine, with the ones that need the owner first. The phone keeps the same palette and state language but lays the home screen out as a stacked list of tappable rows above a fixed 40px key bar.

The surface is flat. Depth comes from two tonal steps (paper ground, card chrome one step darker) and 1px rules, and only overlays (dialogs, toasts, floating windows, drawers) cast a shadow. Colour is spent on two things: state (working, waiting, needs-you, error, offline) and selection. Everything else is ink on paper. Words take Manrope; paths, numbers, models, times, keys and the terminal take JetBrains Mono.

The direction contract named purple as the selection colour and red as "waiting". The build landed differently: the Monokai pink accent (`accent`) carries selection, focus and the accent buttons, yellow means waiting, and red (the same pink) means needs-you or error. This file records the build. There is no 44px activity bar; the explorer's top entries (Overview, New session, Machines & accounts, Running elsewhere) do that job.

**Key Characteristics:**

- Light only (`color-scheme: light`); the Monokai Pro Light values are the palette for UI and terminal.
- Flat paper ground, card-tinted chrome, 1px rules; shadow only on things that float.
- Colour means state or selection, never decoration.
- State is carried by mark shape as well as colour, so it survives any colour vision.
- One sans face for words, one mono face for data, one seven-step size scale.
- Dense editor rhythm on desktop (24 to 36px rows), 44px+ touch targets on the phone.

## Colors

A warm off-white paper with near-black plum ink, a single hot-pink accent, and the Monokai state hues used sparingly as marks. Every colour that is also used as small text has a darker text step beside it (`state-green-text`, `accent-text` ...): the bright Monokai hue draws the mark, the text step holds the 4.5:1 PRODUCT.md asks for, on `paper`, on `card` and on a 12 to 16% tint of itself. In the CSS these are `--green-text`, `--yellow-text`, `--red-text`, `--cyan-text`, `--purple-text` and `--accent-text`, each the hue mixed toward black with `color-mix`; skins whose hues already read as text leave them equal to the hue.

### Primary

- **Monokai Pink** (`accent`): selection, focus outlines (2px), the focused input border, selected chips (as a 12% tint with `accent-text` ink), the active Overview entry (13% tint), the outline of the phone's Enter key, the waking machine ring. Also serves as `state-red`, so pink always means "look here".
- **Pink Fill** (`accent-fill`): the fill of the one primary button per surface (New session, Start session, Save, Create, Allow, Wake), with `accent-ink`. The accent darkened until white ink holds 4.5:1 (white on `accent` itself is 3.9:1).
- **Deep Pink** (`accent-deep`): the primary button's hover fill.
- **Deeper Pink** (`accent-deeper`): the gear hover on the run split; a pressed step below `accent-deep`.
- **Pink Text** (`accent-text`): the ink for anything accent-coloured that is text: the active session name and number, the selected chip label, the active Overview and settings entries, the active palette row title, the explorer's New session link, the phone's Enter label. 5.4:1 on `card`, 4.6:1 on the 13% accent tint. A custom accent (Appearance) derives it the same way, `color-mix(in srgb, var(--accent) 68%, #000)`, the step that keeps every preset at 4.5:1.

### Secondary (state)

- **Working Green** (`state-green`): working marks (filled dot), connected dot, machine online, usage ring under 50%, success toast mark, git clean.
- **Waiting Amber** (`state-yellow`): waiting marks (ringed dot), attention diamond in the status bar, machine reachable but unusable, usage ring mid band, warning toast mark, git dirty, pinned history tint.
- **Needs-you Pink** (`state-red`): needs-you diamond, error square, offline machine, high usage, conflict, the approvals badge. Same value as `accent`.
- **Info Cyan** (`info-cyan`): info toast mark and the tint behind the session search badge.
- **State text** (`state-green-text`, `state-yellow-text`, `state-red-text`, `info-cyan-text`): the same states as words: board state column, state pills, plan-usage numbers, git badges, hints, the needs-you section title, the Sonnet badge, case subtitles. 5.1 to 5.2:1 on `card`.

### Tertiary (session colours)

- **Monokai Orange** (`session-orange`) and **Monokai Purple** (`session-purple`): user-assigned session colours and the Opus / plan-agent / event badges. As text, purple takes `session-purple-text` (it is 4.48:1 on `card` by itself).

### Neutral

- **Paper** (`paper`): the ground: page, editor area, dialogs, inputs, chips, toasts, floating window bodies.
- **Terminal Paper** (`terminal-paper`): the xterm background, a hair lighter than the ground.
- **Card** (`card`): chrome one step down: title bar, explorer, status bar, window title bars, settings callouts.
- **Rule** (`rule`): every 1px divider and border; also the control fill (header stat pills, badges) and hovered control fill.
- **Strong Rule** (`rule-strong`): dialog and window outlines, control borders, the empty part of a usage ring.
- **Hover Rule** (`rule-hover`): hovered control borders and the 2px ring-glow focus substitute.
- **Ink** (`ink`): all primary text (13.98:1 on paper).
- **Dim Ink** (`ink-dim`): secondary text, section and field labels, status bar text, small labels on the `rule` control fill, row actions on a tinted row. 6.0:1 on paper, 5.4:1 on card, 4.6:1 on the 13% accent tint.
- **Muted Ink** (`ink-muted`): row numbers, counts, hint text, model names, meta lines. 5.2:1 on paper, 4.6:1 on card; on the `rule` fill or a tint use `ink-dim`.
- **Mark Grey** (`mark-muted`): the quiet marks that are not text: hollow asleep rings, detection hints, done/exited dots, the empty board mark, the machine swatch. Monokai's own `#918c8e`, which as text measured 2.7:1 on card.
- **Scrim** (`scrim`): flat modal backdrop, no blur.

### Named Rules

**The State-or-Selection Rule.** Colour on this surface means a session's state or the current selection. A section mark, icon tile or callout that only wants to look nice takes `card` and `ink-dim`, as the settings surface does.

**The Mark-and-Text Rule.** A hue draws marks; its `-text` step writes words. Never set small text in a bright state hue, `accent`, `mark-muted` or a faded (`opacity` < 1) ink: each fell between 2 and 3.6:1 before this rule.

**The Shape-Carries-State Rule.** Every state mark differs in shape as well as hue: filled dot working, ringed dot waiting, diamond needs-you, square error, dash done or exited, hollow ring asleep. Never add a state that differs from another by colour alone.

## Typography

**UI Font:** Manrope (variable, self-hosted `fonts/manrope-variable.woff2`), with -apple-system, BlinkMacSystemFont, Segoe UI fallback
**Data / Terminal Font:** JetBrains Mono (variable, self-hosted), with Codeman Terminal Symbols (bundled, supplies the glyphs Claude Code draws that JetBrains Mono lacks: ⎿ ⏵ ⏺ ✻ ✔ ✘ ...) and then Fira Code, SF Mono, Menlo fallback

**Character:** A plain geometric sans that stays quiet at 12 to 14px, beside a monospace that makes every path, count and clock read as data. Form controls inherit the page face; `code`, `kbd`, `samp` and `pre` take the mono face.

### Hierarchy

All sizes come from the `--fs-*` scale: 10, 11, 12, 13, 14, 16, 20px. Nothing in the fork sits off it.

- **Headline** (700, 20px, -0.015em): the Overview title and dialog titles. The largest text in the product; there is no display size.
- **Title** (600, 14px): phone row titles, settings callout titles.
- **Body** (400 or 600, 13px): session names, board rows, buttons, chips, inputs, toasts. Weight 600 marks names and the active row.
- **Body small** (400, 12px): hints, notes, the explorer search, toolbar buttons.
- **Label** (700, 11px, 0.06em, uppercase): functional headers that name the group or field directly below them: explorer machine sections, board sections, New session field labels. The phone uses a 10px, 0.09em variant in `ink-muted`.
- **Data** (JetBrains Mono 12px, tabular figures): folders, models, state and age on board rows.
- **Data small** (JetBrains Mono 11px, line-height 1): the whole status bar, row numbers, counts, history subtitles, palette subtitles, lifecycle tables.
- **Micro** (JetBrains Mono 10px, 600): state pills on floating windows.

### Named Rules

**The Two Faces Rule.** Words in Manrope, data in JetBrains Mono. A path, number, model, time, shortcut or hash is data; a project name is a label and takes the UI face even inside a mono field.

**The One Scale Rule.** Every size is a `--fs-*` step. A new size means a new step on the scale, not a literal.

## Layout

Desktop is an editor grid: title bar (`--header-height` 36px), explorer (`--tab-rail-width` 264px, fixed), editor area, status bar (24px at 768px and up). The Overview board is centred in the editor area at `max-width: 1180px` with `28px 32px 48px` padding. Focus mode (`data-focus="on"`) removes title bar, explorer and status bar so the terminal fills the window; it is desktop only.

Rhythm is tight and ruled rather than spaced: board rows are 36px on a six-column grid (number 18px, mark 12px, name, folder, model, state) with 12px gaps; explorer rows 28px with 8px gaps; status items 20px. Sections are separated by 26px and a 1px rule, form fields by 18px. There is no spacing token in the CSS; the frontmatter steps are the values that recur.

Phones (`max-width: 599px`): the home screen becomes a single column of 56px-minimum rows; the bottom toolbar is a fixed 40px bar with 32px keys (Stop, Enter, Attach, Settings) honouring the left and right safe-area insets; the keyboard accessory bar sits directly above it with 32px keys. Tabs run across the top as a horizontal strip. Breakpoints in use: 599px (phone), 767/768px (status line and focus mode).

## Elevation & Depth

Flat by default. Chrome is separated from content by one tonal step (`card` against `paper`) and a 1px `rule`, never by a shadow; the upstream header, explorer, toolbar and tab shadows are all set to `none` on this skin. Shadows exist only on surfaces that float above the workbench.

### Shadow Vocabulary

- **Overlay** (`box-shadow: 0 12px 36px rgba(41, 36, 42, 0.14), 0 2px 8px rgba(41, 36, 42, 0.08)`): dialogs, the command palette, toasts, floating log/subagent/lifecycle windows, the approvals drawer, the files and git panels.
- **Subtle edge** (`box-shadow: 0 -1px 0 rgba(41, 36, 42, 0.06)`): a hairline lift where a fixed bar meets scrolling content.
- **Focus ring substitute** (`box-shadow: 0 0 0 2px #a59fa0`): replaces the upstream accent glow; real keyboard focus is a 2px `accent` outline.

### Named Rules

**The Floats-Only Rule.** A shadow means the surface floats over the workbench and can be dismissed. Anything docked (bars, explorer, board, cards in a list) is flat.

**The Plain Scrim Rule.** Modal backdrops are the flat `scrim`; no backdrop blur on this skin.

## Shapes

Small, square-ish corners. Controls, chips, rows and buttons use 4px (`--btn-radius`); dialogs, floating windows, toasts, cards in the approvals list and the command palette use 6px; status items and state pills 3px; the explorer's machine swatch 1px. Status marks are 7 to 9px circles (or a rotated square for the diamond). Outlines are always 1px; the only 2px line is the focus outline. Usage rings are 11px conic-gradient donuts masked to a 2.6px hole.

## Components

### Buttons

- **Shape:** 4px corners, 32px tall in dialogs, 30px on the board header, 24px in the status/toolbar, 26px for small inline actions.
- **Primary (one per surface):** the single main action of a surface is filled: `accent-fill` with `accent-ink`, `accent-deep` on hover, flat, 4px. That is the board's and the phone home's New session, the New session dialog's Start session, the settings and case dialogs' Save/Create (`.btn-primary`), an approval's Allow and Wake. Everything beside it stays neutral (the grey `rule` control fill, an outline or a ghost); a surface never has two accent buttons.
- **Outline:** Cancel and secondary actions: transparent with a 1px `control-border`, `ink` text.
- **Ghost:** close buttons and status items: no fill, `control-bg-hover` on hover.
- **Focus:** 2px `accent` outline, 2px offset (inset -2px on explorer rows).

### Chips

- **Style:** 28px tall, 12px side padding, 4px corners, `paper` fill, 1px `control-border`, body text.
- **Selected:** `accent` border, 12% accent tint, `accent-text` ink, weight 600 (`aria-checked="true"`).
- **Machine chips** carry the machine-state dot before the label.
- **Search filter chips:** 10% accent tint over paper, 45% accent border, `accent-text` ink when active.

### Inputs / Fields

- **Style:** 32px tall (26px in the explorer search), 10px padding, 4px corners, `paper` fill, 1px `control-border`. Folder and path inputs use the mono face; the project name uses the UI face.
- **Focus:** border turns `accent`, no outline, no glow.
- **Error:** a plain `state-red-text` line of body text under the form.
- **Switches:** off track is `control-bg` with a visible border; focus-visible adds a 2px 35% accent ring.

### Navigation (Explorer)

- Top entries (Overview, New session, Machines & accounts, Running elsewhere): 30px rows with a line icon, weight 600; Overview is tinted 13% accent with `accent-text` ink while the board is showing; New session is `accent-text` text.
- Machine sections read as explorer folders: a 7px square swatch, an 11px uppercase label in `ink-dim`, a mono count right-aligned. No box, no card.
- Session rows: one line, 28px, the shortcut number in mono `ink-muted` right-aligned in a 14px column, then the state dot, then the name ellipsised. Hover is `control-bg-hover`; active is the accent tint with an `accent-text` weight-600 name and number (no pill behind the number) and `ink-dim` row actions, no outline.

### Status Bar (signature)

- Desktop only (768px+): 24px tall, `card` fill, 1px top rule, every item JetBrains Mono 11px in `ink-dim`.
- Items are 20px, 6px padding, 3px corners; buttons among them get a hover fill and `ink` text.
- **Connection:** a 7px dot, green connected, yellow reconnecting, red offline.
- **Attention:** a 7px yellow diamond and `ink` weight-600 text ("Nothing waiting" / count waiting).
- **Machines:** one item per machine with the machine-state dot and its usage rings.
- **Usage rings:** one 11px ring per window, the arc is the share used, green, then yellow (`--mid`), then red (`--high`); the unused arc is `rule-strong`.
- **Detection hints:** a 6px hollow `mark-muted` ring, deliberately quiet.

### Machine Dots

One dot language for the status bar and New session chips: 7px circle; green online, yellow online but unusable, hollow 1.5px `mark-muted` ring asleep, red offline, hollow 1.5px `accent` ring pulsing (1.2s, off under reduced motion) while waking.

### Overview Board (signature)

- Header: headline title, a 13px `ink-dim` tabular summary, the New session button pushed right, a 1px rule beneath.
- Sections: label-style title (the needs-you section's title turns `state-red-text`), a lower-case kind note in `ink-muted`, a mono count right.
- Rows: 36px, 1px rule between, state mark (9px) in the state hue, name 600, folder and model in mono, state and age mono right-aligned with the state word in its `-text` step. Working marks breathe (1.6s opacity) unless reduced motion is set.

### Dialogs & Sheets

- **Dialog:** `<dialog>` 620px wide (720px for the Running dialog), 6px corners, 1px `rule-strong`, `paper`, overlay shadow, flat scrim, 20/22px padding, 18px between fields. Title row: headline + secondary action + 28px ghost close.
- **Recents list:** ruled rows with name 600, machine/system right in `ink-dim`, path below in mono 11px `ink-muted`.
- **Phone sheets** (case picker, settings popover) take `floating-bg`, `control-border` and the overlay shadow.

### Floating Windows

Log viewer, subagent and plan windows, and the lifecycle log share one chrome: `paper` body, 1px `rule-strong`, 6px corners, overlay shadow, a `card` title bar with a 1px rule, title in 13px 600. No emoji title glyphs. State pills are 10px mono 600 on a 3px pill: the state's text step as ink on a 14 to 16% tint of the hue; neutral states use `control-bg` and `ink-dim`.

### Toasts

Top-right under the title bar, max 420px, `paper`, 1px `rule-strong`, 6px corners, overlay shadow, body text. The card stays neutral; the kind is a 7px dot before the message (green, red, yellow, cyan). Every toast has a close button. Slides in from the right over 0.2s.

### Banners

Full-width strips under the title bar (offline, reboot restore, host wake): 6px 12px padding, 12px weight-600 `ink` text, the state colour as a 10 to 12% tint over `paper` with a 1px bottom rule of the same colour at 45 to 50% (red for offline, yellow for restore and wake). A 7px state dot leads; the offline dot pulses (1.4s, off under reduced motion). Detail text is mono 11px `ink-dim`. Never a solid state-colour bar.

### Tab Rows (phone)

On phones the session tabs run as a horizontal strip across the top: rounded chips with the state dot, a small agent badge (`SH` / `CC`) on a yellow tint, and the ellipsised name.

### Phone Home

A header row with the "Claude RC" wordmark in `ink` at the headline step (the desktop title bar's treatment; a display name set in App Settings replaces it) and the New session button opposite: the surface's one primary, `accent-fill`, flat, 4px, 44px tall. Below it a vertical list of 56px-minimum session rows on `card` with 6px corners: state dot, a two-line body (name 14px 600, `shell · path` 11px `ink-muted`) plus a mono meta line ("STARTED 1h ago · IDLE 1m", keys set apart by case, not by fading), a 3px state pill (state hue border, `-text` ink) and a chevron. Needs-you rows blink red (2.5s), waiting rows blink yellow (3.5s), working rows breathe green (2.2s); the blink is the state hue mixed into `card` (12 / 12 / 10%), and the path and meta lines of those rows step up to `ink-dim` so they hold 4.5:1 at the tint, and reduced motion holds that tint instead. Machine chips, approval answers and the More button take the 4px control radius, the Run menu the 6px floating radius. Approvals that can be answered inline get an answer strip of buttons under the row.

## Do's and Don'ts

### Do:

- **Do** take every colour from the skin tokens (`--accent`, `--green`, `--text-dim`, `--border` ...); the "light everywhere" block exists because literal dark-default colours broke on this skin.
- **Do** keep chrome flat: `card` against `paper` with a 1px `rule`, and put the overlay shadow only on things that float.
- **Do** give every state a distinct mark shape as well as a hue (dot, ring, diamond, square, dash).
- **Do** set paths, numbers, models, times, keys and hashes in JetBrains Mono, and words in Manrope.
- **Do** pick font sizes from the `--fs-*` scale (10 / 11 / 12 / 13 / 14 / 16 / 20px).
- **Do** show focus as a 2px `accent` outline, and write accent-coloured text in `accent-text`.
- **Do** give a state its `-text` step whenever it is words, and keep the bright hue for its mark.
- **Do** fill exactly one button per surface, the main action, with `accent-fill`; the rest stay neutral.
- **Do** honour `prefers-reduced-motion` on every looping animation (working breathe, waking pulse).
- **Do** keep phone keys at 32px inside 40px bars and respect the safe-area insets.

### Don't:

- **Don't** add gradients, glass, backdrop blur or glows; the skin collapses the upstream gradient pairs to one colour and turns the ring glow into a plain outline.
- **Don't** use colour for decoration: section icons, callouts and settings marks are neutral `card` / `ink-dim`.
- **Don't** use emoji as icons or title glyphs; they were removed from floating windows and subagent activity because they drew as tofu or clip-art.
- **Don't** put white text on the state hues; state pills use the state's text step as ink on its own tint.
- **Don't** set text in `mark-muted`, `state-green`, `state-yellow`, `info-cyan`, `accent` or `accent-deep`, or fade text with `opacity`: on `card` they measure 2.7 to 4.1:1, under the 4.5:1 PRODUCT.md requires. Use `ink`, `ink-dim`, `ink-muted` (not on a fill or tint), `accent-text` or a state's `-text` step.
- **Don't** reintroduce dark navy, the upstream daylight blue, or a dark mode.
- **Don't** add a new corner radius; 3 / 4 / 6px plus round marks cover every shipped surface.
