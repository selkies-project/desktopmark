import { existsSync, readFileSync } from 'node:fs';
import { Proc, waitFor, listening, xSocket } from '../lib/proc.mjs';
import { resolve, xArgs, params } from '../lib/settings.mjs';

const DISPLAY = ':5', PORT = 6922, UDP = 6923;

export const KASM_CRF = { default: 23 };
for (const f of [process.env.DM_KASM_CRF, '/out/kasm-crf.json', '/dm/harness/stacks/kasm-crf.json']) {
  try { if (f && existsSync(f)) { Object.assign(KASM_CRF, JSON.parse(readFileSync(f, 'utf8')).crf); KASM_CRF.source = f; break; } } catch {}
}

function adapter(variant) {
  const h264 = variant === 'h264', udp = variant === 'hybrid-rtc';
  return {
    id: h264 ? 'kasm-ws' : udp ? 'kasm-rtc-hybrid' : 'kasm-ws-hybrid', stack: 'kasmvnc',
    transport: udp ? 'webrtc' : 'websockets', display: DISPLAY, ports: udp ? [PORT, UDP] : [PORT],
    selector: null,
    extra: !h264,
    version: ['dpkg-query', '-W', '-f', '${Version}', 'kasmvncserver'],
    binary: '/usr/bin/Xkasmvnc', xserver: null, encoderLib: ['/usr/lib/x86_64-linux-gnu/libavcodec.so.61'],
    vars: ({ mode: { w, h, fps } }) => ({ crf: KASM_CRF[`${w}x${h}@${fps}`] ?? KASM_CRF.default }),

    async startX(ctx) {
      const { w, h } = ctx.mode;
      ctx.settings = resolve(this, ctx);
      const args = [DISPLAY, '-geometry', `${w}x${h}`, '-interface', '127.0.0.1', '-websocketPort', String(PORT),
        '-publicIP', '127.0.0.1', '-udpPort', String(UDP), '-httpd', '/usr/share/kasmvnc/www',
        '-Log', '*:stdout:30,ffmpeg:stdout:100,SoftwareEncoder:stdout:100', ...xArgs(ctx.settings, 'server')];
      const x = new Proc('xkasmvnc', '/usr/bin/Xkasmvnc', args, { logDir: ctx.logDir, cpus: ctx.stackCpus });
      await waitFor('X socket', () => existsSync(xSocket(DISPLAY)));
      return [x];
    },

    async startServer(ctx) {
      await waitFor('KasmVNC listening', () => listening(PORT));
      const q = new URLSearchParams(params(ctx.settings, 'client'));
      return { procs: [], url: `http://127.0.0.1:${PORT}/vnc.html?${q}` };
    },

    assertions: [
      { proc: 'xkasmvnc', re: /libavcodec\.so loaded/, what: 'FFmpeg loaded', only: () => h264 },
      { proc: 'xkasmvnc', re: /SoftwareEncoder: FRAME RESIZE \(\d+, \d+\): RATE/, what: 'software H.264 stream mode', only: () => h264 },
      { proc: 'xkasmvnc', re: /Failed to create software encoder/, what: 'software encoder', invert: true },
    ],
  };
}

export const kasmWs = adapter('h264');
export const kasmWsHybrid = adapter('hybrid-ws');
export const kasmRtcHybrid = adapter('hybrid-rtc');
