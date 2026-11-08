import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Proc, sleep, waitFor } from './proc.mjs';

const DMAPP = '/env/bin/dmapp';

export async function baseDesktop(ctx, display) {
  const env = { DISPLAY: display, HOME: ctx.home };
  for (const args of [['s', 'off'], ['-dpms'], ['s', 'noblank']])
    try { execFileSync('xset', args, { env: { ...process.env, ...env }, stdio: 'ignore' }); } catch {}
  execFileSync('xrdb', ['-merge'], { input: 'Xft.dpi: 96\n', env: { ...process.env, ...env } });
  execFileSync(DMAPP, ['wallpaper'], { env: { ...process.env, ...env } });
  mkdirSync(`${ctx.home}/.config/openbox`, { recursive: true });
  writeFileSync(`${ctx.home}/.config/openbox/rc.xml`, OPENBOX_RC);
  const wm = new Proc('openbox', 'openbox', ['--config-file', `${ctx.home}/.config/openbox/rc.xml`],
    { env, logDir: ctx.logDir, cpus: ctx.appCpus });
  await sleep(500);
  return wm;
}

export async function app(ctx, display, mode, opts = {}) {
  const args = [mode];
  for (const [k, v] of Object.entries(opts)) args.push(`--${k}`, String(v));
  const p = new Proc(`dmapp-${mode}-${opts.title || ''}${Date.now() % 100000}`, DMAPP, args,
    { env: { DISPLAY: display, HOME: ctx.home }, logDir: ctx.logDir, cpus: ctx.appCpus });
  await sleep(300);
  return p;
}

export async function windowGeometry(display, title) {
  return waitFor(`window ${title}`, () => {
    try {
      const out = execFileSync('xwininfo', ['-name', title], { encoding: 'utf8', env: { ...process.env, DISPLAY: display } });
      const g = (k) => +(out.match(new RegExp(`${k}:\\s+(-?\\d+)`)) || [])[1];
      return { x: g('Absolute upper-left X'), y: g('Absolute upper-left Y'), w: g('Width'), h: g('Height') };
    } catch { return null; }
  }, 10000);
}

export function xgrab(display, x, y, w, h) {
  return execFileSync('/env/bin/xgrab', [x, y, w, h].map(String), { env: { ...process.env, DISPLAY: display }, maxBuffer: 1 << 28 });
}

export function desktopChromium(ctx, display, url, { x, y, w, h }) {
  const prof = `${ctx.home}/desktop-chromium-${Date.now()}`;
  mkdirSync(`${prof}/Default`, { recursive: true });
  writeFileSync(`${prof}/Default/Preferences`, JSON.stringify({ browser: { custom_chrome_frame: false } }));
  return new Proc('desktop-chromium', '/env/bin/chromium', [
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-dev-shm-usage', '--disable-smooth-scrolling', '--disable-features=Translate', '--test-type',
    '--force-device-scale-factor=1',
    `--user-data-dir=${prof}`, `--window-position=${x},${y}`, `--window-size=${w},${h}`, `--app=${url}`,
  ], { env: { DISPLAY: display, HOME: ctx.home }, logDir: ctx.logDir, cpus: ctx.appCpus });
}

const OPENBOX_RC = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy></placement>
  <theme><name>Clearlooks</name><titleLayout>NLIMC</titleLayout><animateIconify>no</animateIconify></theme>
  <desktops><number>1</number></desktops>
  <!-- no edge resistance: a dragged window goes exactly where the pointer takes it -->
  <resistance><strength>0</strength><screen_edge_strength>0</screen_edge_strength></resistance>
  <mouse>
    <dragThreshold>1</dragThreshold><doubleClickTime>400</doubleClickTime>
    <context name="Titlebar">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
      <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
    </context>
    <context name="Client">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
    </context>
  </mouse>
  <applications><application class="*"><decor>yes</decor></application></applications>
</openbox_config>
`;
