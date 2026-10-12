<p align="center"><img src="icon.svg" width="72" alt=""></p>
<h1 align="center">graph</h1>
<p align="center"><b>Talk to Claude in diagrams.</b><br>The first <a href="https://github.com/TikoTikTok/lets">lets</a> unique: a dark-violet node/edge board where you draw the thing you mean while you chat, and the companion (Doto) reads, points, suggests and edits the same board.</p>

---

## Install

It comes with `lets`: the engine installs `graph` into `~/.lets/uniques/graph` the first time it runs (it is listed in the engine's `defaults.json`). Then:

```
/lets:lets graph          # or /lets graph with the alias
```

Manual: `/lets store graph` (inspect → confirm), or clone this repo into `~/.lets/uniques/graph`, or set `LETS_UNIQUES_DIRS=<parent folder>` while developing.

## What you can do

- Double-click to add a node; drag from a node's glowing dot (or select one and Shift+click another) to connect; double-click a label to rename; marquee-select; Ctrl+Z/Y; Delete.
- Node kinds: idea, step, decision, data, note, image, group. Keys 1–5 change the kind of the selection.
- Toolbar: add per kind, connect mode, tree / grid / radial auto-layout, fit, new, **Send to Claude**, **Ask**, chat, companion, `?` shortcuts.
- **Send to Claude** hands the board over: the engine saves it as a session, the window says goodbye and closes, and Claude answers in the Claude Code chat. Say *continue* (or `/lets graph resume`) and the board comes back as you left it, with Claude's suggestions drawn in.
- Right-click summons or dismisses Doto; click Doto for questions about what you selected ("Explain this", "What's missing around …?", "Suggest what comes next", "Break it into steps", "Critique it", "Better name?") or about the whole board ("What do you see?", "Suggest a structure", "Review the flow").
- Paste or drop a screenshot: it becomes an image node and Claude gets the file path.
- Everything persists locally per window and survives reloads.

## How Claude drives it

Events (up): `graph.changed`, `graph.node.select`, `graph.node.create|update|delete`, `graph.edge.create|delete`, `graph.export`, `graph.ask`, `graph.snapshot`.
Commands (down): `graph.load`, `graph.clear`, `graph.node.add|set|remove`, `graph.edge.add|remove`, `graph.layout`, `graph.focus`, `graph.highlight`, `graph.annotate`, `graph.snapshot`.

The manifest's `session` block (`export: graph.export`, `snapshot: graph.snapshot`, `restore: graph.load`) is what lets the engine save and resume boards.

[GUIDE.md](GUIDE.md) is what Claude reads when it opens the board. [CONTRACT.md](CONTRACT.md) is the build contract (board behaviour, event and command shapes). `schemas/` holds JSON Schemas for the graph document and the main messages.

## Layout

```
unique.json    LIP manifest (name, entry, domains, events, commands, permissions)
GUIDE.md       instructions for Claude
CONTRACT.md    behaviour spec
icon.svg
schemas/       JSON Schemas
ui/            index.html, graph.js (board), layout.js (auto-layouts), style.css
scripts/       validate.mjs — manifest + schema check (zero dependencies)
```

The UI imports the engine's SDK at runtime (`/sdk/lets-client.js`, `/sdk/lets-shell.js`); it has no build step and no dependencies.

## Develop

```bash
# in a lets checkout, with this repo next to it
LETS_UNIQUES_DIRS=../ node engine/bin/lets.mjs serve --open graph --verbose   # serves ../graph? no: point it at the PARENT of a folder named like the unique
```

Simplest: symlink or copy this folder to `~/.lets/uniques/graph` (that is where the default install lives) and run the engine's `serve`. Validate with `node scripts/validate.mjs` here, or `node engine/bin/lets.mjs validate <this folder>` from the engine.

## License

MIT © TikoTikTok
