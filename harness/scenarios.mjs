import { markerStats, quantile, round, median } from './lib/metrics.mjs';
import { sleep } from './lib/proc.mjs';

const sleepUntil = (t) => sleep(Math.max(0, t - Date.now()));
const lat = (arr) => ({ p50: quantile(arr, 0.5), p90: quantile(arr, 0.9), p99: quantile(arr, 0.99), n: arr.length });

function counterLatency(seen, inputs) {
  const l = [];
  for (const [k, ti] of inputs) {
    const s = seen.find(([n, , t]) => n >= k && t >= ti);
    if (s) l.push(s[2] - ti);
  }
  return lat(l);
}

function typingMetrics(seen, inputs) {
  const app = [];
  for (const [k, ti] of inputs) {
    const s = seen.find(([n]) => n === k);
    if (s) { const d = (s[1] - (ti & 0xffffff) + 0x1000000) % 0x1000000; if (d < 60000) app.push(d); }
  }
  return { keyToScreenMs: counterLatency(seen, inputs), keysSent: inputs.length,
    keysShown: seen.filter(([n]) => n > 0).length, keyToAppMs: lat(app) };
}

function wheelMetrics(seen, inputs) {
  const l = [];
  let missed = 0;
  inputs.forEach(([, ti], i) => {
    const next = i + 1 < inputs.length ? inputs[i + 1][1] : Infinity;
    const before = [...seen].reverse().find(([, , t]) => t <= ti);
    const s = seen.find(([n, , t]) => t >= ti && n > (before ? before[0] : 0));
    if (s && s[2] < next) l.push(s[2] - ti); else missed++;
  });
  return { wheelToScreenMs: lat(l), wheelsSent: inputs.length, wheelsMissed: missed };
}

async function typeKeys(e, deadline) {
  const chars = 'the quick brown fox jumps over the lazy dog 0123456789 ', inputs = [];
  let k = 0;
  while (Date.now() < deadline - 300) {
    const ts = Date.now();
    await e.key(chars[k % chars.length]);
    inputs.push([++k, ts]);
    await sleep(125);
  }
  return inputs;
}

async function wheelTicks(e, deadline) {
  const inputs = [];
  let k = 0;
  for (;;) {
    const ts = Date.now();
    await e.wheel(0, k % 40 < 20 ? 120 : -120);
    inputs.push([++k, ts]);
    if (ts + 166 >= deadline - 300) return inputs;
    await sleep(Math.max(0, ts + 166 - Date.now()));
  }
}

async function region(e, mode, w, h) {
  const x = Math.round(e.W * 0.55), y = Math.round(e.H * 0.3);
  await e.app(mode, { x, y, w, h, fps: e.fps });
  await e.waitMarker(x, y);
  const m = await e.measure({ markers: [{ id: 'a', x, y }] });
  return { ...markerStats(m.page.marks.a.seen, m.t0, m.t1), ...m.common };
}

async function pageScroll(e) {
  const r = { x: 60, y: 60, w: Math.min(1400, e.W - 120), h: Math.min(1000, e.H - 160) };
  await e.chromium('file:///dm/content/scroll.html', r);
  const g = await e.geom('dm-scroll');
  await e.waitMarker(g.x, g.y);
  const m = await e.measure({ markers: [{ id: 's', x: g.x, y: g.y }] });
  return { ...markerStats(m.page.marks.s.seen, m.t0, m.t1), ...m.common };
}

export const SCENARIOS = {
  'region-256': { about: '256x256 animation on a still desktop', run: (e) => region(e, 'anim', 256, 256) },
  scroll: { about: 'Chromium page on the desktop scrolling itself 8 px per frame', run: (e) => pageScroll(e) },
};

export const WALK = ['drag', 'typing', 'scroll-narrow', 'scroll-medium', 'scroll', 'switch', 'wheel',
  'region-256', 'region-640', 'area-12', 'area-25', 'area-50', 'area-100', 'idle', 'fidelity'];
export const AREAS = [['area-12', '1/8', 0.5, 0.25], ['area-25', '1/4', 0.5, 0.5], ['area-50', '1/2', 1, 0.5], ['area-100', 'full', 1, 1]];
const SCROLLS = [['scroll-narrow', '1'], ['scroll-medium', '2'], ['scroll', '3']];

export function walkLayout(W, H) {
  const fx = W / 2560, fy = H / 1440, r = Math.round;
  const top = r(64 * fy), bot = r(48 * fy), y1 = H - bot, WH = y1 - top;
  const bars = { top: { x: 0, y: 0, w: W, h: top }, bottom: { x: 0, y: y1, w: W, h: bot } };
  const scroll = { x: 40, y: top + 40, w: W - 80, h: WH - 120 };
  const wheel = { x: r(W * 0.58), y: r(H * 0.38), w: r(W * 0.42) - 40, h: r(H * 0.36) - bot };
  const doc = { x: 40, y: top + 40, w: r(800 * fx), h: r(400 * fy) };
  const wall = { w: r(960 * fx), h: r(400 * fy) };
  wall.x = W - wall.w - 40; wall.y = top + 40;
  const edit = { x: 40, y: y1 - 280, w: r(900 * fx), h: 240 };
  const a256 = { x: edit.x + edit.w + 40, y: y1 - 276, w: 256, h: 256 };
  const a640 = { x: a256.x + 256 + 40, y: y1 - 370, w: 640, h: 360 };
  const caret = { x: W - 200, y: y1 - 100 };
  const areas = Object.fromEntries(AREAS.map(([n, , fw, fh]) => { const w = r(W * fw), h = r(WH * fh); return [n, { x: 0, y: y1 - h, w, h }]; }));
  const sw = Math.min(256, Math.floor(W / 8)), col = (c) => r(c * W / 8 + (W / 8 - sw) / 2);
  const slices = [...[0, 1, 2, 4, 6].map((c) => ({ x: col(c), y: 0, w: sw, h: top })),
    ...[0.02, 0.4, 0.8].map((f) => ({ x: r(W * f), y: y1, w: sw, h: bot }))];
  return { bars, slices, work: { y0: top, y1 }, doc, wall, scroll, wheel, edit, a256, a640, caret, areas };
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function dragPath(W, H, win, start, { seed = 20261107, speed = 900, hz = 60, work = { y0: 0, y1: H } } = {}) {
  const rnd = mulberry32(seed), mx = 30, x0 = mx, x1 = W - win.w - mx, y0 = work.y0 + 40, y1 = work.y1 - win.h - mx;
  const cells = [];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) cells.push([i, j]);
  for (let i = cells.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [cells[i], cells[k]] = [cells[k], cells[i]]; }
  const spread = (u) => Math.min(1, Math.max(0, (u - 0.5) * 1.3 + 0.5));
  const pts = [[start.x, start.y], ...cells.map(([i, j]) => [x0 + (x1 - x0) * spread((i + 0.15 + 0.7 * rnd()) / 4), y0 + (y1 - y0) * spread((j + 0.15 + 0.7 * rnd()) / 2)]), [start.x, start.y]];
  const P = [pts[0], ...pts, pts.at(-1)], fine = [];
  for (let k = 1; k < P.length - 2; k++) for (let u = 0; u < 1; u += 0.002) {
    const [p0, p1, p2, p3] = [P[k - 1], P[k], P[k + 1], P[k + 2]], u2 = u * u, u3 = u2 * u;
    const c = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u2 + (-a + 3 * b - 3 * c2 + d) * u3);
    fine.push([Math.min(x1, Math.max(x0, c(p0[0], p1[0], p2[0], p3[0]))), Math.min(y1, Math.max(y0, c(p0[1], p1[1], p2[1], p3[1])))]);
  }
  fine.push(pts.at(-1));
  const step = speed / hz, out = [];
  let acc = 0;
  for (let i = 1; i < fine.length; i++) {
    const d = Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]);
    acc += d;
    while (acc >= step) { acc -= step; out.push([Math.round(fine[i][0] - start.x), Math.round(fine[i][1] - start.y)]); }
  }
  out.push([0, 0]);
  const gx = Math.ceil(W / 32), gy = Math.ceil((work.y1 - work.y0) / 32), hit = new Uint8Array(gx * gy);
  for (const [dx, dy] of out) {
    const ax = start.x + dx, ay = start.y + dy - work.y0;
    for (let y = Math.max(0, Math.floor(ay / 32)); y < Math.min(gy, Math.ceil((ay + win.h) / 32)); y++)
      for (let x = Math.floor(ax / 32); x < Math.min(gx, Math.ceil((ax + win.w) / 32)); x++) hit[y * gx + x] = 1;
  }
  return { moves: out, coverage: hit.reduce((a, b) => a + b, 0) / hit.length };
}

function dragMetrics2d(track, inputs, t0, t1, start) {
  const bins = Math.max(1, Math.floor((t1 - t0) / 1000)), counts = Array(bins).fill(0);
  for (const [, , t] of track) { const b = Math.floor((t - t0) / 1000); if (b >= 0 && b < bins) counts[b]++; }
  const near = (ax, ay, bx, by) => Math.abs(ax - bx) <= 2 && Math.abs(ay - by) <= 2, l = [];
  let j = 0;
  for (let i = 0; i < inputs.length; i++) {
    const [dx, dy, ti] = inputs[i], later = inputs.slice(i + 1, i + 4).filter(([x, y]) => !near(x, y, dx, dy));
    while (j < track.length && track[j][2] < ti) j++;
    for (let k = j; k < track.length; k++) {
      const rx = track[k][0] - start.x, ry = track[k][1] - start.y;
      if (near(rx, ry, dx, dy)) { l.push(track[k][2] - ti); j = k; break; }
      if (later.some(([x, y]) => near(rx, ry, x, y))) break;
    }
  }
  return { positionsPerS: { avg: round(counts.reduce((a, b) => a + b, 0) / bins), worst: Math.min(...counts) },
    inputToScreenMs: lat(l), movesSent: inputs.length, movesMatched: l.length };
}

const textOf = (d) => ({ x: d.x + 12, y: d.y + 14, w: d.w - 12, h: d.h - 14 });
const errOf = (err) => {
  const error = String(err.message || err).slice(0, 300);
  return err.streamLost || /stream lost/.test(error) ? { error, failed: 'stream lost' } : { error };
};

export async function walkthrough(e, want, record) {
  const L = walkLayout(e.W, e.H), phases = WALK.filter((p) => want.includes(p));
  const wm = (action, title) => e.wmAction(action, title);
  await e.app('panel', { edge: 'top', h: L.bars.top.h });
  await e.app('panel', { edge: 'bottom', h: L.bars.bottom.h });
  await e.chromium('file:///dm/content/scroll.html?keys=1', L.scroll);
  await e.chromium('file:///dm/content/doc.html', L.wheel);
  await e.app('doc', { ...L.doc, title: 'dm-doc' });
  await e.app('edit', { ...L.edit, title: 'dm-edit' });
  await wm('minimize', 'dm-scroll');
  const geom = async () => ({ doc: await e.geom('dm-doc'), edit: await e.geom('dm-edit'), wheel: await e.geom('dm-wheel') });
  let g = await geom();
  await e.parkPointer();
  try {
    await e.waitShown([...[g.doc, g.edit, g.wheel].map((w) => ({ x: w.x + 12, y: w.y + 12, w: 160, h: 64 })), L.slices[0], L.slices.at(-1)]);
  } catch (err) {
    if (!/timed out/.test(String(err.message))) throw err;
    for (const p of phases) record(p, { failed: 'desktop never shown within 60 s' });
    return;
  }
  e.timelineStart();
  e.gaugeStart(L.slices);

  let lost = false;
  const run = async (name, fn, { coversGauge = false } = {}) => {
    if (!phases.includes(name)) return;
    if (lost) return record(name, { failed: 'stream lost' });
    e.phase = name;
    if (coversGauge) e.gaugePause(true);
    try { record(name, { metrics: await fn() }); } catch (err) {
      const r = errOf(err);
      if (r.failed) lost = true;
      record(name, r);
    } finally { e.gaugePause(false); }
    e.phase = null;
  };
  const marker = (id, w) => ({ markers: [{ id, x: w.x, y: w.y }] });

  await run('drag', async () => {
    const d = g.doc, path = dragPath(e.W, e.H, d, d, { work: L.work }), grab = { x: d.x + 120, y: d.y - 10 };
    await e.mouseMove(grab.x, grab.y);
    await sleep(100);
    await e.mouseDown();
    const inputs = [];
    const m = await e.measure({ track2d: { x: d.x, y: d.y, w: d.w, h: d.h, W: e.W, H: e.H } }, async () => {
      const t0 = Date.now();
      for (let k = 0; k < path.moves.length; k++) {
        await sleepUntil(t0 + (k + 1) * (1000 / 60));
        const [dx, dy] = path.moves[k], ts = Date.now();
        await e.mouseMove(grab.x + dx, grab.y + dy);
        inputs.push([dx, dy, ts]);
      }
    }, { endWithDuring: true });
    await e.mouseUp();
    const upAt = Date.now();
    setTimeout(() => e.parkPointer().catch(() => {}), 100);
    const out = { ...dragMetrics2d(m.page.track, inputs, m.t0, m.t1, d), ...m.common, coverage: round(path.coverage, 2) };
    if (process.env.DM_DEBUG) out.debug = { track: m.page.track, inputs };
    out.clean = await e.settle('drag', L.wall, upAt);
    return out;
  });
  await run('typing', async () => {
    await e.click(g.edit.x + g.edit.w / 2, g.edit.y + 200);
    let inputs = [];
    const m = await e.measure(marker('k', g.edit), async (dl) => { inputs = await typeKeys(e, dl); });
    return { ...typingMetrics(m.page.marks.k.seen, inputs), ...m.common };
  });
  if (SCROLLS.some(([n]) => phases.includes(n))) {
    await wm('activate', 'dm-scroll');
    const gs = await e.geom('dm-scroll');
    const view = { x: gs.x + Math.round(gs.w / 2) - 640, y: gs.y + 80, w: 1280, h: Math.min(720, gs.h - 100) };
    for (const [name, key] of SCROLLS) {
      await run(name, async () => {
        await e.key(key);
        const m = await e.measure(marker('s', gs));
        const motion = name === 'scroll' ? await e.shot('scroll-motion', view) : null;
        await e.key('s');
        const stopAt = Date.now();
        return { ...markerStats(m.page.marks.s.seen, m.t0, m.t1), ...m.common, motionShot: motion,
          clean: await e.settle(name, view, stopAt, { crop: 'center' }) };
      });
    }
  }
  const restore = async () => { await wm('minimize', 'dm-scroll'); for (const t of ['dm-wheel', 'dm-doc', 'dm-edit']) await wm('activate', t); };
  if (phases.includes('switch')) {
    await run('switch', async () => {
      const steps = [['activate', 'dm-doc'], ['maximize', 'dm-doc'], ['maximize', 'dm-doc'], ['activate', 'dm-wheel'],
        ['maximize', 'dm-wheel'], ['maximize', 'dm-wheel'], ['activate', 'dm-edit'], ['maximize', 'dm-edit'], ['maximize', 'dm-edit'],
        ['activate', 'dm-scroll'], ['activate', 'dm-wheel'], ['activate', 'dm-doc'], ['activate', 'dm-edit'], ['minimize', 'dm-scroll']];
      let lastAt = Date.now();
      const m = await e.measure({}, async () => {
        const t0 = Date.now();
        for (let k = 0; k < steps.length; k++) { await sleepUntil(t0 + k * 400); await wm(...steps[k]); lastAt = Date.now(); }
      }, { endWithDuring: true });
      return { ...m.common, actions: steps.length, clean: await e.settle('switch', L.wall, lastAt) };
    });
  } else if (SCROLLS.some(([n]) => phases.includes(n))) await restore();
  g = await geom();
  await run('wheel', async () => {
    await e.mouseMove(g.wheel.x + g.wheel.w / 2, g.wheel.y + g.wheel.h / 2);
    let inputs = [], settled = null;
    const m = await e.measure(marker('w', g.wheel), async (dl) => {
      inputs = await wheelTicks(e, dl);
      const stopAt = inputs.length ? inputs.at(-1)[1] : Date.now();
      settled = e.settle('wheel', g.wheel, stopAt);
      settled.catch(() => {});
      await sleep(300);
    }, { endWithDuring: true });
    e.parkPointer().catch(() => {});
    return { ...wheelMetrics(m.page.marks.w.seen, inputs), ...m.common, clean: await settled };
  });
  for (const [name, a] of [['region-256', L.a256], ['region-640', L.a640]]) {
    await run(name, async () => {
      await e.app('anim', { x: a.x, y: a.y, w: a.w, h: a.h, fps: e.fps, secs: e.secs + 2 });
      const m = await e.measure(marker('a', a));
      const offArea = await e.look(`${name}-text`, textOf(await e.geom('dm-doc'))).catch(() => null);
      await e.stopApps('anim');
      const seen = m.page.marks.a.seen;
      return { ...markerStats(seen, seen.length ? seen[0][2] : m.t0, m.t1), ...m.common, offArea };
    });
  }
  for (const [name] of AREAS) {
    const a = L.areas[name];
    await run(name, async () => {
      let m, offArea = null;
      try {
        await e.app('anim', { x: a.x, y: a.y, w: a.w, h: a.h, fps: e.fps, secs: e.secs + 2 });
        m = await e.measure(marker('a', a));
        if (name !== 'area-100') offArea = await e.look(`${name}-text`, textOf(await e.geom('dm-doc'))).catch(() => null);
      } finally { await e.stopApps('anim'); }
      const seen = m.page.marks.a.seen;
      return { ...markerStats(seen, seen.length ? seen[0][2] : m.t0, m.t1), ...m.common, areaPx: a.w * a.h, offArea };
    });
  }
  await e.parkPointer();
  let stillDone = false;
  await run('idle', async () => {
    e.phase = 'caret';
    await e.app('marker', { ...L.caret, fps: 2, secs: e.secs + 1 });
    const caret = await e.measure({});
    await e.stopApps('marker');
    e.phase = 'still';
    const still = await e.measure({});
    stillDone = true;
    return { still: still.common, caret: caret.common };
  });
  await run('fidelity', async () => {
    if (!stillDone) { e.phase = 'still'; await e.measure({}); }
    const d = textOf(await e.geom('dm-doc')), out = {};
    for (const [k, r] of [['topbar', L.bars.top], ['taskbar', L.bars.bottom], ['text', d], ['wallpaper', L.wall]])
      out[k] = { ...await e.fidelity(r), shot: await e.shot(k, r) };
    return out;
  });
}

export const MODE = '2560x1440@60';
export const BENCH_LINKS = ['lan', 'wan'];

export { median };
