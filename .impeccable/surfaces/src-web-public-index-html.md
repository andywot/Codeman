---
version: 1
slug: "src-web-public-index-html"
primary_target: "src/web/public/index.html"
related_targets: ["src/web/public/styles.css"]
---

## Scope

The Codeman web app shell (src/web/public): explorer, editor area, overview board, status bar, dialogs. Mode: Operate. Desktop first, phone second.

## Audience and job

One owner watching 4-8 Claude Code agents across several PCs and servers; needs to see who is waiting, jump there, enlarge it, and start sessions on any machine/system/folder/account.

## Constraints

Monokai Pro Light palette for UI and terminal; JetBrains Mono in the terminal; light mode; no dark navy, gradients, glows or card piles; fewer visible buttons; status never hidden.

## Direction contract

THESIS: Codeman is a Monokai Pro Light editor window: machines and sessions are an explorer tree, agents open as editor tabs. Refuses floating cards on a dark canvas.
OWN-WORLD: #FAF4F2 ground, #29242A ink, sidebars one step darker, 1px rules, no shadows except overlays. Accents mean state only: red waiting, yellow blocked, green working, cyan info, purple selection. JetBrains Mono for terminal and data.
STORY: See every agent by machine with its state mark, jump to the one waiting, enlarge it, start the next from recents.
FIRST VIEWPORT: 44px activity bar; 260px explorer (New session, then machines > sessions with mark and number); editor area with tabs, default Overview tab: board grouped by machine; 24px status bar with accounts, usage and waiting count.
FORM: Editor Workbench, rank 1, seed 9de92ee2.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

Laptop host details; cswap and GLM profile wiring; remote image paste transport.
