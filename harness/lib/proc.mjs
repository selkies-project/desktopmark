import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const LIVE = new Set();
export async function killAll() {
  const left = [...LIVE];
  for (const p of left) try { process.kill(-p.pid, 'SIGKILL'); } catch {}
  await Promise.race([Promise.all(left.map((p) => p.exited)), sleep(3000)]);
  return left.map((p) => p.name);
}

export class Proc {
  constructor(name, cmd, args, { env = {}, cpus = null, logDir, cwd, stdin = false } = {}) {
    this.name = name;
    this.launch = { argv: [cmd, ...args], env };
    this.logPath = join(logDir, `${name}.log`);
    const log = createWriteStream(this.logPath, { flags: 'a' });
    const argv = cpus ? ['taskset', '-c', cpus, cmd, ...args] : [cmd, ...args];
    this.child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      cwd,
      detached: true,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    log.on('error', () => {});
    this.child.stdout.pipe(log, { end: false });
    this.child.stderr.pipe(log, { end: false });
    this.child.on('close', () => log.end());
    this.pid = this.child.pid;
    this.exited = new Promise((r) => this.child.on('exit', (code, sig) => r({ code, sig })));
    this.alive = true;
    LIVE.add(this);
    this.exited.then(() => { this.alive = false; LIVE.delete(this); });
  }
  log() {
    try { return readFileSync(this.logPath, 'utf8'); } catch { return ''; }
  }
  async stop(graceMs = 3000) {
    if (!this.alive) return;
    try { process.kill(-this.pid, 'SIGTERM'); } catch {}
    const t = await Promise.race([this.exited, sleep(graceMs).then(() => null)]);
    if (!t) try { process.kill(-this.pid, 'SIGKILL'); } catch {}
    await Promise.race([this.exited, sleep(1000)]);
  }
}

export async function waitFor(what, check, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(100);
  }
}

export const xSocket = (display) => `/tmp/.X11-unix/X${display.replace(':', '').split('.')[0]}`;

export function listening(port, proto = 'tcp') {
  try {
    const out = execFileSync('ss', [proto === 'udp' ? '-lun' : '-ltn'], { encoding: 'utf8' });
    return new RegExp(`:${port}\\s`).test(out);
  } catch { return false; }
}

function stat(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { ppid: +f[1], pgrp: +f[2], ticks: +f[11] + +f[12] };
  } catch { return null; }
}

function allPids() {
  return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
}

export function cpuTicks({ pgids = [], roots = [] }) {
  const pids = allPids(), info = new Map();
  for (const p of pids) { const s = stat(p); if (s) info.set(p, s); }
  const inTree = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, s] of info) if (!inTree.has(p) && inTree.has(s.ppid)) { inTree.add(p); grew = true; }
  }
  let ticks = 0;
  for (const [p, s] of info) if (pgids.includes(s.pgrp) || inTree.has(p)) ticks += s.ticks;
  return ticks;
}

export const TICKS_PER_S = 100;

export const cores = (t0, t1, dtMs) => (t1 - t0) / TICKS_PER_S / (dtMs / 1000);

export function hostInfo() {
  const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
  const model = (cpuinfo.match(/model name\s*:\s*(.*)/) || [])[1] || 'unknown';
  const avx2 = /\bavx2\b/.test(cpuinfo);
  const online = execFileSync('nproc', { encoding: 'utf8' }).trim();
  return { model, avx2, cpus: +online, kernel: readFileSync('/proc/version', 'utf8').split(' ')[2] };
}

export function exists(p) { return existsSync(p); }
