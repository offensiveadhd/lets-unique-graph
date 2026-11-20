# Changelog

## 0.4.1 — 2026-10-14

- **The pane looks like the board from the first second.** The picture is
  always there: an empty board is drawn as the dark dotted canvas around the
  spot where the first node will land, with Doto on it and the hint ("Empty
  board", how to start, the intent) inside the picture. Doto sits on the
  board in native mode now, a small version of the web sprite, beside the
  node last touched (the selected one, else the newest), in the view's
  corner when that node is out of frame.
- **The picture is live.** It is drawn as an interactive SVG (lets-native
  draws it in a script-less frame): hovering a node shows its name, kind and
  the start of its details; Doto blinks; `graph.highlight` glows pulse. A
  board too big for the tree budget still falls back to the light, static
  picture.
- The empty-board hint under the picture is one dim line now (the box is
  gone); the intent stays on its own line.
- `scripts/native-smoke.mjs` checks the empty picture, the tooltips and the
  pulse. GUIDE: the *Native mode* section says what moved.

## 0.4.0 — 2026-10-13

- **The board opens inside Claude Code.** `/lets graph native` shows it as a
  pane in Claude Code's sidebar (lets 0.7.0 with the lets-native mod) instead
  of a browser window: a picture of the whole board, your nodes as buttons,
  an editor for the selection (rename, kind, details, connect with an
  optional label, unlink, note, remove), multi-select to connect or remove
  several, an *add* box (a new node follows the selected one, linked) and an
  *ask* box. Undo/redo, the three layouts, *zoom to selection* / *fit board*
  and clear are in the header.
- Claude and Doto behave the same in both modes: the same commands, events,
  *Send to Claude* handoff and resume. In the pane, when Claude points at
  nodes (`graph.focus`) they are selected and the picture zooms to them.
- Manifest: `native` block, `engine: ">=0.7.0"`; the schema copy is synced
  with the engine's. `scripts/validate.mjs` checks the native script parses;
  `scripts/native-smoke.mjs` tests the pane headlessly.
- GUIDE: a short *Native mode* section; duplicate event notes merged.

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
