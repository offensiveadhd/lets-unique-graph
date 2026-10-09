#!/usr/bin/env node
// Validates unique.json against the LIP unique manifest schema (vendored in
// schemas/unique.schema.json), checks that entry/guide/icon exist, and that every
// declared schema file parses. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const problems = [];

function check(schema, v, root, p = '$') {
  if (schema.$ref) return check(resolve(schema.$ref, root), v, root, p);
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
  if (schema.type) { const ts = [].concat(schema.type); if (!ts.some((x) => x === t || (x === 'number' && t === 'integer'))) { problems.push(`${p}: expected ${ts.join('|')}, got ${t}`); return; } }
  if (schema.const !== undefined && v !== schema.const) problems.push(`${p}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) problems.push(`${p}: must be one of ${schema.enum.join(', ')}`);
  if (typeof v === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) problems.push(`${p}: does not match /${schema.pattern}/`);
    if (schema.minLength !== undefined && v.length < schema.minLength) problems.push(`${p}: too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) problems.push(`${p}: too long`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) problems.push(`${p}: too few items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) problems.push(`${p}: too many items`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, root, `${p}[${i}]`));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of schema.required || []) if (!(r in v)) problems.push(`${p}: missing "${r}"`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) check(s, v[k], root, `${p}.${k}`);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') for (const k of Object.keys(v)) if (!(k in (schema.properties || {}))) check(schema.additionalProperties, v[k], root, `${p}.${k}`);
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (schema.properties || {}))) problems.push(`${p}: unexpected "${k}"`);
  }
}
function resolve(ref, root) { let c = root; for (const part of ref.replace(/^#\//, '').split('/')) c = c[part]; return c; }

const manifest = read('unique.json');
const schema = read('schemas/unique.schema.json');
check(schema, manifest, schema);
for (const key of ['entry', 'guide', 'icon']) if (manifest[key] && !fs.existsSync(path.join(root, manifest[key]))) problems.push(`${key} not found: ${manifest[key]}`);
const reserved = new Set(['lip', 'session', 'entity', 'chat', 'component', 'media', 'ui', 'host', 'claude']);
for (const d of manifest.domains || []) if (reserved.has(d)) problems.push(`reserved domain "${d}"`);
for (const [kind, map] of [['events', manifest.events], ['commands', manifest.commands]]) for (const [t, decl] of Object.entries(map || {})) {
  if (!(manifest.domains || []).includes(t.split('.')[0])) problems.push(`${kind}.${t}: domain not declared`);
  if (decl.schema) { try { read(decl.schema); } catch (e) { problems.push(`${kind}.${t}: schema ${decl.schema}: ${e.message}`); } }
}
const words = fs.readFileSync(path.join(root, manifest.guide || 'GUIDE.md'), 'utf8').split(/\s+/).length;
if (words > 1500) problems.push(`GUIDE.md is ${words} words; keep it under ~1500`);

if (problems.length) { console.error('✘ ' + problems.join('\n✘ ')); process.exit(1); }
console.log(`ok: ${manifest.name}@${manifest.version} — ${Object.keys(manifest.events || {}).length} events, ${Object.keys(manifest.commands || {}).length} commands, guide ${words} words`);
