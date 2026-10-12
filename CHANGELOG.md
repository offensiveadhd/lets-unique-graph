# Changelog

## 0.3.2 — 2026-10-13

- Fix: the page's favicon pointed at `../icon.svg`, which the host resolves
  outside the unique (404); it is `icon.svg` now (the host looks in `ui/`
  first, then the unique root).

## 0.3.1 — 2026-10-13

- The companion is **Doto** (lets 0.5.0): the click menu and the "away" toasts
  say Doto; GUIDE describes his voice on the board (do, then tell; one short
  line ending on a dot; layout changes still need a yes).
- README screenshot re-captured with Doto.

## 0.3.0 — 2026-10-12

- **Send to Claude is a handoff.** The manifest declares
  `session: {export: graph.export, snapshot: graph.snapshot, restore: graph.load}`;
  the engine (lets 0.4.0) saves the board, closes the window and Claude answers
  in the Claude Code chat. `/lets graph resume` reopens the board intact.
- The board plays the companion's new expressions: a wink when you connect
  two nodes, a cheer when you press Send.
- GUIDE: handoff/resume etiquette; expressions for Claude.
- Manifest: `repository` points at this repo; `engine: ">=0.4.0"`.

## 0.2.0 — 2026-10-10

- Moved out of the engine repo into its own repository (history preserved).
  Installed by default by `lets` (listed in the engine's `defaults.json`).
- Selection-aware Pip menu (explain, what's missing, what comes next, break it
  into steps, critique, better name; board-level: what do you see, suggest a
  structure, review the flow) — each a `graph.ask` with ids and labels.
- "Pip is away" hints on Send to Claude / Ask when Claude is not listening.
- Image nodes render from the host's `/uploads/…` URL.

## 0.1.0 — 2026-10-09

First board: nodes, edges, layouts, minimap, undo, Send to Claude, Ask,
paste-to-image-node, full LIP command set.
