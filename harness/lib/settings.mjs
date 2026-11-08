import { readFileSync } from 'node:fs';
import { LINKS } from './net.mjs';

const cache = {};
export function defaults(stack) {
  return (cache[stack] ||= JSON.parse(readFileSync(new URL(`../settings/${stack}.json`, import.meta.url), 'utf8')));
}

let OVERRIDES = {};
export function setOverrides(kv, file, targets) {
  const o = {};
  const add = (target, key, v) => {
    if (!targets.includes(target)) throw new Error(`settings: "${target}" is not a stack or column (${targets.join(', ')})`);
    (o[target] ||= {})[key] = v == null || v === 'unset' ? null : String(v);
  };
  if (file) for (const [t, m] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) for (const [k, v] of Object.entries(m)) add(t, k, v);
  for (const [k, v] of Object.entries(kv)) {
    if (!k.startsWith('set.')) continue;
    const m = k.slice(4).match(/^([^.]+)\.(.+)$/);
    if (!m) throw new Error(`settings: ${k}: use set.<stack>.<key>=<value>`);
    add(m[1], m[2], v);
  }
  OVERRIDES = o;
  return o;
}

function expand(v, vars) {
  return String(v).replace(/\{([^}]+)\}/g, (_, e) => {
    if (!/^[\w\s+\-*/().]+$/.test(e)) throw new Error(`settings: bad expression {${e}}`);
    const r = Function(...Object.keys(vars), `return (${e});`)(...Object.values(vars));
    return typeof r === 'number' ? String(Math.round(r)) : String(r);
  });
}

export function resolve(adapter, ctx) {
  const def = defaults(adapter.stack), groups = Object.keys(def.groups);
  const link = ctx.link || 'lan';
  const vars = { w: ctx.mode.w, h: ctx.mode.h, fps: ctx.mode.fps, ceilingKbps: ctx.ceilingKbps, linkKbps: (LINKS[link]?.rate || 0) * 1000, ...(adapter.vars ? adapter.vars(ctx) : {}) };
  const out = def.settings.filter((s) => !s.only || s.only.includes(adapter.id)).map((s) => {
    const x = { group: s.group || groups[0], key: s.key, value: expand(s.value, vars), role: s.role || 'tuned', why: s.why || '', ...(s.ships != null && { ships: s.ships }) };
    if (s.links && s.links[link] != null) Object.assign(x, { linkSet: link, linkBase: x.value, value: expand(s.links[link], vars), linkWhy: s.linkWhy || '' });
    return x;
  });
  for (const target of [adapter.stack, adapter.id]) for (const [k, v] of Object.entries(OVERRIDES[target] || {})) {
    const m = k.match(/^([^:]+):(.+)$/), group = m ? m[1] : null, key = m ? m[2] : k;
    if (group && !groups.includes(group)) throw new Error(`settings: ${adapter.stack} has no group "${group}" (${groups.join(', ')})`);
    let s = out.find((x) => x.key === key && (!group || x.group === group));
    if (!s) {
      if (!group && groups.length > 1) throw new Error(`settings: ${adapter.stack} has no setting "${key}"; to add one, name its group: ${groups.map((g) => `${g}:${key}`).join(' or ')}`);
      s = { group: group || groups[0], key, value: null, role: 'tuned', why: 'added by this run', added: true };
      out.push(s);
    }
    if (!s.overridden) s.base = s.value;
    s.value = v == null ? null : expand(v, vars);
    s.overridden = true;
  }
  return out;
}

export function notes(adapter, link = 'lan') {
  return (defaults(adapter.stack).notes || []).filter((n) => !n.links || n.links.includes(link)).sort((a, b) => (a.kind !== 'defect') - (b.kind !== 'defect'));
}

export const pick = (list, group) => list.filter((s) => s.group === group && s.value != null).map((s) => [s.key, s.value]);
export const longFlags = (list, group) => pick(list, group).map(([k, v]) => `--${k}=${v}`);
export const xArgs = (list, group) => pick(list, group).flatMap(([k, v]) => (v === '' ? [`-${k}`] : [`-${k}`, v]));
export const params = (list, group) => Object.fromEntries(pick(list, group));
