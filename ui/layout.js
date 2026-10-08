/**
 * layout.js — pure auto-layout helpers for the `graph` unique.
 *
 * Every export is a pure function over graph JSON (`{nodes, edges}`, the shape
 * in docs/UI-CONTRACT.md §3.2). Nothing here touches the DOM or mutates its
 * input. Positions are TOP-LEFT corners in graph units, matching `{x, y, w, h}`
 * on nodes. Layout functions return a position map `{ [id]: {x, y} }`
 * containing only the nodes they placed.
 */

const DEFAULT_W = 160;
const DEFAULT_H = 60;

/** @typedef {{id:string, x?:number, y?:number, w?:number, h?:number}} LNode */
/** @typedef {{from:string, to:string}} LEdge */
/** @typedef {{nodes: LNode[], edges: LEdge[]}} LGraph */
/** @typedef {Object<string, {x:number, y:number}>} Positions */
/** @typedef {{x:number, y:number, w:number, h:number}} Rect */

const fin = (v) => (Number.isFinite(v) ? v : 0);
const dims = (n) => ({ w: n.w > 0 ? n.w : DEFAULT_W, h: n.h > 0 ? n.h : DEFAULT_H });

/**
 * Bounding box of rect-like nodes.
 * @param {LNode[]} nodes
 * @returns {Rect|null} null for an empty list
 */
export function bounds(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (!n) continue;
    const { w, h } = dims(n);
    const x = fin(n.x), y = fin(n.y);
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x + w > x1) x1 = x + w;
    if (y + h > y1) y1 = y + h;
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Restricts a graph to `ids` (all nodes when omitted); drops self-loops and dangling edges. */
function subset(graph, ids) {
  const want = ids ? new Set(ids) : null;
  const nodes = (graph.nodes || []).filter((n) => n && (!want || want.has(n.id)));
  const has = new Set(nodes.map((n) => n.id));
  const edges = (graph.edges || []).filter((e) => e && has.has(e.from) && has.has(e.to) && e.from !== e.to);
  return { nodes, edges };
}

/**
 * BFS spanning forest. Children are visited in the user's reading order
 * (top-to-bottom, then left-to-right) so layouts keep the order they drew.
 * @returns {{roots:string[], children:Map<string,string[]>, depth:Map<string,number>, order:string[], byId:Map<string,LNode>}}
 */
function forest(nodes, edges, root, directed) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reading = (a, b) => {
    const A = byId.get(a), B = byId.get(b);
    return (fin(A.y) - fin(B.y)) || (fin(A.x) - fin(B.x));
  };
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
  const depth = new Map();
  const order = [];
  const roots = [];
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
  for (const id of ids) {
    x0 = Math.min(x0, pos[id].x);
    y0 = Math.min(y0, pos[id].y);
  }
  for (const id of ids) {
    pos[id] = { x: Math.round(pos[id].x - x0 + o.x), y: Math.round(pos[id].y - y0 + o.y) };
  }
  return pos;
}

/**
 * Layered tree layout (flows read left→right by default). Parents are centred
 * on their subtree; every subtree owns its own band, so nothing overlaps.
 * Cycles are broken by BFS; disconnected parts become extra roots stacked below.
 * @param {LGraph} graph
 * @param {{root?:string, ids?:string[], dir?:'LR'|'TB', gapMain?:number, gapCross?:number, origin?:{x:number,y:number}}} [opts]
 * @returns {Positions}
 */
export function treeLayout(graph, opts = {}) {
  const { root, ids, dir = 'LR', gapMain = 84, gapCross = 28, origin } = opts;
  const { nodes, edges } = subset(graph, ids);
  if (!nodes.length) return {};
  const f = forest(nodes, edges, root, true);
  const horizontal = dir !== 'TB';
  const mainOf = (id) => { const d = dims(f.byId.get(id)); return horizontal ? d.w : d.h; };
  const crossOf = (id) => { const d = dims(f.byId.get(id)); return horizontal ? d.h : d.w; };

  const colSize = [];
  for (const id of f.order) {
    const d = f.depth.get(id);
    colSize[d] = Math.max(colSize[d] || 0, mainOf(id));
  }
  const colPos = [];
  let acc = 0;
  for (let d = 0; d < colSize.length; d++) { colPos[d] = acc; acc += colSize[d] + gapMain; }

  const ext = new Map();
  const kidsSpan = (id) => f.children.get(id).reduce((s, k, i) => s + ext.get(k) + (i ? gapCross : 0), 0);
  const measure = (id) => {
    for (const k of f.children.get(id)) measure(k);
    ext.set(id, Math.max(crossOf(id), kidsSpan(id)));
  };
  const pos = {};
  const assign = (id, start) => {
    const d = f.depth.get(id);
    const main = colPos[d] + (colSize[d] - mainOf(id)) / 2;
    const cross = start + (ext.get(id) - crossOf(id)) / 2;
    pos[id] = horizontal ? { x: main, y: cross } : { x: cross, y: main };
    let s = start + (ext.get(id) - kidsSpan(id)) / 2;
    for (const k of f.children.get(id)) { assign(k, s); s += ext.get(k) + gapCross; }
  };
  let start = 0;
  for (const r of f.roots) {
    measure(r);
    assign(r, start);
    start += ext.get(r) + gapCross * 2;
  }
  return anchorTo(pos, nodes, origin);
}

/**
 * Grid layout in flow order (BFS from the roots), aiming for a ~16:10 block.
 * @param {LGraph} graph
 * @param {{root?:string, ids?:string[], gap?:number, cols?:number, origin?:{x:number,y:number}}} [opts]
 * @returns {Positions}
 */
export function gridLayout(graph, opts = {}) {
  const { root, ids, gap = 36, cols, origin } = opts;
  const { nodes, edges } = subset(graph, ids);
  if (!nodes.length) return {};
  const f = forest(nodes, edges, root, true);
  let cw = 0, ch = 0;
  for (const n of nodes) { const d = dims(n); cw = Math.max(cw, d.w); ch = Math.max(ch, d.h); }
  const count = f.order.length;
  const c = Math.max(1, Math.min(count, cols || Math.ceil(Math.sqrt(count * ((ch + gap) / (cw + gap)) * 1.6))));
  const pos = {};
  f.order.forEach((id, i) => {
    const d = dims(f.byId.get(id));
    const col = i % c, row = Math.floor(i / c);
    pos[id] = { x: col * (cw + gap) + (cw - d.w) / 2, y: row * (ch + gap) + (ch - d.h) / 2 };
  });
  return anchorTo(pos, nodes, origin);
}

/**
 * Radial layout: the root (given, or the best-connected node) sits in the
 * centre and stays where it was; each subtree gets an angular sector
 * proportional to its leaf count, rings grow so siblings never touch.
 * Other connected components are laid out radially in a row to the right.
 * @param {LGraph} graph
 * @param {{root?:string, ids?:string[], gap?:number, origin?:{x:number,y:number}}} [opts]
 * @returns {Positions}
 */
export function radialLayout(graph, opts = {}) {
  const { ids, gap = 44, origin } = opts;
  const { nodes, edges } = subset(graph, ids);
  if (!nodes.length) return {};
  let root = opts.root && nodes.some((n) => n.id === opts.root) ? opts.root : null;
  if (!root) {
    const deg = new Map();
    for (const e of edges) {
      deg.set(e.from, (deg.get(e.from) || 0) + 1);
      deg.set(e.to, (deg.get(e.to) || 0) + 1);
    }
    root = nodes.slice().sort((a, b) =>
      (deg.get(b.id) || 0) - (deg.get(a.id) || 0) || fin(a.y) - fin(b.y) || fin(a.x) - fin(b.x))[0].id;
  }
  const f = forest(nodes, edges, root, false);
  let maxW = 0, maxH = 0;
  for (const n of nodes) { const d = dims(n); maxW = Math.max(maxW, d.w); maxH = Math.max(maxH, d.h); }
  const ring = Math.hypot(maxW, maxH) * 0.8 + gap;
  // Arc length one leaf needs. Neighbours on a ring are displaced along the
  // tangent; axis-aligned rects clear each other at any angle once that
  // displacement reaches the diagonal.
  const slot = Math.hypot(maxW, maxH) + 12;

  const leaves = new Map();
  const countLeaves = (id) => {
    const kids = f.children.get(id);
    const v = kids.length ? kids.reduce((s, k) => s + countLeaves(k), 0) : 1;
    leaves.set(id, v);
    return v;
  };

  /** Lays out one component around (0,0); returns centres and its box. */
  const component = (rootId) => {
    const total = countLeaves(rootId);
    let maxDepth = 0;
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      maxDepth = Math.max(maxDepth, f.depth.get(id));
      stack.push(...f.children.get(id));
    }
    const base = f.depth.get(rootId);
    const radius = [0];
    for (let d = 1; d <= maxDepth - base; d++) {
      radius[d] = Math.max(radius[d - 1] + ring, d === 1 ? (total * slot) / (2 * Math.PI) : 0);
    }
    const centres = {};
    const place = (id, a0, a1) => {
      const d = f.depth.get(id) - base;
      const a = (a0 + a1) / 2;
      centres[id] = d === 0 ? { x: 0, y: 0 } : { x: radius[d] * Math.cos(a), y: radius[d] * Math.sin(a) };
      let s = a0;
      for (const k of f.children.get(id)) {
        const span = ((a1 - a0) * leaves.get(k)) / leaves.get(id);
        place(k, s, s + span);
        s += span;
      }
    };
    place(rootId, -Math.PI / 2, (3 * Math.PI) / 2);
    const box = bounds(Object.entries(centres).map(([id, c]) => {
      const d = dims(f.byId.get(id));
      return { x: c.x - d.w / 2, y: c.y - d.h / 2, w: d.w, h: d.h };
    }));
    return { centres, box };
  };

  const comps = f.roots.map(component);
  const centres = { ...comps[0].centres };
  let cursor = comps[0].box.x + comps[0].box.w + gap * 2;
  for (const c of comps.slice(1)) {
    const dx = cursor - c.box.x, dy = -(c.box.y + c.box.h / 2);
    for (const [id, p] of Object.entries(c.centres)) centres[id] = { x: p.x + dx, y: p.y + dy };
    cursor += c.box.w + gap * 2;
  }

  const pos = {};
  for (const [id, c] of Object.entries(centres)) {
    const d = dims(f.byId.get(id));
    pos[id] = { x: c.x - d.w / 2, y: c.y - d.h / 2 };
  }
  if (origin) return anchorTo(pos, nodes, origin);
  // keep the root's centre where it was
  const r = f.byId.get(root), rd = dims(r);
  const ox = fin(r.x) + rd.w / 2, oy = fin(r.y) + rd.h / 2;
  for (const id of Object.keys(pos)) pos[id] = { x: Math.round(pos[id].x + ox), y: Math.round(pos[id].y + oy) };
  return pos;
}

/**
 * Finds a top-left spot for a `want.w × want.h` rect that does not overlap
 * `obstacles` (with `margin`). With `near`, tries right / below / above / left
 * of that node first; otherwise spirals out from `want.x, want.y`.
 * @param {LNode[]} obstacles
 * @param {Rect} want
 * @param {{near?:LNode|null, margin?:number, gap?:number}} [opts]
 * @returns {{x:number, y:number}}
 */
export function findFreeSpot(obstacles, want, opts = {}) {
  const { near = null, margin = 24, gap = 72 } = opts;
  const w = want.w > 0 ? want.w : DEFAULT_W, h = want.h > 0 ? want.h : DEFAULT_H;
  const free = (x, y) => !obstacles.some((o) => {
    if (!o) return false;
    const d = dims(o), ox = fin(o.x), oy = fin(o.y);
    return x < ox + d.w + margin && x + w + margin > ox && y < oy + d.h + margin && y + h + margin > oy;
  });
  const tries = [];
  if (near) {
    const d = dims(near), nx = fin(near.x), ny = fin(near.y);
    const cx = nx + d.w / 2, cy = ny + d.h / 2;
    tries.push([nx + d.w + gap, cy - h / 2], [cx - w / 2, ny + d.h + gap * 0.6],
      [cx - w / 2, ny - h - gap * 0.6], [nx - w - gap, cy - h / 2]);
  } else {
    tries.push([fin(want.x), fin(want.y)]);
  }
  for (const [x, y] of tries) if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
  const [ox, oy] = tries[0];
  const sx = w / 2 + margin, sy = h / 2 + margin;
  for (let ring = 1; ring <= 32; ring++) {
    const cand = [];
    for (let i = -ring; i <= ring; i++) {
      cand.push([i, -ring], [i, ring]);
      if (Math.abs(i) !== ring) cand.push([-ring, i], [ring, i]);
    }
    cand.sort((a, b) => Math.hypot(a[0] * sx, a[1] * sy) - Math.hypot(b[0] * sx, b[1] * sy));
    for (const [i, j] of cand) {
      const x = ox + i * sx, y = oy + j * sy;
      if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return { x: Math.round(ox), y: Math.round(oy) };
}

/**
 * True when rect `inner` lies fully inside rect `outer`.
 * @param {LNode} inner
 * @param {LNode} outer
 */
export function contains(outer, inner) {
  const o = dims(outer), i = dims(inner);
  return fin(inner.x) >= fin(outer.x) && fin(inner.y) >= fin(outer.y)
    && fin(inner.x) + i.w <= fin(outer.x) + o.w && fin(inner.y) + i.h <= fin(outer.y) + o.h;
}

/**
 * True when two rects overlap.
 * @param {LNode} a
 * @param {LNode} b
 */
export function intersects(a, b) {
  const A = dims(a), B = dims(b);
  return fin(a.x) < fin(b.x) + B.w && fin(a.x) + A.w > fin(b.x)
    && fin(a.y) < fin(b.y) + B.h && fin(a.y) + A.h > fin(b.y);
}
