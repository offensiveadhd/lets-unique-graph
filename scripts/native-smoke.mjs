#!/usr/bin/env node
// Headless smoke test of the native view (native/index.js), driven through the
// lets engine's own runtime: the vm context, the tree sanitizer, the bus. It
// needs an engine checkout: LETS_ENGINE=<path>, or ../lets next to this repo;
// without one it prints "skip" and exits 0. Zero dependencies.
//
//   node scripts/native-smoke.mjs            run the checks
//   node scripts/native-smoke.mjs --print    also print the final pane as text
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.resolve(process.env.LETS_ENGINE || path.resolve(root, '..', 'lets'));
const src = path.join(engine, 'engine', 'src');
if (!fs.existsSync(path.join(src, 'native.mjs'))) {
  console.log(`skip: no engine checkout (looked in ${engine}; set LETS_ENGINE)`);
  process.exit(0);
}

// a throwaway home (never the real ~/.lets), no default installs, and this repo's parent as an extra uniques dir:
// the registry keys uniques by the manifest's name, so the folder name does not matter
process.env.LETS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lets-graph-smoke-'));
process.env.LETS_NO_DEFAULTS = '1';
process.env.LETS_UNIQUES_DIRS = path.dirname(root);
const load = (f) => import(pathToFileURL(path.join(src, f)).href);
const { Bus } = await load('bus.mjs');
const { Registry } = await load('registry.mjs');
const { NativeRuntime, dumpTree } = await load('native.mjs');

// ---- harness ---------------------------------------------------------------------------------------

const registry = new Registry();
const u = registry.get('graph');
assert.ok(u && u.ok, `graph not found or invalid: ${u ? u.problems.join('; ') : 'missing'}`);
assert.equal(path.resolve(u.dir), root, 'the registry picked this checkout');
assert.ok(u.modes.includes('native'), 'the manifest declares the native view');

const bus = new Bus();
const logs = [];
const runtime = new NativeRuntime({ bus, registry, entity: { personaForShell: () => ({ name: 'Doto', traits: {}, color: '#a66bff' }) }, log: (s, m) => logs.push(`[${s}] ${m}`) });

let passed = 0;
const step = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (err) {
    console.error(`FAIL ${name}\n${err.stack || err}`);
    if (logs.length) console.error(logs.slice(-10).join('\n'));
    process.exit(1);
  }
};

function* walk(n) { if (n && typeof n === 'object') { yield n; for (const c of n.c || []) yield* walk(c); } }
const all = (tree, pred) => [...walk(tree)].filter(pred);
const keyed = (tree, key) => all(tree, (n) => n.p && n.p.key === `u.${key}`)[0] || null;
const svgOf = (tree) => all(tree, (n) => n.t === 'Svg')[0] || null;
const nodeButtons = (tree) => all(tree, (n) => n.t === 'Button' && /^u\.sel:/.test(n.p.key || ''));

/** One window's harness: its tree, its events, commands with acks, actions. */
function harness(w) {
  const h = {
    tree: () => runtime.sync({ cols: 56, rows: 40 }).windows.find((x) => x.id === w).tree,
    text: () => dumpTree(h.tree()),
    events: () => bus.read(`t-${w}`, { max: 1000 }).events.filter((e) => e.from === `unique:graph#${w}` || e.re),
    /** Sends a command with ack:true; asserts the ack; returns the other events it caused. */
    cmd(type, data = {}, { fail = false } = {}) {
      const sent = bus.send({ type, data, ack: true }, w);
      const ev = h.events();
      const ack = ev.find((e) => e.type === 'lip.ack' && e.re === sent.id);
      assert.ok(ack, `${type}: no lip.ack`);
      if (fail) assert.equal(ack.data.ok, false, `${type} should fail`);
      else assert.equal(ack.data.ok, true, `${type} failed: ${ack.data.error}`);
      const rest = ev.filter((e) => e !== ack);
      rest.id = sent.id;
      rest.ack = ack.data;
      return rest;
    },
    /** A press / submit / select on the view's own element (the host's "u." prefix added here). */
    act(key, kind = 'press', value) {
      const r = runtime.action(w, { key: `u.${key}`, kind, ...(value !== undefined ? { value } : {}) });
      assert.equal(r.ok, true, `action ${key}: ${r.error}`);
      return h.events();
    },
    snapshot: () => h.cmd('graph.snapshot').find((e) => e.type === 'graph.snapshot').data.graph,
  };
  return h;
}
const of = (ev, type) => ev.filter((e) => e.type === type);
const one = (ev, type) => { const list = of(ev, type); assert.equal(list.length, 1, `expected one ${type}, got ${list.length} (${ev.map((e) => e.type).join(', ')})`); return list[0].data; };
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// ---- the checks ------------------------------------------------------------------------------------

const opened = runtime.open('graph', { args: { intent: 'plan the auth flow' } });
const w = opened.windowId;
const g = harness(w);
let ids = [];

step('open: session.opened + lip.ready; the empty hint and the intent', () => {
  const ev = bus.read(`t-${w}`, { max: 50 }).events.map((e) => e.type);
  assert.deepEqual(ev.slice(0, 2), ['session.opened', 'lip.ready']);
  assert.equal(opened.title, 'graph');
  assert.equal(opened.columns, 56);
  const text = g.text();
  assert.match(text, /Empty board/);
  assert.match(text, /for: plan the auth flow/);
  assert.match(text, /\[Send to Claude\]/, 'export() → the shell draws Send to Claude');
  assert.equal(svgOf(g.tree()), null, 'no picture for an empty board');
  assert.ok(keyed(g.tree(), 'add') && keyed(g.tree(), 'ask'), 'add and ask inputs');
});

// graph.changed: exactly one per command or action, with the diff since the previous one.
step('graph.node.add ×3 + graph.edge.add: 3 node buttons, an SVG with 3 rects and 1 edge, graph.changed diffs', () => {
  const added = [];
  let ev = g.cmd('graph.node.add', { id: 'a', label: 'Start', kind: 'step' });
  added.push(...one(ev, 'graph.changed').diff.added);
  ev = g.cmd('graph.node.add', { label: 'Auth', kind: 'idea', near: 'a' });
  const changed = one(ev, 'graph.changed');
  added.push(...changed.diff.added);
  assert.equal(changed.rev, 2);
  assert.deepEqual(changed.summary, { nodes: 2, edges: 0 });
  assert.deepEqual([changed.diff.removed, changed.diff.updated], [[], []]);
  ev = g.cmd('graph.node.add', { label: 'Done' });
  added.push(...one(ev, 'graph.changed').diff.added);
  assert.equal(added.length, 3, 'one id per graph.changed, none repeated');
  assert.equal(added[0], 'a');
  assert.match(added[1], /^n_[a-z0-9]{5}$/, 'generated ids look like n_xxxxx');
  assert.equal(of(ev, 'graph.node.create').length, 0, 'no granular events for Claude\'s commands');
  ids = added;
  ev = g.cmd('graph.edge.add', { from: 'a', to: ids[1], label: 'go' });
  const eAdded = one(ev, 'graph.changed').diff.added;
  assert.equal(eAdded.length, 1);
  assert.match(eAdded[0], /^e_[a-z0-9]{5}$/, 'a generated e_xxxxx id');
  const tree = g.tree();
  assert.equal(nodeButtons(tree).length, 3);
  const svg = svgOf(tree);
  assert.ok(svg, 'a picture');
  assert.equal((svg.p.source.match(/<rect [^>]*rx=/g) || []).length, 3, '3 node rects');
  assert.equal((svg.p.source.match(/<path d='M-?\d+,-?\d+C/g) || []).length, 1, '1 edge path');
  assert.ok(svg.p.width >= 240 && svg.p.width <= 720 && svg.p.height >= 120 && svg.p.height <= 480, `size ${svg.p.width}x${svg.p.height}`);
  assert.match(svg.p.alt, /3 nodes, 1 edge/);
  const snap = g.snapshot();
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(!overlaps(snap.nodes[i], snap.nodes[j]), 'auto-placed without overlap');
  const near = snap.nodes.find((n) => n.id === ids[1]);
  assert.ok(near.x > snap.nodes[0].x + snap.nodes[0].w, '"near" places it to the right of its node');
  // the same pair again updates the edge
  const edgeId = snap.edges[0].id;
  ev = g.cmd('graph.edge.add', { from: 'a', to: ids[1], label: 'next', kind: 'dashed' });
  assert.deepEqual(one(ev, 'graph.changed').diff, { added: [], removed: [], updated: [edgeId] });
  assert.deepEqual(g.snapshot().edges.map((e) => [e.id, e.label, e.kind]), [[edgeId, 'next', 'dashed']]);
});

step('a burst of commands read late: every graph.changed is delivered, each with its own diff', () => {
  const before = g.snapshot().nodes.length;
  for (const id of ['b1', 'b2', 'b3']) bus.send({ type: 'graph.node.add', data: { id, label: id } }, w);
  const changed = g.events().filter((e) => e.type === 'graph.changed').map((e) => e.data);
  assert.deepEqual(changed.map((c) => c.diff.added), [['b1'], ['b2'], ['b3']], 'not merged by the bus, no id repeated');
  assert.equal(changed[2].summary.nodes, before + 3);
  const ev = g.cmd('graph.node.remove', { ids: ['b1', 'b2', 'b3'] });
  assert.deepEqual(one(ev, 'graph.changed').diff, { added: [], removed: ['b1', 'b2', 'b3'], updated: [] });
});

step('select a node: graph.node.select with labels; the editor appears', () => {
  const ev = g.act(`sel:${ids[1]}`);
  assert.deepEqual(one(ev, 'graph.node.select'), { ids: [ids[1]], labels: ['Auth'] });
  const tree = g.tree();
  assert.equal(keyed(tree, `sel:${ids[1]}`).p.variant, 'primary');
  assert.ok(keyed(tree, 'label') && keyed(tree, 'kind') && keyed(tree, 'text') && keyed(tree, 'connect') && keyed(tree, 'note') && keyed(tree, 'remove'));
  assert.match(svgOf(tree).p.source, /stroke='#6bf0ff'/, 'the selected node glows cyan');
});

step('editor: rename → graph.node.update; kind; connect → graph.edge.create', () => {
  let ev = g.act('label', 'submit', 'Authenticate');
  assert.deepEqual(one(ev, 'graph.node.update'), { id: ids[1], patch: { label: 'Authenticate' } });
  assert.deepEqual(one(ev, 'graph.changed').diff, { added: [], removed: [], updated: [ids[1]] });
  ev = g.act('kind', 'select', 'decision');
  const upd = one(ev, 'graph.node.update');
  assert.equal(upd.patch.kind, 'decision');
  assert.equal(upd.patch.w, 184, 'a node at its default size takes the new kind\'s size');
  g.act('elabel', 'submit', 'ok');
  ev = g.act('connect', 'select', ids[2]);
  const edge = one(ev, 'graph.edge.create').edge;
  assert.deepEqual([edge.from, edge.to, edge.label], [ids[1], ids[2], 'ok']);
  assert.ok(keyed(g.tree(), `unlink:${edge.id}`), 'its connections are listed with an unlink button');
});

let created;
step('add: graph.node.create, linked from the selection, and it becomes the selection', () => {
  const ev = g.act('add', 'submit', 'Validate token');
  created = one(ev, 'graph.node.create').node;
  assert.equal(created.label, 'Validate token');
  assert.equal(created.kind, 'idea');
  const edge = one(ev, 'graph.edge.create').edge;
  assert.deepEqual([edge.from, edge.to], [ids[1], created.id]);
  assert.deepEqual(one(ev, 'graph.node.select').ids, [created.id]);
  assert.equal(nodeButtons(g.tree()).length, 4);
});

step('ask: graph.ask with the selection, its labels and the graph', () => {
  const ev = g.act('ask', 'submit', 'What is missing here?');
  const q = one(ev, 'graph.ask');
  assert.equal(q.question, 'What is missing here?');
  assert.deepEqual(q.selection, [created.id]);
  assert.deepEqual(q.labels, ['Validate token']);
  assert.equal(q.graph.nodes.length, 4);
  assert.match(g.text(), /you: What is missing here\?  ·  Validate token/, 'the question is echoed in the pane\'s chat (ctx.chat)');
});

step('graph.snapshot: a reply with re = the command id', () => {
  const sent = bus.send({ type: 'graph.snapshot', data: {} }, w);
  const reply = g.events().find((e) => e.type === 'graph.snapshot');
  assert.ok(reply, 'a reply');
  assert.equal(reply.re, sent.id);
  assert.equal(reply.data.graph.nodes.length, 4);
  assert.equal(reply.data.graph.edges.length, 3);
  assert.ok(reply.data.graph.rev > 0);
});

step('graph.highlight and graph.focus: no throw; focus selects and frames; [] clears', () => {
  g.cmd('graph.highlight', { ids: ['a'], color: '#ffd166', ttl: 0 });
  assert.match(svgOf(g.tree()).p.source, /#ffd166/);
  assert.match(g.text(), /Start ✦/, 'highlighted nodes are marked in the list');
  const ev = g.cmd('graph.focus', { ids: [ids[2]] });
  assert.deepEqual(one(ev, 'graph.node.select').ids, [ids[2]]);
  assert.ok(keyed(g.tree(), 'fit'), 'the picture is framed on the focus; "fit board" undoes it');
  g.act('fit');
  g.cmd('graph.highlight', { ids: [] });
  assert.doesNotMatch(svgOf(g.tree()).p.source, /#ffd166/);
  g.cmd('graph.focus', { ids: [] });
});

// highlights with a ttl expire without a command: ctx.after asks the host for a redraw, render drops what
// has expired; the host keeps only the earliest pending redraw, so render re-arms it for the next one
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const glowing = () => { const s = svgOf(g.tree()).p.source; return ['#ffd166', '#c0ffee'].filter((c) => s.includes(c)); };
step('highlight ttl: both glow', () => {
  g.cmd('graph.highlight', { ids: ['a'], color: '#ffd166', ttl: 300 });
  g.cmd('graph.highlight', { ids: [ids[1]], color: '#c0ffee', ttl: 900 });
  assert.deepEqual(glowing(), ['#ffd166', '#c0ffee']);
});
await sleep(550);
step('highlight ttl: the first has expired, with no command in between', () => assert.deepEqual(glowing(), ['#c0ffee']));
await sleep(600);
step('highlight ttl: the second has expired too', () => assert.deepEqual(glowing(), []));

step('graph.layout {mode:"tree"} moves nodes; bad modes are refused', () => {
  const before = g.snapshot().nodes;
  const ev = g.cmd('graph.layout', { mode: 'tree' });
  const diff = one(ev, 'graph.changed').diff;
  assert.ok(diff.updated.length >= 1 && diff.updated.every((id) => before.some((n) => n.id === id)), 'the moved nodes are the diff');
  const after = g.snapshot().nodes;
  assert.ok(after.some((n) => { const b = before.find((x) => x.id === n.id); return b.x !== n.x || b.y !== n.y; }));
  for (let i = 0; i < after.length; i++) for (let j = i + 1; j < after.length; j++) assert.ok(!overlaps(after[i], after[j]), 'a tree does not overlap');
  const bad = g.cmd('graph.layout', { mode: 'spiral' }, { fail: true });
  assert.match(bad.ack.error, /unknown layout mode "spiral"/);
  g.cmd('graph.layout', { mode: 'radial', root: 'a' });
  g.cmd('graph.layout', { mode: 'grid', ids: ['a', ids[1]] });
});

step('errors: unknown node, unknown endpoints, missing graph', () => {
  const refused = g.cmd('graph.node.set', { id: 'nope', patch: { label: 'x' } }, { fail: true });
  assert.match(refused.ack.error, /no node "nope"/);
  assert.equal(of(refused, 'graph.changed').length, 0, 'a refused command reports no change');
  assert.match(g.cmd('graph.edge.add', { from: 'a', to: 'nope' }, { fail: true }).ack.error, /endpoints must exist/);
  assert.match(g.cmd('graph.load', {}, { fail: true }).ack.error, /expected \{graph/);
  assert.match(g.cmd('graph.annotate', { id: 'nope', text: 'x' }, { fail: true }).ack.error, /no node/);
  bus.send({ type: 'graph.node.set', data: { id: 'nope' } }, w);
  assert.ok(g.events().some((e) => e.type === 'lip.error' && /no node/.test(e.data.message)), 'without ack: lip.error');
});

step('graph.load: replace, then merge (unplaced nodes beside the rest)', () => {
  let ev = g.cmd('graph.load', { graph: { nodes: [{ id: 'x', label: 'X', x: 0, y: 0 }, { id: 'y', label: 'Y', kind: 'decision', x: 300, y: 0 }], edges: [{ from: 'x', to: 'y' }] } });
  const diff = one(ev, 'graph.changed').diff;
  assert.ok(diff.removed.includes('a') && diff.added.includes('x'));
  let snap = g.snapshot();
  assert.deepEqual(snap.nodes.map((n) => n.id), ['x', 'y']);
  assert.equal(snap.edges.length, 1);
  assert.equal(nodeButtons(g.tree()).length, 2);
  ev = g.cmd('graph.load', { merge: true, graph: { nodes: [{ id: 'z', label: 'Z' }, { id: 'x', label: 'X2' }], edges: [{ from: 'y', to: 'z', label: 'yes' }, { from: 'y', to: 'ghost' }] } });
  snap = g.snapshot();
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.nodes.find((n) => n.id === 'x').label, 'X2', 'merge upserts by id');
  assert.equal(snap.nodes.find((n) => n.id === 'x').x, 0, 'and keeps what it does not set');
  const z = snap.nodes.find((n) => n.id === 'z'), yN = snap.nodes.find((n) => n.id === 'y');
  assert.ok(z.x >= yN.x + yN.w, 'an unplaced node goes to the right of the rest');
  assert.equal(snap.edges.length, 2, 'the edge to an unknown node is skipped');
  const partial = of(ev, 'lip.error');
  assert.equal(partial.length, 1, 'a partial load raises lip.error, as the web board does');
  assert.equal(partial[0].data.code, 'partial');
  assert.match(partial[0].data.message, /skipped 1 edge/);
  assert.equal(partial[0].re, ev.id, 're = the load command');
  assert.equal(ev.ack.ok, true, 'the load itself stood');
});

step('graph.annotate: a note attached via meta.attachedTo; "" removes; graph.node.remove drops edges + notes', () => {
  g.cmd('graph.annotate', { id: 'y', text: 'Which branch is the happy path?' });
  let snap = g.snapshot();
  const note = snap.nodes.find((n) => n.meta && n.meta.attachedTo === 'y');
  assert.ok(note && note.kind === 'note' && note.meta.annotation && note.meta.by === 'claude');
  assert.match(svgOf(g.tree()).p.source, /Which branch/, 'the note body is drawn');
  g.cmd('graph.annotate', { id: 'y', text: 'Updated.' });
  snap = g.snapshot();
  assert.equal(snap.nodes.filter((n) => n.meta && n.meta.attachedTo === 'y').length, 1, 'one note per node');
  g.cmd('graph.annotate', { id: 'y', text: '' });
  assert.equal(g.snapshot().nodes.length, 3);
  g.cmd('graph.annotate', { id: 'y', text: 'again' });
  snap = g.snapshot();
  const gone = ['y', snap.nodes.find((n) => n.meta && n.meta.attachedTo === 'y').id, ...snap.edges.filter((e) => e.from === 'y' || e.to === 'y').map((e) => e.id)];
  assert.equal(gone.length, 4);
  const ev = g.cmd('graph.node.remove', { ids: ['y'] });
  const removed = one(ev, 'graph.changed').diff.removed;
  assert.deepEqual(removed.slice().sort(), gone.slice().sort(), 'the node, its two edges and its note');
  snap = g.snapshot();
  assert.deepEqual(snap.nodes.map((n) => n.id).sort(), ['x', 'z']);
  assert.equal(snap.edges.length, 0);
});

step('undo / redo: Claude\'s commands and the human\'s edits share the stack; undo emits the human\'s events', () => {
  let ev = g.act('undo');
  assert.ok(of(ev, 'graph.node.create').length >= 2, 'undoing the removal re-creates y and its note');
  assert.equal(g.snapshot().nodes.length, 4);
  ev = g.act('redo');
  assert.deepEqual(one(ev, 'graph.node.delete').ids.sort().length, 2);
  assert.equal(g.snapshot().nodes.length, 2);
  g.act('sel:x');
  ev = g.act('remove');
  assert.deepEqual(one(ev, 'graph.node.delete').ids, ['x']);
  g.act('undo');
  assert.equal(g.snapshot().nodes.length, 2);
  for (let i = 0; i < 60; i++) runtime.action(w, { key: 'u.undo', kind: 'press' });
  assert.match(g.text(), /Nothing to undo/);
  assert.equal(g.snapshot().nodes.length, 0, 'all the way back to the empty board');
  g.act('redo');
  g.act('redo');
  assert.ok(g.snapshot().nodes.length > 0);
});

step('the human: multi-select, connect A→B, chain, remove, clear + undo', () => {
  g.cmd('graph.load', { graph: { nodes: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }, { id: 'r', label: 'R' }], edges: [] } });
  g.act('multi');
  g.act('sel:p');
  let ev = g.act('sel:q');
  assert.deepEqual(one(ev, 'graph.node.select').ids, ['p', 'q']);
  ev = g.act('link');
  assert.deepEqual(['from', 'to'].map((k) => one(ev, 'graph.edge.create').edge[k]), ['p', 'q']);
  g.act('sel:r');
  ev = g.act('chain');
  assert.equal(of(ev, 'graph.edge.create').length, 1, 'p→q exists; q→r is new');
  ev = g.act('clear');
  assert.equal(one(ev, 'graph.changed').summary.nodes, 0);
  assert.deepEqual(one(ev, 'graph.node.select').ids, []);
  assert.match(g.text(), /Board cleared/);
  g.act('undo');
  assert.equal(g.snapshot().nodes.length, 3);
  g.act('multi');
});

let exported;
step('export: Send to Claude → graph.export {graph}', () => {
  const r = runtime.action(w, { key: 's.send', kind: 'press' });
  assert.equal(r.ok, true, r.error);
  const ev = bus.read(`t-${w}`, { max: 50 }).events;
  exported = ev.find((e) => e.type === 'graph.export');
  assert.ok(exported, 'graph.export was emitted');
  assert.deepEqual(Object.keys(exported.data), ['graph']);
  assert.deepEqual(exported.data.graph.nodes.map((n) => n.id).sort(), ['p', 'q', 'r']);
  assert.equal(exported.data.graph.edges.length, 2);
  assert.ok(exported.data.graph.viewport && typeof exported.data.graph.viewport.zoom === 'number');
});

step('resume: graph.load with session.resumed restores the board, says so once, starts a fresh history', () => {
  const w2 = runtime.open('graph', {}).windowId;
  const h = harness(w2);
  h.events();
  h.cmd('graph.load', { session: { id: 'S123', resumed: true }, graph: exported.data.graph });
  assert.equal(nodeButtons(h.tree()).length, 3);
  assert.match(h.text(), /resumed/);
  h.act('undo');
  assert.match(h.text(), /Nothing to undo/, 'a resume is not undoable back to an empty board');
  assert.doesNotMatch(h.text(), /resumed/, 'the notice goes away at the next action');
  runtime.close(w2, 'test');
});

step('escaping: labels that look like markup, handlers, URLs or CSS still draw as an SVG', () => {
  const nasty = [   // short enough to be drawn whole: [id, label, note body]
    ['evil1', '<b>on = 1</b>', 'onload=1 javascript:x'],
    ['evil2', 'data: users', 'url(x) @import'],
    ['evil3', "&#x41; it's", '<!DOCTYPE x> <?xml?>'],
  ];
  for (const [id, label, text] of nasty) g.cmd('graph.node.add', { id, label, kind: 'note', text });
  const tree = g.tree();
  const svg = svgOf(tree);
  assert.ok(svg, `still an Svg element, not refused: ${dumpTree(tree).split('\n').find((l) => /refused/.test(l)) || ''}`);
  assert.doesNotMatch(svg.p.source, /<b>|&#|​|<style/);
  for (const s of ['data: users', 'url(x) @import', 'onload=1 javascript:x', "it's"]) assert.ok(svg.p.source.includes(s), `drawn as written: ${s}`);
  for (const s of ['&lt;b&gt;on = 1&lt;/b&gt;', '&amp;#x41;', '&lt;!DOCTYPE x&gt; &lt;?xml?&gt;']) assert.ok(svg.p.source.includes(s), `& < > as XML entities: ${s}`);
  g.cmd('graph.node.remove', { ids: nasty.map((x) => x[0]) });
});

step('scale: 300 nodes render under 50 ms and stay inside the tree bounds', () => {
  const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, label: `Step number ${i} of the long flow`, kind: ['idea', 'step', 'decision', 'data', 'note'][i % 5] }));
  const edges = nodes.slice(1).map((n, i) => ({ from: `s${Math.floor(i / 2)}`, to: n.id, label: i % 7 ? undefined : 'yes' }));
  g.cmd('graph.load', { graph: { nodes, edges } });
  g.act('sel:s3');
  g.tree();
  const t0 = performance.now();
  bus.send({ type: 'graph.highlight', data: { ids: ['s4'] } }, w);   // a new rev, so the next sync renders again
  const tree = g.tree();
  const ms = performance.now() - t0;
  const text = dumpTree(tree);
  assert.doesNotMatch(text, /view error/, text.slice(0, 400));
  assert.ok(svgOf(tree), 'a picture');
  assert.equal(nodeButtons(tree).length, 40, 'a page of 40');
  assert.match(text, /…and 260 more/);
  const size = JSON.stringify(tree).length;
  assert.ok(size < 96 * 1024, `tree ${size} chars`);
  assert.ok(ms < 50, `render took ${ms.toFixed(1)} ms`);
  g.act('more');
  assert.ok(keyed(g.tree(), 'sel:s40'), 'the next page');
  console.log(`     300 nodes: render ${ms.toFixed(1)} ms, tree ${(size / 1024).toFixed(1)} KB, svg ${(svgOf(tree).p.source.length / 1024).toFixed(1)} KB`);
});

step('big boards: a big undo stays inside the 1000-item budget; ask and snapshot carry the whole board', () => {
  // a big undo: 300 re-created nodes go out as graph.changed alone, not 300 graph.node.create
  g.act('clear');
  let ev = g.act('undo');
  assert.equal(of(ev, 'graph.node.create').length, 0);
  assert.equal(one(ev, 'graph.changed').summary.nodes, 300);
  // ~360 KB of board: ask and snapshot still carry all of it
  const long = 'x'.repeat(200);
  g.cmd('graph.load', { graph: { nodes: Array.from({ length: 1200 }, (_, i) => ({ id: `L${i}`, label: `Long ${i}`, text: long, x: (i % 40) * 200, y: Math.floor(i / 40) * 100 })), edges: [{ from: 'L0', to: 'L1' }, { from: 'L1', to: 'L2' }] } });
  g.act('sel:L1');
  ev = g.act('ask', 'submit', 'What about this one?');
  const q = one(ev, 'graph.ask');
  assert.equal(q.graph.nodes.length, 1200);
  assert.equal('partial' in q.graph, false);
  assert.equal(g.snapshot().nodes.length, 1200);
});

step('a board near the 1 MB state limit: snapshot and ask refuse with a reason instead of being dropped', () => {
  // nodes in normNode's own shape, sized so the graph is just over the 1 MB emit budget but under the state limit
  const N = 1800, make = (len) => Array.from({ length: N }, (_, i) => ({ id: `H${i}`, label: `H${i}`, kind: 'idea', x: (i % 60) * 200, y: Math.floor(i / 60) * 100, w: 168, h: 60, text: 'y'.repeat(len) }));
  const size = (len) => JSON.stringify({ graph: { rev: 9999, nodes: make(len), edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }).length;
  const nodes = make(Math.ceil((1015000 - size(0)) / N));
  const ev = g.cmd('graph.load', { graph: { nodes, edges: [] } });
  assert.equal(one(ev, 'graph.changed').summary.nodes, N);
  assert.match(g.cmd('graph.snapshot', {}, { fail: true }).ack.error, /too big for one event/);
  g.act('sel:H1');
  assert.equal(of(g.act('ask', 'submit', 'Too big?'), 'graph.ask').length, 0);
  assert.match(g.text(), /too big to send with a question/);
  g.cmd('graph.clear');
});

if (process.argv.includes('--print')) {
  g.cmd('graph.load', { graph: { nodes: [{ id: 'a', label: 'Start', kind: 'step' }, { id: 'b', label: 'Logged in?', kind: 'decision' }, { id: 'c', label: 'Dashboard' }, { id: 'd', label: 'Login form', kind: 'step' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'yes' }, { from: 'b', to: 'd', label: 'no' }] } });
  g.act('sel:b');
  console.log(g.text());
}
runtime.stop();
console.log(`native smoke: ${passed} checks passed`);
