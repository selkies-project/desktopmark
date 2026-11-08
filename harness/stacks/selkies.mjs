import { writeFileSync, existsSync } from 'node:fs';
import { Proc, waitFor, listening, xSocket } from '../lib/proc.mjs';
import { resolve, longFlags } from '../lib/settings.mjs';

const DISPLAY = ':3', PORT = 6912, UDP = 6913;

function adapter(transport) {
  const rtc = transport === 'webrtc';
  return {
    id: rtc ? 'selkies-rtc' : 'selkies-ws', stack: 'selkies', transport, display: DISPLAY,
    ports: rtc ? [PORT, UDP] : [PORT],
    selector: rtc ? '#stream' : '#videoStream',
    version: ['/opt/selkies/bin/selkies', '--version'],
    binary: '/opt/selkies/bin/selkies', xserver: ['/opt/selkies/bin/Xvfb', '-version'], xserverName: 'XLibre Xvfb from the selkies image', encoderLib: null,

    async startX(ctx) {
      const { w, h, fps } = ctx.mode;
      const x = new Proc('xvfb', '/opt/selkies/bin/Xvfb', [DISPLAY, '-screen', '0', `${w}x${h}x24`, '-dpi', '96',
        '-ac', '-nolisten', 'tcp', '-noreset', '-fakescreenfps', String(fps)],
      { logDir: ctx.logDir, cpus: ctx.stackCpus });
      await waitFor('X socket', () => existsSync(xSocket(DISPLAY)));
      return [x];
    },

    async startServer(ctx) {
      const rtcJson = `${ctx.home}/rtc.json`;
      writeFileSync(rtcJson, '{"iceServers":[]}\n');
      ctx.settings = resolve(this, ctx);
      const args = ['--addr=127.0.0.1', `--port=${PORT}`, `--mode=${transport}`, `--rtc-config-json=${rtcJson}`,
        `--webrtc-udp-mux-port=${UDP}`, ...longFlags(ctx.settings, 'server')];
      const server = new Proc('selkies', '/opt/selkies/bin/selkies', args,
        { env: { DISPLAY, HOME: ctx.home, XDG_RUNTIME_DIR: ctx.runtimeDir }, logDir: ctx.logDir, cpus: ctx.stackCpus });
      await waitFor('selkies listening', () => listening(PORT), 60000);
      return { procs: [server], url: `http://127.0.0.1:${PORT}/` };
    },

    assertions: [{ proc: 'selkies', re: /Reading the screen in place/, what: 'shared-framebuffer capture' }],
  };
}

export const selkiesWs = adapter('websockets');
export const selkiesRtc = adapter('webrtc');
