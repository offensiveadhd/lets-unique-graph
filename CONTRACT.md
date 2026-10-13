# graph — build contract

The behaviour spec of the board. The shell (companion, chat, components, media) and the theme are defined by the engine: see [docs/UI-CONTRACT.md](https://github.com/TikoTikTok/lets/blob/main/docs/UI-CONTRACT.md) in the lets repo; this file is its former section 3.

## The board (`ui/`)

Files: `index.html`, `graph.js` (board), `layout.js` (auto layouts),
`style.css`. Uses the shell for everything non-graph.

### 1 Board
- SVG canvas filling the viewport; pan (space+drag or middle/right-drag on
  empty space... note right-click is the entity summon, so pan = space+drag,
  middle-drag, or two-finger); zoom with wheel (0.25–3, centered on cursor).
- Nodes: rounded rects, `kind` sets color: `idea` (violet), `step` (cyan),
  `decision` (magenta diamond-ish), `data` (teal), `note` (dim, wider),
  `image` (shows the uploaded image with a caption), `group` (dashed frame).
  Label editing on double-click (contentEditable foreignObject or an overlay
  input). Resize handle for `note`/`group`.
- Edges: smooth cubic beziers with arrowheads; optional label; created by
  dragging from a node's edge-port (small handle appears on hover) to another
  node, or by selecting A then `Shift+click` B. Delete with `Delete`.
- Selection: click, shift-click, marquee on empty space. Selected nodes glow
  cyan. Multi-drag. `Ctrl+D` duplicate, `Ctrl+Z/Y` undo/redo (50 steps),
  `Ctrl+A`, `Delete`.
- Toolbar (top-left, glass): add node (per kind), connect mode, auto-layout
  (tree / grid / radial), fit, clear, **"Send to Claude"** (emits
  `graph.export {graph}`), **"Ask"** (prompts a one-liner and emits
  `graph.ask {question, selection, graph?}`), chat toggle, entity toggle.
- Minimap bottom-left (optional, nice-to-have).
- Persisted to `localStorage` (`lets.graph.<windowId>`) on change; restored on
  boot; "New" clears.

### 2 Events the board emits (LIP `graph.*`)
- `graph.changed {rev, summary:{nodes,edges}, diff?}` — debounced 400 ms,
  `diff` = `{added:[ids], removed:[ids], updated:[ids]}` since last emit.
- `graph.node.select {ids, labels}` — on selection change (debounced 150 ms).
- `graph.node.create {node}` / `graph.node.update {id, patch}` /
  `graph.node.delete {ids}` / `graph.edge.create {edge}` / `graph.edge.delete {ids}`
- `graph.export {graph}` — full graph on "Send to Claude".
- `graph.ask {question, selection:[ids], graph}` — "Ask" button.
- `graph.snapshot {graph}` — answer to the `graph.snapshot` command.

Graph JSON: `{rev, nodes:[{id,label,kind,x,y,w,h,color?,text?,image?,meta?}],
edges:[{id,from,to,label?,kind?}], viewport:{x,y,zoom}}`.

### 3 Commands the board handles
`graph.load {graph, merge?}`, `graph.clear {}`, `graph.node.add {id?, label,
kind?, x?, y?, text?, near?}` (auto-places near `near` node or viewport center,
avoiding overlap), `graph.node.set {id, patch}`, `graph.node.remove {ids}`,
`graph.edge.add {from, to, label?, id?}`, `graph.edge.remove {ids}`,
`graph.layout {mode:"tree"|"grid"|"radial", root?}`, `graph.focus {ids}`
(pan/zoom to fit), `graph.highlight {ids, color?, ttl?}` (pulse glow),
`graph.annotate {id, text}` (sticky note attached to node), `graph.snapshot {}`
(reply with `graph.snapshot` event).

Every command that changes the graph goes through the same undo stack as user
edits and animates (300 ms ease) rather than jumping.

### 4 Entity context for the graph
`context()` returns `{selection:[ids], hover: nodeId|null, counts:{nodes,edges},
at:{x,y} (graph coords)}`. `quickSuggestions(ctx)`: "Add a node here",
"Connect selected", "Auto-layout", "Explain selection" (emits `graph.ask`),
"Open chat", "Paste a screenshot" (creates an `image-drop` component locally).

## 5 Native view (`native/`)

The same board as a pane inside Claude Code (lets 0.7.0, the engine's
`docs/NATIVE.md`): `/lets graph native`, or `open {mode:"native"}`. File:
`native/index.js`, one plain script (no import/export, no timers) that calls
`lets.native({init, render, on, action, export})`; it ports what it needs from
`layout.js`. Manifest: `native: {entry, title:"graph", columns:56, rows:40}`.
The host draws its native shell around the tree (companion line, chat, cards,
toasts, **Send to Claude** → `export()` → `graph.export {graph}`).

**State** (plain JSON): `graph` (exactly the exported graph JSON), `sel` (node
ids in pick order), `hl` (`[{id, color, until}]`), `undo`/`redo` (≤ 50 steps
and ≤ 400 KB: the host refuses a state over 1 MB), `pend` (the diff since the
last `graph.changed`), `intent`, `resumed`, `notice`, `ui` (add kind, layout
mode, multi-select, auto-link, list page, picture frame, next edge label).

**The pane**, top to bottom (keys are the view's; the host prefixes them):

1. Header: counts; `undo`, `redo`, `clear`; Select `layoutmode`
   (tree | grid | radial) + `layout` (the selection when ≥ 2 are selected,
   else everything); `zoom` (frame the picture on the selection) or `fit`
   (the whole board); `multi` (presses toggle instead of replace).
2. Picture: one Svg, `min(max(cols, 30) × 8, 720)` px wide, 120–480 px high
   by the board's aspect; viewBox = the board's (or the frame's) bounding box
   + 40. Dark `#120b1f` ground; nodes in their kind colour (decision hexagon,
   data cylinder, note dim sticky with its text, group dashed frame, image
   placeholder); bezier edges with arrowheads and labels; annotation
   connectors dashed; selection glows `#6bf0ff`, highlights their colour.
   Text is dropped below 6 px; over 80 000 characters it redraws without
   text, then falls back to its alt (counts and the first connections).
3. List: Button `sel:<id>` per node (kind glyph + label), 40 per page with
   `more` / `less`; selected ones `primary`, highlighted ones marked ✦.
4. One node selected: Input `label` (rename), Select `kind`, Input `text`
   (note body or details), Select `connect` (target → edge) with Input
   `elabel` (label of the next connection; on an existing pair it relabels),
   Button `unlink:<edgeId>` per connection, Input `note` (attach / update the
   annotation, `meta.by: "human"`), `unnote`, `remove`, `deselect`.
   Several selected: `link` (exactly two: first picked → second), `chain`
   (≥ 3, in pick order), `remove`, `deselect`.
5. Add: Select `addkind` (idea, step, decision, data, note, group), Button
   `autolink` (with one node selected the new node is linked from it, on by
   default), Input `add` (Enter adds it next to the selection, or auto-placed;
   a group wraps the selection; the new node becomes the selection).
6. Ask: Input `ask` → `graph.ask {question, selection, labels, graph}`; the
   question (with the selection's labels) shows in the pane's chat.

**Events and commands** are §2 and §3, with these differences: nothing
animates; `graph.changed` is sent once per command or action (no debounce),
each with its own diff; `graph.node.select` whenever the selection differs
at the end of one (Claude's `graph.focus` and removals included); a command
or action that throws reports nothing (the host puts the state back);
`graph.focus` selects the nodes, scrolls the list to them, frames the
picture on them and highlights them for 2.5 s; a highlight's ttl expires
through `ctx.after` (a redraw just past it; render re-arms it for the next
one, since the host keeps only the earliest); the Ask question is echoed in
the pane's chat (`ctx.chat`); edges skipped by `graph.load` raise
`lip.error {code: "partial"}` with `re` = the load, as the web board does;
`graph.load` with `session.resumed` shows "resumed" until the human's next
action and starts a fresh undo history. Host limits shape three more: one
call emits at most 1000 items and 1 MB, so a board over ~1 MB of JSON
refuses `graph.snapshot` with an error and tells the human it is too big to
ask about (*Send to Claude* still carries it whole), and a change of more
than 200 creates/updates (a big undo) is reported by `graph.changed` alone;
the state is at most 1 MB, so the undo history keeps ≤ 400 KB and a bigger
step ("too big to undo") clears it.

Not in the pane: pointer pan/zoom, drag, resize, marquee, duplicate, keyboard
shortcuts, image paste, the minimap, cards on the canvas (they show under the
board), `localStorage` (the state lives in the host while the pane is open;
sessions keep it after). `node scripts/native-smoke.mjs` drives the view
headlessly through the engine's runtime.

