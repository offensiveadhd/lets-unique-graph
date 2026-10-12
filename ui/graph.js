/**
 * graph.js — the board of the `graph` unique (lets).
 *
 * A dark-violet node/edge board. The human draws flows and ideas; Claude reads
 * and edits the same graph through LIP `graph.*` messages. Contract:
 * docs/UI-CONTRACT.md §3 (events §3.2, commands §3.3, entity context §3.4).
 * Everything non-graph (companion, chat, components, media upload, toasts) is
 * the shell's job (/sdk/lets-shell.js); this file only plugs into it.
 *
 *   1. constants & helpers      7. label editor
 *   2. boot                     8. user actions
 *   3. model + undo stack       9. outgoing events
 *   4. view (SVG rendering)    10. incoming commands
 *   5. viewport                11. media, clipboard, inline components
 *   6. pointer / keyboard      12. entity, chrome, persistence, start-up
 *
 * Coordinates: nodes store their TOP-LEFT corner in graph units. The viewport
 * is a translation + zoom: screen = graph * zoom + (viewport.x, viewport.y).
 */

import { Lets } from '/sdk/lets-client.js';
import { treeLayout, gridLayout, radialLayout, findFreeSpot, bounds, contains, intersects } from './layout.js';

// ───────────────────────────── 1. constants & helpers ─────────────────────────────

const VERSION = '0.3.0';
const CAPS = ['entity', 'chat', 'components', 'media.image', 'clipboard'];
const NS = 'http://www.w3.org/2000/svg';
const Z_MIN = 0.25;
const Z_MAX = 3;
const UNDO_MAX = 50;
const ARROW_GAP = 5; // path stops short of the border; the marker tip covers the gap
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const animMs = () => (REDUCED.matches ? 0 : 300);

/** Node kinds: default size and the label a fresh node gets. */
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
const MIN_SIZE = { note: { w: 120, h: 56 }, group: { w: 160, h: 100 }, image: { w: 100, h: 80 } };
const KIND_COLOR = { idea: '#a66bff', step: '#6bf0ff', decision: '#ff6bd6', data: '#3ee6c1', note: '#a99cd0', image: '#7a64c0', group: '#5a44a0' };
const NODE_KEYS = ['label', 'kind', 'x', 'y', 'w', 'h', 'color', 'text', 'image', 'meta'];
const STYLED_EDGE_KINDS = new Set(['dashed', 'dotted', 'bold', 'muted']);
const LAYOUTS = { tree: treeLayout, grid: gridLayout, radial: radialLayout };

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clone = (o) => (o == null ? null : structuredClone(o));
const now = () => performance.now();
const num = (v, d) => (v !== null && v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);
const str = (v, max) => String(v ?? '').slice(0, max);
const listOf = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => cleanId(x)).filter(Boolean);
const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const validColor = (c) => typeof c === 'string' && c.length < 64 && CSS.supports('color', c);
const basename = (p) => String(p || '').split(/[\\/]/).pop();

/** Creates an SVG element with attributes, optionally appended to `parent`. */
function svg(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

/** Creates an HTML element (text via textContent only — never innerHTML). */
function html(tag, cls, parent = null, text = null) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

/** Trailing debounce with `.flush()` and `.cancel()`. */
function debounce(fn, ms) {
  let t = 0;
  const d = () => { clearTimeout(t); t = setTimeout(() => { t = 0; fn(); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = 0; fn(); } };
  d.cancel = () => { clearTimeout(t); t = 0; };
  return d;
}

/** Sanitises an id coming from the outside world; null when empty. */
function cleanId(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 64);
  return s || null;
}

/** Short, collision-free id: `n_k3f9a` / `e_x81qz`. */
function newId(prefix, extra = null) {
  for (;;) {
    const id = prefix + Math.random().toString(36).slice(2, 7).padEnd(5, '0');
    if (!G.nodes.has(id) && !G.edges.has(id) && !extra?.has(id)) return id;
  }
}

// ───────────────────────────── 2. boot ─────────────────────────────

// The shell is loaded before connecting so its command handlers exist before
// the first SSE message can arrive. If it is missing, the board still works.
let ShellApi = null;
try {
  const mod = await import('/sdk/lets-shell.js');
  ShellApi = mod.Shell || mod.default || null;
} catch (err) {
  console.warn('[graph] /sdk/lets-shell.js unavailable — running without the shell:', err?.message || err);
}

const lets = Lets.connect({ unique: 'graph', version: VERSION, caps: CAPS });
const STORE_KEY = `lets.graph.${lets.windowId}`;
const MEDIA_KEY = `${STORE_KEY}.media`;

const board = $('board');
const svgRoot = $('svg');
const world = $('world');
const L_GROUPS = $('layer-groups');
const L_EDGES = $('layer-edges');
const L_NODES = $('layer-nodes');
const L_INLINE = $('layer-inline');
const tempEdge = $('temp-edge');
const marqueeEl = $('marquee');
const editor = $('editor');
const toolbar = $('toolbar');
const askForm = $('ask');
const askInput = $('ask-input');
const modeHint = $('mode-hint');
const helpEl = $('help');
const emptyEl = $('empty');
const mmBox = $('minimap');
const mmSvg = $('mm-svg');
const mmNodes = $('mm-nodes');
const mmView = $('mm-view');
const fileInput = $('file-input');
const statusDot = $('status-dot');
const zoomLabel = $('zoom-label');
const btnUndo = $('btn-undo');
const btnRedo = $('btn-redo');
const btnConnect = $('btn-connect');
const btnSend = $('btn-send');
const btnHelp = $('btn-help');

let R = board.getBoundingClientRect();

// ───────────────────────────── 3. model + undo stack ─────────────────────────────

/** @typedef {{id:string,label:string,kind:string,x:number,y:number,w:number,h:number,color?:string,text?:string,image?:string,meta?:object}} GNode */
/** @typedef {{id:string,from:string,to:string,label?:string,kind?:string}} GEdge */
/** @typedef {{label:string, origin:'user'|'claude', merge?:string, nodes:Map<string,GNode|null>, edges:Map<string,GEdge|null>}} Tx */
/** @typedef {[string, object|null, object|null]} Change  [id, before, after] */

const G = { rev: 0, nodes: new Map(), edges: new Map(), viewport: { x: 0, y: 0, zoom: 1 } };
const vp = G.viewport;
const byNode = new Map(); // nodeId -> Set<edgeId>
const undoStack = [];
const redoStack = [];
const sel = new Set();
const selE = new Set();
const HL = new Map(); // highlighted id -> colour ('' = default)
const hlTimers = new Map();
const ptr = { sx: 0, sy: 0, gx: 0, gy: 0, ts: 0, inside: false };
let hoverId = null;
let connectMode = false;
let connectSrc = null;

/**
 * Normalises any node-ish object into the canonical, fixed-key-order shape.
 * @param {object} raw must carry a valid `id`
 * @returns {GNode}
 */
function normNode(raw) {
  const kind = KINDS[raw.kind] ? raw.kind : 'idea';
  const def = KINDS[kind];
  const n = {
    id: String(raw.id),
    label: str(raw.label, 300),
    kind,
    x: Math.round(num(raw.x, 0)),
    y: Math.round(num(raw.y, 0)),
    w: Math.round(clamp(num(raw.w, def.w), 40, 4000)),
    h: Math.round(clamp(num(raw.h, def.h), 32, 4000)),
  };
  if (validColor(raw.color)) n.color = raw.color;
  if (raw.text != null && raw.text !== '') n.text = str(raw.text, 8000);
  if (typeof raw.image === 'string' && raw.image) n.image = raw.image.slice(0, 2048);
  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
    try { const s = JSON.stringify(raw.meta); if (s.length <= 8000) n.meta = JSON.parse(s); } catch { /* drop */ }
  }
  return n;
}

/**
 * Normalises an edge; `id`, `from`, `to` must already be clean.
 * @returns {GEdge}
 */
function normEdge(raw) {
  const e = { id: String(raw.id), from: String(raw.from), to: String(raw.to) };
  if (raw.label != null && raw.label !== '') e.label = str(raw.label, 160);
  if (typeof raw.kind === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(raw.kind) && raw.kind !== 'solid') e.kind = raw.kind;
  return e;
}

const indexEdge = (e) => { for (const n of [e.from, e.to]) { if (!byNode.has(n)) byNode.set(n, new Set()); byNode.get(n).add(e.id); } };
const unindexEdge = (e) => { for (const n of [e.from, e.to]) byNode.get(n)?.delete(e.id); };

/** Writes a node ('n') or edge ('e') straight into the model (no undo record). */
function setRaw(kind, id, v) {
  if (kind === 'n') {
    if (v) G.nodes.set(id, clone(v)); else G.nodes.delete(id);
    return;
  }
  const old = G.edges.get(id);
  if (old) unindexEdge(old);
  if (v) { const e = clone(v); G.edges.set(id, e); indexEdge(e); } else G.edges.delete(id);
}

/** Opens a transaction. Every model write goes through one. */
function beginTx(label, origin = 'user') { return { label, origin, nodes: new Map(), edges: new Map() }; }
function touchN(t, id) { if (!t.nodes.has(id)) t.nodes.set(id, clone(G.nodes.get(id))); }
function touchE(t, id) { if (!t.edges.has(id)) t.edges.set(id, clone(G.edges.get(id))); }
function putNode(t, n) { touchN(t, n.id); G.nodes.set(n.id, n); }
function putEdge(t, e) { touchE(t, e.id); setRaw('e', e.id, e); }
function dropEdge(t, id) { if (!G.edges.has(id)) return; touchE(t, id); setRaw('e', id, null); }
function dropNode(t, id) {
  if (!G.nodes.has(id)) return;
  for (const eid of [...(byNode.get(id) || [])]) dropEdge(t, eid);
  touchN(t, id);
  G.nodes.delete(id);
}
/** Drops nodes plus the annotation notes attached to them. */
function dropNodes(t, ids) {
  const all = new Set(ids);
  for (const n of G.nodes.values()) if (n.meta?.attachedTo && all.has(n.meta.attachedTo)) all.add(n.id);
  for (const id of all) dropNode(t, id);
}

const same = (a, b) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

/**
 * Runs `fn(tx)` as one undoable step.
 * @param {string} label
 * @param {'user'|'claude'} origin
 * @param {(t:Tx)=>void} fn
 * @param {{animate?:boolean, merge?:string}} [opts] animate defaults to true for Claude
 * @returns {boolean} whether anything changed
 */
function mutate(label, origin, fn, { animate = origin !== 'user', merge } = {}) {
  const t = beginTx(label, origin);
  t.merge = merge;
  fn(t);
  return commit(t, { animate });
}

/** Closes a transaction: diff, push to the undo stack, render, emit. */
function commit(t, { animate = false } = {}) {
  const ch = { label: t.label, merge: t.merge, ts: Date.now(), nodes: [], edges: [] };
  for (const [id, b] of t.nodes) { const a = clone(G.nodes.get(id)); if (!same(b, a)) ch.nodes.push([id, b, a]); }
  for (const [id, b] of t.edges) { const a = clone(G.edges.get(id)); if (!same(b, a)) ch.edges.push([id, b, a]); }
  if (!ch.nodes.length && !ch.edges.length) return false;
  const top = undoStack[undoStack.length - 1];
  if (ch.merge && top?.merge === ch.merge && ch.ts - top.ts < 1200) {
    for (const k of ['nodes', 'edges']) {
      for (const [id, b, a] of ch[k]) {
        const row = top[k].find((r) => r[0] === id);
        if (row) row[2] = a; else top[k].push([id, b, a]);
      }
    }
    top.ts = ch.ts;
  } else {
    undoStack.push(ch);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  redoStack.length = 0;
  applied(ch, t.origin, animate);
  return true;
}

/** Restores the before-state of an unfinished transaction (Esc during a drag). */
function rollback(t) {
  const ch = { nodes: [], edges: [] };
  for (const [id, b] of t.nodes) { const cur = clone(G.nodes.get(id)); setRaw('n', id, b); ch.nodes.push([id, cur, b]); }
  for (const [id, b] of t.edges) { const cur = clone(G.edges.get(id)); setRaw('e', id, b); ch.edges.push([id, cur, b]); }
  for (const [id, b, a] of ch.nodes) syncNode(id, b, a, true);
  for (const [id] of ch.edges) syncEdge(id);
}

/** Post-change bookkeeping shared by commits, undo and redo. */
function applied(ch, origin, animate) {
  G.rev++;
  for (const [id, b, a] of ch.nodes) { markDiff(id, b, a); syncNode(id, b, a, animate); }
  for (const [id, b, a] of ch.edges) { markDiff(id, b, a); syncEdge(id); }
  if (origin === 'user') emitGranular(ch);
  let pruned = false;
  for (const id of [...sel]) if (!G.nodes.has(id)) { sel.delete(id); pruned = true; }
  for (const id of [...selE]) if (!G.edges.has(id)) { selE.delete(id); pruned = true; }
  if (connectSrc && !G.nodes.has(connectSrc)) connectSrc = null;
  if (pruned) selectionChanged();
  changedSoon();
  saveSoon();
  syncUndoButtons();
  refreshEmpty();
  V.mm = V.mmNodes = true;
  requestFrame();
}

/** Undo one step (user edits and Claude's commands share the stack). */
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  closeEditor(false);
  redoStack.push(s);
  replay(s, 1);
}

/** Redo one step. */
function redo() {
  const s = redoStack.pop();
  if (!s) return;
  closeEditor(false);
  undoStack.push(s);
  replay(s, 2);
}

function replay(s, idx) {
  const ch = { nodes: [], edges: [] };
  for (const r of s.nodes) { setRaw('n', r[0], r[idx]); ch.nodes.push([r[0], r[3 - idx], r[idx]]); }
  for (const r of s.edges) { setRaw('e', r[0], r[idx]); ch.edges.push([r[0], r[3 - idx], r[idx]]); }
  applied(ch, 'user', true);
}

function syncUndoButtons() {
  btnUndo.disabled = !undoStack.length;
  btnRedo.disabled = !redoStack.length;
}

/**
 * The full graph JSON (UI-CONTRACT §3.2), safe to send to Claude.
 * @returns {{rev:number, nodes:GNode[], edges:GEdge[], viewport:{x:number,y:number,zoom:number}}}
 */
function exportGraph() {
  return {
    rev: G.rev,
    nodes: [...G.nodes.values()].map(clone),
    edges: [...G.edges.values()].map(clone),
    viewport: { x: Math.round(vp.x), y: Math.round(vp.y), zoom: Math.round(vp.zoom * 1000) / 1000 },
  };
}

// ───────────────────────────── 4. view ─────────────────────────────

const V = {
  nodeEls: new Map(), // id -> <g>
  edgeEls: new Map(), // id -> <g>
  attachEls: new Map(), // annotation id -> <path>
  annots: new Set(), // ids of notes attached to a node
  disp: new Map(), // id -> {x,y,w,h} as displayed (lags the model while animating)
  sized: new Map(), // id -> "WxH" last applied to the DOM
  anims: new Map(), // id -> {from,to,t0,ms}
  spawn: new Map(), // id -> rect a new node animates out of
  entering: new Set(),
  rebuild: new Set(),
  moved: new Set(),
  edges: new Set(),
  attach: false,
  vp: true,
  mm: true,
  mmNodes: true,
  vpAnim: null,
  lz: 0,
};
let raf = 0;
const requestFrame = () => { if (!raf) raf = requestAnimationFrame(frame); };

/** One render pass. All DOM writes are batched here (rAF). */
function frame(t) {
  raf = 0;
  let again = false;
  if (V.vpAnim) {
    const a = V.vpAnim;
    const k = a.ms ? clamp((t - a.t0) / a.ms, 0, 1) : 1;
    const e = ease(k);
    vp.x = a.from.x + (a.to.x - a.from.x) * e;
    vp.y = a.from.y + (a.to.y - a.from.y) * e;
    vp.zoom = a.from.zoom + (a.to.zoom - a.from.zoom) * e;
    V.vp = true;
    if (k >= 1) { V.vpAnim = null; saveSoon(); } else again = true;
  }
  for (const [id, a] of V.anims) {
    const d = V.disp.get(id);
    if (!d) { V.anims.delete(id); continue; }
    const k = a.ms ? clamp((t - a.t0) / a.ms, 0, 1) : 1;
    const e = ease(k);
    for (const p of ['x', 'y', 'w', 'h']) d[p] = a.from[p] + (a.to[p] - a.from[p]) * e;
    V.moved.add(id);
    if (k >= 1) V.anims.delete(id); else again = true;
  }
  if (V.vp) { V.vp = false; applyViewport(); V.mm = true; }
  if (V.rebuild.size) { for (const id of V.rebuild) buildNode(id); V.rebuild.clear(); }
  if (V.moved.size) {
    for (const id of V.moved) {
      placeNode(id);
      const es = byNode.get(id);
      if (es) for (const e of es) V.edges.add(e);
    }
    V.moved.clear();
    V.attach = V.mm = V.mmNodes = true;
  }
  if (V.edges.size) { for (const id of V.edges) routeEdge(id); V.edges.clear(); }
  if (V.attach) { V.attach = false; routeAttachments(); }
  if (V.mm) { V.mm = false; drawMinimap(); }
  if (ED.target) positionEditor();
  if (again) requestFrame();
}

/** Reconciles one node's DOM with a model change. */
function syncNode(id, b, a, animate) {
  if (!a) { removeNodeEl(id, animate); return; }
  if (a.meta?.attachedTo) V.annots.add(id); else V.annots.delete(id);
  const geo = { x: a.x, y: a.y, w: a.w, h: a.h };
  const ms = animate ? animMs() : 0;
  if (!b || !V.nodeEls.has(id)) {
    const from = V.spawn.get(id);
    V.spawn.delete(id);
    if (ms && from) {
      V.disp.set(id, { ...from });
      V.anims.set(id, { from: { ...from }, to: geo, t0: now(), ms });
    } else V.disp.set(id, geo);
    if (animate) V.entering.add(id);
    V.rebuild.add(id);
  } else {
    const d = V.disp.get(id) || geo;
    if (d.x !== a.x || d.y !== a.y || d.w !== a.w || d.h !== a.h) {
      if (ms) V.anims.set(id, { from: { ...d }, to: geo, t0: now(), ms });
      else { V.anims.delete(id); V.disp.set(id, geo); }
      V.moved.add(id);
    }
    if (['label', 'kind', 'color', 'text', 'image', 'meta'].some((k) => !same(b[k], a[k]))) V.rebuild.add(id);
  }
  V.attach = true;
  requestFrame();
}

function removeNodeEl(id, animate) {
  const g = V.nodeEls.get(id);
  for (const m of [V.nodeEls, V.disp, V.anims, V.sized]) m.delete(id);
  V.annots.delete(id);
  V.rebuild.delete(id);
  if (ED.target?.type === 'node' && ED.target.id === id) closeEditor(false);
  if (hoverId === id) hoverId = null;
  V.attach = V.mm = V.mmNodes = true;
  if (!g) return;
  g.removeAttribute('data-node');
  g.removeAttribute('tabindex');
  if (animate && animMs()) { g.classList.add('leaving'); setTimeout(() => g.remove(), 200); } else g.remove();
}

/** (Re)creates a node's DOM from the model. */
function buildNode(id) {
  const n = G.nodes.get(id);
  if (!n) return;
  const layer = n.kind === 'group' ? L_GROUPS : L_NODES;
  let g = V.nodeEls.get(id);
  if (!g) {
    g = svg('g', { 'data-node': id, tabindex: '0', role: 'button' });
    V.nodeEls.set(id, g);
  }
  if (g.parentNode !== layer) layer.appendChild(g);
  const entering = V.entering.delete(id) && animMs() > 0;
  g.setAttribute('class', `node kind-${n.kind}${entering ? ' entering' : ''}`);
  if (entering) setTimeout(() => g.classList.remove('entering'), 360);
  g.setAttribute('aria-label', `${n.kind}: ${n.label || n.text || 'untitled'}`);
  if (n.color) g.style.setProperty('--kc', n.color); else g.style.removeProperty('--kc');
  g.replaceChildren();
  if (n.text && n.kind !== 'note') svg('title', {}, g).textContent = n.text;
  const body = svg('g', { class: 'node-body' }, g);
  const r = { halo: svg('path', { class: 'node-halo' }, body), shape: svg('path', { class: 'node-shape' }, body) };
  if (n.kind === 'data') r.deco = svg('path', { class: 'node-deco' }, body);
  if (n.kind === 'group') r.hit = svg('path', { class: 'group-hit' }, body);
  r.fo = svg('foreignObject', { class: 'node-fo' }, body);
  r.fo.appendChild(nodeContent(n));
  r.ports = ['t', 'r', 'b', 'l'].map((p) => svg('circle', { class: 'port', 'data-port': p, r: '5.5' }, body));
  if (MIN_SIZE[n.kind]) {
    r.rz = svg('path', { class: 'resize' }, body);
    r.rzHit = svg('rect', { class: 'resize-hit', 'data-resize': '1', width: '18', height: '18' }, body);
  }
  g._r = r;
  V.sized.delete(id);
  paintNode(id);
  V.moved.add(id);
}

/** HTML content shown inside a node's foreignObject. */
function nodeContent(n) {
  const root = html('div', `node-content k-${n.kind}`);
  if (n.kind === 'image') {
    html('div', 'img-wrap', root).appendChild(mediaEl(n));
    html('div', 'caption', root, n.label);
  } else if (n.kind === 'note') {
    if (n.label) html('div', 'note-title', root, n.label);
    if (n.text) html('div', 'note-text', root, n.text);
    if (!n.label && !n.text) html('div', 'note-text', root, '…');
  } else if (n.kind === 'group') {
    html('div', 'group-title', root, n.label);
  } else {
    html('div', n.label ? 'lbl' : 'lbl empty', root, n.label || 'untitled');
  }
  return root;
}

function placeNode(id) {
  const g = V.nodeEls.get(id);
  const d = V.disp.get(id);
  if (!g || !d) return;
  g.setAttribute('transform', `translate(${d.x.toFixed(1)} ${d.y.toFixed(1)})`);
  const key = `${Math.round(d.w)}x${Math.round(d.h)}`;
  if (V.sized.get(id) !== key) {
    V.sized.set(id, key);
    sizeNode(G.nodes.get(id)?.kind, g._r, Math.round(d.w), Math.round(d.h));
  }
}

/** Applies a w×h size to every size-dependent part of a node. */
function sizeNode(kind, r, w, h) {
  if (!r) return;
  const d = shapePath(kind, w, h);
  r.shape.setAttribute('d', d);
  r.halo.setAttribute('d', d);
  r.hit?.setAttribute('d', d);
  if (r.deco) { const e = Math.min(10, h / 5); r.deco.setAttribute('d', `M0,${e} A${w / 2},${e} 0 0 0 ${w},${e}`); }
  const box = contentBox(kind, w, h);
  for (const k in box) r.fo.setAttribute(k, Math.max(0, box[k]));
  const pts = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
  r.ports.forEach((c, i) => { c.setAttribute('cx', pts[i][0]); c.setAttribute('cy', pts[i][1]); });
  if (r.rz) {
    r.rz.setAttribute('d', `M${w - 13},${h - 4} L${w - 4},${h - 13} M${w - 8},${h - 4} L${w - 4},${h - 8}`);
    r.rzHit.setAttribute('x', w - 18);
    r.rzHit.setAttribute('y', h - 18);
  }
}

function shapePath(kind, w, h) {
  if (kind === 'decision') {
    const k = Math.min(h / 2, w / 4);
    return `M${k},0 H${w - k} L${w},${h / 2} L${w - k},${h} H${k} L0,${h / 2} Z`;
  }
  if (kind === 'data') {
    const e = Math.min(10, h / 5);
    return `M0,${e} A${w / 2},${e} 0 0 1 ${w},${e} V${h - e} A${w / 2},${e} 0 0 1 0,${h - e} Z`;
  }
  const r = Math.min(kind === 'group' ? 16 : kind === 'note' ? 8 : 12, w / 2, h / 2);
  return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
}

function contentBox(kind, w, h) {
  if (kind === 'decision') { const k = Math.min(h / 2, w / 4) * 0.55; return { x: k, y: 0, width: w - 2 * k, height: h }; }
  if (kind === 'data') { const e = Math.min(10, h / 5); return { x: 0, y: e * 1.6, width: w, height: h - e * 2.2 }; }
  if (kind === 'group') return { x: 0, y: 0, width: w, height: 34 };
  return { x: 0, y: 0, width: w, height: h };
}

/** Marks an edge for a full rebuild on the next frame. */
function syncEdge(id) {
  const g = V.edgeEls.get(id);
  if (g) { g.remove(); V.edgeEls.delete(id); }
  V.edges.add(id);
  requestFrame();
}

function buildEdge(e) {
  const g = svg('g', { class: `edge${STYLED_EDGE_KINDS.has(e.kind) ? ` k-${e.kind}` : ''}`, 'data-edge': e.id });
  const r = { hit: svg('path', { class: 'edge-hit' }, g), line: svg('path', { class: 'edge-line' }, g), label: null };
  if (e.label) { r.label = svg('text', { class: 'edge-label' }, g); r.label.textContent = e.label; }
  g._r = r;
  L_EDGES.appendChild(g);
  V.edgeEls.set(e.id, g);
  paintEdge(e.id);
  return g;
}

function routeEdge(id) {
  const e = G.edges.get(id);
  let g = V.edgeEls.get(id);
  const a = e && V.disp.get(e.from);
  const b = e && V.disp.get(e.to);
  if (!e || !a || !b) { if (g) { g.remove(); V.edgeEls.delete(id); } return; }
  if (!g) g = buildEdge(e);
  const geo = e.from === e.to ? loopGeometry(a) : edgeGeometry(a, b);
  g._r.hit.setAttribute('d', geo.d);
  g._r.line.setAttribute('d', geo.d);
  if (g._r.label) { g._r.label.setAttribute('x', geo.mx.toFixed(1)); g._r.label.setAttribute('y', geo.my.toFixed(1)); }
  g._geo = geo;
}

const f1 = (v) => v.toFixed(1);

/**
 * Smooth cubic bezier between two rects, leaving and entering on the sides
 * that face each other. Returns the path and its midpoint (for the label).
 */
function edgeGeometry(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  const horiz = Math.abs(dx) / (a.w + b.w + 1) >= Math.abs(dy) / (a.h + b.h + 1);
  let sx, sy, tx, ty, ux = 0, uy = 0;
  if (horiz) {
    const s = dx >= 0 ? 1 : -1;
    sx = ax + (s * a.w) / 2; sy = ay; tx = bx - (s * b.w) / 2; ty = by; ux = s;
  } else {
    const s = dy >= 0 ? 1 : -1;
    sx = ax; sy = ay + (s * a.h) / 2; tx = bx; ty = by - (s * b.h) / 2; uy = s;
  }
  const along = horiz ? Math.abs(tx - sx) : Math.abs(ty - sy);
  const k = clamp(along * 0.5 + Math.hypot(tx - sx, ty - sy) * 0.1, 24, 180);
  const ex = tx - ux * ARROW_GAP, ey = ty - uy * ARROW_GAP;
  const c1x = sx + ux * k, c1y = sy + uy * k, c2x = ex - ux * k, c2y = ey - uy * k;
  return {
    d: `M${f1(sx)},${f1(sy)} C${f1(c1x)},${f1(c1y)} ${f1(c2x)},${f1(c2y)} ${f1(ex)},${f1(ey)}`,
    mx: (sx + 3 * c1x + 3 * c2x + ex) / 8,
    my: (sy + 3 * c1y + 3 * c2y + ey) / 8,
  };
}

function loopGeometry(a) {
  const x = a.x + a.w * 0.72, y = a.y, x2 = a.x + a.w, y2 = a.y + a.h * 0.3;
  return { d: `M${f1(x)},${f1(y)} C${f1(x)},${f1(y - 56)} ${f1(x2 + 56)},${f1(y2)} ${f1(x2 + ARROW_GAP)},${f1(y2)}`, mx: x2 + 22, my: y - 22 };
}

/** Point where the ray from a rect's centre towards (px,py) leaves the rect. */
function rectExit(r, px, py) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = px - cx, dy = py - cy;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(Math.abs(r.w / 2 / (dx || 1e-9)), Math.abs(r.h / 2 / (dy || 1e-9)));
  return [cx + dx * s, cy + dy * s];
}

/** Dashed connectors from annotation notes to the node they annotate. */
function routeAttachments() {
  const live = new Set();
  for (const id of V.annots) {
    const n = G.nodes.get(id);
    const a = V.disp.get(id), b = n && V.disp.get(n.meta?.attachedTo);
    if (!a || !b) continue;
    live.add(id);
    let p = V.attachEls.get(id);
    if (!p) { p = svg('path', { class: 'attach' }); L_EDGES.prepend(p); V.attachEls.set(id, p); }
    const [x1, y1] = rectExit(a, b.x + b.w / 2, b.y + b.h / 2);
    const [x2, y2] = rectExit(b, a.x + a.w / 2, a.y + a.h / 2);
    p.setAttribute('d', `M${f1(x1)},${f1(y1)} L${f1(x2)},${f1(y2)}`);
  }
  for (const [id, p] of V.attachEls) if (!live.has(id)) { p.remove(); V.attachEls.delete(id); }
}

function paintNode(id) {
  const g = V.nodeEls.get(id);
  if (!g) return;
  g.classList.toggle('sel', sel.has(id));
  g.classList.toggle('connect-src', id === connectSrc);
  paintHL(id, g);
}

function paintEdge(id) {
  const g = V.edgeEls.get(id);
  if (!g) return;
  g.classList.toggle('sel', selE.has(id));
  paintHL(id, g);
}

/** Highlight state of one node or edge element. */
function paintHL(id, el) {
  if (!el) return;
  const c = HL.get(id);
  el.classList.toggle('hl', HL.has(id));
  if (c) el.style.setProperty('--hl', c); else el.style.removeProperty('--hl');
  if (el._r?.line) {
    el._r.line.setAttribute('marker-end', HL.has(id) ? 'url(#arrow-hl)' : selE.has(id) ? 'url(#arrow-sel)' : 'url(#arrow)');
  }
}

function refreshEmpty() { emptyEl.hidden = G.nodes.size > 0; }

// ───────────────────────────── 5. viewport ─────────────────────────────

const local = (e) => ({ sx: e.clientX - R.left, sy: e.clientY - R.top });
const toGraph = (sx, sy) => ({ x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom });
/** Centre of the visible board in graph coordinates. */
const viewCenter = () => toGraph(R.width / 2, R.height / 2);

function applyViewport() {
  world.setAttribute('transform', `translate(${vp.x.toFixed(2)} ${vp.y.toFixed(2)}) scale(${vp.zoom.toFixed(4)})`);
  const pitch = 24 * vp.zoom * (vp.zoom < 0.5 ? 2 : 1);
  board.style.backgroundSize = `${pitch}px ${pitch}px`;
  board.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
  // Semantic zoom: below 75 % text grows (in graph units) so it stays legible.
  const lz = Math.round((vp.zoom < 0.75 ? Math.min(2.6, 0.75 / vp.zoom) : 1) * 10) / 10;
  if (lz !== V.lz) {
    V.lz = lz;
    svgRoot.style.setProperty('--lz', String(lz));
    svgRoot.classList.toggle('lowzoom', vp.zoom < 0.55);
  }
  zoomLabel.textContent = `${Math.round(vp.zoom * 100)}%`;
}

function viewportChanged() { V.vp = true; requestFrame(); saveSoon(); }

/** Pans by a screen-space delta. */
function panBy(dx, dy) {
  V.vpAnim = null;
  vp.x += dx;
  vp.y += dy;
  viewportChanged();
}

/** Zooms to `z`, keeping the screen point (sx, sy) fixed. */
function zoomAt(z, sx, sy) {
  V.vpAnim = null;
  const nz = clamp(z, Z_MIN, Z_MAX);
  const k = nz / vp.zoom;
  vp.x = sx - (sx - vp.x) * k;
  vp.y = sy - (sy - vp.y) * k;
  vp.zoom = nz;
  viewportChanged();
}

/** Animated zoom around the board centre. */
function zoomTo(z) {
  const nz = clamp(z, Z_MIN, Z_MAX), cx = R.width / 2, cy = R.height / 2, k = nz / vp.zoom;
  animateViewport({ x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k, zoom: nz }, 180);
}

/** Eases the viewport to `to` ({x,y,zoom}). */
function animateViewport(to, ms = animMs()) {
  const target = { x: num(to.x, vp.x), y: num(to.y, vp.y), zoom: clamp(num(to.zoom, vp.zoom), Z_MIN, Z_MAX) };
  V.vpAnim = { from: { x: vp.x, y: vp.y, zoom: vp.zoom }, to: target, t0: now(), ms };
  requestFrame();
}

/**
 * Pans/zooms so `nodes` fill the board (leaving room for the toolbar).
 * @param {GNode[]} nodes
 */
function fitTo(nodes, { maxZoom = 1.4 } = {}) {
  const b = bounds(nodes);
  if (!b) return;
  const pad = { t: 92, r: 56, b: 56, l: 56 };
  const W = Math.max(120, R.width - pad.l - pad.r), H = Math.max(120, R.height - pad.t - pad.b);
  const z = clamp(Math.min(W / Math.max(b.w, 1), H / Math.max(b.h, 1)), Z_MIN, maxZoom);
  animateViewport({ x: pad.l + W / 2 - (b.x + b.w / 2) * z, y: pad.t + H / 2 - (b.y + b.h / 2) * z, zoom: z });
}

function fitAll() { if (G.nodes.size) fitTo([...G.nodes.values()]); else animateViewport({ x: R.width / 2, y: R.height / 2, zoom: 1 }); }

/** Fits nodes (edge ids resolve to their endpoints); everything when empty. */
function focusIds(ids) {
  const nodes = [];
  for (const id of ids) {
    if (G.nodes.has(id)) nodes.push(G.nodes.get(id));
    else if (G.edges.has(id)) { const e = G.edges.get(id); nodes.push(G.nodes.get(e.from), G.nodes.get(e.to)); }
  }
  if (nodes.length) fitTo(nodes.filter(Boolean), { maxZoom: 1.25 }); else fitAll();
}

/** True when any part of the rect is on screen. */
function inView(n) {
  const a = toGraph(0, 0), b = toGraph(R.width, R.height);
  return intersects(n, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
}

/** Pans (keeping zoom) so node `id` is fully visible. */
function ensureVisible(id) {
  const n = G.nodes.get(id);
  if (!n) return;
  const z = vp.zoom, sx = n.x * z + vp.x, sy = n.y * z + vp.y;
  if (sx >= 40 && sy >= 72 && sx + n.w * z <= R.width - 40 && sy + n.h * z <= R.height - 40) return;
  animateViewport({ x: R.width / 2 - (n.x + n.w / 2) * z, y: R.height / 2 - (n.y + n.h / 2) * z, zoom: z });
}

/** Where a new thing should go: under the pointer if it is on the board, else the centre. */
function pointOfInterest() {
  return ptr.inside && now() - ptr.ts < 15000 ? { x: ptr.gx, y: ptr.gy } : viewCenter();
}

// ───────────────────────────── 6. pointer / keyboard ─────────────────────────────

let P = {}; // the active gesture
const touches = new Map();
let spaceDown = false;
let lastDownTs = 0;
let lastTap = null;
let trackpadTs = 0;

function trackPointer(e) {
  const { sx, sy } = local(e);
  const g = toGraph(sx, sy);
  ptr.sx = sx; ptr.sy = sy; ptr.gx = g.x; ptr.gy = g.y; ptr.ts = now(); ptr.inside = true;
}

/** Classifies what is under the pointer. */
function hitOf(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return { type: 'empty' };
  if (el.closest('.inline-card')) {
    const grip = el.closest('button, input, textarea, select, a, label') ? null : el.closest('[data-grip]');
    return grip ? { type: 'grip', id: grip.dataset.grip } : { type: 'card' };
  }
  const g = el.closest('[data-node]');
  if (g) {
    if (el.closest('[data-port]')) return { type: 'port', id: g.dataset.node };
    if (el.closest('[data-resize]')) return { type: 'resize', id: g.dataset.node };
    return { type: 'node', id: g.dataset.node };
  }
  const eg = el.closest('[data-edge]');
  if (eg) return { type: 'edge', id: eg.dataset.edge };
  return { type: 'empty' };
}

function begin(e, state) {
  P = { ...state, pid: e.pointerId, cx0: e.clientX, cy0: e.clientY };
  try { svgRoot.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
}

function endGesture() {
  if (P.pid != null) { try { svgRoot.releasePointerCapture(P.pid); } catch { /* not captured */ } }
  if (P.target) V.nodeEls.get(P.target)?.classList.remove('drop-target');
  P = {};
  board.classList.remove('panning', 'dragging');
  marqueeEl.setAttribute('visibility', 'hidden');
  tempEdge.setAttribute('d', '');
}

function cancelGesture() {
  if (P.tx) rollback(P.tx);
  if (P.mode === 'marquee') setSelection(P.base || [], P.baseE || []);
  endGesture();
}

function onPointerDown(e) {
  lastDownTs = now();
  trackPointer(e);
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) { cancelGesture(); startPinch(); return; }
    if (touches.size > 2) return;
  }
  if (e.button === 2) return; // right-click belongs to the companion (shell)
  if (ED.target) closeEditor(true);
  if (!askForm.hidden && !askInput.value.trim()) closeAsk();
  if (!helpEl.hidden) toggleHelp(false);
  const hit = hitOf(e.target);
  if (hit.type === 'card') return;
  if (e.button === 1 || (spaceDown && e.button === 0)) {
    e.preventDefault();
    begin(e, { mode: 'pan', lx: e.clientX, ly: e.clientY });
    board.classList.add('panning');
    lastTap = null;
    return;
  }
  if (e.button !== 0) return;
  if (hit.type !== 'node') svgRoot.focus({ preventScroll: true });

  const key = `${hit.type}:${hit.id || ''}`;
  if (hit.type !== 'grip' && lastTap && lastTap.key === key && lastDownTs - lastTap.t < 380
    && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 8) {
    lastTap = null;
    e.preventDefault(); // no compat mousedown -> focus stays in the editor we open
    onDouble(hit, e);
    return;
  }
  lastTap = { key, t: lastDownTs, x: e.clientX, y: e.clientY };

  const { sx, sy } = local(e);
  switch (hit.type) {
    case 'grip': begin(e, { mode: 'card', id: hit.id, lx: e.clientX, ly: e.clientY }); break;
    case 'port': begin(e, { mode: 'connect', from: hit.id, target: null }); break;
    case 'resize': startResize(e, hit.id); break;
    case 'node': nodeDown(e, hit.id); break;
    case 'edge':
      if (connectMode) break;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selE.has(hit.id)) selE.delete(hit.id); else selE.add(hit.id);
        paintEdge(hit.id);
        selectionChanged();
      } else setSelection([], [hit.id]);
      break;
    default:
      if (connectMode) setConnectSource(null);
      begin(e, { mode: 'marquee?', x0: sx, y0: sy, add: e.shiftKey || e.ctrlKey || e.metaKey, base: [...sel], baseE: [...selE] });
  }
}

function nodeDown(e, id) {
  if (connectMode) { connectClick(id); return; }
  const toggleKey = e.ctrlKey || e.metaKey;
  if (e.shiftKey && !toggleKey) {
    // Shift+click with exactly one other node selected connects A → B.
    if (sel.size === 1 && !sel.has(id)) {
      const [a] = sel;
      if (!edgeBetween(a, id)) { addEdge(a, id); setSelection([id]); return; }
    }
    toggleSel(id);
    return;
  }
  if (toggleKey) { toggleSel(id); return; }
  const collapse = sel.has(id) && sel.size > 1;
  if (!sel.has(id)) setSelection([id]);
  begin(e, { mode: 'press', id, collapse });
}

function onPointerMove(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (P.mode === 'pinch') { pinchMove(); return; }
  }
  trackPointer(e);
  if (!P.mode) {
    const g = e.target instanceof Element ? e.target.closest('[data-node]') : null;
    hoverId = g ? g.dataset.node : null;
    return;
  }
  if (e.pointerId !== P.pid) return;
  const far = Math.hypot(e.clientX - P.cx0, e.clientY - P.cy0) > 3;
  switch (P.mode) {
    case 'pan':
      panBy(e.clientX - P.lx, e.clientY - P.ly);
      P.lx = e.clientX; P.ly = e.clientY;
      break;
    case 'press': if (far) startDrag(); if (P.mode === 'drag') dragMove(e); break;
    case 'drag': dragMove(e); break;
    case 'connect': connectMove(e); break;
    case 'resize': resizeMove(e); break;
    case 'marquee?': if (far) { P.mode = 'marquee'; lastTap = null; } if (P.mode === 'marquee') marqueeMove(e); break;
    case 'card': cardMove(e); break;
    default: break;
  }
}

function onPointerUp(e) {
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (P.mode === 'pinch') { if (touches.size < 2) endGesture(); return; }
  }
  if (!P.mode || e.pointerId !== P.pid) return;
  switch (P.mode) {
    case 'press': if (P.collapse) setSelection([P.id]); break;
    case 'drag': case 'resize': commit(P.tx); break;
    case 'connect': connectEnd(e); break;
    case 'marquee?': if (!P.add) setSelection([]); break;
    default: break;
  }
  endGesture();
}

function onDouble(hit, e) {
  if (hit.type === 'node' || hit.type === 'port' || hit.type === 'resize') { editNode(hit.id); return; }
  if (hit.type === 'edge') { editEdge(hit.id); return; }
  if (hit.type === 'empty') {
    const { sx, sy } = local(e);
    addNodeAt('idea', toGraph(sx, sy), { exact: true });
  }
}

function startDrag() {
  const ids = new Set(sel);
  for (const id of sel) {
    const g = G.nodes.get(id);
    if (g?.kind === 'group') for (const m of G.nodes.values()) if (m.id !== id && contains(g, m)) ids.add(m.id);
  }
  for (const n of G.nodes.values()) if (n.meta?.attachedTo && ids.has(n.meta.attachedTo)) ids.add(n.id);
  P.mode = 'drag';
  lastTap = null;
  P.tx = beginTx('move', 'user');
  P.start = new Map();
  for (const id of ids) {
    const n = G.nodes.get(id);
    if (!n) continue;
    touchN(P.tx, id);
    P.start.set(id, { x: n.x, y: n.y });
  }
  board.classList.add('dragging');
}

function dragMove(e) {
  const dx = (e.clientX - P.cx0) / vp.zoom, dy = (e.clientY - P.cy0) / vp.zoom;
  for (const [id, s] of P.start) {
    const n = G.nodes.get(id);
    if (!n) continue;
    n.x = Math.round(s.x + dx);
    n.y = Math.round(s.y + dy);
    const d = V.disp.get(id);
    if (d) { d.x = n.x; d.y = n.y; }
    V.anims.delete(id);
    V.moved.add(id);
  }
  requestFrame();
}

function startResize(e, id) {
  const n = G.nodes.get(id);
  if (!n) return;
  if (!sel.has(id)) setSelection([id]);
  begin(e, { mode: 'resize', id, w0: n.w, h0: n.h, tx: beginTx('resize', 'user') });
  touchN(P.tx, id);
}

function resizeMove(e) {
  const n = G.nodes.get(P.id);
  const d = V.disp.get(P.id);
  if (!n || !d) return;
  const min = MIN_SIZE[n.kind] || { w: 80, h: 40 };
  n.w = Math.round(Math.max(min.w, P.w0 + (e.clientX - P.cx0) / vp.zoom));
  n.h = Math.round(Math.max(min.h, P.h0 + (e.clientY - P.cy0) / vp.zoom));
  d.w = n.w; d.h = n.h;
  V.moved.add(P.id);
  requestFrame();
}

function connectMove(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const g = el instanceof Element ? el.closest('[data-node]') : null;
  const over = g ? g.dataset.node : null;
  const target = over && over !== P.from ? over : null;
  P.overSelf = over === P.from;
  if (target !== P.target) {
    if (P.target) V.nodeEls.get(P.target)?.classList.remove('drop-target');
    P.target = target;
    if (target) V.nodeEls.get(target)?.classList.add('drop-target');
  }
  const a = V.disp.get(P.from);
  if (!a) return;
  const { sx, sy } = local(e);
  const gp = toGraph(sx, sy);
  const b = target ? V.disp.get(target) : { x: gp.x, y: gp.y, w: 0, h: 0 };
  tempEdge.setAttribute('d', edgeGeometry(a, b).d);
}

function connectEnd(e) {
  const from = P.from, to = P.target;
  if (to) { addEdge(from, to); setSelection([to]); return; }
  if (P.overSelf || Math.hypot(e.clientX - P.cx0, e.clientY - P.cy0) < 14) return;
  // Released on empty space: grow a new, linked node there.
  const kind = { idea: 'idea', step: 'step', decision: 'step', data: 'step' }[G.nodes.get(from)?.kind] || 'idea';
  const { sx, sy } = local(e);
  const gp = toGraph(sx, sy);
  const def = KINDS[kind];
  const node = normNode({ id: newId('n_'), kind, label: def.label, x: gp.x - def.w / 2, y: gp.y - def.h / 2 });
  mutate('add linked node', 'user', (t) => {
    putNode(t, node);
    putEdge(t, normEdge({ id: newId('e_'), from, to: node.id }));
  }, { animate: true });
  setSelection([node.id]);
  editNode(node.id, true);
}

function marqueeMove(e) {
  const { sx, sy } = local(e);
  const x = Math.min(sx, P.x0), y = Math.min(sy, P.y0), w = Math.abs(sx - P.x0), h = Math.abs(sy - P.y0);
  marqueeEl.setAttribute('x', x); marqueeEl.setAttribute('y', y);
  marqueeEl.setAttribute('width', w); marqueeEl.setAttribute('height', h);
  marqueeEl.setAttribute('visibility', 'visible');
  const a = toGraph(x, y), b = toGraph(x + w, y + h);
  const r = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  const hit = [];
  for (const n of G.nodes.values()) if (n.kind === 'group' ? contains(r, n) : intersects(r, n)) hit.push(n.id);
  setSelection(P.add ? [...new Set([...P.base, ...hit])] : hit, P.add ? P.baseE : []);
}

function cardMove(e) {
  const c = cards.get(P.id);
  if (!c) return;
  c.x += (e.clientX - P.lx) / vp.zoom;
  c.y += (e.clientY - P.ly) / vp.zoom;
  P.lx = e.clientX; P.ly = e.clientY;
  c.fo.setAttribute('x', c.x.toFixed(1));
  c.fo.setAttribute('y', c.y.toFixed(1));
}

function startPinch() {
  const [a, b] = [...touches.values()];
  const mx = (a.x + b.x) / 2 - R.left, my = (a.y + b.y) / 2 - R.top;
  P = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: vp.zoom, g0: toGraph(mx, my) };
}

function pinchMove() {
  const [a, b] = [...touches.values()];
  if (!a || !b) return;
  const z = clamp((P.z0 * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / P.d0, Z_MIN, Z_MAX);
  const mx = (a.x + b.x) / 2 - R.left, my = (a.y + b.y) / 2 - R.top;
  V.vpAnim = null;
  vp.zoom = z;
  vp.x = mx - P.g0.x * z;
  vp.y = my - P.g0.y * z;
  viewportChanged();
}

function onWheel(e) {
  if (e.target instanceof Element && e.target.closest('.inline-card') && !e.ctrlKey) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? R.height : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  const t = now();
  if (!e.ctrlKey && Math.abs(dx) > 0.5) trackpadTs = t;
  // Two-finger trackpad scroll pans; the mouse wheel and pinch (ctrl) zoom.
  if (!e.ctrlKey && (e.shiftKey || t - trackpadTs < 400)) {
    if (e.shiftKey && !dx) panBy(-dy, 0); else panBy(-dx, -dy);
    return;
  }
  const { sx, sy } = local(e);
  zoomAt(vp.zoom * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)), sx, sy);
}

function onKeyDown(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const t = e.target instanceof Element ? e.target : null;
  if (isEditable(t)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (e.code === 'Space' && !mod && !e.altKey) {
    if (t && t.closest('button, a, [role="button"]:not(.node), [role="menuitem"]')) return;
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; board.classList.add('space'); }
    return;
  }
  if (mod && !e.altKey) {
    const lk = k.toLowerCase();
    if (lk === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (lk === 'y') { e.preventDefault(); redo(); }
    else if (lk === 'd') { e.preventDefault(); duplicateSelection(); }
    else if (lk === 'a') { e.preventDefault(); selectAll(); }
    else if (k === '0') { e.preventDefault(); zoomTo(1); }
    else if (k === '=' || k === '+') { e.preventDefault(); zoomTo(vp.zoom * 1.25); }
    else if (k === '-') { e.preventDefault(); zoomTo(vp.zoom / 1.25); }
    return;
  }
  if (e.altKey) return;
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[k]) {
    e.preventDefault();
    const [dx, dy] = arrows[k], step = e.shiftKey ? 10 : 1;
    if (!nudge(dx * step, dy * step)) panBy(-dx * 48, -dy * 48);
    return;
  }
  switch (k) {
    case 'Escape': escape(); break;
    case 'Delete': case 'Backspace':
      if (sel.size || selE.size) { e.preventDefault(); deleteSelection(); }
      break;
    case 'Enter': case 'F2':
      if (sel.size === 1) { e.preventDefault(); editNode([...sel][0]); }
      else if (!sel.size && selE.size === 1) { e.preventDefault(); editEdge([...selE][0]); }
      break;
    case 'n': case 'N': e.preventDefault(); addNodeAt('idea', pointOfInterest()); break;
    case 'c': case 'C': setConnectMode(!connectMode); break;
    case 'f': case 'F': fitAll(); break;
    case 'a': case 'A': e.preventDefault(); openAsk(); break;
    case '?': toggleHelp(); break;
    case '+': case '=': zoomTo(vp.zoom * 1.25); break;
    case '-': zoomTo(vp.zoom / 1.25); break;
    case '0': zoomTo(1); break;
    case '1': case '2': case '3': case '4': case '5':
      setKindOf([...sel], KIND_KEYS[Number(k) - 1]);
      break;
    default: break;
  }
}

function onKeyUp(e) {
  if (e.code === 'Space' && spaceDown) { spaceDown = false; board.classList.remove('space'); }
}

/** Esc: closes the innermost thing that is open. */
function escape() {
  if (!helpEl.hidden) { toggleHelp(false); return; }
  if (P.mode) { cancelGesture(); return; }
  if (connectMode) { setConnectMode(false); return; }
  if (sel.size || selE.size) setSelection([]);
}

/** Keyboard focus on a node (Tab) selects it and brings it into view. */
function onFocusIn(e) {
  const g = e.target instanceof Element ? e.target.closest('[data-node]') : null;
  if (!g || now() - lastDownTs < 250) return;
  const id = g.dataset.node;
  if (!(sel.size === 1 && sel.has(id))) setSelection([id]);
  ensureVisible(id);
  const n = G.nodes.get(id);
  if (n) announce(`${n.kind}: ${n.label || 'untitled'}`);
}

// ───────────────────────────── 7. label editor ─────────────────────────────

const ED = { target: null }; // {type:'node'|'edge', id, isNew, multi}

/**
 * Opens the overlay editor on a node's label (notes: label + body text).
 * @param {string} id
 * @param {boolean} [isNew]
 */
function editNode(id, isNew = false) {
  const n = G.nodes.get(id);
  if (!n) return;
  closeEditor(true);
  const multi = n.kind === 'note';
  ED.target = { type: 'node', id, isNew, multi };
  editor.value = multi ? (n.meta?.annotation ? n.text || '' : [n.label, n.text].filter(Boolean).join('\n')) : n.label;
  editor.className = multi ? 'editor multi' : 'editor';
  editor.setAttribute('aria-label', multi ? 'Edit note (Ctrl+Enter saves)' : 'Edit label (Enter saves)');
  openEditor();
}

/** Opens the overlay editor on an edge label. */
function editEdge(id) {
  const e = G.edges.get(id);
  if (!e) return;
  closeEditor(true);
  ED.target = { type: 'edge', id, isNew: false, multi: false };
  editor.value = e.label || '';
  editor.className = 'editor';
  editor.setAttribute('aria-label', 'Edit connection label (Enter saves)');
  openEditor();
}

function openEditor() {
  editor.hidden = false;
  positionEditor();
  editor.focus({ preventScroll: true });
  editor.select();
}

function positionEditor() {
  const t = ED.target;
  if (!t) return;
  const z = vp.zoom;
  const fs = clamp(14 * z, 13, 26);
  let x, y, w, h;
  if (t.type === 'node') {
    const d = V.disp.get(t.id);
    if (!d) return;
    w = Math.max(180, d.w * z);
    h = t.multi ? Math.max(96, d.h * z) : Math.max(fs * 1.3 + 16, Math.min(d.h * z, fs * 3 + 16));
    x = d.x * z + vp.x + (d.w * z - w) / 2;
    y = d.y * z + vp.y + (d.h * z - h) / 2;
  } else {
    const g = V.edgeEls.get(t.id);
    if (!g?._geo) return;
    w = 200; h = fs * 1.3 + 14;
    x = g._geo.mx * z + vp.x - w / 2;
    y = g._geo.my * z + vp.y - h / 2;
  }
  editor.style.left = `${Math.round(x)}px`;
  editor.style.top = `${Math.round(y)}px`;
  editor.style.width = `${Math.round(w)}px`;
  editor.style.height = `${Math.round(h)}px`;
  editor.style.fontSize = `${fs.toFixed(1)}px`;
}

/** Closes the editor, committing (save=true) or discarding the text; `refocus` returns focus to the board. */
function closeEditor(save, refocus = false) {
  const t = ED.target;
  if (!t) return;
  ED.target = null;
  editor.hidden = true;
  const v = editor.value;
  if (save) {
    if (t.type === 'node') {
      const n = G.nodes.get(t.id);
      if (n) {
        let patch;
        if (t.multi && n.meta?.annotation) patch = { text: v.trim() || null };
        else if (t.multi) {
          const [first, ...rest] = v.split('\n');
          patch = { label: first.trim().slice(0, 300), text: rest.join('\n').trim() || null };
        } else patch = { label: v.replace(/\s+/g, ' ').trim().slice(0, 300) || (t.isNew ? n.label : '') };
        mutate('edit label', 'user', (tx) => putNode(tx, normNode({ ...n, ...patch })));
      }
    } else {
      const e = G.edges.get(t.id);
      if (e) mutate('edit edge', 'user', (tx) => putEdge(tx, normEdge({ ...e, label: v.replace(/\s+/g, ' ').trim() || null })));
    }
  }
  if (refocus) svgRoot.focus({ preventScroll: true });
}

editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeEditor(false, true); return; }
  if (e.key === 'Enter' && (!ED.target?.multi || e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); closeEditor(true, true); }
});
editor.addEventListener('blur', () => closeEditor(true));

// ───────────────────────────── 8. user actions ─────────────────────────────

/** Replaces the selection (node ids, edge ids). */
function setSelection(ids = [], edgeIds = []) {
  const before = [...sel].join() + '|' + [...selE].join();
  sel.clear();
  for (const id of ids) if (G.nodes.has(id)) sel.add(id);
  selE.clear();
  for (const id of edgeIds) if (G.edges.has(id)) selE.add(id);
  if ([...sel].join() + '|' + [...selE].join() === before) return;
  for (const id of V.nodeEls.keys()) paintNode(id);
  for (const id of V.edgeEls.keys()) paintEdge(id);
  selectionChanged();
}

function toggleSel(id) {
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  paintNode(id);
  selectionChanged();
}

function selectionChanged() { emitSelectSoon(); }

function selectAll() { setSelection([...G.nodes.keys()], [...G.edges.keys()]); }

/**
 * Adds a node of `kind` centred on graph point `at` and opens its editor.
 * A group added while nodes are selected wraps them.
 * @returns {string} the new id
 */
function addNodeAt(kind, at, { edit = true, exact = false } = {}) {
  const def = KINDS[kind] || KINDS.idea;
  let w = def.w, h = def.h, x = at.x - w / 2, y = at.y - h / 2;
  const picked = [...sel].map((id) => G.nodes.get(id)).filter(Boolean);
  if (kind === 'group' && picked.length) {
    const b = bounds(picked);
    x = b.x - 28; y = b.y - 52; w = b.w + 56; h = b.h + 80;
  } else if (!exact) ({ x, y } = findFreeSpot(obstacles(), { x, y, w, h }));
  const n = normNode({ id: newId('n_'), kind, label: def.label, x, y, w, h });
  mutate(`add ${kind}`, 'user', (t) => putNode(t, n), { animate: true });
  setSelection([n.id]);
  ensureVisible(n.id);
  if (edit) editNode(n.id, true);
  return n.id;
}

/** Toolbar "add": next to the single selected node, else the view centre. */
function addFromToolbar(kind) {
  if (kind !== 'group' && sel.size === 1) {
    const near = G.nodes.get([...sel][0]);
    const def = KINDS[kind];
    const spot = findFreeSpot(obstacles(), { x: 0, y: 0, w: def.w, h: def.h }, { near });
    addNodeAt(kind, { x: spot.x + def.w / 2, y: spot.y + def.h / 2 }, { exact: true });
  } else addNodeAt(kind, viewCenter());
}

const obstacles = () => [...G.nodes.values()].filter((n) => n.kind !== 'group');

function edgeBetween(a, b) {
  for (const id of byNode.get(a) || []) { const e = G.edges.get(id); if (e && e.from === a && e.to === b) return e; }
  return null;
}

/** Connects two nodes (no duplicates). @returns {string|null} edge id */
function addEdge(from, to) {
  if (!G.nodes.has(from) || !G.nodes.has(to)) return null;
  const ex = edgeBetween(from, to);
  if (ex) return ex.id;
  const e = normEdge({ id: newId('e_'), from, to });
  mutate('connect', 'user', (t) => putEdge(t, e));
  react('wink');
  return e.id;
}

/** Chains nodes A→B→C in reading order (along the wider axis). */
function chainConnect(ids) {
  const nodes = ids.map((id) => G.nodes.get(id)).filter((n) => n && n.kind !== 'group');
  if (nodes.length < 2) return;
  const b = bounds(nodes);
  nodes.sort(b.w >= b.h ? (p, q) => p.x - q.x || p.y - q.y : (p, q) => p.y - q.y || p.x - q.x);
  mutate('connect selected', 'user', (t) => {
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1].id, c = nodes[i].id;
      if (!edgeBetween(a, c)) putEdge(t, normEdge({ id: newId('e_'), from: a, to: c }));
    }
  });
}

function deleteSelection() {
  if (!sel.size && !selE.size) return;
  const ns = [...sel], es = [...selE];
  mutate('delete', 'user', (t) => { for (const id of es) dropEdge(t, id); dropNodes(t, ns); }, { animate: true });
  setSelection([]);
}

function duplicateSelection() {
  if (!sel.size) return;
  const frag = fragment([...sel]);
  const b = bounds(frag.nodes);
  insertFragment(frag, { x: b.x + b.w / 2 + 32, y: b.y + b.h / 2 + 32 }, 'duplicate');
}

/** Moves the selection by a delta; consecutive nudges merge into one undo step. */
function nudge(dx, dy) {
  const ids = [...sel];
  if (!ids.length) return false;
  mutate('nudge', 'user', (t) => {
    for (const id of ids) { const n = G.nodes.get(id); if (n) putNode(t, { ...n, x: n.x + dx, y: n.y + dy }); }
  }, { animate: false, merge: `nudge:${ids.join(',')}` });
  return true;
}

/** Converts nodes to another kind (keys 1–5), resizing those still at the default size. */
function setKindOf(ids, kind) {
  if (!ids.length || !KINDS[kind]) return;
  mutate(`make ${kind}`, 'user', (t) => {
    for (const id of ids) {
      const n = G.nodes.get(id);
      if (!n || n.kind === kind || n.kind === 'group' || n.kind === 'image') continue;
      const od = KINDS[n.kind], nd = KINDS[kind];
      const resize = n.w === od.w && n.h === od.h;
      putNode(t, normNode({ ...n, kind, w: resize ? nd.w : n.w, h: resize ? nd.h : n.h }));
    }
  }, { animate: true });
}

/** Removes everything (undoable). */
function clearBoard(origin) {
  const had = G.nodes.size + G.edges.size;
  mutate('clear', origin, (t) => {
    for (const id of [...G.edges.keys()]) dropEdge(t, id);
    for (const id of [...G.nodes.keys()]) dropNode(t, id);
  }, { animate: true });
  if (origin === 'user') {
    animateViewport({ x: R.width / 2, y: R.height / 2, zoom: 1 });
    if (had) toast('Board cleared — Ctrl+Z brings it back');
  }
}

/**
 * Auto-layout (tree | grid | radial) of `ids` (or all nodes). Groups are
 * re-wrapped around their members, annotations follow their nodes.
 * @returns {number} how many nodes were placed
 */
function applyLayout(mode, { root, ids = null, origin = 'user' } = {}) {
  const fn = LAYOUTS[mode];
  if (!fn) throw new Error(`unknown layout mode "${mode}" (tree | grid | radial)`);
  const want = ids ? new Set(ids) : null;
  const all = [...G.nodes.values()];
  const movable = all.filter((n) => n.kind !== 'group' && !n.meta?.attachedTo && (!want || want.has(n.id)));
  if (!movable.length) return 0;
  const groups = all.filter((g) => g.kind === 'group' && movable.some((m) => contains(g, m)));
  const members = new Map(groups.map((g) => [g.id, movable.filter((m) => contains(g, m)).map((m) => m.id)]));
  const old = new Map(movable.map((n) => [n.id, { x: n.x, y: n.y }]));
  const pos = fn({ nodes: movable, edges: [...G.edges.values()] }, { root: cleanId(root) || undefined });
  mutate(`layout ${mode}`, origin, (t) => {
    for (const [id, p] of Object.entries(pos)) { const n = G.nodes.get(id); if (n) putNode(t, { ...n, x: p.x, y: p.y }); }
    for (const n of all) {
      const tid = n.meta?.attachedTo;
      const cur = G.nodes.get(n.id);
      if (!tid || !pos[tid] || !cur) continue;
      putNode(t, { ...cur, x: cur.x + pos[tid].x - old.get(tid).x, y: cur.y + pos[tid].y - old.get(tid).y });
    }
    for (const [gid, mids] of members) {
      const b = bounds(mids.map((id) => G.nodes.get(id)));
      const g = G.nodes.get(gid);
      if (b && g) putNode(t, { ...g, x: Math.round(b.x - 28), y: Math.round(b.y - 52), w: Math.round(b.w + 56), h: Math.round(b.h + 80) });
    }
  }, { animate: true });
  return Object.keys(pos).length;
}

function layoutFromToolbar(mode) {
  const ids = sel.size >= 2 ? [...sel] : null;
  const n = applyLayout(mode, { ids });
  if (n) announce(`${mode} layout applied to ${n} nodes`);
  if (!ids && n) setTimeout(fitAll, animMs() + 20);
}

/**
 * Pulses a glow on nodes/edges. ttl 0 keeps it until cleared; empty ids clear all.
 * @param {string[]} ids
 * @param {string} [color]
 * @param {number} [ttl] ms, default 3000
 */
function highlight(ids, color, ttl) {
  if (!ids.length) { for (const id of [...HL.keys()]) unhighlight(id); return; }
  const c = validColor(color) ? color : '';
  const life = ttl === 0 ? 0 : clamp(num(ttl, 3000), 300, 120000);
  for (const id of ids) {
    if (!G.nodes.has(id) && !G.edges.has(id)) continue;
    HL.set(id, c);
    paintHL(id, V.nodeEls.get(id));
    paintHL(id, V.edgeEls.get(id));
    clearTimeout(hlTimers.get(id));
    hlTimers.delete(id);
    if (life) hlTimers.set(id, setTimeout(() => unhighlight(id), life));
  }
}

function unhighlight(id) {
  HL.delete(id);
  clearTimeout(hlTimers.get(id));
  hlTimers.delete(id);
  paintHL(id, V.nodeEls.get(id));
  paintHL(id, V.edgeEls.get(id));
}

function setConnectMode(on) {
  connectMode = !!on;
  board.classList.toggle('connecting', connectMode);
  btnConnect.setAttribute('aria-pressed', String(connectMode));
  setConnectSource(connectMode && sel.size === 1 ? [...sel][0] : null);
  showHint(connectMode ? 'Connect: click a source, then a target · Esc to finish' : '');
}

function setConnectSource(id) {
  const prev = connectSrc;
  connectSrc = id;
  if (prev) paintNode(prev);
  if (id) paintNode(id);
}

function connectClick(id) {
  if (!connectSrc || connectSrc === id) { setConnectSource(id); setSelection([id]); return; }
  addEdge(connectSrc, id);
  setConnectSource(id);
  setSelection([id]);
}

// ───────────────────────────── 9. outgoing events ─────────────────────────────

const pend = { added: new Set(), removed: new Set(), updated: new Set() };

function markDiff(id, b, a) {
  if (!b && a) {
    if (pend.removed.delete(id)) pend.updated.add(id); else pend.added.add(id);
  } else if (b && !a) {
    if (!pend.added.delete(id)) pend.removed.add(id);
    pend.updated.delete(id);
  } else if (!pend.added.has(id)) pend.updated.add(id);
}

/** graph.changed — debounced 400 ms, diff since the last emit. */
const changedSoon = debounce(() => {
  const diff = { added: [...pend.added], removed: [...pend.removed], updated: [...pend.updated] };
  pend.added.clear(); pend.removed.clear(); pend.updated.clear();
  lets.emit('graph.changed', { rev: G.rev, summary: { nodes: G.nodes.size, edges: G.edges.size }, diff });
}, 400);

let lastSelKey = '';
/** graph.node.select — debounced 150 ms, only when the node selection really changed. */
const emitSelectSoon = debounce(() => {
  const ids = [...sel];
  const key = ids.join(',');
  if (key === lastSelKey) return;
  lastSelKey = key;
  lets.emit('graph.node.select', { ids, labels: ids.map((id) => G.nodes.get(id)?.label ?? '') });
}, 150);

/** Fine-grained events for the human's own edits (not echoed for Claude's commands). */
function emitGranular(ch) {
  const delN = [], delE = [];
  for (const [id, b, a] of ch.nodes) {
    if (!b) lets.emit('graph.node.create', { node: clone(a) });
    else if (!a) delN.push(id);
    else {
      const patch = {};
      for (const k of NODE_KEYS) if (!same(b[k], a[k])) patch[k] = a[k] === undefined ? null : a[k];
      lets.emit('graph.node.update', { id, patch });
    }
  }
  if (delN.length) lets.emit('graph.node.delete', { ids: delN });
  for (const [id, b, a] of ch.edges) {
    if (!b) lets.emit('graph.edge.create', { edge: clone(a) });
    else if (!a) delE.push(id);
  }
  if (delE.length) lets.emit('graph.edge.delete', { ids: delE });
}

/**
 * "Send to Claude": graph.export with the full graph. The engine saves it as a
 * session and (by default) asks this window to close — Claude answers in the
 * Claude Code chat, and `/lets graph resume` brings the board back.
 */
function sendToClaude() {
  closeEditor(true);
  changedSoon.flush();
  save();
  lets.emitNow('graph.export', { graph: exportGraph() });
  btnSend.classList.remove('sent');
  void btnSend.getBoundingClientRect();
  btnSend.classList.add('sent');
  react('cheer');
  toast(G.nodes.size ? `Sent ${G.nodes.size} node${G.nodes.size === 1 ? '' : 's'} to Claude — continue in Claude Code` : 'Sent an empty board to Claude', 'ok');
  if (hasShell && shell.listening === false) toast('Pip is away — Claude reads this with your next message in Claude Code', 'info', 4500);
}

/** Play one of the companion's short expressions, if the shell has them (0.4.0+). */
function react(name) {
  try { shell.entity?.react?.(name); } catch { /* optional */ }
}

/** graph.ask with the selection (or explicit ids) and the full graph; mirrors the question in chat. */
function emitAsk(question, ids = null) {
  changedSoon.flush();
  const selection = Array.isArray(ids) && ids.length ? ids.filter((id) => G.nodes.has(id)) : [...sel];
  const labels = selection.map((id) => G.nodes.get(id)?.label).filter(Boolean);
  lets.emitNow('graph.ask', { question, selection, labels, graph: exportGraph() });
  try { shell.chat?.open?.(); shell.chat?.append?.('you', labels.length ? `${question}  ·  ${labels.join(', ')}` : question); } catch { /* chat optional */ }
  if (!hasShell) toast('Question sent to Claude', 'ok');
  else if (shell.listening === false) toast('Pip is away — Claude reads this with your next message in Claude Code', 'info', 4500);
}

// ───────────────────────────── 10. incoming commands ─────────────────────────────

const COMMANDS = {
  'graph.load': cmdLoad,
  'graph.clear': () => clearBoard('claude'),
  'graph.node.add': cmdNodeAdd,
  'graph.node.set': cmdNodeSet,
  'graph.node.remove': (d) => mutate('remove nodes', 'claude', (t) => dropNodes(t, listOf(d.ids))),
  'graph.edge.add': cmdEdgeAdd,
  'graph.edge.remove': (d) => mutate('remove edges', 'claude', (t) => { for (const id of listOf(d.ids)) dropEdge(t, id); }),
  'graph.layout': (d) => {
    const ids = d.ids != null ? listOf(d.ids) : null;
    applyLayout(String(d.mode || 'tree'), { root: d.root, ids, origin: 'claude' });
  },
  'graph.focus': (d) => focusIds(listOf(d.ids)),
  'graph.highlight': (d) => highlight(listOf(d.ids), d.color, d.ttl),
  'graph.annotate': cmdAnnotate,
  'graph.snapshot': (d, msg) => lets.emitNow('graph.snapshot', { graph: exportGraph() }, msg?.id ? { re: msg.id } : undefined),
};
const STRUCTURAL = new Set(['graph.load', 'graph.clear', 'graph.node.remove']);

/** Runs a command; errors become lip.ack{ok:false} (if acked) or lip.error. */
function runCommand(type, fn, data, msg) {
  try {
    if (STRUCTURAL.has(type) && P.mode) cancelGesture();
    fn(data && typeof data === 'object' ? data : {}, msg);
  } catch (err) {
    if (msg?.ack) throw err;
    const message = `${type}: ${err?.message || err}`;
    console.warn('[graph]', message);
    lets.emit('lip.error', { code: 'bad_request', message, re: msg?.id });
  }
}

function cmdLoad(d) {
  const g = d.graph;
  if (!g || typeof g !== 'object') throw new Error('expected {graph:{nodes,edges}}');
  const merge = !!d.merge;
  const inNodes = (Array.isArray(g.nodes) ? g.nodes : []).filter((n) => n && typeof n === 'object').slice(0, 2000);
  const inEdges = (Array.isArray(g.edges) ? g.edges : []).filter((e) => e && typeof e === 'object').slice(0, 5000);
  const unplaced = [];
  let skipped = 0;
  mutate(merge ? 'merge graph' : 'load graph', 'claude', (t) => {
    if (!merge) {
      for (const id of [...G.edges.keys()]) dropEdge(t, id);
      for (const id of [...G.nodes.keys()]) dropNode(t, id);
    }
    for (const raw of inNodes) {
      const id = cleanId(raw.id) || newId('n_');
      const prev = G.nodes.get(id);
      const placed = num(raw.x, null) != null && num(raw.y, null) != null;
      if (!placed && !prev) unplaced.push(id);
      putNode(t, normNode({ ...(prev || {}), ...raw, id }));
    }
    const edges = [];
    for (const raw of inEdges) {
      const from = cleanId(raw.from), to = cleanId(raw.to);
      if (!G.nodes.has(from) || !G.nodes.has(to)) { skipped++; continue; }
      edges.push(normEdge({ ...raw, id: cleanId(raw.id) || newId('e_'), from, to }));
    }
    if (unplaced.length) autoPlace(unplaced, edges);
    for (const e of edges) putEdge(t, e);
  });
  if (!merge) {
    const v = g.viewport;
    if (v && num(v.x, null) != null && num(v.y, null) != null && num(v.zoom, null) != null) animateViewport(v);
    else if (G.nodes.size) setTimeout(fitAll, animMs() + 20);
  } else if (unplaced.length) setTimeout(() => focusIds(unplaced), animMs() + 20);
  if (skipped) lets.emit('lip.error', { code: 'partial', message: `graph.load: skipped ${skipped} edge(s) with unknown endpoints` });
}

/** Lays out nodes that arrived without coordinates (tree), beside the rest. */
function autoPlace(ids, edges) {
  const set = new Set(ids);
  const nodes = ids.map((id) => G.nodes.get(id));
  const pos = treeLayout({ nodes, edges }, { origin: { x: 0, y: 0 } });
  const blk = bounds(nodes.map((n) => ({ ...n, ...pos[n.id] })));
  const others = [...G.nodes.values()].filter((n) => !set.has(n.id));
  let ox, oy;
  if (others.length) { const b = bounds(others); ox = b.x + b.w + 120; oy = b.y; } else { const c = viewCenter(); ox = c.x - blk.w / 2; oy = c.y - blk.h / 2; }
  for (const n of nodes) { n.x = Math.round(pos[n.id].x + ox); n.y = Math.round(pos[n.id].y + oy); }
}

function cmdNodeAdd(d) {
  const id = cleanId(d.id) || newId('n_');
  if (G.nodes.has(id)) { cmdNodeSet({ id, patch: d }); return; }
  const kind = KINDS[d.kind] ? d.kind : 'idea';
  const w = clamp(num(d.w, KINDS[kind].w), 40, 4000), h = clamp(num(d.h, KINDS[kind].h), 32, 4000);
  let x = num(d.x, null), y = num(d.y, null);
  const near = d.near != null ? G.nodes.get(cleanId(d.near)) : null;
  if (x == null || y == null) {
    const c = viewCenter();
    ({ x, y } = findFreeSpot(obstacles(), { x: c.x - w / 2, y: c.y - h / 2, w, h }, { near }));
    if (near) V.spawn.set(id, { x: near.x + near.w / 2 - w / 2, y: near.y + near.h / 2 - h / 2, w, h });
  }
  const node = normNode({ ...d, id, kind, x, y, w, h });
  mutate('Claude added a node', 'claude', (t) => putNode(t, node));
  announce(`Claude added ${node.label || 'a node'}`);
  if (!inView(node) && now() - offscreenToastTs > 5000) {
    offscreenToastTs = now();
    toast(`Claude added “${node.label || node.kind}” off-screen — press F to fit`);
  }
}
let offscreenToastTs = -1e9;

function cmdNodeSet(d) {
  const id = cleanId(d.id);
  const old = G.nodes.get(id);
  if (!old) throw new Error(`no node "${d.id}"`);
  const patch = d.patch && typeof d.patch === 'object' ? { ...d.patch } : {};
  delete patch.id;
  delete patch.near;
  if (KINDS[patch.kind] && patch.kind !== old.kind && patch.w == null && patch.h == null) {
    const od = KINDS[old.kind];
    if (old.w === od.w && old.h === od.h) { patch.w = KINDS[patch.kind].w; patch.h = KINDS[patch.kind].h; }
  }
  mutate('Claude edited a node', 'claude', (t) => putNode(t, normNode({ ...old, ...patch, id })));
}

function cmdEdgeAdd(d) {
  const from = cleanId(d.from), to = cleanId(d.to);
  if (!G.nodes.has(from) || !G.nodes.has(to)) throw new Error(`edge endpoints must exist (${d.from} → ${d.to})`);
  const id = cleanId(d.id) || edgeBetween(from, to)?.id || newId('e_');
  const prev = G.edges.get(id);
  mutate('Claude connected nodes', 'claude', (t) => putEdge(t, normEdge({ ...(prev || {}), ...d, id, from, to })));
}

const noteHeight = (text) => clamp(30 + (Math.ceil(text.length / 26) + text.split('\n').length - 1) * 18, 56, 320);

function cmdAnnotate(d) {
  const id = cleanId(d.id);
  const target = G.nodes.get(id);
  if (!target) throw new Error(`no node "${d.id}"`);
  const text = str(d.text, 4000).trim();
  const existing = [...G.nodes.values()].find((n) => n.meta?.attachedTo === id && n.meta?.annotation);
  if (existing) {
    mutate('Claude annotated', 'claude', (t) => {
      if (text) putNode(t, normNode({ ...existing, text, h: Math.max(existing.h, noteHeight(text)) }));
      else dropNode(t, existing.id);
    });
    return;
  }
  if (!text) return;
  const w = 210, h = noteHeight(text);
  const spot = findFreeSpot(obstacles(), { x: target.x + target.w + 36, y: target.y - h - 20, w, h }, { margin: 16 });
  const node = normNode({ id: newId('n_'), kind: 'note', label: '', text, x: spot.x, y: spot.y, w, h, meta: { attachedTo: id, annotation: true, by: 'claude' } });
  V.spawn.set(node.id, { x: target.x + target.w / 2 - w / 2, y: target.y + target.h / 2 - h / 2, w, h });
  mutate('Claude annotated', 'claude', (t) => putNode(t, node));
}

// ───────────────────────────── 11. media, clipboard, inline components ─────────────────────────────

const pending = []; // image blobs seen in paste/drop, waiting for the shell's upload result
const seenPaths = new Set();
const bitmaps = new Map(); // image key -> Promise<ImageBitmap|null>
let mediaStore = null;
let shellMedia = false;

/** Same-origin web paths can be shown directly; filesystem paths cannot. */
function webSrc(p) {
  if (typeof p !== 'string' || !p) return null;
  if (/^\/(u|lip|sdk|uploads)\//.test(p)) return p;
  if (/^https?:\/\//i.test(p)) { try { return new URL(p).origin === location.origin ? p : null; } catch { return null; } }
  return null;
}

/** <img> for web paths, else a <canvas> painted from the local thumbnail cache (CSP-safe). */
function mediaEl(n) {
  const src = webSrc(n.image) || webSrc(n.meta?.src);
  if (src) {
    const img = html('img');
    img.alt = n.label || 'image';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('error', () => img.replaceWith(imagePlaceholder(n)), { once: true });
    img.src = src;
    return img;
  }
  const canvas = html('canvas', 'thumb');
  canvas.width = 1; canvas.height = 1;
  getBitmap(n.image).then((bm) => {
    if (!bm) { canvas.replaceWith(imagePlaceholder(n)); return; }
    canvas.width = bm.width; canvas.height = bm.height;
    canvas.getContext('2d').drawImage(bm, 0, 0);
  }).catch(() => canvas.replaceWith(imagePlaceholder(n)));
  return canvas;
}

function imagePlaceholder(n) { return html('div', 'img-ph', null, basename(n.image) || 'image'); }

function readMedia() {
  if (!mediaStore) {
    try { mediaStore = JSON.parse(localStorage.getItem(MEDIA_KEY) || '{}') || {}; } catch { mediaStore = {}; }
  }
  return mediaStore;
}

function writeMedia() {
  const store = readMedia();
  const keys = Object.keys(store).sort((a, b) => store[a].t - store[b].t);
  let size = keys.reduce((s, k) => s + store[k].d.length, 0);
  while (size > 2_400_000 && keys.length > 1) { const k = keys.shift(); size -= store[k].d.length; delete store[k]; }
  for (let i = 0; i < 4; i++) {
    try { localStorage.setItem(MEDIA_KEY, JSON.stringify(store)); return; } catch {
      const k = keys.shift();
      if (!k) return;
      delete store[k];
    }
  }
}

function getBitmap(key) {
  if (!key) return Promise.resolve(null);
  if (!bitmaps.has(key)) {
    const rec = readMedia()[key];
    bitmaps.set(key, rec ? decodeThumb(rec).catch(() => null) : Promise.resolve(null));
  }
  return bitmaps.get(key);
}

async function decodeThumb(rec) {
  const bin = atob(rec.d);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: rec.m }));
}

/** Decodes an image blob into the in-memory + localStorage thumbnail caches. */
async function cacheImage(key, blob) {
  let bm = await createImageBitmap(blob);
  const iw = bm.width, ih = bm.height, big = Math.max(iw, ih);
  if (big > 1600) {
    const s = 1600 / big;
    const small = await createImageBitmap(bm, { resizeWidth: Math.round(iw * s), resizeHeight: Math.round(ih * s), resizeQuality: 'high' });
    bm.close();
    bm = small;
  }
  bitmaps.set(key, Promise.resolve(bm));
  try {
    const s = Math.min(1, 480 / Math.max(bm.width, bm.height));
    const c = html('canvas');
    c.width = Math.max(1, Math.round(bm.width * s));
    c.height = Math.max(1, Math.round(bm.height * s));
    c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/webp', 0.8);
    readMedia()[key] = { m: url.slice(5, url.indexOf(';')), d: url.slice(url.indexOf(',') + 1), t: Date.now() };
    writeMedia();
  } catch { /* thumbnails are best-effort */ }
  for (const n of G.nodes.values()) if (n.image === key) V.rebuild.add(n.id);
  requestFrame();
  return { w: iw, h: ih };
}

/**
 * Places an uploaded image as an `image` node.
 * @param {{path:string, url?:string, w?:number, h?:number, mime?:string, name?:string, source?:string}} info
 * @param {Blob|null} blob local copy for the preview
 * @param {{x:number,y:number}} at graph point to centre on
 */
async function placeImage(info, blob, at) {
  const key = info.path;
  seenPaths.add(key);
  let iw = num(info.w, 0), ih = num(info.h, 0);
  if (blob) {
    try { const s = await cacheImage(key, blob); iw = iw || s.w; ih = ih || s.h; } catch { /* undecodable */ }
  }
  const w = 240, imgH = iw && ih ? clamp(Math.round((w - 12) * ih / iw), 80, 360) : 160, h = imgH + 34;
  const named = info.name && !/^image\.(png|jpe?g|webp|gif)$/i.test(basename(info.name));
  const label = named ? basename(info.name).replace(/\.[a-z0-9]+$/i, '').slice(0, 48) : info.source === 'paste' ? 'Screenshot' : 'Image';
  const spot = findFreeSpot(obstacles(), { x: at.x - w / 2, y: at.y - h / 2, w, h });
  const meta = {};
  if (info.mime) meta.mime = info.mime;
  if (iw && ih) { meta.w = iw; meta.h = ih; }
  if (webSrc(info.url)) meta.src = info.url;
  const node = normNode({ id: newId('n_'), kind: 'image', label, x: spot.x, y: spot.y, w, h, image: key, meta });
  mutate('add image', 'user', (t) => putNode(t, node), { animate: true });
  setSelection([node.id]);
}

function takePending(res) {
  const t = Date.now();
  for (let i = pending.length - 1; i >= 0; i--) if (t - pending[i].ts > 30000) pending.splice(i, 1);
  let idx = res.bytes ? pending.findIndex((p) => p.blob.size === res.bytes) : -1;
  if (idx < 0 && res.source) idx = pending.findIndex((p) => p.source === res.source);
  return idx < 0 ? null : pending.splice(idx, 1)[0];
}

/** shell.onMedia: an image the shell uploaded (paste / drop / image-drop card). */
function onShellMedia(res) {
  if (!res || typeof res !== 'object') return;
  const path = res.path || res.url;
  if (!path || seenPaths.has(path)) return;
  if (res.mime && !String(res.mime).startsWith('image/')) return;
  const p = takePending(res);
  // A paste/drop we did not see on the board (e.g. into the chat) is not ours to place.
  if (!p && !res.componentId && (res.source === 'paste' || res.source === 'drop')) return;
  const blob = res.blob instanceof Blob ? res.blob : res.file instanceof Blob ? res.file : p?.blob || null;
  const at = p?.at || (res.componentId ? viewCenter() : pointOfInterest());
  placeImage({ path, url: res.url, w: res.w, h: res.h, mime: res.mime, name: res.name || blob?.name, source: res.source }, blob, at)
    .catch((err) => console.warn('[graph] could not place image', err));
}

/** Uploads files ourselves (toolbar picker, or no shell available). */
async function uploadImages(files, at, source) {
  let i = 0;
  for (const f of files) {
    const spot = { x: at.x + i * 28, y: at.y + i * 28 };
    i++;
    let res = null;
    try { res = await lets.upload(f, { source, name: f.name || '' }); } catch {
      toast('Upload failed — the image stays on this board only', 'warn');
    }
    const key = res?.path || `local:${Date.now().toString(36)}-${basename(f.name || 'image').slice(0, 40)}`;
    await placeImage({ path: key, w: res?.w, h: res?.h, mime: res?.mime || f.type, name: f.name, source }, f, spot);
  }
}

/** Serialisable sub-graph for copy / duplicate. */
function fragment(ids) {
  const set = new Set(ids);
  for (const n of G.nodes.values()) if (n.meta?.attachedTo && set.has(n.meta.attachedTo)) set.add(n.id);
  return {
    'lets-graph': 1,
    nodes: [...set].map((id) => clone(G.nodes.get(id))).filter(Boolean),
    edges: [...G.edges.values()].filter((e) => set.has(e.from) && set.has(e.to)).map(clone),
  };
}

/** Inserts a fragment with fresh ids, centred on `at`. */
function insertFragment(frag, at, label = 'paste') {
  const src = (Array.isArray(frag.nodes) ? frag.nodes : []).filter((n) => n && n.id != null).slice(0, 500);
  if (!src.length) return;
  const map = new Map(), taken = new Set();
  for (const n of src) { const id = newId('n_', taken); taken.add(id); map.set(String(n.id), id); }
  const b = bounds(src.map((n) => normNode(n)));
  const dx = Math.round(at.x - (b.x + b.w / 2)), dy = Math.round(at.y - (b.y + b.h / 2));
  mutate(label, 'user', (t) => {
    for (const raw of src) {
      const n = normNode({ ...raw, id: map.get(String(raw.id)) });
      n.x += dx; n.y += dy;
      if (n.meta?.attachedTo) { const m = map.get(String(n.meta.attachedTo)); if (m) n.meta.attachedTo = m; else delete n.meta.attachedTo; }
      putNode(t, n);
    }
    for (const raw of Array.isArray(frag.edges) ? frag.edges : []) {
      const from = map.get(String(raw?.from)), to = map.get(String(raw?.to));
      if (from && to) putEdge(t, normEdge({ ...raw, id: newId('e_'), from, to }));
    }
  }, { animate: true });
  setSelection([...map.values()]);
}

/** Plain text pasted on the board becomes nodes (a list → a column of ideas). */
function pasteText(text) {
  try {
    const j = JSON.parse(text);
    if (j && j['lets-graph'] === 1) { insertFragment(j, pointOfInterest()); return; }
  } catch { /* not ours */ }
  const clean = text.trim().slice(0, 8000);
  if (!clean) return;
  const lines = clean.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  const at = pointOfInterest();
  if (lines.length > 1 && lines.length <= 16 && lines.every((l) => l.length <= 60)) {
    const nodes = lines.map((l, i) => normNode({ id: newId('n_'), kind: 'idea', label: l, x: at.x - 84, y: at.y + i * 84 - lines.length * 42 }));
    mutate('paste list', 'user', (t) => { for (const n of nodes) putNode(t, n); }, { animate: true });
    setSelection(nodes.map((n) => n.id));
  } else if (lines.length === 1 && lines[0].length <= 80) {
    const d = KINDS.idea;
    const spot = findFreeSpot(obstacles(), { x: at.x - d.w / 2, y: at.y - d.h / 2, w: d.w, h: d.h });
    const n = normNode({ id: newId('n_'), kind: 'idea', label: lines[0], x: spot.x, y: spot.y });
    mutate('paste', 'user', (t) => putNode(t, n), { animate: true });
    setSelection([n.id]);
  } else {
    const [first, ...rest] = clean.split(/\r?\n/);
    const n = normNode({ id: newId('n_'), kind: 'note', label: first.slice(0, 60), text: rest.join('\n').trim(), x: at.x - 140, y: at.y - 90, w: 280, h: 180 });
    mutate('paste note', 'user', (t) => putNode(t, n), { animate: true });
    setSelection([n.id]);
  }
}

const canUseClipboard = () => !isEditable(document.activeElement) && !String(getSelection?.() || '');

function onCopy(e, cut = false) {
  if (!sel.size || !canUseClipboard() || !e.clipboardData) return;
  e.clipboardData.setData('text/plain', JSON.stringify(fragment([...sel])));
  e.preventDefault();
  announce(`${cut ? 'Cut' : 'Copied'} ${sel.size} node${sel.size === 1 ? '' : 's'}`);
  if (cut) deleteSelection();
}

function onPaste(e) {
  const dt = e.clipboardData;
  if (!dt) return;
  const inField = isEditable(e.target instanceof Element ? e.target : document.activeElement);
  const files = [...dt.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) {
    if (inField) return; // chat / form pastes are the shell's business
    const at = pointOfInterest();
    if (shellMedia) files.forEach((f, i) => pending.push({ blob: f, ts: Date.now(), at: { x: at.x + i * 28, y: at.y + i * 28 }, source: 'paste' }));
    else { e.preventDefault(); uploadImages(files, at, 'paste'); }
    return;
  }
  if (inField) return;
  const text = dt.getData('text/plain');
  if (!text || !text.trim()) return;
  e.preventDefault();
  pasteText(text);
}

function onDrop(e) {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length || !(e.target instanceof Node) || !board.contains(e.target)) return;
  e.preventDefault();
  const { sx, sy } = local(e);
  const at = toGraph(sx, sy);
  if (shellMedia) files.forEach((f, i) => pending.push({ blob: f, ts: Date.now(), at: { x: at.x + i * 28, y: at.y + i * 28 }, source: 'drop' }));
  else uploadImages(files, at, 'drop');
}

const cards = new Map(); // inline component id -> {fo, wrap, el, x, y, ro, mo}

/**
 * shell.onInline: places an `inline` component as a card on the canvas. The
 * shell hands `{id, type, el, props, update, remove}`. Placement: `props.near`
 * (a node id, card goes to its right), else `props.at` / `at` in GRAPH
 * coordinates, else the view centre.
 */
function placeInline(a, b) {
  const el = a instanceof Element ? a : a?.el || a?.element;
  const spec = (a instanceof Element ? b : a) || {};
  if (!(el instanceof Element)) return;
  const props = (spec.props && typeof spec.props === 'object' ? spec.props : null) || {};
  const id = String(spec.id || el.dataset?.id || el.id || newId('c_'));
  removeCard(id);
  const fo = svg('foreignObject', { class: 'inline-fo', width: '320', height: '60' }, L_INLINE);
  const wrap = html('div', 'inline-card', fo);
  const head = el.querySelector?.('.lets-card-head');
  if (head) head.dataset.grip = id; // the card's own title bar moves it
  else { const grip = html('div', 'inline-grip', wrap); grip.dataset.grip = id; grip.title = 'Drag to move'; }
  wrap.appendChild(el);
  const near = G.nodes.get(cleanId(props.near ?? spec.near));
  const at = props.at || spec.at;
  let x, y;
  if (near) { x = near.x + near.w + 40; y = near.y; }
  else if (at && num(at.x, null) != null && num(at.y, null) != null) { x = +at.x; y = +at.y; }
  else { const c = viewCenter(); x = c.x - 160; y = c.y - 90; }
  fo.setAttribute('x', x);
  fo.setAttribute('y', y);
  const card = { id, fo, wrap, el, x, y };
  card.ro = new ResizeObserver(() => fo.setAttribute('height', String(Math.max(40, Math.ceil(wrap.offsetHeight) + 2))));
  card.ro.observe(wrap);
  card.mo = new MutationObserver(() => { if (!wrap.contains(el)) removeCard(id); });
  card.mo.observe(wrap, { childList: true });
  cards.set(id, card);
}

function removeCard(id) {
  const c = cards.get(id);
  if (!c) return;
  c.ro.disconnect();
  c.mo.disconnect();
  c.fo.remove();
  cards.delete(id);
}

// ───────────────────────────── 12. entity, chrome, persistence, start-up ─────────────────────────────

/**
 * Entity context (UI-CONTRACT §3.4). The shell calls it on summon / click /
 * hotkey with `{reason, x, y, target?}` (screen coordinates).
 * @returns {{selection:string[], hover:string|null, counts:{nodes:number, edges:number}, at:{x:number, y:number}}}
 */
function entityContext(info) {
  let at = { x: ptr.gx, y: ptr.gy };
  if (info && num(info.x, null) != null && num(info.y, null) != null) at = toGraph(info.x - R.left, info.y - R.top);
  const g = info?.target instanceof Element ? info.target.closest('[data-node]') : null;
  return {
    selection: [...sel],
    hover: g ? g.dataset.node : hoverId,
    counts: { nodes: G.nodes.size, edges: G.edges.size },
    at: { x: Math.round(at.x), y: Math.round(at.y) },
  };
}

let suggestCtx = null;
/**
 * Instant local suggestions for the companion's click menu (§3.4). Each item
 * carries `run(item, ctx)`, which the shell calls after emitting `entity.pick`.
 * @returns {{id:string, label:string, hint?:string, run:Function}[]}
 */
/** The node ids a suggestion is about: the selection, else the node under the pointer when summoned. */
function pipFocus() {
  const ids = (suggestCtx?.selection || []).filter((id) => G.nodes.has(id));
  if (ids.length) return ids;
  const hov = suggestCtx?.hover;
  return hov && G.nodes.has(hov) ? [hov] : [];
}

/**
 * Pip's click menu. Everything here is about what the human is looking at:
 * with a selection (or a hovered node) the questions target it; on empty
 * space they target the whole board. Every "ask" item becomes a `graph.ask`
 * event with the question, the ids and the labels, so Claude answers in chat
 * and points with `graph.highlight`.
 */
function quickSuggestions(ctx) {
  suggestCtx = ctx && typeof ctx === 'object' ? ctx : entityContext();
  const focus = pipFocus();
  const n = focus.length;
  const names = focus.map((id) => G.nodes.get(id)?.label).filter(Boolean);
  const what = n === 1 ? `“${(names[0] || 'this').slice(0, 24)}”` : n ? `these ${n}` : 'the board';
  const run = (item, c) => { if (c && typeof c === 'object') suggestCtx = c; runPick(item?.id); };
  const it = (id, label, hint) => ({ id, label, hint, run });
  const items = [];
  if (n) {
    items.push(
      it('graph.ask-explain', `Explain ${what}`, 'Claude explains it in chat'),
      it('graph.ask-missing', `What's missing around ${what}?`, 'gaps, risks, forgotten steps'),
      it('graph.ask-next', 'Suggest what comes next', 'Claude adds nodes after it'),
      it('graph.ask-break', 'Break it into steps', 'smaller nodes, connected'),
      it('graph.ask-critique', 'Critique it', 'the honest take, briefly'),
      it('graph.ask-rename', 'Better name?', 'Claude proposes a label'),
    );
    if (n >= 2) items.push(it('graph.connect-selected', 'Connect them', `chain ${n} nodes in reading order`));
    else items.push(it('graph.add-here', 'Add a node here', 'a new idea at this spot'));
  } else {
    items.push(
      it('graph.ask-see', 'What do you see?', 'Claude reads the whole board'),
      it('graph.ask-structure', 'Suggest a structure', 'a skeleton to start from'),
      it('graph.ask-review', 'Review the flow', 'order, gaps, naming'),
      it('graph.add-here', 'Add a node here', 'a new idea at this spot'),
      it('graph.auto-layout', 'Auto-layout', 'tidy the board as a tree'),
    );
  }
  items.push(it('graph.open-chat', 'Open chat', 'type to Claude'), it('graph.paste-screenshot', 'Paste a screenshot', 'drop or paste an image onto the board'));
  return items;
}

/** Ask Claude about the focused nodes (or the board). */
function askAbout(question) {
  const ids = pipFocus();
  if (!ids.length) { emitAsk(question, []); return; }
  if (!ids.every((id) => sel.has(id)) || sel.size !== ids.length) setSelection(ids);
  emitAsk(question, ids);
}

const PICKS = {
  'graph.ask-explain': () => askAbout(pipFocus().length ? 'Explain the selected part of this graph.' : 'Explain this graph.'),
  'graph.ask-missing': () => askAbout('What is missing around the selected nodes? Name gaps, risks and forgotten steps; add the important ones as nodes near them.'),
  'graph.ask-next': () => askAbout('Suggest what comes next after the selected nodes, and add the best 2–4 as connected nodes.'),
  'graph.ask-break': () => askAbout('Break the selected node(s) into smaller concrete steps as connected nodes.'),
  'graph.ask-critique': () => askAbout('Critique the selected part honestly and briefly: what is unclear, risky or over-engineered?'),
  'graph.ask-rename': () => askAbout('Propose a better, shorter label for the selected node(s) and apply it with graph.node.set if it is clearly better.'),
  'graph.ask-see': () => askAbout('What do you see on this board? Summarize the flow in a few lines and point at anything odd.'),
  'graph.ask-structure': () => askAbout('Suggest a structure for what I am trying to design here and add a small skeleton of nodes I can edit.'),
  'graph.ask-review': () => askAbout('Review this flow: order, gaps and naming. Highlight what you talk about.'),
  'graph.add-here': () => {
    const at = suggestCtx?.at && num(suggestCtx.at.x, null) != null ? suggestCtx.at : pointOfInterest();
    const id = addNodeAt('idea', at, { edit: false });
    setTimeout(() => editNode(id, true), 80);
  },
  'graph.connect-selected': () => {
    if (sel.size >= 2) chainConnect([...sel]);
    else { setConnectMode(true); toast('Pick a source node, then a target'); }
  },
  'graph.auto-layout': () => layoutFromToolbar('tree'),
  'graph.explain-selection': () => emitAsk(sel.size ? 'Explain the selected part of this graph.' : 'Explain this graph.'),
  'graph.open-chat': () => { try { shell.chat?.open?.(); } catch { /* optional */ } },
  'graph.paste-screenshot': () => openScreenshotDrop(),
};
let lastPick = { id: '', t: 0 };

function runPick(id) {
  if (!Object.hasOwn(PICKS, id) || (lastPick.id === id && now() - lastPick.t < 400)) return;
  lastPick = { id, t: now() };
  try { PICKS[id](); } catch (err) { console.warn('[graph] suggestion failed', err); }
}

function openScreenshotDrop() {
  if (!hasShell || typeof shell.components?.create !== 'function') { fileInput.click(); return; }
  try {
    if (shell.components.get?.('graph-screenshot')) shell.components.remove('graph-screenshot');
    shell.components.create({
      id: 'graph-screenshot',
      type: 'image-drop',
      props: { title: 'Paste a screenshot', hint: 'Ctrl+V or drop an image — it lands on the board as a node', multiple: true },
      slot: 'float',
      at: { x: Math.round(ptr.sx + R.left), y: Math.round(ptr.sy + R.top) },
    });
  } catch { fileInput.click(); }
}

function toggleEntity() {
  const e = shell.entity;
  if (!e) { toast('The companion is not available here', 'warn'); return; }
  try {
    if (typeof e.toggle === 'function') { e.toggle(); return; }
    const visible = typeof e.visible === 'boolean' ? e.visible : typeof e.isVisible === 'function' ? e.isVisible() : false;
    if (visible) e.hide?.(); else e.show?.();
  } catch (err) { console.warn('[graph] companion toggle failed', err); }
}

/** Shell toast, or a local one when running without the shell. */
function toast(text, level = 'info', ttl = 3500) {
  if (hasShell && typeof shell.toast === 'function') {
    try { shell.toast(text, level, ttl); return; } catch { /* fall through */ }
  }
  const el = html('div', level, $('g-toast'), text);
  setTimeout(() => el.remove(), ttl);
}

function announce(text) { $('sr-live').textContent = text; }

function showHint(text) { modeHint.textContent = text; modeHint.hidden = !text; }

function toggleHelp(force) {
  const show = typeof force === 'boolean' ? force : helpEl.hidden;
  helpEl.hidden = !show;
  btnHelp.setAttribute('aria-expanded', String(show));
  if (show) closeAsk();
}

function openAsk() {
  toggleHelp(false);
  askForm.hidden = false;
  askInput.placeholder = sel.size
    ? `Ask Claude about the ${sel.size} selected node${sel.size === 1 ? '' : 's'}…`
    : 'Ask Claude about this board…';
  askInput.focus();
}

function closeAsk() {
  if (askForm.hidden) return;
  const hadFocus = document.activeElement === askInput;
  askForm.hidden = true;
  if (hadFocus) svgRoot.focus({ preventScroll: true });
}

function showStatus(s) {
  statusDot.dataset.status = s;
  const text = s === 'open' ? 'Connected to Claude' : s === 'closed' ? 'Offline — your board is kept locally' : 'Connecting to Claude…';
  statusDot.setAttribute('aria-label', text);
  statusDot.parentElement.title = `graph · ${text}`;
}

let mmDrag = false;
/** Minimap: node rects + the visible area; drag to pan. */
function drawMinimap() {
  mmBox.hidden = G.nodes.size === 0;
  if (!G.nodes.size) return;
  if (V.mmNodes) {
    V.mmNodes = false;
    const rects = mmNodes.children;
    let i = 0;
    for (const [id, d] of V.disp) {
      const n = G.nodes.get(id);
      if (!n) continue;
      const r = rects[i++] || svg('rect', { rx: '10' }, mmNodes);
      r.setAttribute('x', d.x.toFixed(0)); r.setAttribute('y', d.y.toFixed(0));
      r.setAttribute('width', d.w.toFixed(0)); r.setAttribute('height', d.h.toFixed(0));
      r.setAttribute('class', n.kind === 'group' ? 'mm-node group' : 'mm-node');
      r.style.setProperty('--mm', n.color || KIND_COLOR[n.kind]);
    }
    while (rects.length > i) rects[rects.length - 1].remove();
  }
  const view = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: R.width / vp.zoom, h: R.height / vp.zoom };
  if (!mmDrag) {
    const b = bounds([...V.disp.values(), view]);
    const pad = Math.max(b.w, b.h) * 0.05 + 20;
    mmSvg.setAttribute('viewBox', `${(b.x - pad).toFixed(0)} ${(b.y - pad).toFixed(0)} ${(b.w + pad * 2).toFixed(0)} ${(b.h + pad * 2).toFixed(0)}`);
  }
  mmView.setAttribute('x', view.x.toFixed(0)); mmView.setAttribute('y', view.y.toFixed(0));
  mmView.setAttribute('width', view.w.toFixed(0)); mmView.setAttribute('height', view.h.toFixed(0));
}

function mmJump(e) {
  const m = mmSvg.getScreenCTM();
  if (!m) return;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  V.vpAnim = null;
  vp.x = R.width / 2 - p.x * vp.zoom;
  vp.y = R.height / 2 - p.y * vp.zoom;
  viewportChanged();
}

let saveWarned = false;
/** Persists the graph to localStorage (`lets.graph.<windowId>`). */
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(exportGraph())); } catch {
    if (!saveWarned) { saveWarned = true; toast('Could not save the board locally (storage full?)', 'warn'); }
  }
}
const saveSoon = debounce(save, 400);

/** Restores the persisted graph (no undo entry, no events). @returns {boolean} */
function restore() {
  let g = null;
  try { g = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { g = null; }
  if (!g || !Array.isArray(g.nodes)) return false;
  for (const raw of g.nodes) {
    const id = raw && cleanId(raw.id);
    if (!id) continue;
    const n = normNode({ ...raw, id });
    G.nodes.set(id, n);
    V.disp.set(id, { x: n.x, y: n.y, w: n.w, h: n.h });
    if (n.meta?.attachedTo) V.annots.add(id);
    V.rebuild.add(id);
  }
  for (const raw of Array.isArray(g.edges) ? g.edges : []) {
    const id = raw && cleanId(raw.id), from = raw && cleanId(raw.from), to = raw && cleanId(raw.to);
    if (!id || !G.nodes.has(from) || !G.nodes.has(to)) continue;
    setRaw('e', id, normEdge({ ...raw, id, from, to }));
    V.edges.add(id);
  }
  G.rev = Math.max(0, Math.floor(num(g.rev, 0)));
  const v = g.viewport;
  if (v && num(v.x, null) != null && num(v.y, null) != null) {
    vp.x = +v.x; vp.y = +v.y; vp.zoom = clamp(num(v.zoom, 1), Z_MIN, Z_MAX);
  } else { vp.x = R.width / 2; vp.y = R.height / 2; }
  V.attach = true;
  return true;
}

// ── start-up ──

if (!restore()) { vp.x = Math.round(R.width / 2); vp.y = Math.round(R.height / 2); }

let shell = {
  entity: null,
  chat: null,
  components: null,
  media: null,
  toast: null,
};
let hasShell = false;
if (ShellApi && typeof ShellApi.mount === 'function') {
  try {
    shell = ShellApi.mount(lets, { root: document.body, entity: { name: 'Pip' }, context: entityContext, quickSuggestions }) || shell;
    hasShell = true;
  } catch (err) {
    console.warn('[graph] Shell.mount failed — running without the shell:', err?.message || err);
  }
}
if (hasShell) {
  try { if (typeof shell.onMedia === 'function') { shell.onMedia(onShellMedia); shellMedia = true; } } catch (err) { console.warn('[graph] onMedia', err); }
  try { shell.onInline?.(placeInline); } catch (err) { console.warn('[graph] onInline', err); }
  // Shells without run() on suggestions: entity.onPick fires too (runPick dedupes).
  try { shell.entity?.onPick?.((it) => runPick(it?.id)); } catch (err) { console.warn('[graph] onPick', err); }
  // Idempotent: the shell already listens on document unless mounted with media:false.
  try { shell.media?.enablePaste?.(document); shell.media?.enableDrop?.(document); } catch (err) { console.warn('[graph] media', err); }
}

for (const [type, fn] of Object.entries(COMMANDS)) lets.on(type, (data, msg) => runCommand(type, fn, data, msg));
// The shell fades the card out, then detaches it (the MutationObserver catches that); this is a backstop.
lets.on('component.remove', (d) => { if (d?.id != null) setTimeout(() => removeCard(String(d.id)), 400); });
lets.onStatus(showStatus);
showStatus(lets.status);

svgRoot.addEventListener('pointerdown', onPointerDown);
svgRoot.addEventListener('pointermove', onPointerMove);
svgRoot.addEventListener('pointerup', onPointerUp);
svgRoot.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); cancelGesture(); });
svgRoot.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
svgRoot.addEventListener('wheel', onWheel, { passive: false });
svgRoot.addEventListener('focusin', onFocusIn);
board.addEventListener('pointerleave', () => { ptr.inside = false; if (!P.mode) hoverId = null; });
board.addEventListener('contextmenu', trackPointer, true);
board.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('keydown', onKeyDown);
addEventListener('keyup', onKeyUp);
addEventListener('blur', () => { spaceDown = false; board.classList.remove('space'); });
document.addEventListener('copy', (e) => onCopy(e));
document.addEventListener('cut', (e) => onCopy(e, true));
document.addEventListener('paste', onPaste, true);
document.addEventListener('drop', onDrop, true);
addEventListener('pagehide', save);
addEventListener('beforeunload', save);
new ResizeObserver(() => { R = board.getBoundingClientRect(); V.mm = true; requestFrame(); }).observe(board);

toolbar.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-act]') : null;
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'add') addFromToolbar(b.dataset.kind);
  else if (act === 'add-image') fileInput.click();
  else if (act === 'connect') setConnectMode(!connectMode);
  else if (act === 'layout') layoutFromToolbar(b.dataset.mode);
  else if (act === 'fit') fitAll();
  else if (act === 'zoom-reset') zoomTo(1);
  else if (act === 'undo') undo();
  else if (act === 'redo') redo();
  else if (act === 'new') clearBoard('user');
  else if (act === 'send') sendToClaude();
  else if (act === 'ask') { if (askForm.hidden) openAsk(); else closeAsk(); }
  else if (act === 'chat') { try { shell.chat?.toggle?.(); } catch { /* optional */ } if (!hasShell) toast('Chat needs the lets shell', 'warn'); }
  else if (act === 'entity') toggleEntity();
  else if (act === 'help') toggleHelp();
});

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = askInput.value.trim();
  askInput.value = '';
  closeAsk();
  if (q) emitAsk(q);
});
askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askInput.value = ''; closeAsk(); }
});

fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files || [])].filter((f) => f.type.startsWith('image/'));
  fileInput.value = '';
  if (!files.length) return;
  const near = sel.size === 1 ? G.nodes.get([...sel][0]) : null;
  uploadImages(files, near ? { x: near.x + near.w + 160, y: near.y + near.h / 2 } : viewCenter(), 'file');
});

mmSvg.addEventListener('pointerdown', (e) => { mmDrag = true; try { mmSvg.setPointerCapture(e.pointerId); } catch { /* ignore */ } mmJump(e); });
mmSvg.addEventListener('pointermove', (e) => { if (mmDrag) mmJump(e); });
for (const ev of ['pointerup', 'pointercancel']) mmSvg.addEventListener(ev, () => { mmDrag = false; V.mm = true; requestFrame(); });

refreshEmpty();
syncUndoButtons();
V.vp = V.mm = V.mmNodes = true;
requestFrame();
