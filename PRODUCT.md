# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner of this fork (andy). A developer who runs many Claude Code agents at once across several of their own machines — a main Windows PC (native Windows projects and WSL Ubuntu projects), a laptop (also Windows + WSL), and an always-on home server (arr, 192.168.0.50) that hosts this dashboard. The job: keep every agent moving without hunting through terminal tabs — see which agent needs them, answer it, start new work on the right machine with the right account, and keep an eye on usage limits.

Primary device is a desktop browser on a large screen; the phone is for glancing at status and approving things while away. Only reachable on the home LAN or over WireGuard.

## Product Purpose

A single, always-available control room for Claude Code sessions spread over multiple PCs. It replaces a Windows Terminal window full of SSH tabs: sessions keep running in tmux on each machine, the dashboard on the server reconnects to them, and the same live sessions are there whether the owner is at the office, at home, on the laptop or on the phone.

Success: the owner never opens an SSH tab to reach an agent, always knows within a glance which agent is waiting on them, and can start a new session on any machine/system/folder/account in a few keystrokes.

## Positioning

A personal fork of Codeman (Ark0N/Codeman, MIT), reshaped around one person's multi-PC, multi-account setup rather than a generic agent dashboard: sessions grouped by machine, native Windows and WSL projects side by side, and account switching (claude-swap and a GLM gateway) built into session launch.

## Operating Context

- Machines: DESKTOP-TJLEEOP (192.168.0.28, Windows 11 + WSL Ubuntu-22.04), a laptop (Windows + WSL), and arr (Ubuntu server, Docker, SWAG reverse proxy). Codeman runs in Docker on arr at https://codeman.siumimi.com behind SWAG: LAN + WireGuard (10.10.10.0/24) only, Tinyauth/Pocket ID login (admins group).
- Each PC hosts its sessions in tmux inside WSL. Windows-native projects run the Windows `claude` binary inside that WSL tmux (file access stays native-speed); Linux projects run Claude in WSL.
- Accounts: Claude subscriptions managed with claude-swap (`cswap`: `run <account> -- …`, directory→account maps, auto-switch near rate limits, `list --json` usage); a GLM endpoint through a local Anthropic-compatible gateway on each PC's localhost:3000 (the `use-glm` shell function sets `ANTHROPIC_BASE_URL`, key and model vars); plain Claude login (`use-claude`).
- Wake-on-LAN for sleeping PCs (UpSnap exists on the server; Codeman can send the packet itself).
- Today's workflow being replaced: Windows Terminal with many SSH tabs, one per machine/project/account.

## Capabilities and Constraints

Front and center:
- Sessions across PCs: grouped by machine, attention states (working / waiting / blocked), keyboard switching, mouse, full-screen session view, and a usable new-session flow (machine → Windows or WSL → folder → model → account).
- Remote machine management as a first-class flow: many machines (several PCs and several servers), adding one, testing the connection, waking it, seeing it offline/asleep, reconnecting.
- Recents: recently used machine + folder (+ account) combinations are the fastest way to start a session.
- Claude Code updates itself on each machine; status detection depends on Claude's TUI and hooks, so the fork must keep merging upstream Codeman fixes. A broken detector must degrade to "unknown", never to a wrong state.
- Usage and approvals: token/plan usage per session and per account (including every cswap account), the approvals inbox, notifications.
- Files, git and previews: file browser, git status/diff, HTML/image/doc previews, web tabs.
- Image/file pasting into prompts — must work for remote (SSH) sessions, which upstream refuses.
- Respawn and auto-resume on usage limit.

Moved out of the way (kept, not removed): Ralph loop, orchestrator, cron, voice, gesture control, Docker cases, other agent CLIs.

Technical constraints: upstream architecture rules in CLAUDE.md and src/web/CLAUDE.md (skins are four synced pieces, per-device vs synced settings, base path, CSP from 'self' + jsdelivr). Must stay mergeable enough to pull upstream updates. No WAN exposure, ever.

Undecided: laptop host details; whether the GLM gateway is reachable from WSL on every PC.

## Brand Commitments

- Personal tool; product name may stay "Codeman".
- Owner-stated binding constraints: light mode; Monokai Pro Light as the palette for both UI and terminal; a good monospace terminal font such as JetBrains Mono; the current default look (dark navy/blue, generic AI-template feel) is explicitly rejected.

## Evidence on Hand

Real data only: the owner's machines, sessions, accounts and usage as the running instance reports them. No invented testimonials, metrics or screenshots.

## Product Principles

1. Attention first: what needs the owner right now is the loudest thing on screen; everything else waits quietly.
2. Machine is a first-class noun: every session, path, account and failure is shown with the PC and system (Windows/WSL) it belongs to.
3. Fewer, deeper surfaces: features the owner does not use leave the main view rather than competing for it.
4. Never lose an agent: disconnects, sleeping PCs and reboots are visible states with an obvious recovery, not silent failures.
5. Keyboard and mouse both: every frequent action has a shortcut and a clickable target.

## Accessibility & Inclusion

Single sighted user on desktop; keep WCAG AA contrast for text (the light palette must hold 4.5:1), visible focus, and full keyboard operation.
