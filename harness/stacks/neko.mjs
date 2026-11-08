import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Proc, waitFor, listening, xSocket } from '../lib/proc.mjs';
import { resolve, params } from '../lib/settings.mjs';

const DISPLAY = ':9', PORT = 6942, UDP = 59000;

function hostIp() {
  const ips = execFileSync('hostname', ['-I'], { encoding: 'utf8' }).trim().split(/\s+/).filter((a) => /^\d+\./.test(a));
  if (!ips.length) throw new Error('Neko needs a non-loopback IPv4 address for ICE (run without --network none)');
  return ips[0];
}

export const nekoRtc = {
  id: 'neko-rtc', stack: 'neko', transport: 'webrtc', display: DISPLAY, ports: [PORT, UDP],
  selector: 'video',
  version: ['sh', '-c', 'echo "$DM_SOURCES" | tr " " "\n" | grep ^neko='],
  binary: '/opt/neko/bin/neko', xserver: ['/usr/bin/Xorg', '-version'],
  encoderLib: ['/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstx264.so'],

  async startX(ctx) {
    const x = new Proc('xorg', '/usr/bin/Xorg', [DISPLAY, '-config', '/opt/neko/xorg.conf', '-noreset', '-nolisten',
      'tcp', '-logfile', `${ctx.logDir}/Xorg.log`], { env: { HOME: ctx.home }, logDir: ctx.logDir, cpus: ctx.stackCpus });
    await waitFor('X socket', () => existsSync(xSocket(DISPLAY)));
    return [x];
  },

  async startServer(ctx) {
    ctx.settings = resolve(this, ctx);
    const pipe = params(ctx.settings, 'pipeline');
    if ('show_pointer' in pipe) pipe.show_pointer = pipe.show_pointer === 'true';
    const env = {
      DISPLAY, HOME: ctx.home, USER: 'bench',
      NEKO_SERVER_BIND: `127.0.0.1:${PORT}`,
      NEKO_WEBRTC_ICELITE: 'true', NEKO_WEBRTC_UDPMUX: String(UDP), NEKO_WEBRTC_NAT1TO1: hostIp(),
      NEKO_WEBRTC_ICESERVERS_FRONTEND: '[{"urls":["stun:127.0.0.1:3478"]}]',
      NEKO_WEBRTC_ICESERVERS_BACKEND: '[]',
      NEKO_CAPTURE_VIDEO_IDS: 'main',
      ...params(ctx.settings, 'env'),
      NEKO_CAPTURE_VIDEO_PIPELINES: JSON.stringify({ main: { ...pipe, gst_params: params(ctx.settings, 'x264') } }),
    };
    const server = new Proc('neko', '/opt/neko/bin/neko', ['serve', '--server.static', '/opt/neko/www'],
      { env, logDir: ctx.logDir, cpus: ctx.stackCpus });
    await waitFor('neko listening', () => listening(PORT), 30000);
    return { procs: [server], url: `http://127.0.0.1:${PORT}/?usr=bench&pwd=bench&cast=1` };
  },

  assertions: [{ proc: 'neko', re: /syntax check for video stream pipeline passed/, what: 'video pipeline', }],
};
