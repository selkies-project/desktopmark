import { Proc, waitFor, listening, xSocket } from '../lib/proc.mjs';
import { existsSync } from 'node:fs';
import { resolve, longFlags } from '../lib/settings.mjs';

const DISPLAY = ':2', PORT = 6902;

export default {
  id: 'voxl-ws', stack: 'voxl', transport: 'websockets', display: DISPLAY, ports: [PORT],
  selector: 'video.stripe',
  version: ['/env/bin/voxl', '--version'],
  binary: '/env/bin/voxl', xserver: ['/env/bin/Xvfb-voxl', '-version'], encoderLib: ['/env/bin/voxl'],

  async startX(ctx) {
    const { w, h, fps } = ctx.mode;
    const x = new Proc('xvfb', '/env/bin/Xvfb-voxl', [DISPLAY, '-screen', '0', `${w}x${h}x24`, '-dpi', '96',
      '-shmem', '-ac', '-nolisten', 'tcp', '-noreset', '-fakescreenfps', String(fps)],
    { logDir: ctx.logDir, cpus: ctx.stackCpus });
    await waitFor('X socket', () => existsSync(xSocket(DISPLAY)));
    return [x];
  },

  async startServer(ctx) {
    ctx.settings = resolve(this, ctx);
    const args = [`--addr=127.0.0.1`, `--port=${PORT}`, ...longFlags(ctx.settings, 'server')];
    const server = new Proc('voxl', '/env/bin/voxl', args,
      { env: { DISPLAY, HOME: ctx.home, RUST_LOG: 'info' }, logDir: ctx.logDir, cpus: ctx.stackCpus });
    await waitFor('voxl listening', () => listening(PORT));
    return { procs: [server], url: `http://127.0.0.1:${PORT}/` };
  },

  assertions: [{ proc: 'voxl', re: /capturing directly from the Xvfb framebuffer/i, what: 'direct framebuffer capture' }],
};
