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

