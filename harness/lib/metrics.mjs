
export function quantile(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}
export const median = (a) => quantile(a, 0.5);
export const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function stampLatency(ms24, seenMs) {
  let l = (seenMs & 0xffffff) - ms24;
  if (l < -0x800000) l += 0x1000000;
  return l >= 0 && l < 60000 ? l : null;
}

export function frameRate(seen, t0, t1) {
  const bins = Math.max(1, Math.floor((t1 - t0) / 1000)), counts = Array(bins).fill(0);
  for (const [, , t] of seen) { const b = Math.floor((t - t0) / 1000); if (b >= 0 && b < bins) counts[b]++; }
  const total = counts.reduce((a, b) => a + b, 0);
  return { avg: round(total / bins), worst: Math.min(...counts), median: median(counts) };
}

export function markerStats(seen, t0, t1) {
  const lat = seen.map(([, ms, t]) => stampLatency(ms, t)).filter((v) => v != null);
  return { fps: frameRate(seen, t0, t1), latencyMs: { p50: quantile(lat, 0.5), p90: quantile(lat, 0.9), p99: quantile(lat, 0.99) } };
}

export function bandwidth(samples) {
  if (samples.length < 2) return null;
  const d = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    d.push({ bits: (samples[i].down - samples[i - 1].down) * 8, dt });
  }
  const tot = d.reduce((a, x) => a + x.bits, 0), dur = d.reduce((a, x) => a + x.dt, 0);
  const per100 = d.map((x) => x.bits / x.dt / 1e6);
  const per1s = [];
  for (let i = 0; i + 10 <= d.length; i += 10) {
    const s = d.slice(i, i + 10);
    per1s.push(s.reduce((a, x) => a + x.bits, 0) / s.reduce((a, x) => a + x.dt, 0) / 1e6);
  }
  const up = (samples.at(-1).up - samples[0].up) * 8 / dur / 1e6;
  return { meanMbps: round(tot / dur / 1e6, 2), peak100msMbps: round(Math.max(...per100), 1),
    p95_1sMbps: round(quantile(per1s, 0.95), 2), upMbps: round(up, 3) };
}
