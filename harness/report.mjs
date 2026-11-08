import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { median, round } from './lib/metrics.mjs';
import { LINKS } from './lib/net.mjs';

export const noise = (best, d, rel = 0.01) => Math.max(10 ** -(d ?? 2), Math.abs(best) * rel) + 1e-9;
const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export const STACK_ORDER = ['selkies-ws', 'selkies-rtc', 'kasm-ws', 'neko-rtc', 'voxl-ws', 'kasm-ws-hybrid', 'kasm-rtc-hybrid'];

const CLEAN = (d = 'after stop') => [['ms to SSIM 0.98 ' + d, 'clean.msToSsim98', 0, 'lo'], ['SSIM after settling', 'clean.finalSsim', 4, 'hi'],
  ['PSNR dB after settling', 'clean.psnr', 1, 'hi']];
const ROWS = {
  drag: [['positions/s', 'positionsPerS.avg', 1, 'hi'], ['positions/s worst second', 'positionsPerS.worst', 0, 'hi'],
    ['input→screen p50 ms', 'inputToScreenMs.p50', 0, 'lo'], ['input→screen p99 ms', 'inputToScreenMs.p99', 0, 'lo'],
    ['moves shown / sent', 'movesShownRatio', 2, 'hi'],
    ['Mbit/s mean', 'bandwidth.meanMbps', 2, 'lo'], ['Mbit/s peak 100 ms', 'bandwidth.peak100msMbps', 1, 'lo'],
    ['server cores', 'serverCores', 2, 'lo'], ['client cores', 'clientCores', 2, 'lo'], ['share of the screen the drag passed over', 'coverage', 2], ...CLEAN()],
  switch: [['Mbit/s mean', 'bandwidth.meanMbps', 2, 'lo'], ['Mbit/s peak 100 ms', 'bandwidth.peak100msMbps', 1, 'lo'],
    ['server cores', 'serverCores', 2, 'lo'], ['client cores', 'clientCores', 2, 'lo'], ...CLEAN('after the last switch')],
  region: [['frames/s', 'fps.avg', 1, 'hi'], ['frames/s worst second', 'fps.worst', 0, 'hi'],
    ['draw→screen p50 ms', 'latencyMs.p50', 0, 'lo'], ['draw→screen p99 ms', 'latencyMs.p99', 0, 'lo'],
    ['Mbit/s mean', 'bandwidth.meanMbps', 2, 'lo'], ['Mbit/s peak 100 ms', 'bandwidth.peak100msMbps', 1, 'lo'],
    ['server cores', 'serverCores', 2, 'lo'], ['client cores', 'clientCores', 2, 'lo']],
  typing: [['key→screen p50 ms', 'keyToScreenMs.p50', 0, 'lo'], ['key→screen p99 ms', 'keyToScreenMs.p99', 0, 'lo'],
    ['keys shown / sent', 'keysShownRatio', 2, 'hi'], ['Mbit/s mean', 'bandwidth.meanMbps', 2, 'lo'], ['server cores', 'serverCores', 2, 'lo']],
  wheel: [['wheel→screen p50 ms', 'wheelToScreenMs.p50', 0, 'lo'], ['wheel→screen p99 ms', 'wheelToScreenMs.p99', 0, 'lo'],
    ['wheels not shown before the next', 'wheelsMissed', 0, 'lo'],
    ['Mbit/s mean', 'bandwidth.meanMbps', 2, 'lo'], ['server cores', 'serverCores', 2, 'lo'], ...CLEAN()],
  idle: [['still, cleanup included: Mbit/s', 'still.bandwidth.meanMbps', 3, 'lo'], ['still, cleanup included: server cores', 'still.serverCores', 2, 'lo'],
    ['caret Mbit/s', 'caret.bandwidth.meanMbps', 3, 'lo'], ['caret server cores', 'caret.serverCores', 2, 'lo']],
  fidelity: [['top bar (colour reference) SSIM', 'topbar.ssim', 4, 'hi'], ['top bar (colour reference) PSNR dB', 'topbar.psnr', 1, 'hi'],
    ['taskbar text SSIM', 'taskbar.ssim', 4, 'hi'], ['taskbar text PSNR dB', 'taskbar.psnr', 1, 'hi'],
    ['wallpaper SSIM', 'wallpaper.ssim', 4, 'hi'], ['wallpaper PSNR dB', 'wallpaper.psnr', 1, 'hi'],
    ['chart SSIM', 'chart.ssim', 4, 'hi'], ['chart PSNR dB', 'chart.psnr', 1, 'hi'],
    ['text SSIM', 'text.ssim', 4, 'hi'], ['text PSNR dB', 'text.psnr', 1, 'hi']],
};
ROWS.scroll = [...ROWS.region, ...CLEAN()];
ROWS['scroll-narrow'] = ROWS.scroll;
ROWS['scroll-medium'] = ROWS.scroll;
ROWS.animated = [...ROWS.region, ['still text SSIM meanwhile', 'offArea.ssim', 4, 'hi'], ['still text PSNR dB meanwhile', 'offArea.psnr', 1, 'hi']];
const rowsFor = (sc) => ROWS[sc] || ROWS[{ 'region-256': 'animated', 'region-640': 'animated', 'area-12': 'animated', 'area-25': 'animated',
  'area-50': 'animated', 'area-100': 'region' }[sc]] || [];

const SCALING = [['region-256', '256²'], ['region-640', '640×360'], ['area-12', '1/8'], ['area-25', '1/4'], ['area-50', '1/2'], ['area-100', 'full']];
const SCALING_METRICS = [['fps', 'Frames shown per second', 'fps.avg', 'hi'], ['lat', 'Draw→screen p50, ms', 'latencyMs.p50', 'lo'],
  ['bw', 'Bandwidth, Mbit/s', 'bandwidth.meanMbps', 'lo'], ['srv', 'Server cores', 'serverCores', 'lo'], ['cli', 'Viewer cores', 'clientCores', 'lo'],
  ['still', 'Still text meanwhile, PSNR dB', 'offArea.psnr', 'hi']];

const BW = 'bandwidth.meanMbps';
export const GROUPS = {
  Responsiveness: 'How long input or a change on the desktop takes to reach the viewer’s screen. Under each value: the bandwidth that phase used.',
  Smoothness: 'How many distinct frames or positions the viewer showed per second while things move; 60 is every frame. Under each value: the bandwidth that phase used.',
  Sharpness: 'How close the viewer’s picture is to the X server’s own pixels, and how soon it gets there after motion stops.',
  Cost: 'What the motion and the stillness cost in bandwidth and CPU. See also the cost of the whole session above.',
};
const HEADLINE = [
  ['Responsiveness', 'Window drag: input→screen p50 ms', 'drag', 'inputToScreenMs.p50', 0, 'lo', BW],
  ['Responsiveness', 'Typing: key→screen p50 ms', 'typing', 'keyToScreenMs.p50', 0, 'lo', BW],
  ['Responsiveness', 'Wheel scroll: wheel→screen p50 ms', 'wheel', 'wheelToScreenMs.p50', 0, 'lo', BW],
  ['Responsiveness', 'Scroll, 680 px column: draw→screen p50 ms', 'scroll-narrow', 'latencyMs.p50', 0, 'lo', BW],
  ['Responsiveness', 'Scroll, full width: draw→screen p50 ms', 'scroll', 'latencyMs.p50', 0, 'lo', BW],
  ['Responsiveness', 'Video-sized region: draw→screen p50 ms', 'region-640', 'latencyMs.p50', 0, 'lo', BW],
  ['Smoothness', 'Window drag: positions/s', 'drag', 'positionsPerS.avg', 1, 'hi', BW],
  ['Smoothness', 'Scroll, 680 px column: frames/s', 'scroll-narrow', 'fps.avg', 1, 'hi', BW],
  ['Smoothness', 'Scroll, full width: frames/s', 'scroll', 'fps.avg', 1, 'hi', BW],
  ['Smoothness', 'Video-sized region: frames/s', 'region-640', 'fps.avg', 1, 'hi', BW],
  ['Smoothness', 'Half the screen animating: frames/s', 'area-50', 'fps.avg', 1, 'hi', BW],
  ['Smoothness', 'Whole screen animating: frames/s', 'area-100', 'fps.avg', 1, 'hi', BW],
  ['Sharpness', 'Window drag: ms until the wallpaper it passed over is sharp again', 'drag', 'clean.msToSsim98', 0, 'lo'],
  ['Sharpness', 'Scroll, full width: ms to sharp after stopping', 'scroll', 'clean.msToSsim98', 0, 'lo'],
  ['Sharpness', 'Window switching: ms until the wallpaper is sharp again', 'switch', 'clean.msToSsim98', 0, 'lo'],
  ['Sharpness', 'Still text while half the screen animates: PSNR dB', 'area-50', 'offArea.psnr', 1, 'hi'],
  ['Sharpness', 'Still: text SSIM', 'fidelity', 'text.ssim', 4, 'hi'],
  ['Sharpness', 'Still: top bar (colour reference) PSNR dB', 'fidelity', 'topbar.psnr', 1, 'hi'],
  ['Sharpness', 'Still: taskbar text SSIM', 'fidelity', 'taskbar.ssim', 4, 'hi'],
  ['Sharpness', 'Still: wallpaper PSNR dB', 'fidelity', 'wallpaper.psnr', 1, 'hi'],
  ['Cost', 'Scroll, full width: Mbit/s', 'scroll', 'bandwidth.meanMbps', 1, 'lo'],
  ['Cost', 'Window switching: Mbit/s peak 100 ms', 'switch', 'bandwidth.peak100msMbps', 1, 'lo'],
  ['Cost', 'Idle desktop, cleanup included: Mbit/s', 'idle', 'still.bandwidth.meanMbps', 2, 'lo'],
  ['Cost', 'Window drag: server cores', 'drag', 'serverCores', 2, 'lo'],
  ['Cost', 'Window drag: viewer cores', 'drag', 'clientCores', 2, 'lo'],
  ['Cost', 'Idle desktop, cleanup included: server cores', 'idle', 'still.serverCores', 2, 'lo'],
];

const COST = [
  ['Data sent to the viewer over the session, MB', (t) => (t.samples.at(-1)[1] - t.samples[0][1]) / 1e6, 1, 'lo'],
  ['Average bandwidth over the session, Mbit/s', (t) => (t.samples.at(-1)[1] - t.samples[0][1]) * 8 / ((t.samples.at(-1)[0] - t.samples[0][0]) / 1000) / 1e6, 2, 'lo'],
  ['Busiest second, Mbit/s', (t) => { let m = 0; const S = t.samples; for (let i = 0, j = 0; i < S.length; i++) { while (S[i][0] - S[j][0] > 1000) j++; if (S[i][0] - S[j][0] >= 750) m = Math.max(m, (S[i][1] - S[j][1]) * 8 / ((S[i][0] - S[j][0]) / 1000) / 1e6); } return m; }, 1, 'lo'],
  ['Server CPU over the session, core-seconds', (t) => (t.samples.at(-1)[3] - t.samples[0][3]) / 100, 1, 'lo'],
  ['Viewer CPU over the session, core-seconds', (t) => (t.samples.at(-1)[4] - t.samples[0][4]) / 100, 1, 'lo'],
  ['Session length, s', (t) => (t.samples.at(-1)[0] - t.samples[0][0]) / 1000, 1],
];

const TRADEOFF = [['drag', 'Window drag', 'positionsPerS.avg', 'positions/s', 'inputToScreenMs.p50'], ['scroll-narrow', 'Scroll, 680 px column', 'fps.avg', 'frames/s', 'latencyMs.p50'],
  ['scroll-medium', 'Scroll, 1280 px column', 'fps.avg', 'frames/s', 'latencyMs.p50'], ['scroll', 'Scroll, full width', 'fps.avg', 'frames/s', 'latencyMs.p50'],
  ['region-640', 'Video-sized region', 'fps.avg', 'frames/s', 'latencyMs.p50'], ['area-50', 'Half the screen animating', 'fps.avg', 'frames/s', 'latencyMs.p50'],
  ['area-100', 'Whole screen animating', 'fps.avg', 'frames/s', 'latencyMs.p50']];

const LAT = 'p50 is the median: half the samples were faster, half slower.';
export const ABOUT = {
  'Data sent to the viewer over the session, MB': 'Everything the stack sent to the viewer over the whole walkthrough, from the first phase to the last, in megabytes. It is the plainest measure of cost: the same desktop, the same input, the same length of session for every stack.',
  'Average bandwidth over the session, Mbit/s': 'The data above spread over the length of the session. On a metered or shared connection this is what the stack costs on average.',
  'Busiest second, Mbit/s': 'The most data sent in any one second of the session: the burst a connection has to carry without the picture stalling.',
  'Server CPU over the session, core-seconds': 'CPU time the stack (its server and its X server) used over the whole session: 10 core-seconds is one core fully busy for 10 seconds. This is what serving one desktop costs the host.',
  'Viewer CPU over the session, core-seconds': 'CPU time the browser showing the stream used over the whole session: the cost on the viewer’s machine of decoding and drawing.',
  'Session length, s': 'How long the measured walkthrough took. Every stack runs the same phases for the same time, so this is nearly equal; it differs only by how long each stack’s stream takes to settle and to respond.',
  'Window drag: positions/s': 'A text window is dragged by its title bar along a fixed path over most of the screen, at 900 px/s, with one pointer move every 1/60 s sent through the stack\'s web client. This counts how many different positions of the window the viewer actually showed per second. 60 would be every move; lower means the window jumps rather than glides.',
  'Window drag: input→screen p50 ms': `For each pointer move during the drag, the time from the harness sending it to the viewer showing the window at that position. This is how far the window lags behind your hand. ${LAT}`,
  'Window drag: ms until the wallpaper it passed over is sharp again': 'After the dragged window is let go, the wallpaper it kept passing over has to be redrawn. The patch is compared with the X server\'s own pixels as fast as the viewer can be read, and this is the time until it reaches SSIM 0.98 and stays there. Blank means it never got there within the 2 s settle: the stack left it softer than that.',
  'Typing: key→screen p50 ms': `Keys are typed through the client into an editor, 8 a second. The editor stamps each key press into a marker on screen; this is the time from sending a key to the viewer showing that key's marker. ${LAT}`,
  'Scroll, 680 px column: frames/s': 'A near-full-screen browser page scrolls itself one step every frame, with its text in a narrow centred column (680 px, as most websites lay text out). Each frame carries a counter, and this counts how many distinct frames the viewer showed per second. 60 is every frame.',
  'Scroll, 680 px column: draw→screen p50 ms': `Each frame of the scrolling page carries the time it was drawn. This is the time from the page drawing a frame on the desktop to the viewer showing it. ${LAT}`,
  'Scroll, full width: frames/s': 'The same scrolling page with its text across the full width: the most of the screen changing every frame. Distinct frames the viewer showed per second; 60 is every frame.',
  'Scroll, full width: draw→screen p50 ms': `Time from the page drawing a frame to the viewer showing it, while the full-width page scrolls. ${LAT}`,
  'Scroll, full width: Mbit/s': 'The average bandwidth from the stack to the viewer while the full-width page scrolls, measured on the network interface. Lower is cheaper for the same motion; read it with the frames/s and quality rows, since sending fewer or blurrier frames also costs less.',
  'Scroll, full width: ms to sharp after stopping': 'When the scrolling stops, how long until the centre of the page is back to SSIM 0.98 against the X server\'s own pixels and stays there. This is the wait before you can read what you scrolled to. Blank means it never got there within 2 s.',
  'Window switching: Mbit/s peak 100 ms': 'Windows are brought to the front, maximised and restored, and the big browser restored over everything and minimised again, one action every 0.4 s, the way a taskbar does it. Each action repaints a large part of the screen at once. This is the most data sent in any 100 ms: how big the burst is that the network has to carry.',
  'Window switching: ms until the wallpaper is sharp again': 'After the last window switch, how long until the wallpaper that was covered and uncovered is back to SSIM 0.98 against the X server and stays there. Blank means it never got there within 2 s.',
  'Wheel scroll: wheel→screen p50 ms': `Mouse-wheel steps are sent through the client into a long document, 6 a second. This is the time from each wheel step to the viewer showing the document moved. ${LAT}`,
  'Video-sized region: frames/s': 'A 640×360 animation, the size of an embedded video, plays on an otherwise still desktop. Distinct animation frames the viewer showed per second; 60 is every frame.',
  'Video-sized region: draw→screen p50 ms': `Time from the animation drawing a frame to the viewer showing it. ${LAT}`,
  'Half the screen animating: frames/s': 'The same animation covering the bottom half of the screen. Distinct frames shown per second; 60 is every frame. Watch how it holds up as more of the screen moves.',
  'Whole screen animating: frames/s': 'The animation covering the whole work area between the two bars: everything changes every frame. Distinct frames shown per second; 60 is every frame.',
  'Still text while half the screen animates: PSNR dB': 'While the bottom half of the screen animates, a text window that is not touched is compared with the X server\'s own pixels. PSNR in decibels: higher is closer, and a few dB is a visible difference. A stack that only sends what changed keeps this as sharp as when idle; one that spreads its bits over the whole screen lets the still text blur.',
  'Still: text SSIM': 'At the end of the idle period, the text window compared with the X server\'s own pixels. SSIM is 1 for identical; for sharp text, 0.99 and above is hard to tell apart and 0.95 is visibly soft.',
  'Still: top bar (colour reference) PSNR dB': 'At the end of the idle period, the top bar (colour bars, a grey ramp, 1 px lines and coloured text on coloured backgrounds) compared with the X server\'s own pixels. Coloured detail is what 4:2:0 colour loses first, so every stack scores lower here than on plain text; the differences between stacks are what matter.',
  'Still: taskbar text SSIM': 'At the end of the idle period, the taskbar (small light text on dark buttons, in columns) compared with the X server\'s own pixels. SSIM is 1 for identical.',
  'Still: wallpaper PSNR dB': 'At the end of the idle period, a patch of the wallpaper (fine lines, checkers, rings, gradients and text, built to be hard to encode) compared with the X server\'s own pixels. Higher is closer to the real desktop.',
  'Idle desktop, cleanup included: Mbit/s': 'Bandwidth over the seconds after the last change on the desktop (a blinking caret just stopped), while nothing on screen changes. That is not necessarily nothing to send: a stack may still be sharpening what it sent earlier (paint-over, cleanup), which is useful work and is counted here. A short burst that dies away is that; traffic that never stops, such as a full keyframe every second, is a cost with no gain.',
  'Idle desktop, cleanup included: server cores': 'CPU used by the stack (its server and its X server) over the same seconds, in cores: 1.00 is one CPU core fully busy. Finishing a cleanup costs a little; a stack that keeps encoding a screen that does not change costs it all the time.',
  'Window drag: server cores': 'CPU used by the stack (its server and its X server) during the window drag, in cores: 1.00 is one core fully busy. Read it with the drag\'s positions/s, since showing fewer positions also costs less.',
  'Window drag: viewer cores': 'CPU used by the browser showing the stream during the window drag, in cores: 1.00 is one core fully busy. This is the cost on the viewer\'s machine: decoding and drawing.',
};

const QUALITY = [['Wallpaper, after the drag', 'drag', 'clean'], ['Wallpaper, after switching', 'switch', 'clean'],
  ['680 px column, stopped', 'scroll-narrow', 'clean'], ['Full-width page, stopped', 'scroll', 'clean'],
  ['Wheel scroll, stopped', 'wheel', 'clean'], ['Still text, ½ screen animating', 'area-50', 'offArea'],
  ['Text, after idling', 'fidelity', 'text'], ['Top bar, after idling', 'fidelity', 'topbar'], ['Taskbar, after idling', 'fidelity', 'taskbar'],
  ['Wallpaper, after idling', 'fidelity', 'wallpaper'], ['Colour chart, after idling', 'fidelity', 'chart']];

const SHOTS = [
  ['Wallpaper after the drag', 'The wallpaper, two seconds after the window that kept passing over it is let go.', 'drag', 'clean'],
  ['Wallpaper after switching', 'The wallpaper, two seconds after the last window switch: windows maximised over it, the big browser restored over it and minimised again.', 'switch', 'clean'],
  ['680 px column, stopped', 'The centre of the page, two seconds after a narrow-column scroll stops.', 'scroll-narrow', 'clean'],
  ['1280 px column, stopped', 'The centre of the page, two seconds after a 1280 px column scroll stops.', 'scroll-medium', 'clean'],
  ['Full width, stopped', 'The centre of the page, two seconds after a full-width scroll stops.', 'scroll', 'clean'],
  ['Full width, in motion', 'The same page mid-scroll: how much detail survives motion. Not scored.', 'scroll', 'motionShot'],
  ['Wheel scroll, then stop', 'The document two seconds after the last wheel tick.', 'wheel', 'clean'],
  ['Still text, video-sized region animating', 'The text window, untouched, while a 640×360 region elsewhere animates.', 'region-640', 'offArea'],
  ['Still text, 1/4 of the screen animating', 'The text window, untouched, while the bottom-left quarter of the screen animates.', 'area-25', 'offArea'],
  ['Still text, 1/2 of the screen animating', 'The text window, untouched, while the bottom half of the screen animates.', 'area-50', 'offArea'],
  ['Text, after idling', 'The text window at the end of the idle period.', 'fidelity', 'text'],
  ['Top bar, after idling', 'The top bar: colour bars, a grey ramp, 1 px lines and coloured text, at the end of the idle period.', 'fidelity', 'topbar'],
  ['Taskbar, after idling', 'The taskbar: small text in columns, at the end of the idle period.', 'fidelity', 'taskbar'],
  ['Wallpaper, after idling', 'The wallpaper patch at the end of the idle period.', 'fidelity', 'wallpaper'],
  ['Colour chart, after idling', 'Colour bars, a grey ramp, 1 px lines and coloured text at the end of the idle period.', 'fidelity', 'chart'],
];

function load(dir) {
  const path = join(dir, 'results.jsonl');
  if (!existsSync(path)) return null;
  const recs = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let meta = {};
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch {}
  return { recs, meta };
}

function model({ recs, meta }) {
  const key = (r) => `${r.stack}|${r.config}|${r.mode}|${r.link}|${r.rep}`;
  const invalid = new Set(recs.filter((r) => r.invalid).map(key));
  const data = recs.filter((r) => r.scenario && r.metrics && !r.failed && !invalid.has(key(r)));
  const fails = recs.filter((r) => r.scenario && r.failed);
  for (const r of data) {
    if (r.scenario === 'typing' && r.metrics.keysSent) r.metrics.keysShownRatio = r.metrics.keysShown / r.metrics.keysSent;
    if (r.metrics.movesSent) r.metrics.movesShownRatio = r.metrics.movesMatched / r.metrics.movesSent;
  }
  const groups = new Map();
  for (const r of [...data, ...fails, ...recs.filter((r) => r.timeline && !invalid.has(key(r)))]) {
    const k = `${r.tier}|${r.mode}|${r.link}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const sections = [];
  const linkOrder = (k) => { const l = k.split('|')[2]; return l === 'lan' ? 0 : l === 'wan' ? 1 : 2; };
  for (const [k, rs] of [...groups].sort(([a], [b]) => a.split('|')[0].localeCompare(b.split('|')[0]) || a.split('|')[1].localeCompare(b.split('|')[1]) || linkOrder(a) - linkOrder(b) || a.localeCompare(b))) {
    const [tier, mode, link] = k.split('|');
    const cols = STACK_ORDER.filter((s) => rs.some((r) => r.stack === s && (r.scenario || r.timeline)));
    const reps = Math.max(1, ...rs.map((r) => r.rep));
    const scens = new Set(rs.filter((r) => r.scenario).map((r) => r.scenario));
    const cell = (sc, stack, p, d) => {
      const vals = rs.filter((r) => r.scenario === sc && r.stack === stack && r.metrics && !r.failed).map((r) => get(r.metrics, p)).filter((v) => typeof v === 'number');
      const failed = rs.filter((r) => r.scenario === sc && r.stack === stack && r.failed).length;
      if (!vals.length) return { v: null, text: failed ? `FAIL (${failed}/${failed})` : '', fail: !!failed };
      const m = round(median(vals), d);
      const note = failed ? ` (${failed} failed)` : vals.length < reps ? ` (n=${vals.length})` : '';
      return { v: m, text: `${m}${note}` };
    };
    const mark = (cells, better, d, rel) => {
      const nums = cells.map((c) => c.v).filter((v) => v != null);
      if (better && cells.length > 1 && nums.length) {
        const best = better === 'hi' ? Math.max(...nums) : Math.min(...nums);
        for (const c of cells) if (c.v != null && Math.abs(c.v - best) <= noise(best, d, rel)) c.best = true;
      }
    };
    const row = (label, sc, p, d, better, sub) => {
      const cells = cols.map((c) => ({ ...cell(sc, c, p, d), ...(sub && { sub: cell(sc, c, sub, 1).v }) })), rel = /ssim/i.test(p) ? 0 : 0.01;
      mark(cells, better, d, rel);
      return { label, scenario: sc, cells, better, d, rel };
    };
    const headline = HEADLINE.filter(([, , sc]) => scens.has(sc)).map(([g, l, sc, p, d, b, sub]) => ({ ...row(l, sc, p, d, b, sub), group: g, about: ABOUT[l] }))
      .filter((r) => r.cells.some((c) => c.text));
    const tls = (c) => rs.filter((r) => r.stack === c && r.timeline && r.timeline.samples.length > 1).map((r) => r.timeline);
    const cost = COST.map(([label, f, d, better]) => {
      const cells = cols.map((c) => { const v = tls(c).map(f).filter((x) => Number.isFinite(x)); return v.length ? { v: round(median(v), d), text: String(round(median(v), d)) } : { v: null, text: '' }; });
      mark(cells, better, d, 0.01);
      return { label, scenario: 'session', cells, better, d, rel: 0.01, about: ABOUT[label] };
    }).filter((r) => r.cells.some((c) => c.text));
    const med = (sc, c, p) => cell(sc, c, p, 2).v;
    const tradeoff = TRADEOFF.filter(([sc]) => scens.has(sc)).map(([sc, title, sp, sl, lp]) => ({ sc, title, speedLabel: sl,
      pts: Object.fromEntries(cols.map((c) => [c, { mbps: med(sc, c, 'bandwidth.meanMbps'), speed: med(sc, c, sp), lat: med(sc, c, lp) }]).filter(([, v]) => v.mbps != null && v.speed != null)) }))
      .filter((t) => Object.keys(t.pts).length);
    const all = [...scens].sort().flatMap((sc) => rowsFor(sc).map(([l, p, d, b]) => row(l, sc, p, d, b)));
    const first = (stack, pred) => rs.filter((r) => r.stack === stack && pred(r)).sort((a, b) => a.rep - b.rep)[0];
    const timelines = {}, shots = {}, curves = {};
    for (const c of cols) {
      const t = first(c, (r) => r.timeline);
      if (t) timelines[c] = t.timeline;
      for (const [, , sc, p] of SHOTS) {
        const r = first(c, (r) => r.scenario === sc && r.metrics && get(r.metrics, p));
        if (!r) continue;
        const o = get(r.metrics, p), shot = o.shot || (o.file ? o : null);
        if (shot) (shots[`${sc}.${p}`] ??= {})[c] = { ...shot, ssim: o.ssim, psnr: o.psnr, ms: o.msToSsim98 };
        if (o.curve) (curves[sc] ??= {})[c] = o.curve;
      }
    }
    const quality = QUALITY.filter(([, sc]) => scens.has(sc)).map(([label, sc, p]) => ({ label, values: Object.fromEntries(cols.map((c) => {
      const rr = rs.filter((r) => r.scenario === sc && r.stack === c && r.metrics && !r.failed).map((r) => get(r.metrics, p)).filter(Boolean);
      const med = (k) => { const v = rr.map((o) => o[k]).filter((x) => typeof x === 'number'); return v.length ? median(v) : null; };
      return [c, { ssim: med('ssim'), psnr: med('psnr') }];
    })) })).filter((q) => Object.values(q.values).some((v) => v.ssim != null));
    const cats = SCALING.filter(([sc]) => scens.has(sc));
    const scaling = cats.length > 1 ? { cats: cats.map(([, l]) => l), metrics: SCALING_METRICS.map(([key, title, p, better]) => ({ key, title, better,
      values: Object.fromEntries(cols.map((c) => [c, cats.map(([sc]) => { const v = cell(sc, c, p, 3).v; return v; })])) })) } : null;
    sections.push({ tier, mode, link, linkLabel: LINKS[link]?.label || link, fps: +mode.split('@')[1], cols, reps, headline, cost, tradeoff, groups: GROUPS, all, timelines, shots, curves, quality, scaling });
  }
  const problems = [];
  for (const r of recs.filter((r) => r.invalid)) problems.push(`invalid session ${r.stack} ${r.mode} ${r.link} rep ${r.rep}: ${r.invalid.join(', ')} not confirmed`);
  for (const r of recs.filter((r) => r.sessionError)) problems.push(`session error ${r.stack} ${r.mode} ${r.link} rep ${r.rep}: ${r.sessionError}`);
  for (const r of recs.filter((r) => r.error)) problems.push(`${r.scenario} on ${r.stack} ${r.mode} ${r.link} rep ${r.rep}: ${r.error}`);
  return { meta, sections, problems, config: configuration(meta, recs) };
}

function configuration(meta, recs) {
  const cfg = meta.config || {};
  return STACK_ORDER.filter((c) => cfg[c]).map((c) => {
    const launches = {};
    for (const r of recs.filter((r) => r.launch && r.stack === c).sort((a, b) => a.rep - b.rep)) launches[r.link] ||= r.launch;
    const v = (meta.versions || {})[cfg[c].stack];
    const vv = typeof v === 'string' ? { version: v } : { ...(v || {}) };
    if (/Unrecognized option/.test(vv.xserver || '')) delete vv.xserver;
    return { col: c, stack: cfg[c].stack, versions: vv, modes: cfg[c].modes, notes: cfg[c].notes || {}, launches };
  });
}
export const settingsAt = (c, mode, link) => { const m = c.modes[mode] || Object.values(c.modes)[0] || []; return Array.isArray(m) ? m : m[link] || Object.values(m)[0] || []; };
export const sectionFlags = (config, sec, meta = {}) => config.filter((c) => sec.cols.includes(c.col)).map((c) => ({ col: c.col,
  hand: settingsAt(c, sec.mode, sec.link).filter((x) => x.linkSet === sec.link), notes: (c.notes || {})[sec.link] || [],
  merged: mergeOf(meta, c.col, sec.mode, sec.link) })).filter((f) => f.hand.length || f.notes.length || f.merged);
export function mergeOf(meta, col, mode, link) {
  const m = [...(meta.merges || [])].reverse().find((x) => x.sessions.some((y) => y.stack === col && y.mode === mode && y.link === link));
  if (!m) return null;
  const stack = (meta.config?.[col] || {}).stack, a = (m.versions || {})[stack], b = (meta.versions || {})[stack];
  return { at: m.at, reps: m.reps, secs: m.secs, label: m.label, binaryDiffers: !!(a && b && typeof b === 'object' && a.sha256 !== b.sha256), overrides: overrideList(m.overrides) };
}
const when = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
export const mergeText = (g, meta) => `measured separately on ${when(g.at)} and merged into this run` +
  `${g.reps !== meta.reps || g.secs !== meta.secs ? ` (${g.reps} rep${g.reps > 1 ? 's' : ''} of ${g.secs} s phases)` : ''}${g.binaryDiffers ? '; a different binary from the rest of the run' : ''}${g.overrides.length ? `; with ${g.overrides.join(', ')}` : ''}${g.label ? ` (${g.label})` : ''}.`;
const overrideList = (o = {}) => Object.entries(o).flatMap(([t, m]) => Object.entries(m).map(([k, v]) => `set.${t}.${k}=${v ?? 'unset'}`));

function markdown(m) {
  let md = '# DesktopMark results\n\nEach cell: median over reps (n shown when fewer than all reps produced a value).\n\n';
  for (const s of m.sections) {
    md += `## ${s.linkLabel} · ${s.mode}\n\n`;
    for (const f of sectionFlags(m.config, s, m.meta)) md += `> **⚑ ${f.col}:** ${[...(f.merged ? [mergeText(f.merged, m.meta).replace(/^./, (c) => c.toUpperCase())] : []), ...f.hand.map((x) => `\`${x.key}\` hand-set to \`${x.value}\` on this link (elsewhere \`${x.linkBase}\`).`), ...f.notes.filter((n) => n.kind === 'defect').map((n) => `Defect: ${n.text.split('. ')[0]}.`)].join(' ')}\n\n`;
    if (s.fps > 60) md += `The viewer (Chromium, no GPU) presents at most 60 frames/s for every stack, so frames/positions shown cap at 60 here; latency, CPU and bandwidth reflect the ${s.fps} fps source.\n\n`;
    const head = `|---|${s.cols.map(() => '---').join('|')}|\n`;
    if (s.cost.length) {
      md += `**Cost of the session**\n\n| | ${s.cols.join(' | ')} |\n${head}`;
      for (const r of s.cost) md += `| ${r.label} | ${r.cells.map((c) => c.text).join(' | ')} |\n`;
      md += '\n';
    }
    if (s.headline.length) {
      md += `| | ${s.cols.join(' | ')} |\n${head}`;
      let g = null;
      for (const r of s.headline) {
        if (r.group !== g) { g = r.group; md += `| **${g}** |${s.cols.map(() => ' |').join('')}\n`; }
        md += `| ${r.label} | ${r.cells.map((c) => c.text + (c.sub != null && c.text ? ` (${c.sub} Mbit/s)` : '')).join(' | ')} |\n`;
      }
      md += '\n<details><summary>All metrics</summary>\n\n';
    }
    md += `| scenario | metric | ${s.cols.join(' | ')} |\n|---|${head}`;
    for (const r of s.all) md += `| ${r.scenario} | ${r.label} | ${r.cells.map((c) => c.text).join(' | ')} |\n`;
    if (s.headline.length) md += '\n</details>\n';
    md += '\n';
  }
  md += configMarkdown(m);
  if (m.problems.length) md += '## Problems\n\n' + m.problems.map((p) => `- ${p}\n`).join('');
  return md;
}

function configMarkdown(m) {
  if (!m.config.length) return '';
  const ov = overrideList(m.meta.overrides);
  let md = '## Configuration under test\n\nEvery setting the harness gives each stack (harness/settings/<stack>.json), its shipped value where known and why. ' +
    'To propose a change, give the override: `set.<stack>.<key>=<value>` (see https://desktopmark.selkies.io/settings/); a retest of the same binary needs no code change.\n\n';
  md += ov.length ? `**This run overrides:** ${ov.map((x) => `\`${x}\``).join(', ')}\n\n` : 'This run uses the settings files as they are (no overrides).\n\n';
  const cell = (x) => String(x ?? '').replace(/\|/g, '\\|');
  for (const c of m.config) {
    const v = c.versions;
    md += `### ${c.col}: ${v.version || c.stack}\n\n`;
    md += [['source', v.source], ['binary', v.binary && `${v.binary} sha256 ${v.sha256 || '?'}`], ['X server', v.xserver], ['x264', v.x264]]
      .filter(([, x]) => x).map(([k, x]) => `- ${k}: \`${x}\`\n`).join('') + '\n';
    const notes = [...new Map(Object.values(c.notes || {}).flat().map((n) => [n.text, n])).values()];
    for (const n of notes) md += `> **${n.kind === 'defect' ? 'Defect' : 'Note'}${n.links ? ` (${n.links.join(', ')})` : ''}:** ${n.text}\n\n`;
    const runs = Object.entries(c.modes).flatMap(([mode, m]) => Array.isArray(m) ? [[mode, m]] : Object.entries(m).map(([link, l]) => [`${mode} · ${link}`, l]));
    for (const [mode, list] of runs) {
      md += `${mode}:\n\n| setting | value | ${c.stack} ships | why |\n|---|---|---|---|\n`;
      for (const s of list.filter((s) => s.role !== 'harness'))
        md += `| ${s.group}: \`${cell(s.key)}\` | \`${cell(s.value ?? 'unset')}\`${s.linkSet ? ` (**hand-set for ${s.linkSet}**; elsewhere \`${cell(s.linkBase)}\`)` : ''}${s.overridden ? ` (overridden; file: \`${cell(s.base ?? 'none')}\`)` : ''} | ${cell(s.ships)} | ${cell(s.why)}${s.linkSet && s.linkWhy ? ` On ${s.linkSet}: ${cell(s.linkWhy)}` : ''} |\n`;
      md += `\n<details><summary>harness settings</summary>\n\n${list.filter((s) => s.role === 'harness').map((s) => `- ${s.group}: \`${s.key}=${s.value ?? 'unset'}\` ${s.why}`).join('\n')}\n\n</details>\n\n`;
    }
    for (const [link, l] of Object.entries(c.launches || {})) md += `<details><summary>launched (${link})</summary>\n\n\`\`\`\n${launchText(l)}\n\`\`\`\n\n</details>\n\n`;
  }
  return md;
}
export function launchText(l) {
  const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return [...l.procs.map((p) => [...Object.entries(p.env || {}).map(([k, v]) => `${k}=${q(String(v))}`), ...p.argv.map(q)].join(' \\\n  ')), `viewer: ${l.url}`].join('\n\n');
}

function readOwnPNG(path) {
  const b = readFileSync(path);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), idat = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  return { w, h, raw: inflateSync(Buffer.concat(idat)) };
}
function detailPatch(path, pw, ph) {
  try {
    const { w, h, raw } = readOwnPNG(path), stride = w * 3 + 1;
    const Y = (x, y) => { const i = y * stride + 1 + x * 3; return 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]; };
    let best = { x: 0, y: 0, v: -1 };
    for (let y = 0; y + ph <= h; y += 16) for (let x = 0; x + pw <= w; x += 16) {
      if (x < 176 && y < 80) continue;
      let s = 0, s2 = 0, n = 0;
      for (let yy = y; yy < y + ph; yy += 3) for (let xx = x; xx < x + pw; xx += 3) { const v = Y(xx, yy); s += v; s2 += v * v; n++; }
      const v = s2 / n - (s / n) ** 2;
      if (v > best.v) best = { x, y, v };
    }
    return { x: best.x, y: best.y, w: pw, h: ph };
  } catch { return { x: 0, y: 0, w: pw, h: ph }; }
}

function html(m, dir) {
  for (const s of m.sections) for (const byStack of Object.values(s.shots))
    for (const v of Object.values(byStack)) v.patch = detailPatch(join(dir, v.xfile), Math.min(120, v.w), Math.min(68, v.h));
  const data = { meta: { host: m.meta.host, versions: m.meta.versions, reps: m.meta.reps, secs: m.meta.secs, started: m.meta.started, label: m.meta.label },
    config: m.config.map((c) => ({ ...c, launchText: Object.fromEntries(Object.entries(c.launches || {}).map(([k, l]) => [k, launchText(l)])), launches: undefined })), overrides: overrideList(m.meta.overrides),
    sections: m.sections.map((sec) => ({ ...sec, merged: Object.fromEntries(sec.cols.map((c) => { const g = mergeOf(m.meta, c, sec.mode, sec.link); return [c, g && mergeText(g, m.meta)]; }).filter(([, t]) => t)) })),
    merges: (m.meta.merges || []).map((g) => ({ at: when(g.at), what: g.sessions.map((x) => `${x.stack} ${x.link.toUpperCase()}`).join(', '), overrides: overrideList(g.overrides), label: g.label })),
    problems: m.problems, shotsDef: SHOTS, stackOrder: STACK_ORDER,
    preview: existsSync(join(dir, 'walkthrough.mp4')) ? 'walkthrough.mp4' : null };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return readFileSync(new URL('./report.html', import.meta.url), 'utf8').replace('__DM_DATA__', () => json);
}

export function report(dir) {
  const l = load(dir);
  if (!l) return `no results in ${dir}\n`;
  const m = model(l);
  const md = markdown(m);
  writeFileSync(join(dir, 'report.md'), md);
  writeFileSync(join(dir, 'report.html'), html(m, dir));
  return md;
}
