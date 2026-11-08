import { execFileSync } from 'node:child_process';

const tc = (...a) => execFileSync('tc', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function canShape() {
  try {
    tc('qdisc', 'replace', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'bands', '3',
      'priomap', ...Array(16).fill('1'));
    tc('qdisc', 'del', 'dev', 'lo', 'root');
    return true;
  } catch { return false; }
}

export const LINKS = {
  lan: { rate: 0, rtt: 0, loss: 0, jitter: 0, label: 'LAN' },
  wan: { rate: 10, rtt: 100, loss: 0, jitter: 0, queueMs: 200, mtu: 1500, label: 'WAN: 10 Mbit/s, 100 ms RTT, 200 ms buffer' },
};

function netemArgs(l, down) {
  const limit = down && l.rate && l.queueMs ? Math.max(10, Math.round((l.rate * 1e6 / 8) * ((l.rtt / 2 + l.queueMs) / 1000) / (l.mtu || 1500))) : 100000;
  const a = ['netem', 'limit', String(limit)];
  const delay = l.rtt / 2;
  if (delay || l.jitter) a.push('delay', `${delay}ms`, ...(l.jitter ? [`${l.jitter}ms`, 'distribution', 'normal'] : []));
  if (down && l.rate) a.push('rate', `${l.rate}mbit`);
  if (down && l.loss) a.push('loss', `${l.loss}%`);
  return a;
}

export function shape(ports, l) {
  clear();
  if (l.mtu) execFileSync('busybox', ['ifconfig', 'lo', 'mtu', String(l.mtu)]);
  tc('qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'bands', '3', 'priomap', ...Array(16).fill('1'));
  tc('qdisc', 'add', 'dev', 'lo', 'parent', '1:1', 'handle', '10:', ...netemArgs(l, true));
  tc('qdisc', 'add', 'dev', 'lo', 'parent', '1:3', 'handle', '30:', ...netemArgs(l, false));
  for (const p of ports) {
    tc('filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', 'ip', 'prio', '1', 'u32',
      'match', 'ip', 'sport', String(p), '0xffff', 'flowid', '1:1');
    tc('filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', 'ip', 'prio', '2', 'u32',
      'match', 'ip', 'dport', String(p), '0xffff', 'flowid', '1:3');
  }
}

export function clear() {
  try { tc('qdisc', 'del', 'dev', 'lo', 'root'); } catch {}
  try { execFileSync('busybox', ['ifconfig', 'lo', 'mtu', '65536'], { stdio: 'ignore' }); } catch {}
}

export function bytes() {
  const out = tc('-s', 'class', 'show', 'dev', 'lo');
  const read = (cls) => {
    const m = out.match(new RegExp(`class prio ${cls} [\\s\\S]*?Sent (\\d+) bytes`));
    return m ? +m[1] : 0;
  };
  return { down: read('1:1'), up: read('1:3') };
}
