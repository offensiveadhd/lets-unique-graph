#!/usr/bin/env node
// Validates unique.json against the LIP unique manifest schema (vendored in
// schemas/unique.schema.json), checks that entry/guide/icon exist, that the
// native view (native.entry) exists and parses as a plain script, and that
// every declared schema file parses. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const problems = [];

function check(schema, v, root, p = '$', out = problems) {
  if (schema.$ref) return check(resolve(schema.$ref, root), v, root, p, out);
  if (schema.anyOf && !schema.anyOf.some((s) => { const sub = []; check(s, v, root, p, sub); return !sub.length; })) {
    out.push(`${p}: must match one of ${schema.anyOf.map((s) => JSON.stringify(s.required || s)).join(' | ')}`);
  }
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
  if (schema.type) { const ts = [].concat(schema.type); if (!ts.some((x) => x === t || (x === 'number' && t === 'integer'))) { out.push(`${p}: expected ${ts.join('|')}, got ${t}`); return; } }
  if (schema.const !== undefined && v !== schema.const) out.push(`${p}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) out.push(`${p}: must be one of ${schema.enum.join(', ')}`);
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) out.push(`${p}: below the minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) out.push(`${p}: above the maximum ${schema.maximum}`);
  }
  if (typeof v === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) out.push(`${p}: does not match /${schema.pattern}/`);
    if (schema.minLength !== undefined && v.length < schema.minLength) out.push(`${p}: too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) out.push(`${p}: too long`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) out.push(`${p}: too few items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) out.push(`${p}: too many items`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, root, `${p}[${i}]`, out));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of schema.required || []) if (!(r in v)) out.push(`${p}: missing "${r}"`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) check(s, v[k], root, `${p}.${k}`, out);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') for (const k of Object.keys(v)) if (!(k in (schema.properties || {}))) check(schema.additionalProperties, v[k], root, `${p}.${k}`, out);
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (schema.properties || {}))) out.push(`${p}: unexpected "${k}"`);
  }
}
function resolve(ref, root) { let c = root; for (const part of ref.replace(/^#\//, '').split('/')) c = c[part]; return c; }

const manifest = read('unique.json');
const schema = read('schemas/unique.schema.json');
check(schema, manifest, schema);
for (const key of ['entry', 'guide', 'icon']) if (manifest[key] && !fs.existsSync(path.join(root, manifest[key]))) problems.push(`${key} not found: ${manifest[key]}`);

// the native view: one plain script (no import/export) the host runs in a vm context
const native = manifest.native?.entry ? path.join(root, manifest.native.entry) : null;
if (manifest.native && !native) problems.push('native.entry missing');
else if (native && !fs.existsSync(native)) problems.push(`native.entry not found: ${manifest.native.entry}`);
else if (native) {
  try { execFileSync(process.execPath, ['--check', native], { stdio: 'pipe' }); } catch (e) { problems.push(`native.entry ${manifest.native.entry} does not parse: ${String(e.stderr || e.message).trim()}`); }
  if (/^\s*(import|export)\s/m.test(fs.readFileSync(native, 'utf8'))) problems.push(`native.entry ${manifest.native.entry}: must be a plain script (no import/export)`);
}

const reserved = new Set(['lip', 'session', 'entity', 'chat', 'component', 'media', 'ui', 'host', 'claude']);
for (const d of manifest.domains || []) if (reserved.has(d)) problems.push(`reserved domain "${d}"`);
for (const [kind, map] of [['events', manifest.events], ['commands', manifest.commands]]) for (const [t, decl] of Object.entries(map || {})) {
  if (!(manifest.domains || []).includes(t.split('.')[0])) problems.push(`${kind}.${t}: domain not declared`);
  if (decl.schema) { try { read(decl.schema); } catch (e) { problems.push(`${kind}.${t}: schema ${decl.schema}: ${e.message}`); } }
}
const words = fs.readFileSync(path.join(root, manifest.guide || 'GUIDE.md'), 'utf8').split(/\s+/).length;
if (words > 1500) problems.push(`GUIDE.md is ${words} words; keep it under ~1500`);

if (problems.length) { console.error('✘ ' + problems.join('\n✘ ')); process.exit(1); }
const modes = [manifest.entry && 'web', native && 'native'].filter(Boolean).join('+');
console.log(`ok: ${manifest.name}@${manifest.version} — ${modes}, ${Object.keys(manifest.events || {}).length} events, ${Object.keys(manifest.commands || {}).length} commands, guide ${words} words`);
