/**
 * graph — the native view (lets 0.7.0, docs/NATIVE.md in the engine).
 *
 * The same board as ui/graph.js, drawn as a pane inside Claude Code: one SVG
 * picture of the board, the nodes as a list of buttons, an editor for the
 * selection, an "add" input and an "ask" input. The graph model, the commands
 * Claude sends and the events the board emits are the web board's
 * (CONTRACT.md §2–3), so GUIDE.md holds in both modes.
 *
 * This is one plain script (no import/export, no timers): the lets host
 * evaluates it in a node:vm context, and it calls lets.native({...}) once, at
 * the bottom. The state is plain JSON (arrays and objects, no Maps or Sets);
 * render() only reads it (and asks for a redraw when a highlight expires).
 * Handlers are atomic: one that throws leaves the state as it was. The host
 * wraps the tree in its native shell (companion line, chat, components,
 * toasts, "Send to Claude"), so none of that is here.
 *
 *   1. constants            6. board operations (shared by Claude and the human)
 *   2. helpers              7. commands (Claude → board)
 *   3. layouts              8. actions (human → board)
 *   4. model + undo         9. the picture (one SVG)
 *   5. outgoing events     10. the pane (render) and lets.native
 */

// ───────────────────────────── 1. constants ─────────────────────────────

const UNDO_MAX = 50;
const UNDO_BYTES = 400000;      // the host refuses a state over 1 MB: the history gets at most this much of it
const MAX_LOAD_NODES = 2000;
const MAX_LOAD_EDGES = 5000;
const LIST_PAGE = 40;           // node buttons shown at once
const CONNECT_OPTIONS = 100;    // targets offered by the "connect" select
const LINKS_SHOWN = 24;         // a node's connections listed in the editor
const EMIT_MAX = 1000000;       // one call emits at most 1000 items and 1 MB in all: a payload must fit, with room to spare
const GRANULAR_MAX = 200;       // per change: more creates/updates than this go out as graph.changed alone
const HL_TTL = 3000;            // graph.highlight default, ms
const FOCUS_TTL = 2500;         // how long graph.focus highlights its nodes
const SVG_BUDGET = 80000;       // characters; the whole tree must stay under 96 KB
const PIC_MAX_H = 480;          // picture height cap, px
const PIC_MIN_H = 120;
const VIEW_PAD = 40;            // graph units around the board in the picture
const VIEW_MIN = { w: 360, h: 160 };   // a lone node is not blown up to the pane width
const EMPTY_VIEW = { w: 480, h: 270 }; // what an empty board shows around its centre: room for Doto and the hint
const NOMINAL = { w: 1200, h: 800 };   // the web board's usual screen: "the view centre" of an empty board
const LIVE = true;                     // the picture is an interactive SVG: hover titles, Doto blinks, highlights pulse (the host draws it in a script-less frame)

const BG = '#120b1f';
const TEXT = '#efe9ff';
const EDGE = '#8f7fc0';
const SEL = '#6bf0ff';
const HL_DEFAULT = '#ff6bd6';

/** Node kinds: default size and the label a fresh node gets (graph.js KINDS). */
const KINDS = {
  idea: { w: 168, h: 60, label: 'New idea' },
  step: { w: 176, h: 60, label: 'New step' },
  decision: { w: 184, h: 76, label: 'Decide?' },
  data: { w: 168, h: 70, label: 'Data' },
  note: { w: 224, h: 128, label: 'Note' },
  image: { w: 240, h: 200, label: 'Image' },
  group: { w: 400, h: 260, label: 'Group' },
};
const KIND_KEYS = ['idea', 'step', 'decision', 'data', 'note'];
const ADD_KINDS = KIND_KEYS.concat('group');
const KIND_COLOR = { idea: '#a66bff', step: '#6bf0ff', decision: '#ff6bd6', data: '#3ee6c1', note: '#a99cd0', image: '#7a64c0', group: '#5a44a0' };
const KIND_FILL = { idea: '.16', step: '.14', decision: '.16', data: '.14', note: '.10', image: '.10', group: '.06' };
const KIND_GLYPH = { idea: '○', step: '▸', decision: '◇', data: '≡', note: '✎', image: '▣', group: '▢' };
const NODE_KEYS = ['label', 'kind', 'x', 'y', 'w', 'h', 'color', 'text', 'image', 'meta'];
const LAYOUT_MODES = ['tree', 'grid', 'radial'];

// ───────────────────────────── 2. helpers ─────────────────────────────

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (v !== null && v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const same = (a, b) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const basename = (p) => String(p || '').split(/[\\/]/).pop();
const r = Math.round;
const r1 = (v) => Math.round(v * 10) / 10;

/** Cuts `s` to `n` characters with an ellipsis. */
const fit = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };

/** Sanitises an id coming from the outside world; null when empty (graph.js cleanId). */
function cleanId(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 64);
  return s || null;
}
const listOf = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(cleanId).filter(Boolean);

/** A CSS colour we are willing to put into the SVG (hex, rgb()/hsl(), or a name). */
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]{1,60}\)|[a-z]{3,24})$/i;
const validColor = (c) => typeof c === 'string' && COLOR_RE.test(c.trim());

/**
 * Escapes the text of a `<text>` element. The host allows only the five XML
 * entities (no numeric references) and does not scan what a `<text>` says as
 * long as the document has no `<style>` block (this one never does), so a
 * label may read "data: users" or "onload=1".
 */
const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const xml = (s) => String(s).replace(/[&<>]/g, (c) => XML[c]);

/** Greedy word wrap into at most `max` lines of `cpl` characters; the last line gets "…" when cut. */
function wrapLines(s, cpl, max) {
  if (max <= 0) return [];
  const lines = [];
  for (const para of String(s).slice(0, 600).split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/)) {
      if (!word) continue;
      while (word.length > cpl) { if (line) { lines.push(line); line = ''; } lines.push(word.slice(0, cpl)); word = word.slice(cpl); }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cpl) line += ' ' + word;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
    if (lines.length > max) break;
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (lines.length > max) { lines.length = max; lines[max - 1] = fit(lines[max - 1] + '…', cpl); }
  return lines;
}

// ───────────────────────────── 3. layouts (ported from ui/layout.js) ─────────────────────────────
// Pure functions over {nodes, edges}; positions are top-left corners; each
// returns {id: {x, y}} for the nodes it placed. Maps and Sets are fine here:
// they never reach the state.

const fin = (v) => (Number.isFinite(v) ? v : 0);
const dims = (n) => ({ w: n.w > 0 ? n.w : 160, h: n.h > 0 ? n.h : 60 });

/** Bounding box of rect-like nodes; null for an empty list. */
function bounds(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (!n) continue;
    const d = dims(n), x = fin(n.x), y = fin(n.y);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + d.w); y1 = Math.max(y1, y + d.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const contains = (o, i) => fin(i.x) >= fin(o.x) && fin(i.y) >= fin(o.y) && fin(i.x) + dims(i).w <= fin(o.x) + dims(o).w && fin(i.y) + dims(i).h <= fin(o.y) + dims(o).h;
const intersects = (a, b) => fin(a.x) < fin(b.x) + dims(b).w && fin(a.x) + dims(a).w > fin(b.x) && fin(a.y) < fin(b.y) + dims(b).h && fin(a.y) + dims(a).h > fin(b.y);

/** Restricts a graph to `ids`; drops self-loops and dangling edges. */
function subset(graph, ids) {
  const want = ids ? new Set(ids) : null;
  const nodes = (graph.nodes || []).filter((n) => n && (!want || want.has(n.id)));
  const ok = new Set(nodes.map((n) => n.id));
  return { nodes, edges: (graph.edges || []).filter((e) => e && ok.has(e.from) && ok.has(e.to) && e.from !== e.to) };
}

/** BFS spanning forest; children in reading order (top-to-bottom, then left-to-right). */
function forest(nodes, edges, root, directed) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reading = (a, b) => (fin(byId.get(a).y) - fin(byId.get(b).y)) || (fin(byId.get(a).x) - fin(byId.get(b).x));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
    if (!directed) adj.get(e.to).push(e.from);
  }
  for (const list of adj.values()) list.sort(reading);
  const all = nodes.map((n) => n.id).sort(reading);
  const seeds = [];
  if (root && byId.has(root)) seeds.push(root);
  if (directed) for (const id of all) if (indeg.get(id) === 0) seeds.push(id);
  seeds.push(...all);
  const children = new Map(nodes.map((n) => [n.id, []]));
  const depth = new Map(), order = [], roots = [];
  for (const s of seeds) {
    if (depth.has(s)) continue;
    roots.push(s);
    depth.set(s, 0);
    const queue = [s];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      order.push(id);
      for (const nb of adj.get(id)) {
        if (depth.has(nb)) continue;
        depth.set(nb, depth.get(id) + 1);
        children.get(id).push(nb);
        queue.push(nb);
      }
    }
  }
  return { roots, children, depth, order, byId };
}

/** Shifts `pos` so its bounding box starts at `origin` (default: the input nodes' box). */
function anchorTo(pos, nodes, origin) {
  const ids = Object.keys(pos);
  if (!ids.length) return pos;
  const o = origin || bounds(nodes) || { x: 0, y: 0 };
  let x0 = Infinity, y0 = Infinity;
  for (const id of ids) { x0 = Math.min(x0, pos[id].x); y0 = Math.min(y0, pos[id].y); }
  for (const id of ids) pos[id] = { x: r(pos[id].x - x0 + o.x), y: r(pos[id].y - y0 + o.y) };
  return pos;
}

/** Layered tree, left→right; parents centred on their subtree; extra roots stack below. */
function treeLayout(graph, opts = {}) {
  const { root, ids, gapMain = 84, gapCross = 28, origin } = opts;
  const { nodes, edges } = subset(graph, ids);
  if (!nodes.length) return {};
  const f = forest(nodes, edges, root, true);
  const mainOf = (id) => dims(f.byId.get(id)).w;
  const crossOf = (id) => dims(f.byId.get(id)).h;
  const colSize = [];
  for (const id of f.order) { const d = f.depth.get(id); colSize[d] = Math.max(colSize[d] || 0, mainOf(id)); }
  const colPos = [];
  let acc = 0;
  for (let d = 0; d < colSize.length; d++) { colPos[d] = acc; acc += colSize[d] + gapMain; }
  const ext = new Map();
  const kidsSpan = (id) => f.children.get(id).reduce((s, k, i) => s + ext.get(k) + (i ? gapCross : 0), 0);
  const measure = (id) => { for (const k of f.children.get(id)) measure(k); ext.set(id, Math.max(crossOf(id), kidsSpan(id))); };
  const pos = {};
  const assign = (id, start) => {
    const d = f.depth.get(id);
    pos[id] = { x: colPos[d] + (colSize[d] - mainOf(id)) / 2, y: start + (ext.get(id) - crossOf(id)) / 2 };
    let s = start + (ext.get(id) - kidsSpan(id)) / 2;
    for (const k of f.children.get(id)) { assign(k, s); s += ext.get(k) + gapCross; }
  };
  let start = 0;
  for (const rt of f.roots) { measure(rt); assign(rt, start); start += ext.get(rt) + gapCross * 2; }
  return anchorTo(pos, nodes, origin);
}

/** Grid in flow order (BFS from the roots), aiming for a ~16:10 block. */
function gridLayout(graph, opts = {}) {
  const { root, ids, gap = 36, origin } = opts;
  const { nodes, edges } = subset(graph, ids);
  if (!nodes.length) return {};
  const f = forest(nodes, edges, root, true);
  let cw = 0, ch = 0;
  for (const n of nodes) { const d = dims(n); cw = Math.max(cw, d.w); ch = Math.max(ch, d.h); }
  const count = f.order.length;
  const c = Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * ((ch + gap) / (cw + gap)) * 1.6))));
  const pos = {};
  f.order.forEach((id, i) => {
    const d = dims(f.byId.get(id));
    pos[id] = { x: (i % c) * (cw + gap) + (cw - d.w) / 2, y: Math.floor(i / c) * (ch + gap) + (ch - d.h) / 2 };
  });
  return anchorTo(pos, nodes, origin);
}

/** Radial: the root (given, or the best connected) stays put; sectors by leaf count. */
function radialLayout(graph, opts = {}) {
  const { ids, gap = 44 } = opts;
  const { nodes, edges } = subset(graph, ids);
  if (!nodes.length) return {};
  let root = opts.root && nodes.some((n) => n.id === opts.root) ? opts.root : null;
  if (!root) {
    const deg = new Map();
    for (const e of edges) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
    root = nodes.slice().sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0) || fin(a.y) - fin(b.y) || fin(a.x) - fin(b.x))[0].id;
  }
  const f = forest(nodes, edges, root, false);
  let maxW = 0, maxH = 0;
  for (const n of nodes) { const d = dims(n); maxW = Math.max(maxW, d.w); maxH = Math.max(maxH, d.h); }
  const ring = Math.hypot(maxW, maxH) * 0.8 + gap;
  const slot = Math.hypot(maxW, maxH) + 12;
  const leaves = new Map();
  const countLeaves = (id) => {
    const kids = f.children.get(id);
    const v = kids.length ? kids.reduce((s, k) => s + countLeaves(k), 0) : 1;
    leaves.set(id, v);
    return v;
  };
  const component = (rootId) => {
    const total = countLeaves(rootId);
    let maxDepth = 0;
    const stack = [rootId];
    while (stack.length) { const id = stack.pop(); maxDepth = Math.max(maxDepth, f.depth.get(id)); stack.push(...f.children.get(id)); }
    const base = f.depth.get(rootId);
    const radius = [0];
    for (let d = 1; d <= maxDepth - base; d++) radius[d] = Math.max(radius[d - 1] + ring, d === 1 ? (total * slot) / (2 * Math.PI) : 0);
    const centres = {};
    const place = (id, a0, a1) => {
      const d = f.depth.get(id) - base, a = (a0 + a1) / 2;
      centres[id] = d === 0 ? { x: 0, y: 0 } : { x: radius[d] * Math.cos(a), y: radius[d] * Math.sin(a) };
      let s = a0;
      for (const k of f.children.get(id)) { const span = ((a1 - a0) * leaves.get(k)) / leaves.get(id); place(k, s, s + span); s += span; }
    };
    place(rootId, -Math.PI / 2, (3 * Math.PI) / 2);
    const box = bounds(Object.keys(centres).map((id) => { const d = dims(f.byId.get(id)); return { x: centres[id].x - d.w / 2, y: centres[id].y - d.h / 2, w: d.w, h: d.h }; }));
    return { centres, box };
  };
  const comps = f.roots.map(component);
  const centres = Object.assign({}, comps[0].centres);
  let cursor = comps[0].box.x + comps[0].box.w + gap * 2;
  for (const c of comps.slice(1)) {
    const dx = cursor - c.box.x, dy = -(c.box.y + c.box.h / 2);
    for (const id of Object.keys(c.centres)) centres[id] = { x: c.centres[id].x + dx, y: c.centres[id].y + dy };
    cursor += c.box.w + gap * 2;
  }
  const rn = f.byId.get(root), rd = dims(rn);
  const ox = fin(rn.x) + rd.w / 2, oy = fin(rn.y) + rd.h / 2;
  const pos = {};
  for (const id of Object.keys(centres)) { const d = dims(f.byId.get(id)); pos[id] = { x: r(centres[id].x - d.w / 2 + ox), y: r(centres[id].y - d.h / 2 + oy) }; }
  return pos;
}

const LAYOUTS = { tree: treeLayout, grid: gridLayout, radial: radialLayout };

/**
 * A top-left spot for a `want.w × want.h` rect clear of `obstacles`. With
 * `near`: right / below / above / left of that node first; then a spiral.
 */
function findFreeSpot(obstacles, want, opts = {}) {
  const { near = null, margin = 24, gap = 72 } = opts;
  const w = want.w > 0 ? want.w : 160, h = want.h > 0 ? want.h : 60;
  const free = (x, y) => !obstacles.some((o) => {
    const d = dims(o), ox = fin(o.x), oy = fin(o.y);
    return x < ox + d.w + margin && x + w + margin > ox && y < oy + d.h + margin && y + h + margin > oy;
  });
  const tries = [];
  if (near) {
    const d = dims(near), nx = fin(near.x), ny = fin(near.y), cx = nx + d.w / 2, cy = ny + d.h / 2;
    tries.push([nx + d.w + gap, cy - h / 2], [cx - w / 2, ny + d.h + gap * 0.6], [cx - w / 2, ny - h - gap * 0.6], [nx - w - gap, cy - h / 2]);
  } else tries.push([fin(want.x), fin(want.y)]);
  for (const [x, y] of tries) if (free(x, y)) return { x: r(x), y: r(y) };
  const [ox, oy] = tries[0];
  const sx = w / 2 + margin, sy = h / 2 + margin;
  for (let ring = 1; ring <= 32; ring++) {
    const cand = [];
    for (let i = -ring; i <= ring; i++) { cand.push([i, -ring], [i, ring]); if (Math.abs(i) !== ring) cand.push([-ring, i], [ring, i]); }
    cand.sort((a, b) => Math.hypot(a[0] * sx, a[1] * sy) - Math.hypot(b[0] * sx, b[1] * sy));
    for (const [i, j] of cand) if (free(ox + i * sx, oy + j * sy)) return { x: r(ox + i * sx), y: r(oy + j * sy) };
  }
  return { x: r(ox), y: r(oy) };
}

// ───────────────────────────── 4. model + undo ─────────────────────────────

/** @typedef {{id:string,label:string,kind:string,x:number,y:number,w:number,h:number,color?:string,text?:string,image?:string,meta?:object}} GNode */
/** @typedef {{id:string,from:string,to:string,label?:string,kind?:string}} GEdge */
/** @typedef {[string, object|null, object|null]} Row  [id, before, after] */
/** @typedef {{label:string, nodes:Row[], edges:Row[], size:number}} Step  one undo step */
/**
 * @typedef {object} State
 * @property {{rev:number, nodes:GNode[], edges:GEdge[], viewport:{x:number,y:number,zoom:number}}} graph  the board, as exported
 * @property {string[]} sel                 selected node ids, in the order they were picked
 * @property {string} lastSel               the selection last reported (graph.node.select)
 * @property {{id:string,color:string,until:number}[]} hl   highlights; until 0 = until cleared
 * @property {Step[]} undo
 * @property {Step[]} redo
 * @property {{added:string[],removed:string[],updated:string[]}} pend   the diff since the last graph.changed
 * @property {string} intent                what the board was opened for (ctx.args.intent)
 * @property {string|null} resumed          the session id when this board is a resume
 * @property {string} notice                a one-off line (cleared by the human's next action)
 * @property {{addKind:string, layout:string, multi:boolean, autolink:boolean, from:number, frame:string[], edgeLabel:string}} ui
 */

/** @returns {State} */
function initialState(ctx) {
  const intent = ctx.args && typeof ctx.args.intent === 'string' ? ctx.args.intent.trim().slice(0, 300) : '';
  return {
    graph: { rev: 0, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    sel: [], lastSel: '', hl: [], undo: [], redo: [],
    pend: { added: [], removed: [], updated: [] },
    intent, resumed: null, notice: '',
    ui: { addKind: 'idea', layout: 'tree', multi: false, autolink: true, from: 0, frame: [], edgeLabel: '' },
  };
}

const nodeOf = (state, id) => state.graph.nodes.find((n) => n.id === id) || null;
const edgeOf = (state, id) => state.graph.edges.find((e) => e.id === id) || null;
const edgeBetween = (state, a, b) => state.graph.edges.find((e) => e.from === a && e.to === b) || null;
const obstacles = (state) => state.graph.nodes.filter((n) => n.kind !== 'group');

/** Normalises any node-ish object into the canonical, fixed-key-order shape (graph.js normNode). */
function normNode(raw) {
  const kind = has(KINDS, raw.kind) ? raw.kind : 'idea';
  const def = KINDS[kind];
  const n = {
    id: String(raw.id),
    label: str(raw.label, 300),
    kind,
    x: r(num(raw.x, 0)),
    y: r(num(raw.y, 0)),
    w: r(clamp(num(raw.w, def.w), 40, 4000)),
    h: r(clamp(num(raw.h, def.h), 32, 4000)),
  };
  if (validColor(raw.color)) n.color = raw.color.trim();
  if (raw.text != null && raw.text !== '') n.text = str(raw.text, 8000);
  if (typeof raw.image === 'string' && raw.image) n.image = raw.image.slice(0, 2048);
  if (isObj(raw.meta)) { try { const s = JSON.stringify(raw.meta); if (s.length <= 8000) n.meta = JSON.parse(s); } catch (e) { /* drop */ } }
  return n;
}

/** Normalises an edge; `id`, `from`, `to` must already be clean. */
function normEdge(raw) {
  const e = { id: String(raw.id), from: String(raw.from), to: String(raw.to) };
  if (raw.label != null && raw.label !== '') e.label = str(raw.label, 160);
  if (typeof raw.kind === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(raw.kind) && raw.kind !== 'solid') e.kind = raw.kind;
  return e;
}

/**
 * A working copy of the board: Maps by id, in array order (a replaced item
 * keeps its place, a new one goes last). Changes are made here and written
 * back to the state's arrays once (writeBack), so big loads stay linear.
 * Maps are fine: a working copy lives for one call and never reaches the state.
 */
function working(state) {
  return { N: new Map(state.graph.nodes.map((n) => [n.id, n])), E: new Map(state.graph.edges.map((e) => [e.id, e])), adj: null };
}
/** Edge ids by node id, built on first use and kept in step by setE. */
function adjacency(w) {
  if (!w.adj) { w.adj = new Map(); for (const e of w.E.values()) link(w, e, true); }
  return w.adj;
}
function link(w, e, on) {
  for (const id of [e.from, e.to]) {
    if (!w.adj.has(id)) w.adj.set(id, new Set());
    if (on) w.adj.get(id).add(e.id); else w.adj.get(id).delete(e.id);
  }
}
function setN(w, id, v) { if (v) w.N.set(id, clone(v)); else w.N.delete(id); }
function setE(w, id, v) {
  const old = w.E.get(id);
  if (old && w.adj) link(w, old, false);
  if (v) { const e = clone(v); w.E.set(id, e); if (w.adj) link(w, e, true); } else w.E.delete(id);
}
function writeBack(state, w) { state.graph.nodes = Array.from(w.N.values()); state.graph.edges = Array.from(w.E.values()); }

/** A fresh `n_xxxxx` / `e_xxxxx` id that no node or edge uses (in the transaction `t` when given). */
function newId(state, prefix, ctx, t) {
  for (;;) {
    const id = ctx.id(prefix);
    if (t ? !t.N.has(id) && !t.E.has(id) : !nodeOf(state, id) && !edgeOf(state, id)) return id;
  }
}

// A transaction is a working copy that also remembers the before-state of
// everything it touches: that is the undo step.
const tNode = (t, id) => t.N.get(id) || null;
function touchN(t, id) { if (!t.nb.has(id)) t.nb.set(id, clone(tNode(t, id))); }
function touchE(t, id) { if (!t.eb.has(id)) t.eb.set(id, clone(t.E.get(id) || null)); }
function putNode(t, n) { touchN(t, n.id); setN(t, n.id, n); }
function putEdge(t, e) { touchE(t, e.id); setE(t, e.id, e); }
function dropEdge(t, id) { if (!t.E.has(id)) return; touchE(t, id); setE(t, id, null); }
function dropNode(t, id) {
  if (!t.N.has(id)) return;
  for (const eid of Array.from(adjacency(t).get(id) || [])) dropEdge(t, eid);
  touchN(t, id);
  setN(t, id, null);
}
/** Drops nodes plus the annotation notes attached to them. */
function dropNodes(t, ids) {
  const all = new Set(ids);
  for (const n of t.N.values()) if (n.meta && n.meta.attachedTo && all.has(n.meta.attachedTo)) all.add(n.id);
  for (const id of all) dropNode(t, id);
}

/**
 * Runs `fn(tx)` as one undoable step. Inside `fn`, read the board through
 * the transaction (tNode, t.N, t.E): the state's arrays change only at the end.
 * @param {'user'|'claude'} origin  the human's edits also emit graph.node.* / graph.edge.*
 * @returns {boolean} whether anything changed
 */
function mutate(state, ctx, label, origin, fn) {
  const t = Object.assign(working(state), { nb: new Map(), eb: new Map() });
  fn(t);
  const step = { label, nodes: [], edges: [], size: 0 };
  for (const [id, b] of t.nb) { const a = clone(tNode(t, id)); if (!same(b, a)) step.nodes.push([id, b, a]); }
  for (const [id, b] of t.eb) { const a = clone(t.E.get(id) || null); if (!same(b, a)) step.edges.push([id, b, a]); }
  if (!step.nodes.length && !step.edges.length) return false;
  writeBack(state, t);
  record(state, step, ctx);
  applied(state, step, origin, ctx);
  return true;
}

/** Pushes a step on the undo stack, within UNDO_MAX steps and UNDO_BYTES. */
function record(state, step, ctx) {
  step.size = JSON.stringify(step).length;
  state.redo = [];
  if (step.size > UNDO_BYTES) {
    state.undo = [];
    ctx.toast('That change is too big to undo.', 'warn');
    return;
  }
  state.undo.push(step);
  let total = state.undo.reduce((s, x) => s + x.size, 0);
  while (state.undo.length > UNDO_MAX || total > UNDO_BYTES) total -= state.undo.shift().size;
}

/** Undo one step (the human's edits and Claude's commands share the stack). */
function undo(state, ctx) {
  const s = state.undo.pop();
  if (!s) return false;
  state.redo.push(s);
  replay(state, s, 1, ctx);
  return true;
}

function redo(state, ctx) {
  const s = state.redo.pop();
  if (!s) return false;
  state.undo.push(s);
  replay(state, s, 2, ctx);
  return true;
}

/** Applies a step's before (idx 1) or after (idx 2) states. Like the web board, undo/redo count as the human's edits. */
function replay(state, s, idx, ctx) {
  const w = working(state);
  const ch = { nodes: [], edges: [] };
  for (const row of s.nodes) { setN(w, row[0], row[idx]); ch.nodes.push([row[0], row[3 - idx], row[idx]]); }
  for (const row of s.edges) { setE(w, row[0], row[idx]); ch.edges.push([row[0], row[3 - idx], row[idx]]); }
  writeBack(state, w);
  applied(state, ch, 'user', ctx);
}

/** Post-change bookkeeping shared by commits, undo and redo. */
function applied(state, ch, origin, ctx) {
  state.graph.rev++;
  const p = { added: new Set(state.pend.added), removed: new Set(state.pend.removed), updated: new Set(state.pend.updated) };
  for (const [id, b, a] of ch.nodes) markDiff(p, id, b, a);
  for (const [id, b, a] of ch.edges) markDiff(p, id, b, a);
  state.pend = { added: Array.from(p.added), removed: Array.from(p.removed), updated: Array.from(p.updated) };
  if (origin === 'user') emitGranular(ch, ctx);
  const live = (id) => !!nodeOf(state, id);
  state.sel = state.sel.filter(live);
  state.ui.frame = state.ui.frame.filter(live);
  state.hl = state.hl.filter((h) => live(h.id) || !!edgeOf(state, h.id));
}

/** The full graph JSON, safe to send to Claude (graph.js exportGraph). */
function exportGraph(state) {
  const g = state.graph, v = g.viewport;
  return { rev: g.rev, nodes: clone(g.nodes), edges: clone(g.edges), viewport: { x: r(v.x), y: r(v.y), zoom: Math.round(v.zoom * 1000) / 1000 } };
}

// ───────────────────────────── 5. outgoing events ─────────────────────────────

/** Folds one change (before `b`, after `a`) into a diff of Sets (graph.js markDiff). */
function markDiff(p, id, b, a) {
  if (!b && a) { if (p.removed.delete(id)) p.updated.add(id); else p.added.add(id); }
  else if (b && !a) { if (!p.added.delete(id)) p.removed.add(id); p.updated.delete(id); }
  else if (!p.added.has(id)) p.updated.add(id);
}

/**
 * Ends every command and action that stood: graph.changed with the diff
 * since the last one (natively there is no debounce: one per command or
 * action), and graph.node.select when the selection differs from the one
 * last reported.
 */
function flush(state, ctx) {
  const p = state.pend, g = state.graph;
  if (p.added.length || p.removed.length || p.updated.length) {
    ctx.emit('graph.changed', { rev: g.rev, summary: { nodes: g.nodes.length, edges: g.edges.length }, diff: p });
    state.pend = { added: [], removed: [], updated: [] };
  }
  const key = state.sel.join(',');
  if (key !== state.lastSel) {
    state.lastSel = key;
    ctx.emit('graph.node.select', { ids: state.sel.slice(), labels: state.sel.map((id) => { const n = nodeOf(state, id); return n ? n.label : ''; }) });
  }
}

/**
 * Fine-grained events for the human's own edits (never for Claude's commands).
 * Deletes go out batched; a change with more than GRANULAR_MAX creates and
 * updates (a big undo) is left to graph.changed, so a call stays inside the
 * host's budget of 1000 items.
 */
function emitGranular(ch, ctx) {
  const many = ch.nodes.concat(ch.edges).filter((row) => row[2]).length > GRANULAR_MAX;
  const delN = [], delE = [];
  for (const [id, b, a] of ch.nodes) {
    if (!a) delN.push(id);
    else if (many) continue;
    else if (!b) ctx.emit('graph.node.create', { node: clone(a) });
    else {
      const patch = {};
      for (const k of NODE_KEYS) if (!same(b[k], a[k])) patch[k] = a[k] === undefined ? null : a[k];
      ctx.emit('graph.node.update', { id, patch });
    }
  }
  if (delN.length) ctx.emit('graph.node.delete', { ids: delN });
  for (const [id, b, a] of ch.edges) {
    if (!a) delE.push(id);
    else if (!b && !many) ctx.emit('graph.edge.create', { edge: clone(a) });
  }
  if (delE.length) ctx.emit('graph.edge.delete', { ids: delE });
}

/** Whether an event payload fits in one call's emit budget (1 MB in all). */
const fits = (data) => JSON.stringify(data).length < EMIT_MAX;

// ───────────────────────────── 6. board operations ─────────────────────────────

/** Where a new thing goes without `near`: the middle of what the picture shows, or the web board's screen centre. */
function viewCenter(state) {
  const b = bounds(state.graph.nodes);
  if (b) return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const v = state.graph.viewport, z = v.zoom || 1;
  return { x: (NOMINAL.w / 2 - v.x) / z, y: (NOMINAL.h / 2 - v.y) / z };
}

/** The first index of the node list's last page. */
const lastPage = (state) => Math.floor(Math.max(0, state.graph.nodes.length - 1) / LIST_PAGE) * LIST_PAGE;

/** Scrolls the node list so `id` is on the page shown. */
function scrollTo(state, id) {
  const i = state.graph.nodes.findIndex((n) => n.id === id);
  if (i >= 0) state.ui.from = Math.floor(i / LIST_PAGE) * LIST_PAGE;
}

/** Drops highlights whose time is up (render ignores them already; this keeps the state small). */
function purgeHighlights(state, now) { state.hl = state.hl.filter((h) => !h.until || h.until > now); }

/** Highlights still glowing at `now` (until 0 = until cleared). */
const liveHighlights = (state, now) => state.hl.filter((h) => !h.until || h.until > now);

/**
 * Glows nodes/edges. ttl 0 keeps it until cleared; empty ids clear all
 * (graph.js highlight). There are no timers here: ctx.after asks the host for
 * a redraw just past the ttl, and render leaves out what has expired.
 */
function highlight(state, ctx, ids, color, ttl) {
  if (!ids.length) { state.hl = []; return; }
  const c = validColor(color) ? color.trim() : '';
  const life = ttl === 0 ? 0 : clamp(num(ttl, HL_TTL), 300, 120000);
  for (const id of ids) {
    if (!nodeOf(state, id) && !edgeOf(state, id)) continue;
    state.hl = state.hl.filter((h) => h.id !== id);
    state.hl.push({ id, color: c, until: life ? ctx.now() + life : 0 });
  }
  if (life) ctx.after(Math.min(life + 50, 60000));
}

/** Auto-layout of `ids` (or every node). Groups re-wrap their members; annotations follow their node. */
function applyLayout(state, ctx, mode, { root, ids = null, origin = 'user' } = {}) {
  if (!has(LAYOUTS, mode)) throw new Error(`unknown layout mode "${mode}" (tree | grid | radial)`);
  const want = ids ? new Set(ids) : null;
  const all = state.graph.nodes.slice();
  const movable = all.filter((n) => n.kind !== 'group' && !(n.meta && n.meta.attachedTo) && (!want || want.has(n.id)));
  if (!movable.length) return 0;
  const groups = all.filter((g) => g.kind === 'group' && movable.some((m) => contains(g, m)));
  const members = groups.map((g) => [g.id, movable.filter((m) => contains(g, m)).map((m) => m.id)]);
  const old = new Map(movable.map((n) => [n.id, { x: n.x, y: n.y }]));
  const pos = LAYOUTS[mode]({ nodes: movable, edges: state.graph.edges }, { root: cleanId(root) || undefined });
  mutate(state, ctx, `layout ${mode}`, origin, (t) => {
    for (const id of Object.keys(pos)) { const n = tNode(t, id); if (n) putNode(t, Object.assign({}, n, pos[id])); }
    for (const n of all) {
      const tid = n.meta && n.meta.attachedTo, cur = tNode(t, n.id);
      if (!tid || !pos[tid] || !cur) continue;
      putNode(t, Object.assign({}, cur, { x: cur.x + pos[tid].x - old.get(tid).x, y: cur.y + pos[tid].y - old.get(tid).y }));
    }
    for (const [gid, mids] of members) {
      const b = bounds(mids.map((id) => tNode(t, id))), g = tNode(t, gid);
      if (b && g) putNode(t, Object.assign({}, g, { x: r(b.x - 28), y: r(b.y - 52), w: r(b.w + 56), h: r(b.h + 80) }));
    }
  });
  return Object.keys(pos).length;
}

/** Removes everything (undoable). */
function clearBoard(state, ctx, origin) {
  const had = state.graph.nodes.length + state.graph.edges.length;
  mutate(state, ctx, 'clear', origin, (t) => {
    for (const id of Array.from(t.E.keys())) dropEdge(t, id);
    for (const id of Array.from(t.N.keys())) dropNode(t, id);
  });
  state.ui.from = 0;
  if (origin === 'user' && had) ctx.toast('Board cleared. Undo brings it back.');
}

const noteHeight = (text) => clamp(30 + (Math.ceil(text.length / 26) + text.split('\n').length - 1) * 18, 56, 320);

/** Attaches, updates or (empty text) removes the sticky note on a node (graph.js cmdAnnotate). */
function annotate(state, ctx, id, text, by, origin) {
  const target = nodeOf(state, id);
  if (!target) throw new Error(`no node "${id}"`);
  const body = str(text, 4000).trim();
  const label = origin === 'user' ? 'annotate' : 'Claude annotated';
  const existing = state.graph.nodes.find((n) => n.meta && n.meta.attachedTo === id && n.meta.annotation);
  if (existing) {
    mutate(state, ctx, label, origin, (t) => {
      if (body) putNode(t, normNode(Object.assign({}, existing, { text: body, h: Math.max(existing.h, noteHeight(body)) })));
      else dropNode(t, existing.id);
    });
    return;
  }
  if (!body) return;
  const w = 210, h = noteHeight(body);
  const spot = findFreeSpot(obstacles(state), { x: target.x + target.w + 36, y: target.y - h - 20, w, h }, { margin: 16 });
  const node = normNode({ id: newId(state, 'n_', ctx), kind: 'note', label: '', text: body, x: spot.x, y: spot.y, w, h, meta: { attachedTo: id, annotation: true, by } });
  mutate(state, ctx, label, origin, (t) => putNode(t, node));
}

/** The human connects two nodes; an existing from→to edge gets the label instead. @returns {string|null} */
function connect(state, ctx, from, to, label) {
  if (!nodeOf(state, from) || !nodeOf(state, to) || from === to) return null;
  const ex = edgeBetween(state, from, to);
  if (ex) {
    if (label && ex.label !== label) mutate(state, ctx, 'label edge', 'user', (t) => putEdge(t, normEdge(Object.assign({}, ex, { label }))));
    else ctx.toast('Already connected.');
    return ex.id;
  }
  const e = normEdge({ id: newId(state, 'e_', ctx), from, to, label });
  mutate(state, ctx, 'connect', 'user', (t) => putEdge(t, e));
  return e.id;
}

/** Converts nodes to another kind, resizing those still at their default size (graph.js setKindOf). */
function setKindOf(state, ctx, ids, kind) {
  if (!ids.length || !KIND_KEYS.includes(kind)) return;
  mutate(state, ctx, `make ${kind}`, 'user', (t) => {
    for (const id of ids) {
      const n = tNode(t, id);
      if (!n || n.kind === kind || n.kind === 'group' || n.kind === 'image') continue;
      const od = KINDS[n.kind], nd = KINDS[kind], resize = n.w === od.w && n.h === od.h;
      putNode(t, normNode(Object.assign({}, n, { kind, w: resize ? nd.w : n.w, h: resize ? nd.h : n.h })));
    }
  });
}

// ───────────────────────────── 7. commands (Claude → board) ─────────────────────────────
// Same semantics as ui/graph.js section 10. A throw reaches Claude as
// lip.error (or a failed lip.ack), and the host puts the state back as it was.

/** graph.load {graph, merge?}: replace (or upsert); nodes without x/y are laid out as a tree beside the rest. */
function cmdLoad(state, d, ctx) {
  const g = d.graph;
  if (!isObj(g)) throw new Error('expected {graph:{nodes, edges}}');
  const merge = !!d.merge;
  const inNodes = (Array.isArray(g.nodes) ? g.nodes : []).filter(isObj).slice(0, MAX_LOAD_NODES);
  const inEdges = (Array.isArray(g.edges) ? g.edges : []).filter(isObj).slice(0, MAX_LOAD_EDGES);
  const unplaced = [];
  let skipped = 0;
  mutate(state, ctx, merge ? 'merge graph' : 'load graph', 'claude', (t) => {
    if (!merge) {
      for (const id of Array.from(t.E.keys())) dropEdge(t, id);
      for (const id of Array.from(t.N.keys())) dropNode(t, id);
    }
    for (const raw of inNodes) {
      const id = cleanId(raw.id) || newId(state, 'n_', ctx, t);
      const prev = tNode(t, id);
      if (!prev && (num(raw.x, null) == null || num(raw.y, null) == null)) unplaced.push(id);
      putNode(t, normNode(Object.assign({}, prev || {}, raw, { id })));
    }
    const edges = [];
    for (const raw of inEdges) {
      const from = cleanId(raw.from), to = cleanId(raw.to);
      if (!t.N.has(from) || !t.N.has(to)) { skipped++; continue; }
      const e = normEdge(Object.assign({}, raw, { id: cleanId(raw.id) || newId(state, 'e_', ctx, t), from, to }));
      putEdge(t, e);
      edges.push(e);
    }
    if (unplaced.length) autoPlace(state, t, unplaced, edges);
  });
  const v = g.viewport;
  if (!merge && isObj(v) && num(v.x, null) != null && num(v.y, null) != null && num(v.zoom, null) != null) state.graph.viewport = { x: +v.x, y: +v.y, zoom: clamp(+v.zoom, 0.25, 3) };
  // the web board pans to merged nodes; the picture here already shows the whole board (unless framed)
  if (!merge) { state.ui.frame = []; state.ui.from = 0; }
  // a partial load, as the web board reports it (the host sets `re` to this command)
  if (skipped) ctx.emit('lip.error', { code: 'partial', message: `graph.load: skipped ${skipped} edge(s) with unknown endpoints` });
  if (d.session && d.session.resumed) {
    // a resume: the board comes back as it was left; its history starts here
    state.resumed = String(d.session.id || '');
    state.notice = '↺ resumed: the board is as you left it';
    state.undo = [];
    state.redo = [];
  }
}

/** Lays out nodes that arrived without coordinates (tree), to the right of the rest (in transaction `t`). */
function autoPlace(state, t, ids, edges) {
  const set = new Set(ids);
  const nodes = ids.map((id) => tNode(t, id));
  const pos = treeLayout({ nodes, edges }, { origin: { x: 0, y: 0 } });
  const blk = bounds(nodes.map((n) => Object.assign({}, n, pos[n.id])));
  const others = Array.from(t.N.values()).filter((n) => !set.has(n.id));
  let ox, oy;
  if (others.length) { const b = bounds(others); ox = b.x + b.w + 120; oy = b.y; } else { const c = viewCenter(state); ox = c.x - blk.w / 2; oy = c.y - blk.h / 2; }
  for (const n of nodes) { n.x = r(pos[n.id].x + ox); n.y = r(pos[n.id].y + oy); }
}

/** graph.node.add: near `near`, or auto-placed without overlap; an existing id patches. */
function cmdNodeAdd(state, d, ctx) {
  const id = cleanId(d.id) || newId(state, 'n_', ctx);
  if (nodeOf(state, id)) { cmdNodeSet(state, { id, patch: d }, ctx); return; }
  const kind = has(KINDS, d.kind) ? d.kind : 'idea';
  const w = clamp(num(d.w, KINDS[kind].w), 40, 4000), h = clamp(num(d.h, KINDS[kind].h), 32, 4000);
  let x = num(d.x, null), y = num(d.y, null);
  if (x == null || y == null) {
    const near = d.near != null ? nodeOf(state, cleanId(d.near)) : null;
    const c = viewCenter(state);
    const spot = findFreeSpot(obstacles(state), { x: c.x - w / 2, y: c.y - h / 2, w, h }, { near });
    x = spot.x; y = spot.y;
  }
  const node = normNode(Object.assign({}, d, { id, kind, x, y, w, h }));
  mutate(state, ctx, 'Claude added a node', 'claude', (t) => putNode(t, node));
}

/** graph.node.set {id, patch}. A kind change resizes a node still at its kind's default size. */
function cmdNodeSet(state, d, ctx) {
  const id = cleanId(d.id);
  const old = id && nodeOf(state, id);
  if (!old) throw new Error(`no node "${d.id}"`);
  const patch = isObj(d.patch) ? Object.assign({}, d.patch) : {};
  delete patch.id;
  delete patch.near;
  if (has(KINDS, patch.kind) && patch.kind !== old.kind && patch.w == null && patch.h == null) {
    const od = KINDS[old.kind];
    if (old.w === od.w && old.h === od.h) { patch.w = KINDS[patch.kind].w; patch.h = KINDS[patch.kind].h; }
  }
  mutate(state, ctx, 'Claude edited a node', 'claude', (t) => putNode(t, normNode(Object.assign({}, old, patch, { id }))));
}

/** graph.edge.add {from, to, label?, id?, kind?}; the same from→to pair updates. */
function cmdEdgeAdd(state, d, ctx) {
  const from = cleanId(d.from), to = cleanId(d.to);
  if (!nodeOf(state, from) || !nodeOf(state, to)) throw new Error(`edge endpoints must exist (${d.from} → ${d.to})`);
  const ex = edgeBetween(state, from, to);
  const id = cleanId(d.id) || (ex && ex.id) || newId(state, 'e_', ctx);
  const prev = edgeOf(state, id);
  mutate(state, ctx, 'Claude connected nodes', 'claude', (t) => putEdge(t, normEdge(Object.assign({}, prev || {}, d, { id, from, to }))));
}

/** graph.focus {ids}: natively, select them, scroll the list to them, frame the picture on them, glow briefly. */
function cmdFocus(state, d, ctx) {
  const found = new Set();
  for (const id of listOf(d.ids)) {
    if (nodeOf(state, id)) found.add(id);
    else { const e = edgeOf(state, id); if (e) { found.add(e.from); found.add(e.to); } }
  }
  const ids = Array.from(found);
  if (!ids.length) { state.ui.frame = []; return; }      // [] = fit everything
  state.sel = ids;
  state.ui.frame = ids.slice();
  scrollTo(state, ids[0]);
  highlight(state, ctx, ids, '', FOCUS_TTL);
}

/** One handler per declared command. */
const COMMANDS = {
  'graph.load': cmdLoad,
  'graph.clear': (state, d, ctx) => clearBoard(state, ctx, 'claude'),
  'graph.node.add': cmdNodeAdd,
  'graph.node.set': cmdNodeSet,
  'graph.node.remove': (state, d, ctx) => {
    if (d.ids == null) throw new Error('expected {ids:[node ids]}');
    mutate(state, ctx, 'remove nodes', 'claude', (t) => dropNodes(t, listOf(d.ids)));
  },
  'graph.edge.add': cmdEdgeAdd,
  'graph.edge.remove': (state, d, ctx) => {
    if (d.ids == null) throw new Error('expected {ids:[edge ids]}');
    mutate(state, ctx, 'remove edges', 'claude', (t) => { for (const id of listOf(d.ids)) dropEdge(t, id); });
  },
  'graph.layout': (state, d, ctx) => {
    applyLayout(state, ctx, String(d.mode || 'tree'), { root: d.root, ids: d.ids != null ? listOf(d.ids) : null, origin: 'claude' });
  },
  'graph.focus': cmdFocus,
  'graph.highlight': (state, d, ctx) => highlight(state, ctx, listOf(d.ids), d.color, d.ttl),
  'graph.annotate': (state, d, ctx) => {
    if (d.id == null) throw new Error('expected {id, text}');
    annotate(state, ctx, cleanId(d.id), d.text, 'claude', 'claude');
  },
  'graph.snapshot': (state, d, ctx) => {
    const graph = exportGraph(state);
    if (!fits({ graph })) throw new Error(`the board is too big for one event (${Math.round(JSON.stringify(graph).length / 1024)} KB; a call may emit 1 MB). Send to Claude still carries it whole`);
    ctx.reply('graph.snapshot', { graph });
  },
};

/**
 * Wraps each command: expire highlights first, report changes and selection
 * after. A command that throws reports nothing: the host puts the state back.
 */
function commandHandlers(table) {
  const on = {};
  for (const type of Object.keys(table)) {
    on[type] = (state, data, ctx) => {
      purgeHighlights(state, ctx.now());
      table[type](state, isObj(data) ? data : {}, ctx);
      flush(state, ctx);
    };
  }
  return on;
}

// ───────────────────────────── 8. actions (human → board) ─────────────────────────────
// Keys are the ones render() puts on its buttons, inputs and selects; an
// argument follows a colon (`sel:n_ab12c`, `unlink:e_x81qz`).

/** The node when exactly one is selected. */
const single = (state) => (state.sel.length === 1 ? nodeOf(state, state.sel[0]) : null);

/** "add": a node of the chosen kind next to the selection (linked from it), or auto-placed; it becomes the selection. */
function addFromPane(state, ctx, value) {
  const label = value.trim().slice(0, 300);
  if (!label) return;
  const kind = state.ui.addKind;
  const def = KINDS[kind];
  const picked = state.sel.map((id) => nodeOf(state, id)).filter(Boolean);
  let x, y, w = def.w, h = def.h;
  if (kind === 'group' && picked.length) {
    const b = bounds(picked);
    x = b.x - 28; y = b.y - 52; w = b.w + 56; h = b.h + 80;
  } else {
    const near = picked.length === 1 ? picked[0] : null, c = viewCenter(state);
    const spot = findFreeSpot(obstacles(state), { x: c.x - w / 2, y: c.y - h / 2, w, h }, { near });
    x = spot.x; y = spot.y;
  }
  const n = normNode({ id: newId(state, 'n_', ctx), kind, label, x, y, w, h });
  const from = kind !== 'group' && state.ui.autolink && picked.length === 1 ? picked[0].id : null;
  const e = from ? normEdge({ id: newId(state, 'e_', ctx), from, to: n.id }) : null;
  mutate(state, ctx, `add ${kind}`, 'user', (t) => { putNode(t, n); if (e) putEdge(t, e); });
  state.sel = [n.id];
  scrollTo(state, n.id);
}

/** "ask": graph.ask with the selection (or the whole board when nothing is selected); the question shows in chat. */
function ask(state, ctx, value) {
  const question = value.trim().slice(0, 500);
  if (!question) return;
  const selection = state.sel.filter((id) => nodeOf(state, id));
  const labels = selection.map((id) => nodeOf(state, id).label).filter(Boolean);
  const data = { question, selection, labels, graph: exportGraph(state) };
  if (!fits(data)) { ctx.toast('The board is too big to send with a question (over 1 MB). Use Send to Claude.', 'error'); return; }
  ctx.emit('graph.ask', data);
  ctx.chat(labels.length ? `${question}  ·  ${labels.join(', ')}` : question);       // as the web board's chat.append('you', …)
}

const ACTIONS = {
  // selection and the list
  sel(state, a) {
    const id = a.arg;
    if (!nodeOf(state, id)) return;
    const on = state.sel.includes(id);
    if (state.ui.multi) state.sel = on ? state.sel.filter((x) => x !== id) : state.sel.concat(id);
    else state.sel = on && state.sel.length === 1 ? [] : [id];
  },
  multi(state) { state.ui.multi = !state.ui.multi; },
  deselect(state) { state.sel = []; },
  more(state) { state.ui.from = Math.min(state.ui.from + LIST_PAGE, lastPage(state)); },
  less(state) { state.ui.from = Math.max(0, state.ui.from - LIST_PAGE); },

  // header
  undo(state, a, ctx) { if (!undo(state, ctx)) ctx.toast('Nothing to undo.'); },
  redo(state, a, ctx) { if (!redo(state, ctx)) ctx.toast('Nothing to redo.'); },
  clear(state, a, ctx) { clearBoard(state, ctx, 'user'); },
  layoutmode(state, a) { if (LAYOUT_MODES.includes(a.value)) state.ui.layout = a.value; },
  layout(state, a, ctx) {
    const ids = state.sel.length >= 2 ? state.sel.slice() : null;
    applyLayout(state, ctx, state.ui.layout, { ids, origin: 'user' });
    if (!ids) state.ui.frame = [];
  },
  zoom(state) { state.ui.frame = state.sel.slice(); },
  fit(state) { state.ui.frame = []; },

  // the editor (one node selected)
  label(state, a, ctx) {
    const n = single(state);
    const v = a.value.slice(0, 300);
    if (n && v !== n.label) mutate(state, ctx, 'rename', 'user', (t) => putNode(t, normNode(Object.assign({}, n, { label: v }))));
  },
  kind(state, a, ctx) { const n = single(state); if (n) setKindOf(state, ctx, [n.id], a.value); },
  text(state, a, ctx) {
    const n = single(state);
    if (n && a.value !== (n.text || '')) mutate(state, ctx, 'edit text', 'user', (t) => putNode(t, normNode(Object.assign({}, n, { text: a.value }))));
  },
  connect(state, a, ctx) {
    const n = single(state), to = cleanId(a.value);
    if (!n || !to) return;
    if (connect(state, ctx, n.id, to, state.ui.edgeLabel)) state.ui.edgeLabel = '';
  },
  elabel(state, a) { state.ui.edgeLabel = a.value.trim().slice(0, 160); },
  unlink(state, a, ctx) { const id = cleanId(a.arg); if (id && edgeOf(state, id)) mutate(state, ctx, 'disconnect', 'user', (t) => dropEdge(t, id)); },
  note(state, a, ctx) { const n = single(state); if (n) annotate(state, ctx, n.id, a.value, 'human', 'user'); },
  unnote(state, a, ctx) { const n = single(state); if (n) annotate(state, ctx, n.id, '', 'human', 'user'); },
  remove(state, a, ctx) {
    const ids = state.sel.slice();
    if (ids.length) mutate(state, ctx, 'delete', 'user', (t) => dropNodes(t, ids));
    state.sel = [];
  },

  // several nodes selected
  link(state, a, ctx) { if (state.sel.length === 2 && connect(state, ctx, state.sel[0], state.sel[1], state.ui.edgeLabel)) state.ui.edgeLabel = ''; },
  chain(state, a, ctx) {
    const ids = state.sel.filter((id) => { const n = nodeOf(state, id); return n && n.kind !== 'group'; });
    if (ids.length < 2) return;
    mutate(state, ctx, 'connect selected', 'user', (t) => {
      for (let i = 1; i < ids.length; i++) {
        if (!edgeBetween(state, ids[i - 1], ids[i])) putEdge(t, normEdge({ id: newId(state, 'e_', ctx, t), from: ids[i - 1], to: ids[i] }));
      }
    });
  },

  // add and ask
  addkind(state, a) { if (ADD_KINDS.includes(a.value)) state.ui.addKind = a.value; },
  autolink(state) { state.ui.autolink = !state.ui.autolink; },
  add(state, a, ctx) { addFromPane(state, ctx, a.value); },
  ask(state, a, ctx) { ask(state, ctx, a.value); },
};

/** The view's action(): find the key's handler, run it, report what changed. */
function onAction(state, act, ctx) {
  purgeHighlights(state, ctx.now());
  state.notice = '';
  const key = String(act.key || '');
  const cut = key.indexOf(':');
  const name = cut < 0 ? key : key.slice(0, cut);
  if (!has(ACTIONS, name)) return;
  ACTIONS[name](state, { arg: cut < 0 ? '' : key.slice(cut + 1), value: act.value == null ? '' : String(act.value), kind: act.kind }, ctx);
  flush(state, ctx);
}

// ───────────────────────────── 9. the picture (one SVG) ─────────────────────────────

/** A node's outline in graph units: a rect, the decision's hexagon, the data cylinder; `title` becomes its hover tooltip. */
function shapeOf(n, title) {
  const x = n.x, y = n.y, w = n.w, h = n.h;
  let s;
  if (n.kind === 'decision') {
    const k = r(Math.min(h / 2, w / 4)), my = r(y + h / 2);
    s = `<path d='M${x + k},${y}H${x + w - k}L${x + w},${my}L${x + w - k},${y + h}H${x + k}L${x},${my}Z'/>`;
  } else if (n.kind === 'data') {
    const e = r(Math.min(10, h / 5)), hw = r(w / 2);
    s = `<path d='M${x},${y + e}A${hw},${e} 0 0 1 ${x + w},${y + e}V${y + h - e}A${hw},${e} 0 0 1 ${x},${y + h - e}ZM${x},${y + e}A${hw},${e} 0 0 0 ${x + w},${y + e}'/>`;
  } else s = `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='${n.kind === 'group' ? 16 : n.kind === 'note' ? 8 : 12}'/>`;
  return title ? s.replace(/\/>$/, `><title>${xml(title)}</title></${s.startsWith('<rect') ? 'rect' : 'path'}>`) : s;
}

/** What hovering a node says: its name, kind and the start of its details. */
const tooltip = (n) => `${nodeName(n)} · ${n.meta && n.meta.attachedTo ? 'note' : n.kind}${n.text && n.kind !== 'note' ? ` — ${fit(n.text, 90)}` : ''}`;

/**
 * Doto as a dot on the board (the web sprite, reduced): an aura, a glossy
 * body, two eyes and a smile; with `live`, he blinks. `R` is his radius in
 * graph units; the gradients `${P}da` / `${P}db` are in the document's defs.
 */
function dotoSvg(cx, cy, R, P, live, name) {
  const eyeY = r1(cy - R * 0.1), dx = R * 0.36, ry = r1(R * 0.22), ink = '#1a1030';
  const blink = live ? `<animate attributeName='ry' values='${ry};${ry};${r1(R * 0.03)};${ry}' keyTimes='0;.9;.95;1' dur='4.2s' repeatCount='indefinite'/>` : '';
  const eye = (x) => `<ellipse cx='${r1(x)}' cy='${eyeY}' rx='${r1(R * 0.17)}' ry='${ry}' fill='${ink}'>${blink}</ellipse>`;
  const sx = r1(cx - R * 0.35), sy = r1(cy - R * 0.5);
  return `<g><title>${xml(name)}</title>` +
    `<circle cx='${r1(cx)}' cy='${r1(cy)}' r='${r1(R * 2)}' fill='url(#${P}da)'/>` +
    `<circle cx='${r1(cx)}' cy='${r1(cy)}' r='${r1(R)}' fill='url(#${P}db)' stroke='#e9dcff' stroke-opacity='.45' stroke-width='${r1(Math.max(0.8, R * 0.06))}'/>` +
    `<ellipse cx='${sx}' cy='${sy}' rx='${r1(R * 0.3)}' ry='${r1(R * 0.14)}' fill='#fff' fill-opacity='.35' transform='rotate(-24 ${sx} ${sy})'/>` +
    eye(cx - dx) + eye(cx + dx) +
    `<path d='M${r1(cx - R * 0.22)},${r1(cy + R * 0.38)}Q${r1(cx)},${r1(cy + R * 0.62)} ${r1(cx + R * 0.22)},${r1(cy + R * 0.38)}' fill='none' stroke='${ink}' stroke-width='${r1(Math.max(0.8, R * 0.09))}' stroke-linecap='round'/>` +
    '</g>';
}
const dotoDefs = (P) => `<radialGradient id='${P}da'><stop offset='0' stop-color='#a66bff' stop-opacity='.38'/><stop offset='1' stop-color='#a66bff' stop-opacity='0'/></radialGradient>` +
  `<radialGradient id='${P}db' cx='38%' cy='30%' r='75%'><stop offset='0' stop-color='#efe4ff'/><stop offset='.55' stop-color='#a66bff'/><stop offset='1' stop-color='#5a2fb8'/></radialGradient>`;

/**
 * Where Doto sits: beside the node last touched (the one selected node, else
 * the newest), on the side with room; the view's centre on an empty board;
 * its lower-right corner when that node is out of the picture.
 */
function dotoSpot(state, idx, shown, view, R) {
  const inside = (cx, cy) => cx - 2 * R >= view.x && cx + 2 * R <= view.x + view.w && cy - 2 * R >= view.y && cy + 2 * R <= view.y + view.h;
  const real = state.graph.nodes.filter((n) => !(n.meta && n.meta.attachedTo));
  if (!real.length) return { x: view.x + view.w / 2, y: view.y + view.h / 2, where: 'centre' };
  const a = state.sel.length === 1 ? idx.get(state.sel[0]) : real[real.length - 1];
  if (a && shown.includes(a)) {
    const gap = R * 1.8, cy = a.y + a.h / 2;
    for (const [x, y] of [[a.x + a.w + gap, cy], [a.x - gap, cy], [a.x + a.w / 2, a.y - gap], [a.x + a.w / 2, a.y + a.h + gap]]) if (inside(x, y)) return { x, y, where: 'beside' };
  }
  return { x: view.x + view.w - 2.4 * R, y: view.y + view.h - 2.4 * R, where: 'corner' };
}

/** Smooth cubic between two rects, leaving and entering on facing sides (graph.js edgeGeometry). */
function edgeGeometry(a, b, gap) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  const horiz = Math.abs(dx) / (a.w + b.w + 1) >= Math.abs(dy) / (a.h + b.h + 1);
  let sx, sy, tx, ty, ux = 0, uy = 0;
  if (horiz) { const s = dx >= 0 ? 1 : -1; sx = ax + (s * a.w) / 2; sy = ay; tx = bx - (s * b.w) / 2; ty = by; ux = s; }
  else { const s = dy >= 0 ? 1 : -1; sx = ax; sy = ay + (s * a.h) / 2; tx = bx; ty = by - (s * b.h) / 2; uy = s; }
  const along = horiz ? Math.abs(tx - sx) : Math.abs(ty - sy);
  const k = clamp(along * 0.5 + Math.hypot(tx - sx, ty - sy) * 0.1, 24, 180);
  const ex = tx - ux * gap, ey = ty - uy * gap;
  const c1x = sx + ux * k, c1y = sy + uy * k, c2x = ex - ux * k, c2y = ey - uy * k;
  return { d: `M${r(sx)},${r(sy)}C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(ex)},${r(ey)}`, mx: (sx + 3 * c1x + 3 * c2x + ex) / 8, my: (sy + 3 * c1y + 3 * c2y + ey) / 8 };
}

function loopGeometry(a, gap) {
  const x = a.x + a.w * 0.72, y = a.y, x2 = a.x + a.w, y2 = a.y + a.h * 0.3;
  return { d: `M${r(x)},${r(y)}C${r(x)},${r(y - 56)} ${r(x2 + 56)},${r(y2)} ${r(x2 + gap)},${r(y2)}`, mx: x2 + 22, my: y - 22 };
}

/** Where the ray from a rect's centre towards (px, py) leaves the rect. */
function rectExit(n, px, py) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = px - cx, dy = py - cy;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(Math.abs(n.w / 2 / (dx || 1e-9)), Math.abs(n.h / 2 / (dy || 1e-9)));
  return [cx + dx * s, cy + dy * s];
}

const marker = (id, color) => `<marker id='${id}' viewBox='0 0 10 10' refX='8' refY='5' markerWidth='5' markerHeight='5' orient='auto'><path d='M0,0L10,5L0,10Z' fill='${color}'/></marker>`;
const textEl = (x, y, s, extra) => `<text x='${r(x)}' y='${r(y)}'${extra || ''}>${xml(s)}</text>`;
const nodeName = (n) => n.label || (n.kind === 'note' && n.text) || (n.kind === 'image' && basename(n.image)) || 'untitled';

/**
 * Draws the board (or the framed part of it) as an SVG document `W` px wide.
 * `lite` drops every text element, for boards too big for the tree budget.
 * @returns {{svg:string, height:number}}
 */
function drawBoard(state, ctx, idx, now, W, lite) {
  const g = state.graph;
  const live = LIVE && !lite;
  const framed = state.ui.frame.map((id) => idx.get(id)).filter(Boolean);
  const empty = !g.nodes.length;
  // an empty board is drawn around its centre, where the first node will land (viewCentre)
  const c0 = viewCenter(state);
  const b = bounds(framed.length ? framed : g.nodes) || { x: c0.x, y: c0.y, w: 0, h: 0 };
  const minV = empty ? EMPTY_VIEW : VIEW_MIN;
  // the viewBox: the board plus padding, at least VIEW_MIN, stretched to the picture's aspect
  let vw = Math.max(b.w + 2 * VIEW_PAD, minV.w), vh = Math.max(b.h + 2 * VIEW_PAD, minV.h);
  let H = r((W * vh) / vw);
  if (H > PIC_MAX_H) { H = PIC_MAX_H; vw = (vh * W) / H; } else if (H < PIC_MIN_H) { H = PIC_MIN_H; vh = (vw * H) / W; }
  const view = { x: b.x + b.w / 2 - vw / 2, y: b.y + b.h / 2 - vh / 2, w: vw, h: vh };
  const u = vw / W;                                   // graph units per pixel
  const fs = clamp(11 * u, 13, 44);                   // label size in graph units: ≥ 11 px when the board allows
  const text = !lite && fs / u >= 6;
  const sw = { node: r1(Math.max(1.5, 1.2 * u)), edge: r1(Math.max(2, 1.6 * u)), glow: r1(Math.max(8, 6 * u)), line: r1(Math.max(2, 2 * u)) };
  const P = 'lg' + String(ctx.windowId || '').replace(/[^A-Za-z0-9]/g, '');   // ids unique per pane
  const sel = new Set(state.sel);
  const hl = new Map();
  for (const h of liveHighlights(state, now)) hl.set(h.id, h.color || HL_DEFAULT);
  const hlColors = Array.from(new Set(hl.values()));
  const shown = g.nodes.filter((n) => intersects(n, view));

  const out = [`<svg xmlns='http://www.w3.org/2000/svg' viewBox='${r(view.x)} ${r(view.y)} ${r(vw)} ${r(vh)}' width='${W}' height='${H}' font-family='system-ui,-apple-system,Segoe UI,sans-serif'>`];
  out.push('<defs>', marker(`${P}a`, EDGE), marker(`${P}s`, SEL), hlColors.map((c, i) => marker(`${P}h${i}`, c)).join(''), dotoDefs(P));
  const dots = 40 / u >= 12;
  if (dots) out.push(`<pattern id='${P}g' width='40' height='40' patternUnits='userSpaceOnUse'><circle cx='20' cy='20' r='${r1(Math.max(1.2, u))}' fill='#2b1f47'/></pattern>`);
  out.push('</defs>', `<rect x='${r(view.x)}' y='${r(view.y)}' width='${r(vw) + 1}' height='${r(vh) + 1}' fill='${BG}'/>`);
  if (dots) out.push(`<rect x='${r(view.x)}' y='${r(view.y)}' width='${r(vw) + 1}' height='${r(vh) + 1}' fill='url(#${P}g)'/>`);

  // groups: dashed frames under everything
  const groups = shown.filter((n) => n.kind === 'group');
  if (groups.length) {
    out.push(`<g fill='${KIND_COLOR.group}' fill-opacity='.06' stroke='${KIND_COLOR.group}' stroke-width='${sw.node}' stroke-dasharray='${r(10 * Math.max(1, u))} ${r(6 * Math.max(1, u))}'>`);
    for (const n of groups) out.push(n.color ? shapeOf(n).replace('/>', ` stroke='${n.color}' fill='${n.color}'/>`) : shapeOf(n));
    out.push('</g>');
  }

  // annotation connectors
  const attach = [];
  for (const n of shown) {
    const tgt = n.meta && n.meta.attachedTo ? idx.get(n.meta.attachedTo) : null;
    if (!tgt) continue;
    const p1 = rectExit(n, tgt.x + tgt.w / 2, tgt.y + tgt.h / 2), p2 = rectExit(tgt, n.x + n.w / 2, n.y + n.h / 2);
    attach.push(`<path d='M${r(p1[0])},${r(p1[1])}L${r(p2[0])},${r(p2[1])}'/>`);
  }
  if (attach.length) out.push(`<g stroke='${KIND_COLOR.note}' stroke-opacity='.55' stroke-width='${sw.node}' stroke-dasharray='${r(4 * Math.max(1, u))}'>`, attach.join(''), '</g>');

  // edges, then their labels
  const edges = [], elabels = [];
  const dash = { dashed: `${r(8 * Math.max(1, u))} ${r(6 * Math.max(1, u))}`, dotted: `${r(2 * Math.max(1, u))} ${r(6 * Math.max(1, u))}` };
  for (const e of g.edges) {
    const a = idx.get(e.from), z = idx.get(e.to);
    if (!a || !z || (!intersects(a, view) && !intersects(z, view))) continue;
    const geo = e.from === e.to ? loopGeometry(a, sw.edge) : edgeGeometry(a, z, sw.edge);
    let at = '';
    if (hl.has(e.id)) at += ` stroke='${hl.get(e.id)}' marker-end='url(#${P}h${hlColors.indexOf(hl.get(e.id))})'`;
    else if (sel.has(e.from) || sel.has(e.to)) at += ` stroke='${SEL}' marker-end='url(#${P}s)'`;
    if (dash[e.kind]) at += ` stroke-dasharray='${dash[e.kind]}'${e.kind === 'dotted' ? " stroke-linecap='round'" : ''}`;
    if (e.kind === 'bold') at += ` stroke-width='${r1(sw.edge * 1.8)}'`;
    if (e.kind === 'muted') at += " stroke-opacity='.4'";
    edges.push(`<path d='${geo.d}'${at}/>`);
    if (text && e.label) elabels.push(textEl(geo.mx, geo.my, fit(e.label, 24)));
  }
  if (edges.length) out.push(`<g fill='none' stroke='${EDGE}' stroke-width='${sw.edge}' marker-end='url(#${P}a)'>`, edges.join(''), '</g>');

  // nodes, one <g> per kind and colour so the shapes carry no paint attributes
  const buckets = new Map();
  for (const n of shown) {
    if (n.kind === 'group') continue;
    const k = `${n.kind}|${n.color || KIND_COLOR[n.kind]}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(shapeOf(n, live ? tooltip(n) : ''));
  }
  for (const [k, shapes] of buckets) {
    const [kind, c] = k.split('|');
    out.push(`<g fill='${c}' fill-opacity='${KIND_FILL[kind]}' stroke='${c}' stroke-width='${sw.node}'${kind === 'note' ? " stroke-opacity='.6'" : ''}>`, shapes.join(''), '</g>');
  }
  const images = shown.filter((n) => n.kind === 'image');
  if (images.length) {
    out.push(`<g fill='none' stroke='${KIND_COLOR.image}' stroke-width='${sw.line}' stroke-linejoin='round'>`);
    for (const n of images) { const cx = r(n.x + n.w / 2), cy = r(n.y + n.h / 2 - 10); out.push(`<path d='M${cx - 30},${cy + 18}l20,-24 14,14 10,-10 16,20zM${cx - 34},${cy - 26}h68v48h-68z'/>`); }
    out.push('</g>');
  }

  // selection (cyan) and highlights (their colour): a soft wide stroke plus a crisp one
  const glow = (color, list, pulse) => {
    if (!list.length) return;
    const s = list.map((n) => shapeOf(n)).join('');
    const anim = pulse && live ? "<animate attributeName='stroke-opacity' values='.28;.7;.28' dur='1.1s' repeatCount='indefinite'/>" : '';
    out.push(`<g fill='none' stroke='${color}'><g stroke-width='${sw.glow}' stroke-opacity='.28'>${anim}${s}</g><g stroke-width='${sw.line}'>${s}</g></g>`);
  };
  glow(SEL, shown.filter((n) => sel.has(n.id) && !hl.has(n.id)), false);
  for (const c of hlColors) glow(c, shown.filter((n) => hl.get(n.id) === c), true);

  // text: centred labels, left-aligned titles and note bodies, edge labels
  if (text) {
    const mid = [], left = [], body = [];
    const cpl = (w) => Math.max(3, Math.floor(w / (fs * 0.56)));
    const lh = fs * 1.25;
    for (const n of shown) {
      if (n.kind === 'group') { left.push(textEl(n.x + 12, n.y + 10, fit(n.label, cpl(n.w - 24)))); continue; }
      if (n.kind === 'note') {
        let y = n.y + 10;
        if (n.label) { left.push(textEl(n.x + 10, y, fit(n.label, cpl(n.w - 20)), " font-weight='600'")); y += lh; }
        const room = Math.max(0, Math.floor((n.y + n.h - 8 - y) / lh));
        for (const line of wrapLines(n.text || (n.label ? '' : '…'), cpl(n.w - 20), room)) { body.push(textEl(n.x + 10, y, line)); y += lh; }
        continue;
      }
      if (n.kind === 'image') { mid.push(textEl(n.x + n.w / 2, n.y + n.h - fs, fit(nodeName(n), cpl(n.w - 16)))); continue; }
      const inner = n.kind === 'decision' ? n.w - 2 * Math.min(n.h / 2, n.w / 4) * 0.55 - 8 : n.w - 16;
      const lines = wrapLines(n.label || 'untitled', cpl(inner), clamp(Math.floor((n.h - 8) / lh), 1, 3));
      const y0 = n.y + n.h / 2 - ((lines.length - 1) * lh) / 2;
      lines.forEach((line, i) => mid.push(textEl(n.x + n.w / 2, y0 + i * lh, line, n.label ? '' : " fill-opacity='.5'")));
    }
    const base = `font-size='${r1(fs)}' fill='${TEXT}'`;
    if (mid.length) out.push(`<g ${base} text-anchor='middle' dominant-baseline='central'>`, mid.join(''), '</g>');
    if (left.length) out.push(`<g ${base} dominant-baseline='hanging'>`, left.join(''), '</g>');
    if (body.length) out.push(`<g ${base} fill-opacity='.78' dominant-baseline='hanging'>`, body.join(''), '</g>');
    if (elabels.length) out.push(`<g font-size='${r1(fs * 0.85)}' fill='#cfc6ef' text-anchor='middle' dominant-baseline='central' stroke='${BG}' stroke-width='${r1(fs * 0.3)}' paint-order='stroke'>`, elabels.join(''), '</g>');
  }

  // Doto on the board, and on an empty one the hint under him
  if (!lite) {
    const R = clamp(13 * u, 10, 32);
    const spot = dotoSpot(state, idx, shown, view, R);
    out.push(dotoSvg(spot.x, spot.y, R, P, live, (ctx.persona && ctx.persona.name) || 'Doto'));
    if (empty && text) {
      const y = spot.y + R * 2.6, lh = fs * 1.5;
      out.push(`<g text-anchor='middle' fill='${TEXT}' font-size='${r1(fs)}' dominant-baseline='hanging'>`,
        textEl(spot.x, y, 'Empty board', " font-weight='600'"),
        textEl(spot.x, y + lh, 'type a label in "add" below, or ask Claude to draw it', " fill-opacity='.62'"),
        state.intent ? textEl(spot.x, y + 2 * lh, `for: ${fit(state.intent, 56)}`, " fill-opacity='.62' font-style='italic'") : '',
        '</g>');
    }
  }
  out.push('</svg>');
  return { svg: out.join(''), height: H };
}

/** The picture's alt text (what a surface without SVG shows): counts and the first connections. */
function describe(state, idx) {
  const g = state.graph;
  if (!g.nodes.length) return 'empty board: nothing drawn yet';
  const flows = g.edges.slice(0, 10).map((e) => `${fit(nodeName(idx.get(e.from)), 18)} → ${fit(nodeName(idx.get(e.to)), 18)}`);
  return fit(`graph: ${plural(g.nodes.length, 'node')}, ${plural(g.edges.length, 'edge')}${flows.length ? '. ' + flows.join('; ') : ''}`, 400);
}

/**
 * The picture element: an SVG sized to the pane (interactive, so hovering a
 * node shows its tooltip and the animations run), a lighter one when big,
 * alt text as the last resort.
 */
function picture(state, ui, ctx, idx, now) {
  const W = Math.min(Math.max(ctx.viewport.cols, 30) * 8, 720);
  const alt = describe(state, idx);
  let pic = drawBoard(state, ctx, idx, now, W, false);
  let live = LIVE;
  if (pic.svg.length > SVG_BUDGET) { pic = drawBoard(state, ctx, idx, now, W, true); live = false; }
  if (pic.svg.length > SVG_BUDGET) return ui.text({ dimColor: true }, `${alt} (too big to draw here)`);
  return ui.svg({ source: pic.svg, alt, width: W, height: pic.height, isInteractive: live });
}

// ───────────────────────────── 10. the pane (render) ─────────────────────────────

const chip = (n) => `${n.meta && n.meta.attachedTo ? '↳' : KIND_GLYPH[n.kind] || '○'} ${fit(nodeName(n), 26)}`;

/** Counts, undo/redo, clear; layout mode + layout, zoom/fit, multi-select. */
function header(state, ui, sel) {
  const g = state.graph, any = g.nodes.length > 0;
  return ui.col({},
    ui.row({ justifyContent: 'space-between' },
      ui.text({ bold: true }, `${plural(g.nodes.length, 'node')} · ${plural(g.edges.length, 'edge')}`),
      ui.row({ gap: 1 },
        ui.button({ key: 'undo', label: '↶ undo', plain: true, dimColor: !state.undo.length }),
        ui.button({ key: 'redo', label: '↷ redo', plain: true, dimColor: !state.redo.length }),
        any ? ui.button({ key: 'clear', label: 'clear', plain: true, dimColor: true }) : null)),
    any ? ui.row({ gap: 1, flexWrap: 'wrap', alignItems: 'center' },
      ui.select({ key: 'layoutmode', options: LAYOUT_MODES.map((m) => ({ value: m })), value: state.ui.layout }),
      ui.button({ key: 'layout', label: sel.length >= 2 ? `layout ${sel.length} selected` : 'layout all' }),
      state.ui.frame.length ? ui.button({ key: 'fit', label: 'fit board' }) : sel.length ? ui.button({ key: 'zoom', label: 'zoom to selection', dimColor: true }) : null,
      ui.button({ key: 'multi', label: state.ui.multi ? '☑ multi-select' : '☐ multi-select', plain: true, dimColor: !state.ui.multi })) : null,
    state.ui.frame.length ? ui.text({ dimColor: true }, `showing ${plural(state.ui.frame.length, 'node')} up close`) : null);
}

/** The board is empty: one line under the picture (the picture says it too, for the surfaces that draw it). */
function emptyHint(state, ui, ctx) {
  const who = (ctx.persona && ctx.persona.name) || 'Doto';
  return ui.col({},
    ui.text({ dimColor: true }, `Empty board. Type a label in "add" below and press Enter, or ask Claude to draw it. ${who} and Claude see the same board.`),
    state.intent ? ui.text({ italic: true }, `for: ${state.intent}`) : null);
}

/** Every node as a button (a page of LIST_PAGE), selected ones primary, highlighted ones marked. */
function nodeList(state, ui, sel, now) {
  const nodes = state.graph.nodes;
  if (!nodes.length) return null;
  const from = clamp(state.ui.from, 0, lastPage(state));
  const page = nodes.slice(from, from + LIST_PAGE);
  const rest = nodes.length - from - page.length;
  const lit = new Set(liveHighlights(state, now).map((h) => h.id));
  return ui.col({},
    from > 0 ? ui.row({ gap: 1 }, ui.button({ key: 'less', label: '▴ back', plain: true, dimColor: true }), ui.text({ dimColor: true }, `nodes ${from + 1}–${from + page.length} of ${nodes.length}`)) : null,
    ui.row({ gap: 1, flexWrap: 'wrap' }, page.map((n) => {
      const on = sel.includes(n.id);
      return ui.button({ key: `sel:${n.id}`, label: chip(n) + (lit.has(n.id) ? ' ✦' : ''), variant: on ? 'primary' : undefined, dimColor: !on });
    })),
    rest > 0 ? ui.row({ gap: 1 }, ui.text({ dimColor: true }, `…and ${rest} more`), ui.button({ key: 'more', label: 'more ▾', plain: true, dimColor: true })) : null);
}

/** One node selected: label, kind, text, connect (+ edge label), its connections, note, remove. */
function editor(state, ui, n, idx) {
  const isNote = !!(n.meta && n.meta.attachedTo);
  const ann = isNote ? null : state.graph.nodes.find((x) => x.meta && x.meta.attachedTo === n.id && x.meta.annotation);
  const targets = state.graph.nodes.filter((x) => x.id !== n.id && !(x.meta && x.meta.attachedTo)).slice(0, CONNECT_OPTIONS);
  const links = state.graph.edges.filter((e) => e.from === n.id || e.to === n.id);
  return ui.col({ borderStyle: 'round', borderDimColor: true, paddingX: 1 },
    ui.row({ justifyContent: 'space-between' },
      ui.text({ bold: true }, isNote ? `↳ note on ${fit(nodeName(idx.get(n.meta.attachedTo) || {}), 30)}` : chip(n)),
      ui.button({ key: 'deselect', label: '×', plain: true, dimColor: true })),
    ui.input({ key: 'label', label: 'label', value: n.label, placeholder: 'untitled', submitLabel: 'rename' }),
    KIND_KEYS.includes(n.kind) && !isNote
      ? ui.select({ key: 'kind', label: 'kind', options: KIND_KEYS.map((k) => ({ value: k, label: `${KIND_GLYPH[k]} ${k}` })), value: n.kind })
      : ui.text({ dimColor: true }, `kind: ${n.kind}${n.image ? ` · ${fit(basename(n.image), 30)}` : ''}`),
    ui.input({ key: 'text', label: n.kind === 'note' ? 'body' : 'details', value: n.text || '', placeholder: n.kind === 'note' ? 'what the note says…' : 'longer description (optional)…', submitLabel: 'set' }),
    targets.length && !isNote ? ui.select({ key: 'connect', label: 'connect to', options: [{ value: '', label: 'pick a node…' }].concat(targets.map((x) => ({ value: x.id, label: chip(x) }))), value: '' }) : null,
    targets.length && !isNote ? ui.input({ key: 'elabel', label: 'edge label', value: state.ui.edgeLabel, placeholder: 'optional, for the next connection', submitLabel: 'set' }) : null,
    links.slice(0, LINKS_SHOWN).map((e) => {
      const out = e.from === n.id, other = idx.get(out ? e.to : e.from);
      return ui.row({ gap: 1 },
        ui.text({ dimColor: true }, `${out ? '→' : '←'} ${fit(nodeName(other || {}), 28)}${e.label ? ` (${fit(e.label, 16)})` : ''}`),
        ui.button({ key: `unlink:${e.id}`, label: '×', plain: true, dimColor: true }));
    }),
    links.length > LINKS_SHOWN ? ui.text({ dimColor: true }, `…and ${plural(links.length - LINKS_SHOWN, 'more connection')}`) : null,
    isNote ? null : ui.input({ key: 'note', label: 'note', value: ann ? ann.text || '' : '', placeholder: 'annotate this node…', submitLabel: 'annotate' }),
    ui.row({ gap: 1 },
      ann ? ui.button({ key: 'unnote', label: 'remove note', dimColor: true }) : null,
      ui.button({ key: 'remove', label: isNote ? 'remove note' : 'remove node', dimColor: true })));
}

/** Several nodes selected: connect them, remove them. */
function multiEditor(state, ui, sel, idx) {
  const names = sel.map((id) => fit(nodeName(idx.get(id)), 18));
  return ui.col({ borderStyle: 'round', borderDimColor: true, paddingX: 1 },
    ui.row({ justifyContent: 'space-between' },
      ui.text({ bold: true }, `${sel.length} selected`),
      ui.button({ key: 'deselect', label: '×', plain: true, dimColor: true })),
    ui.text({ dimColor: true }, fit(names.join(', '), 160)),
    ui.row({ gap: 1, flexWrap: 'wrap' },
      sel.length === 2
        ? ui.button({ key: 'link', label: `connect ${names[0]} → ${names[1]}` })
        : ui.button({ key: 'chain', label: `connect in order (${sel.length})` }),
      ui.button({ key: 'remove', label: `remove ${sel.length}`, dimColor: true })));
}

/** Add a node (kind select + label input), optionally linked from the selected node. */
function addBlock(state, ui, sel, idx) {
  const one = sel.length === 1 ? idx.get(sel[0]) : null;
  const linking = !!one && state.ui.autolink && state.ui.addKind !== 'group';
  return ui.col({},
    ui.row({ gap: 1, flexWrap: 'wrap', alignItems: 'center' },
      ui.select({ key: 'addkind', label: 'add', options: ADD_KINDS.map((k) => ({ value: k, label: `${KIND_GLYPH[k]} ${k}` })), value: state.ui.addKind }),
      one && state.ui.addKind !== 'group' ? ui.button({ key: 'autolink', label: state.ui.autolink ? `☑ after "${fit(nodeName(one), 16)}"` : '☐ link from selection', plain: true, dimColor: !state.ui.autolink }) : null),
    ui.input({ key: 'add', value: '', placeholder: linking ? `next after "${fit(nodeName(one), 20)}"…` : 'new node label…', submitLabel: 'add' }));
}

/**
 * The whole pane: reads the state and ctx, builds the tree. Its one call out
 * is ctx.after for the next highlight to expire: the host keeps only the
 * earliest pending redraw, so when that one fires, this render asks for the next.
 */
function renderPane(state, ui, ctx) {
  const idx = new Map(state.graph.nodes.map((n) => [n.id, n]));
  const now = ctx.now();
  const next = Math.min.apply(null, liveHighlights(state, now).filter((h) => h.until).map((h) => h.until));
  if (next !== Infinity) ctx.after(Math.min(next - now + 50, 60000));
  const sel = state.sel.filter((id) => idx.has(id));
  const subject = sel.length === 1 ? `"${fit(nodeName(idx.get(sel[0])), 24)}"` : sel.length ? `the ${sel.length} selected nodes` : state.graph.nodes.length ? 'the board' : 'what to draw';
  return ui.col({ gap: 1 },
    header(state, ui, sel),
    state.notice ? ui.text({ color: 'success' }, state.notice) : null,
    picture(state, ui, ctx, idx, now),
    state.graph.nodes.length ? null : emptyHint(state, ui, ctx),
    nodeList(state, ui, sel, now),
    sel.length === 1 ? editor(state, ui, idx.get(sel[0]), idx) : sel.length > 1 ? multiEditor(state, ui, sel, idx) : null,
    addBlock(state, ui, sel, idx),
    ui.input({ key: 'ask', value: '', placeholder: `Ask Claude about ${subject}…`, submitLabel: 'ask' }));
}

lets.native({
  init: initialState,
  render: renderPane,
  on: commandHandlers(COMMANDS),
  action: onAction,
  export(state) { return { graph: exportGraph(state) }; },
});
