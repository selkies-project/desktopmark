import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Proc, sleep, waitFor, cpuTicks, cores, hostInfo, xSocket, LIVE, killAll } from './lib/proc.mjs';
import * as net from './lib/net.mjs';
import { baseDesktop, app, windowGeometry, xgrab, desktopChromium } from './lib/scene.mjs';
import { bandwidth, round } from './lib/metrics.mjs';
import { encodePNG } from './lib/png.mjs';
import { setOverrides, resolve as resolveSettings, notes as stackNotes } from './lib/settings.mjs';
import { SCENARIOS, WALK, MODE, BENCH_LINKS, walkthrough } from './scenarios.mjs';
import { report } from './report.mjs';
import voxl from './stacks/voxl.mjs';
import { selkiesWs, selkiesRtc } from './stacks/selkies.mjs';
import { kasmWs, kasmWsHybrid, kasmRtcHybrid, KASM_CRF } from './stacks/kasmvnc.mjs';
import { nekoRtc } from './stacks/neko.mjs';

const require = createRequire(`${process.env.PLAYWRIGHT_NODE_MODULES || '/opt/pw/node_modules'}/`);
const { chromium } = require('playwright-core');

export const STACKS = [selkiesWs, selkiesRtc, kasmWs, nekoRtc, voxl, kasmWsHybrid, kasmRtcHybrid];
const MEASURE_JS = '/dm/harness/page/measure.js';

const [cmd = 'run', ...rest] = process.argv.slice(2);
const kv = Object.fromEntries(rest.filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2)));
for (const k of ['profile', 'tiers', 'modes'])
  if (kv[k] != null || process.env[`DM_${k.toUpperCase()}`]) { console.error(`[dm] ${k}= is gone: there is one benchmark, the walkthrough at ${MODE} on LAN and WAN`); process.exit(2); }
const opt = (k, d) => kv[k] ?? process.env[`DM_${k.toUpperCase()}`] ?? d;
const list = (k, d) => String(opt(k, d)).split(',').map((s) => s.trim()).filter(Boolean);

const OUT = opt('out', '/out');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MERGE_DIR = (() => {
  const m = opt('merge', '');
  if (!m || cmd !== 'run') return null;
  const d = m === 'latest' ? readdirSync(OUT).filter((f) => /^run-/.test(f) && existsSync(join(OUT, f, 'meta.json'))).sort().map((f) => join(OUT, f)).at(-1)
    : m.startsWith('/') ? m : join(OUT, m);
  if (!d || !existsSync(join(d, 'meta.json'))) throw new Error(`merge=${m}: no run with a meta.json there`);
  return d;
})();
const MERGE_META = MERGE_DIR ? JSON.parse(readFileSync(join(MERGE_DIR, 'meta.json'), 'utf8')) : null;
const mopt = (k, d) => kv[k] ?? process.env[`DM_${k.toUpperCase()}`] ?? MERGE_META?.[k] ?? d;
const GAP_S = +opt('gap', 10);
const REPS = +mopt('reps', cmd === 'selftest' ? 2 : 1), SECS = +mopt('secs', 4), SETTLE_MS = +(kv.settle ?? process.env.DM_SETTLE ?? MERGE_META?.settleMs ?? 2000);
const OVERRIDES = setOverrides(kv, opt('settings', ''), [...new Set(STACKS.flatMap((s) => [s.stack, s.id]))]);

export function ceilingKbps({ w, h, fps }) {
  return Math.round((30000 * (w * h) / (2560 * 1440) * (fps > 60 ? 1.5 : 1)) / 100) * 100;
}
const parseMode = (m) => { const [wh, fps] = m.split('@'); const [w, h] = wh.split('x').map(Number); return { w, h, fps: +fps, id: m }; };

function physicalCores() {
  const seen = new Map();
  for (const d of readFileSync('/sys/devices/system/cpu/online', 'utf8').trim().split(',')) {
    const [a, b = a] = d.split('-').map(Number);
    for (let c = a; c <= b; c++) {
      let sib = String(c);
      try { sib = readFileSync(`/sys/devices/system/cpu/cpu${c}/topology/thread_siblings_list`, 'utf8').trim(); } catch {}
      if (!seen.has(sib)) seen.set(sib, sib);
    }
  }
  return [...seen.values()];
}
function pinning() {
  const pc = physicalCores();
  if (opt('pin', '1') === '0' || pc.length < 8) return { pinned: false, physical: pc.length };
  const n = Math.min(+opt('stackcores', pc.length >= 12 ? 8 : 6), pc.length - 2);
  return { pinned: true, physical: pc.length, stack: pc.slice(0, n).join(','), harness: pc.slice(n).join(','), stackCores: n };
}

async function startSession(stack, config, mode, link, logDir) {
  const pin = HOST.pin;
  const home = mkdtempSync('/tmp/dm-home-'), runtimeDir = mkdtempSync('/tmp/dm-run-');
  const ctx = { mode, config, link, ceilingKbps: ceilingKbps(mode), home, runtimeDir, logDir,
    stackCpus: pin.pinned ? pin.stack : null, appCpus: pin.pinned ? pin.stack : null };
  const procs = [], own = [];
  let browser = null;
  try {
    procs.push(...await stack.startX(ctx)); own.push(...procs);
    procs.push(await baseDesktop(ctx, stack.display));
    const srv = await stack.startServer(ctx);
    procs.push(...srv.procs); own.push(...srv.procs);
    if (HOST.shaping) net.shape(stack.ports, net.LINKS[link]);
    const args = ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args });
    const context = await browser.newContext({ viewport: { width: mode.w, height: mode.h }, deviceScaleFactor: 1 });
    await context.addInitScript({ path: MEASURE_JS });
    const page = await context.newPage();
    page.on('console', (m) => appendFileSync(join(logDir, 'page-console.log'), `[${m.type()}] ${m.text()}\n`));
    page.on('pageerror', (e) => appendFileSync(join(logDir, 'page-console.log'), `[pageerror] ${e.message}\n`));
    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    const info = await waitFor(`stream element at ${mode.w}x${mode.h}`, async () => {
      const i = await page.evaluate((s) => window.__dm && window.__dm.info(s), stack.selector).catch(() => null);
      return i && i.w === mode.w && i.h === mode.h ? i : null;
    }, 45000);
    const launch = { procs: own.map((p) => ({ name: p.name, ...p.launch })), url: srv.url };
    return { stack, ctx, procs, srv, browser, context, page, info, launch, appProcs: [] };
  } catch (err) {
    await browser?.close().catch(() => {});
    for (const p of [...procs].reverse()) await p.stop();
    if (HOST.shaping) net.clear();
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    throw err;
  }
}

async function endSession(s) {
  for (const p of s.appProcs) await p.stop(1000);
  await s.browser.close().catch(() => {});
  for (const p of [...s.procs].reverse()) await p.stop();
  if (HOST.shaping) net.clear();
  rmSync(s.ctx.home, { recursive: true, force: true });
  rmSync(s.ctx.runtimeDir, { recursive: true, force: true });
}

function checkAssertions(s) {
  const fails = [];
  for (const a of s.stack.assertions || []) {
    if (a.only && !a.only(s.ctx)) continue;
    const p = s.procs.find((q) => q.name === a.proc);
    const hit = p ? a.re.test(p.log()) : false;
    if (a.invert ? hit : !hit) fails.push(a.what);
  }
  return fails;
}

function scenarioEnv(s) {
  const { stack, page, ctx } = s, { w: W, h: H, fps } = ctx.mode, display = stack.display;
  const map = (x, y) => {
    const r = s.info.rect, k = r.width / s.info.w;
    return [r.x + x * k, r.y + y * k];
  };
  const stackPgids = () => s.procs.map((p) => p.pid);
  const appPgids = () => s.appProcs.map((p) => p.pid);
  const ticks = () => ({ server: cpuTicks({ pgids: stackPgids() }),
    client: cpuTicks({ roots: [process.pid] }) - cpuTicks({ pgids: [...stackPgids(), ...appPgids()] }) - selfTicks() });
  const e = {
    W, H, fps, display, page, stack, secs: SECS, settleMs: SETTLE_MS, phase: null,
    async app(mode, o) { const p = await app(ctx, display, mode, o); s.appProcs.push(p); return p; },
    async chromium(url, r) { const p = desktopChromium(ctx, display, url, r); s.appProcs.push(p); await sleep(2500); return p; },
    geom: (title) => windowGeometry(display, title),
    wmAction: (action, title) => new Promise((res) => execFile('/env/bin/dmapp', [action, '--title', title],
      { env: { ...process.env, DISPLAY: display } }, () => res())),
    async stopApps(mode) {
      for (const p of s.appProcs.filter((q) => q.name.startsWith(`dmapp-${mode}-`))) await p.stop(1000);
      s.appProcs = s.appProcs.filter((q) => !q.name.startsWith(`dmapp-${mode}-`));
    },
    async waitShown(regions) {
      const last = regions.map(() => null);
      try {
        for (const [i, r] of regions.entries()) await waitFor('content on the stream', async () => (last[i] = (await e.fidelity(r).catch((err) => ({ err: err.message })))).ssimY > 0.9, 60000);
      } catch (err) {
        try {
          const full = { x: 0, y: 0, w: W, h: H };
          writeFileSync(join(ctx.logDir, 'not-shown.png'), encodePNG(Buffer.from(await page.evaluate(([sel, r]) => window.__dm.crop(sel, r.x, r.y, r.w, r.h), [stack.selector, full]), 'base64'), W, H));
          writeFileSync(join(ctx.logDir, 'not-shown-x.png'), encodePNG(xgrab(display, 0, 0, W, H), W, H));
          writeFileSync(join(ctx.logDir, 'not-shown.json'), JSON.stringify(regions.map((r, i) => ({ r, last: last[i] })), null, 1));
        } catch {}
        throw err;
      }
    },
    async waitMarker(x, y) {
      let last = null;
      await waitFor('marker on the stream', async () => {
        const r = await page.evaluate(([sel, x, y]) => window.__dm.markerNow(sel, x, y), [stack.selector, x, y]);
        const ok = r && last && r.n !== last.n && Math.abs(((r.now & 0xffffff) - r.ms + 0x1000000) % 0x1000000) < 10000;
        last = r || last;
        return ok;
      }, 20000).catch(() => {});
    },
    async waitTracker(tracker, x) {
      await waitFor('tracker on the stream', () => page.evaluate(([sel, t, x]) => {
        const st = window.__dm.start({ sel, tracker: t }); return new Promise((r) => setTimeout(() => {
          const res = window.__dm.stop(); r(res.track.some(([p]) => Math.abs(p - x) <= 2));
        }, 300));
      }, [stack.selector, tracker, x]), 20000).catch(() => {});
    },
    mouseMove: (x, y) => page.mouse.move(...map(x, y)),
    mouseDown: () => page.mouse.down(),
    mouseUp: () => page.mouse.up(),
    async click(x, y) { await page.mouse.move(...map(x, y)); await page.mouse.down(); await sleep(50); await page.mouse.up(); },
    key: (k) => page.keyboard.press(k),
    wheel: (dx, dy) => page.mouse.wheel(dx, dy),
    parkPointer: () => page.mouse.move(...map(W - 4, H - 4)),
    async measure(cfg, during, { endWithDuring = false } = {}) {
      const samples = [], secs = SECS;
      const sample = () => { if (HOST.shaping) samples.push({ t: Date.now(), ...net.bytes() }); };
      sample();
      const timer = setInterval(sample, 100);
      const c0 = ticks(), t0 = Date.now();
      const started = await page.evaluate((c) => window.__dm.start(c), { ...cfg, sel: stack.selector });
      const label = e.phase;
      if (started.lost) throw new StreamLost();
      const deadline = t0 + secs * 1000;
      if (during) await during(deadline);
      if (!endWithDuring) await sleep(Math.max(0, deadline - Date.now()));
      const res = await page.evaluate(() => window.__dm.stop());
      const t1 = Date.now(), c1 = ticks();
      clearInterval(timer);
      if (s.timeline && label) s.timeline.phases.push([label, t0, t1]);
      if (res.lost) throw new StreamLost();
      sample();
      return { page: res, t0, t1, common: {
        serverCores: round(cores(c0.server, c1.server, t1 - t0), 2),
        clientCores: round(cores(c0.client, c1.client, t1 - t0), 2),
        bandwidth: bandwidth(samples), pageFrames: res.frames, pageErrors: res.errs } };
    },
    async fidelity(r) {
      r = e.onScreen(r);
      const page64 = await page.evaluate(([sel, r]) => window.__dm.crop(sel, r.x, r.y, r.w, r.h), [stack.selector, r]);
      return compare(Buffer.from(page64, 'base64'), xgrab(display, r.x, r.y, r.w, r.h), r);
    },
    async cleanCurve(r, since = Date.now()) {
      const t0 = since, crops = [];
      while (Date.now() - t0 < 3000) {
        crops.push([Date.now() - t0, await page.evaluate(([sel, r]) => window.__dm.crop(sel, r.x, r.y, r.w, r.h), [stack.selector, r])]);
        await sleep(100);
      }
      const ref = xgrab(display, r.x, r.y, r.w, r.h);
      const curve = crops.map(([t, b]) => [t, compare(Buffer.from(b, 'base64'), ref, r).ssim]);
      const clean = curve.find(([, v], i) => curve.slice(i).every(([, w]) => w >= 0.98));
      return { msToSsim98: clean ? clean[0] : null, finalSsim: curve.at(-1)?.[1] ?? null };
    },
    async shot(name, r, rgb = null) {
      if (!s.shotDir) return null;
      rgb ??= Buffer.from(await page.evaluate(([sel, r]) => window.__dm.crop(sel, r.x, r.y, r.w, r.h), [stack.selector, r]), 'base64');
      const f = `${s.tag}-${name}.png`, xf = `${s.tag}-${name}-x.png`;
      writeFileSync(join(s.shotDir, f), encodePNG(rgb, r.w, r.h));
      writeFileSync(join(s.shotDir, xf), encodePNG(xgrab(display, r.x, r.y, r.w, r.h), r.w, r.h));
      return { file: `shots/${f}`, xfile: `shots/${xf}`, w: r.w, h: r.h };
    },
    onScreen(r) {
      const x = Math.max(0, r.x), y = Math.max(0, r.y), w = Math.min(W, r.x + r.w) - x, h = Math.min(H, r.y + r.h) - y;
      if (w < 64 || h < 32) throw new Error(`region ${r.w}x${r.h}+${r.x}+${r.y} is off screen`);
      return { x, y, w, h };
    },
    async look(name, r) {
      r = e.onScreen(r);
      const rgb = Buffer.from(await page.evaluate(([sel, r]) => window.__dm.crop(sel, r.x, r.y, r.w, r.h), [stack.selector, r]), 'base64');
      const fid = compare(rgb, xgrab(display, r.x, r.y, r.w, r.h), r);
      return { ssim: fid.ssim, psnr: fid.psnr, psnrY: fid.psnrY, chromaErr: fid.chromaErr, shot: await e.shot(name, r, rgb) };
    },
    async settle(name, r, since = Date.now(), { crop = 'topleft' } = {}) {
      r = e.onScreen(r);
      const cw = Math.min(480, r.w), ch = Math.min(270, r.h);
      const c = crop === 'center' ? { x: r.x + Math.round((r.w - cw) / 2), y: r.y + Math.round((r.h - ch) / 2), w: cw, h: ch } : { x: r.x, y: r.y, w: cw, h: ch };
      const crops = [], t0 = Date.now();
      while (Date.now() - since < e.settleMs) {
        const at = Date.now();
        crops.push([at - since, await page.evaluate(([sel, r]) => window.__dm.crop(sel, r.x, r.y, r.w, r.h), [stack.selector, c])]);
        await sleep(Math.max(0, (at - since < 500 ? 30 : 100) - (Date.now() - at)));
      }
      if (s.timeline) s.timeline.phases.push([`${name} settle`, t0, Date.now()]);
      const curve = ssimCurve(crops, xgrab(display, c.x, c.y, c.w, c.h), c);
      const clean = curve.find(([, v], i) => curve.slice(i).every(([, w]) => w >= 0.98));
      const rgb = Buffer.from(await page.evaluate(([sel, r]) => window.__dm.crop(sel, r.x, r.y, r.w, r.h), [stack.selector, r]), 'base64');
      const fid = compare(rgb, xgrab(display, r.x, r.y, r.w, r.h), r);
      return { msToSsim98: clean ? clean[0] : null, finalSsim: curve.at(-1)?.[1] ?? null, settleMs: e.settleMs, curve,
        ssim: fid.ssim, psnr: fid.psnr, psnrY: fid.psnrY, chromaErr: fid.chromaErr, shot: await e.shot(name, r, rgb) };
    },
    timelineStart() {
      s.timeline = { t0: Date.now(), samples: [], phases: [] };
      const tick = () => { const c = ticks(), b = HOST.shaping ? net.bytes() : { down: 0, up: 0 };
        s.timeline.samples.push([Date.now() - s.timeline.t0, b.down, b.up, c.server, c.client]); };
      tick();
      s.timelineTimer = setInterval(tick, 250);
    },
    gaugeStart(regions) {
      if (opt('gauge', '1') === '0' || s.gaugeOff || !s.timeline) return;
      regions = [].concat(regions);
      const dir = mkdtempSync('/tmp/dm-gauge-');
      const r = { w: regions[0].w, h: regions.reduce((a, q) => a + q.h, 0), regions };
      const ref = Buffer.concat(regions.map((q) => xgrab(display, q.x, q.y, q.w, q.h)));
      const g = (s.gauge = { r, dir, ref, files: [], paused: false, busy: false });
      s.gaugeTimer = setInterval(async () => {
        if (g.paused || g.busy || !s.timeline) return;
        g.busy = true;
        try {
          const t = Date.now() - s.timeline.t0;
          const b = await page.evaluate(([sel, rs]) => rs.map((q) => window.__dm.crop(sel, q.x, q.y, q.w, q.h)), [stack.selector, regions]);
          const f = `${dir}/${g.files.length}.rgb`;
          writeFileSync(f, Buffer.concat(b.map((x) => Buffer.from(x, 'base64'))));
          g.files.push([t, f]);
        } catch {} finally { g.busy = false; }
      }, 250);
    },
    gaugePause(on) { if (s.gauge) s.gauge.paused = on; },
    timelineStop() {
      clearInterval(s.timelineTimer); clearInterval(s.gaugeTimer);
      const t = s.timeline; s.timeline = null;
      if (s.gauge) {
        const g = s.gauge; s.gauge = null;
        writeFileSync(`${g.dir}/x.rgb`, g.ref);
        const out = spawnSync('/env/bin/python3', ['/dm/harness/fidelity.py', '--curve', `${g.dir}/x.rgb`, String(g.r.w), String(g.r.h), ...g.files.map(([, f]) => f)], { encoding: 'utf8' });
        let v = [];
        try { v = JSON.parse(out.stdout); } catch {}
        t.gauge = { region: g.r, samples: g.files.map(([ms], i) => [ms, v[i]?.[0] ?? null, v[i]?.[1] ?? null]) };
        rmSync(g.dir, { recursive: true, force: true });
      }
      return t;
    },
    async reconnect(x, y) {
      const t0 = Date.now();
      await page.goto(s.srv.url, { waitUntil: 'domcontentloaded' });
      await waitFor('stream after reconnect', async () => {
        const i = await page.evaluate((sel) => window.__dm && window.__dm.info(sel), stack.selector).catch(() => null);
        return i && i.w === W && i.h === H;
      }, 45000);
      await e.waitMarker(x, y);
      return Date.now() - t0;
    },
  };
  return e;
}

class StreamLost extends Error {
  constructor() { super('stream lost: the client stopped showing the stream (see the page console and server log)'); this.streamLost = true; }
}

let selfBase = 0;
function selfTicks() {
  const st = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
  return +f[11] + +f[12] - selfBase;
}

function compare(pageRgb, xRgb, r) {
  const dir = mkdtempSync('/tmp/dm-fid-');
  writeFileSync(`${dir}/p.rgb`, pageRgb);
  writeFileSync(`${dir}/x.rgb`, xRgb);
  const out = spawnSync('/env/bin/python3', ['/dm/harness/fidelity.py', `${dir}/p.rgb`, `${dir}/x.rgb`, String(r.w), String(r.h)], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  try { return JSON.parse(out.stdout); } catch { return { error: out.stderr.trim().slice(0, 200) }; }
}

function ssimCurve(crops, ref, r) {
  const dir = mkdtempSync('/tmp/dm-curve-');
  writeFileSync(`${dir}/x.rgb`, ref);
  const files = crops.map(([, b], i) => { const f = `${dir}/${i}.rgb`; writeFileSync(f, Buffer.from(b, 'base64')); return f; });
  const out = spawnSync('/env/bin/python3', ['/dm/harness/fidelity.py', '--curve', `${dir}/x.rgb`, String(r.w), String(r.h), ...files], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  let v = [];
  try { v = JSON.parse(out.stdout); } catch {}
  return crops.map(([t], i) => [t, v[i]?.[0] ?? null, v[i]?.[1] ?? null]);
}

function previewEnv(ctx, display, mode, appProcs, send) {
  const { w: W, h: H, fps } = mode;
  const marks = new Proxy({}, { get: () => ({ seen: [] }) });
  const e = {
    W, H, fps, display, secs: SECS, settleMs: SETTLE_MS, phase: null,
    async app(m, o) { const p = await app(ctx, display, m, o); appProcs.push(p); return p; },
    async chromium(url, r) { appProcs.push(desktopChromium(ctx, display, url, r)); await sleep(2500); },
    geom: (title) => windowGeometry(display, title),
    async stopApps(m) {
      for (const p of appProcs.filter((q) => q.name.startsWith(`dmapp-${m}-`))) await p.stop(1000);
      appProcs.splice(0, appProcs.length, ...appProcs.filter((q) => !q.name.startsWith(`dmapp-${m}-`)));
    },
    waitShown: () => sleep(500),
    wmAction: (action, title) => new Promise((res) => execFile('/env/bin/dmapp', [action, '--title', title], { env: { ...process.env, DISPLAY: display } }, () => res())),
    mouseMove: (x, y) => send(`m ${Math.round(x)} ${Math.round(y)}`),
    mouseDown: () => send('d'),
    mouseUp: () => send('u'),
    async click(x, y) { await send(`m ${Math.round(x)} ${Math.round(y)}`); await send('d'); await sleep(50); await send('u'); },
    key: (k) => send(`k ${k}`),
    wheel: (dx, dy) => send(`w ${Math.sign(dy)}`),
    parkPointer: () => send(`m ${W - 4} ${H - 4}`),
    async measure(cfg, during, { endWithDuring = false } = {}) {
      const t0 = Date.now(), deadline = t0 + SECS * 1000;
      if (during) await during(deadline);
      if (!endWithDuring) await sleep(Math.max(0, deadline - Date.now()));
      return { page: { marks, track: [], frames: 0 }, t0, t1: Date.now(), common: {} };
    },
    async settle(name, r, since = Date.now()) { await sleep(Math.max(0, since + SETTLE_MS - Date.now())); return {}; },
    shot: async () => null, look: async () => null, fidelity: async () => ({}), onScreen: (r) => r,
    timelineStart() {}, timelineStop() { return null; }, gaugeStart() {}, gaugePause() {},
  };
  return e;
}

async function preview(dir, mode) {
  const logDir = join(dir, 'logs', 'preview');
  mkdirSync(logDir, { recursive: true });
  const home = mkdtempSync('/tmp/dm-home-'), runtimeDir = mkdtempSync('/tmp/dm-run-');
  const ctx = { mode, config: 'preview', home, runtimeDir, logDir, stackCpus: null, appCpus: null };
  const display = ':20', procs = [], appProcs = [], out = join(dir, 'walkthrough.mp4');
  try {
    procs.push(new Proc('xvfb', '/env/bin/Xvfb-voxl', [display, '-screen', '0', `${mode.w}x${mode.h}x24`, '-dpi', '96',
      '-ac', '-nolisten', 'tcp', '-noreset', '-fakescreenfps', String(mode.fps)], { logDir }));
    await waitFor('X socket', () => existsSync(xSocket(display)));
    procs.push(await baseDesktop(ctx, display));
    const input = new Proc('input', '/env/bin/dmapp', ['input'], { env: { DISPLAY: display }, logDir, stdin: true });
    procs.push(input);
    const send = (l) => new Promise((r) => input.child.stdin.write(`${l}\n`, r));
    const rec = new Proc('ffmpeg', 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '30',
      '-video_size', `${mode.w}x${mode.h}`, '-draw_mouse', '1', '-i', display,
      ...(mode.w > 1920 ? ['-vf', 'scale=1920:-2:flags=lanczos'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', out],
    { env: { DISPLAY: display }, logDir });
    await walkthrough(previewEnv(ctx, display, mode, appProcs, send), WALK, () => {});
    await sleep(1000);
    await rec.stop(30000);
    return existsSync(out) ? 'walkthrough.mp4' : null;
  } catch (err) {
    console.error(`[dm] preview: ${err.message}`);
    return null;
  } finally {
    for (const p of appProcs) await p.stop(1000);
    for (const p of procs.reverse()) await p.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

const HOST = { ...hostInfo(), pin: pinning(), shaping: net.canShape() };

const sh = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 5000 });
  return `${r.stdout || ''}${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
};
function x264Of(files) {
  if (!files) return null;
  for (const f of files) {
    const m = sh(['ldd', f]).match(/libx264\S* => (\S+)/);
    if (!m) continue;
    const real = sh(['readlink', '-f', m[1]]);
    const nix = real.match(/\/nix\/store\/[a-z0-9]+-([^/]+)/);
    if (nix) return `${nix[1].replace(/-lib$/, '')} (nix)`;
    const pkg = sh(['dpkg', '-S', real]).split(':')[0];
    if (pkg) return `${pkg} ${sh(['dpkg-query', '-W', '-f', '${Version}', pkg])}`;
    return real;
  }
  return null;
}
function versions() {
  const v = {}, src = Object.fromEntries((process.env.DM_SOURCES || '').split(/\s+/).filter(Boolean).map((x) => x.split(/=(.*)/s).slice(0, 2)));
  for (const s of STACKS) {
    if (v[s.stack]) continue;
    const ver = sh(s.version).split('\n').filter(Boolean).slice(-3).join(' | ').replace(/^\S+=/, '').slice(0, 300);
    let xs = s.xserver ? sh(s.xserver).split('\n').find((l) => /X\.Org|XLibre|X Server|Window System|version/i.test(l) && !/Unrecognized/i.test(l)) : null;
    if (s.xserver && !xs) xs = (sh(['readlink', '-f', s.xserver[0]]).match(/\/nix\/store\/[a-z0-9]+-([^/]+)/) || [])[1] || s.xserverName || null;
    v[s.stack] = {
      version: ver,
      source: src[s.stack] || (s.stack === 'voxl' ? 'local build context' : null),
      binary: s.binary,
      sha256: s.binary ? sh(['sha256sum', s.binary]).split(' ')[0] : null,
      xserver: s.xserver ? (xs || '').trim().slice(0, 120) : 'the stack itself',
      x264: x264Of(s.encoderLib) || (s.stack === 'selkies' ? 'bundled in pixelflux' : null),
    };
  }
  v.chromium = sh([process.env.CHROMIUM, '--version']);
  return v;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function plan() {
  const wantStacks = list('stacks', STACKS.filter((s) => !s.extra || opt('extras', '0') === '1').map((s) => s.id).join(','));
  const stacks = STACKS.filter((s) => wantStacks.includes(s.id));
  const scen = list('scenarios', WALK.join(',')).filter((x) => WALK.includes(x));
  const links = list('links', BENCH_LINKS.join(',')).filter((l) => BENCH_LINKS.includes(l));
  const sessions = [];
  for (const stack of stacks) for (const link of links) for (const gauge of cmd === 'selftest' ? [true, false] : [undefined])
    sessions.push({ tier: 'desktop', stack, config: 'matched', mode: parseMode(MODE), link, scen, gauge });
  return sessions;
}

async function run() {
  const dir = MERGE_DIR || join(OUT, `run-${STAMP}`);
  mkdirSync(dir, { recursive: true });
  const sessions = plan();
  if (!HOST.shaping) console.error('[dm] no CAP_NET_ADMIN: bandwidth not measured, WAN skipped (docker run --cap-add NET_ADMIN)');
  const config = {};
  for (const x of sessions) {
    const c = (config[x.stack.id] ||= { stack: x.stack.stack, modes: {}, notes: {} });
    (c.modes[x.mode.id] ||= {})[x.link] ||= resolveSettings(x.stack, { mode: x.mode, link: x.link, ceilingKbps: ceilingKbps(x.mode) });
    c.notes[x.link] ||= stackNotes(x.stack, x.link);
  }
  const meta = { host: HOST, versions: versions(), reps: REPS, secs: SECS, settleMs: SETTLE_MS, gapS: GAP_S, kasmCrf: KASM_CRF, started: new Date().toISOString(),
    config, overrides: OVERRIDES, label: opt('label', '') || null,
    sessions: sessions.map((x) => ({ tier: x.tier, stack: x.stack.id, config: x.config, mode: x.mode.id, link: x.link, scenarios: x.scen })) };
  if (MERGE_DIR) writeFileSync(join(dir, 'meta.json'), JSON.stringify(mergeInto(dir, MERGE_META, meta, sessions), null, 2));
  else {
    const walkSession = sessions[0];
    if (cmd === 'run' && walkSession && opt('preview', '1') !== '0') {
      console.error('[dm] preview: recording the walkthrough on a bare X server for the report');
      meta.preview = await preview(dir, walkSession.mode);
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }
  console.error(`[dm] ${sessions.length} sessions x ${REPS} reps -> ${dir}`);
  let opened = 0;
  for (let rep = 1; rep <= REPS; rep++) {
    for (const x of shuffle([...sessions])) {
      if (x.link !== 'lan' && !HOST.shaping) continue;
      if (opened++ && GAP_S > 0) { console.error(`[dm] gap: ${GAP_S} s before the next session`); await sleep(GAP_S * 1000); }
      if (LIVE.size) console.error(`[dm] warning: killed what the last session left running: ${(await killAll()).join(', ')}`);
      const tag = `${x.stack.id}-${x.config}-${x.mode.id}-${x.link}${x.gauge === false ? '-nogauge' : ''}-r${rep}`;
      const logDir = join(dir, 'logs', tag);
      mkdirSync(logDir, { recursive: true });
      console.error(`[dm] rep ${rep}: ${x.stack.id} ${x.config} ${x.mode.id} ${x.link}`);
      let s;
      try {
        s = await startSession(x.stack, x.config, x.mode, x.link, logDir);
        s.gaugeOff = x.gauge === false;
        const base = { rep, tier: x.tier, stack: x.stack.id, config: x.config, mode: x.mode.id, link: x.link, ...(x.gauge !== undefined && { gauge: x.gauge }) };
        appendFileSync(join(dir, 'results.jsonl'), JSON.stringify({ ...base, launch: s.launch }) + '\n');
        {
          s.tag = tag;
          if (rep === 1) { s.shotDir = join(dir, 'shots'); mkdirSync(s.shotDir, { recursive: true }); }
          const env = scenarioEnv(s);
          await walkthrough(env, x.scen, (name, r) => {
            appendFileSync(join(dir, 'results.jsonl'), JSON.stringify({ ...base, scenario: name, ...r }) + '\n');
            console.error(`[dm]   ${name}: ${r.error ? 'error ' + r.error : r.failed ? 'FAIL ' + r.failed : 'ok'}`);
          });
          const tl = s.timeline ? env.timelineStop() : null;
          if (tl) appendFileSync(join(dir, 'results.jsonl'), JSON.stringify({ ...base, timeline: tl }) + '\n');
        }
        const fails = checkAssertions(s);
        if (fails.length) appendFileSync(join(dir, 'results.jsonl'), JSON.stringify({ rep, stack: x.stack.id, config: x.config,
          mode: x.mode.id, link: x.link, invalid: fails }) + '\n');
      } catch (err) {
        appendFileSync(join(dir, 'results.jsonl'), JSON.stringify({ rep, stack: x.stack.id, config: x.config, mode: x.mode.id,
          link: x.link, sessionError: String(err.message || err).slice(0, 300) }) + '\n');
        console.error(`[dm]   session error: ${err.message}`);
      } finally { if (s) { clearInterval(s.timelineTimer); clearInterval(s.gaugeTimer); if (s.gauge) rmSync(s.gauge.dir, { recursive: true, force: true }); await endSession(s); } }
    }
  }
  if (cmd === 'selftest') { const md = selftestReport(dir); writeFileSync(join(dir, 'selftest.md'), md); process.stdout.write(md); }
  else process.stdout.write(report(dir));
}

function mergeInto(dir, old, meta, sessions) {
  const key = (r) => `${r.stack}|${r.mode}|${r.link}`;
  const keys = new Set(sessions.map((x) => `${x.stack.id}|${x.mode.id}|${x.link}`));
  const res = join(dir, 'results.jsonl');
  if (existsSync(res)) {
    copyFileSync(res, join(dir, `results.jsonl.bak-${STAMP}`));
    const lines = readFileSync(res, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter((l) => { try { return !keys.has(key(JSON.parse(l))); } catch { return true; } });
    writeFileSync(res, keep.map((l) => l + '\n').join(''));
    console.error(`[dm] merge: replacing ${lines.length - keep.length} records in ${dir}`);
  }
  for (const x of sessions) {
    const prefix = `${x.stack.id}-${x.config}-${x.mode.id}-${x.link}-`;
    for (const sub of ['logs', 'shots']) {
      const d = join(dir, sub);
      if (existsSync(d)) for (const f of readdirSync(d)) if (f.startsWith(prefix)) rmSync(join(d, f), { recursive: true, force: true });
    }
  }
  const out = { ...old, config: { ...(old.config || {}) } };
  for (const [col, c] of Object.entries(meta.config)) {
    const o = (out.config[col] ||= { stack: c.stack, modes: {}, notes: {} });
    for (const [mode, byLink] of Object.entries(c.modes)) {
      const prev = o.modes[mode], links = [...new Set(meta.sessions.filter((x) => x.stack === col && x.mode === mode).map((x) => x.link))];
      o.modes[mode] = Array.isArray(prev) ? Object.fromEntries((old.sessions || []).filter((x) => x.stack === col && x.mode === mode).map((x) => [x.link, prev])) : { ...(prev || {}) };
      for (const l of links) o.modes[mode][l] = byLink[l];
    }
    const adapter = STACKS.find((a) => a.id === col);
    o.notes = { ...(o.notes || {}), ...c.notes };
    for (const x of [...(old.sessions || []), ...meta.sessions].filter((y) => y.stack === col)) o.notes[x.link] = stackNotes(adapter, x.link);
  }
  out.sessions = [...(old.sessions || []).filter((x) => !keys.has(key(x))), ...meta.sessions];
  const stacks = [...new Set(sessions.map((x) => x.stack.stack))];
  out.merges = [...(old.merges || []), { at: meta.started, sessions: meta.sessions.map(({ stack, mode, link }) => ({ stack, mode, link })),
    reps: meta.reps, secs: meta.secs, settleMs: meta.settleMs, overrides: meta.overrides, label: meta.label,
    versions: Object.fromEntries(stacks.map((st) => [st, meta.versions[st]])) }];
  if (meta.reps !== old.reps || meta.secs !== old.secs) console.error(`[dm] merge: warning, ${meta.reps} reps of ${meta.secs} s phases against the run's ${old.reps} of ${old.secs} s`);
  return out;
}

function selftestReport(dir) {
  const recs = readFileSync(join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.metrics);
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const med = (a) => { const b = a.filter((v) => typeof v === 'number').sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
  const rows = [['drag', 'positionsPerS.avg', 'drag positions/s'], ['drag', 'inputToScreenMs.p50', 'drag input→screen p50 ms'],
    ['typing', 'keyToScreenMs.p50', 'key→screen p50 ms'], ['scroll', 'fps.avg', 'scroll frames/s'], ['scroll', 'latencyMs.p50', 'scroll draw→screen p50 ms'],
    ['wheel', 'wheelToScreenMs.p50', 'wheel→screen p50 ms'], ['region-640', 'fps.avg', 'region-640 frames/s'], ['region-640', 'latencyMs.p50', 'region-640 draw→screen p50 ms'],
    ['area-50', 'fps.avg', 'half-screen frames/s'], ['area-50', 'latencyMs.p50', 'half-screen draw→screen p50 ms'],
    ['drag', 'clientCores', 'drag viewer cores'], ['region-640', 'clientCores', 'region-640 viewer cores']];
  const stacks = [...new Set(recs.map((r) => r.stack))];
  let md = `# DesktopMark self-test: live quality gauge on vs off\n\nThe same walkthrough with the gauge (a 320x180 readback every 250 ms) on and off, medians over ${Math.max(...recs.map((r) => r.rep))} reps each. Off − on: the gauge's cost to each stack.\n\n`;
  md += `| metric | ${stacks.map((c) => `${c} on | off | Δ`).join(' | ')} |\n|---|${stacks.map(() => '---|---|---').join('|')}|\n`;
  for (const [sc, p, label] of rows) {
    md += `| ${label} | ${stacks.map((c) => {
      const v = (g) => med(recs.filter((r) => r.stack === c && r.scenario === sc && r.gauge === g).map((r) => get(r.metrics, p)));
      const on = v(true), off = v(false);
      return `${on ?? ''} | ${off ?? ''} | ${on != null && off != null ? Math.round((off - on) * 100) / 100 : ''}`;
    }).join(' | ')} |\n`;
  }
  return md;
}

async function doctor() {
  console.log(JSON.stringify({ host: HOST, versions: versions() }, null, 2));
  const modes = [parseMode(MODE)];
  const rows = [];
  for (const stack of STACKS.filter((s) => list('stacks', STACKS.map((t) => t.id).join(',')).includes(s.id))) {
    for (const mode of modes) {
      const logDir = join(OUT, `doctor-${STAMP}`, `${stack.id}-${mode.id}`);
      mkdirSync(logDir, { recursive: true });
      const row = { stack: stack.id, mode: mode.id };
      let s;
      try {
        s = await startSession(stack, 'matched', mode, 'lan', logDir);
        row.element = `${s.info.tag}${s.info.id ? '#' + s.info.id : ''} ${s.info.w}x${s.info.h}`;
        row.codecs = await s.page.evaluate(() => window.__dm.codecs());
        row.pageRaf = round(await s.page.evaluate(() => window.__dm.rafRate(2000)));
        const e = scenarioEnv(s);
        const r = await SCENARIOS['region-256'].run(e);
        row.region256 = { fps: r.fps, latencyMs: r.latencyMs, serverCores: r.serverCores, bandwidth: r.bandwidth };
        row.assertionFailures = checkAssertions(s);
      } catch (err) { row.error = String(err.message || err).slice(0, 300); }
      finally { if (s) await endSession(s); }
      row.logs = logDir;
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}

async function calibrate() {
  const modes = [parseMode(MODE)];
  const crfs = list('crfs', '8,11,14,17,20,23,26,29,32,35').map(Number);
  const reference = opt('reference', 'scroll');
  const result = { crf: {}, sweep: {}, at: new Date().toISOString(), reference, secs: SECS };
  for (const mode of modes) {
    const C = ceilingKbps(mode) / 1000, key = `${mode.w}x${mode.h}@${mode.fps}`;
    result.sweep[key] = [];
    for (const crf of crfs) {
      KASM_CRF[key] = crf;
      const logDir = join(OUT, `calibrate-${STAMP}`, `${key}-crf${crf}`);
      mkdirSync(logDir, { recursive: true });
      let s, p95 = null;
      try {
        s = await startSession(kasmWs, 'matched', mode, 'lan', logDir);
        await sleep(3000);
        const m = await SCENARIOS[reference].run(scenarioEnv(s));
        p95 = m.bandwidth?.p95_1sMbps ?? null;
      } catch (err) { console.error(`[dm] ${key} crf ${crf}: ${err.message}`); }
      finally { if (s) await endSession(s); }
      result.sweep[key].push({ crf, p95Mbps: p95, ceilingMbps: C });
      console.error(`[dm] ${key} crf ${crf}: p95 ${p95} Mbit/s (ceiling ${C})`);
    }
    const ok = result.sweep[key].filter((x) => x.p95Mbps != null && x.p95Mbps <= C).map((x) => x.crf);
    result.crf[key] = ok.length ? Math.min(...ok) : Math.max(...crfs);
  }
  writeFileSync(join(OUT, 'kasm-crf.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.crf, null, 2));
}

if (HOST.pin.pinned && !process.env.DM_PINNED && cmd !== 'report') {
  const r = spawnSync('taskset', ['-c', HOST.pin.harness, process.execPath, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, DM_PINNED: '1' } });
  process.exit(r.status ?? 1);
}
if (!HOST.avx2) console.error('[dm] warning: no AVX2; DesktopMark requires a CPU with AVX2 and at least 4 cores');
selfBase = 0;
if (cmd === 'preview') {
  const dir = join(OUT, `preview-${STAMP}`);
  mkdirSync(dir, { recursive: true });
  const f = await preview(dir, parseMode(MODE));
  console.error(f ? `[dm] preview: ${join(dir, f)}` : '[dm] preview failed, see the logs');
} else if (cmd === 'doctor') await doctor();
else if (cmd === 'calibrate') await calibrate();
else if (cmd === 'report') process.stdout.write(report(rest[0]));
else await run();
const left = await killAll();
if (left.length) console.error(`[dm] killed at exit: ${left.join(', ')}`);
process.exit(0);
