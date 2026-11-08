(() => {
  if (window.__dm) return;
  const C = 16, COLS = 10, MW = 160, MH = 64;
  const dm = (window.__dm = {});
  let cv, ctx;

  function findEl(sel) {
    if (sel) for (const e of document.querySelectorAll(sel)) if (e.getBoundingClientRect().width > 0) return e;
    let best = null, area = 0;
    for (const el of document.querySelectorAll('canvas,video')) {
      if (el === cv) continue;
      const w = el.videoWidth || el.width, h = el.videoHeight || el.height;
      if (el.getBoundingClientRect().width > 0 && w * h > area) { area = w * h; best = el; }
    }
    return best;
  }
  function grab(el, x, y, w, h) {
    if (!cv) { cv = document.createElement('canvas'); ctx = cv.getContext('2d', { willReadFrequently: true }); }
    if (cv.width < w) cv.width = w;
    if (cv.height < h) cv.height = h;
    ctx.drawImage(el, x, y, w, h, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }
  function decode(d) {
    let v = 0n;
    for (let b = 0; b < 40; b++) {
      const x = (b % COLS) * C + C / 2, y = Math.floor(b / COLS) * C + C / 2, i = (y * MW + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] > 382) v |= 1n << BigInt(b);
    }
    return { n: Number(v >> 24n), ms: Number(v & 0xffffffn) };
  }

  const hooked = new WeakMap();
  function hookCanvas(el, onPaint) {
    let c;
    try { c = el.getContext('2d'); } catch { return false; }
    if (!c) return false;
    let h = hooked.get(el);
    if (!h) {
      h = { cb: null, pending: false };
      for (const m of ['drawImage', 'putImageData', 'fillRect', 'clearRect', 'fill']) {
        const orig = c[m].bind(c);
        c[m] = (...a) => {
          const r = orig(...a);
          if (h.cb && !h.pending) { h.pending = true; requestAnimationFrame(() => { h.pending = false; h.cb && h.cb(); }); }
          return r;
        };
      }
      hooked.set(el, h);
    }
    h.cb = onPaint;
    return true;
  }

  dm.info = (sel) => {
    const el = findEl(sel);
    if (!el) return null;
    return { tag: el.tagName, id: el.id, cls: String(el.className), w: el.videoWidth || el.width,
      h: el.videoHeight || el.height, rect: el.getBoundingClientRect().toJSON() };
  };

  dm.codecs = async () => {
    let webcodecs = false;
    try {
      webcodecs = (await VideoDecoder.isConfigSupported({ codec: 'avc1.640033', codedWidth: 3840, codedHeight: 2160 })).supported;
    } catch {}
    let rtc = [];
    try { rtc = RTCRtpReceiver.getCapabilities('video').codecs.map((c) => c.mimeType); } catch {}
    return { webcodecs, rtcH264: rtc.some((m) => /h264/i.test(m)) };
  };

  dm.rafRate = (ms) => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(n * 1000 / (performance.now() - t0)); };
    requestAnimationFrame(f);
  });

  dm.markerNow = (sel, x, y) => {
    const el = findEl(sel);
    if (!el || !(el.videoWidth || el.width)) return null;
    try { const r = decode(grab(el, x, y, MW, MH)); return { ...r, now: Date.now() }; } catch { return null; }
  };

  dm.start = (cfg) => {
    const el = findEl(cfg.sel);
    if (!el) return { lost: true };
    const st = (dm.st = { el, frames: 0, t0: performance.now(), marks: {}, track: [], errs: 0, lastPos: null });
    for (const m of cfg.markers || []) st.marks[m.id] = { last: -1, seen: [] };
    const sample = () => {
      if (!el.isConnected || !(el.videoWidth || el.width)) { st.lost = true; return; }
      st.frames++;
      const now = Date.now();
      try {
        for (const m of cfg.markers || []) {
          const r = decode(grab(el, m.x, m.y, MW, MH)), mk = st.marks[m.id];
          if (r.n !== mk.last) { mk.last = r.n; mk.seen.push([r.n, r.ms, now]); }
        }
        if (cfg.track2d) {
          const t = cfg.track2d, orange = (d, i) => d[i] > 200 && d[i + 1] > 90 && d[i + 1] < 190 && d[i + 2] < 80;
          const clamp = (v, hi) => Math.max(0, Math.min(hi - 1, Math.round(v)));
          if (st.lx == null) { st.lx = t.x; st.ly = t.y; }
          let x = -1, y = -1;
          const row = grab(el, 0, clamp(st.ly + t.h / 2, t.H), t.W, 1);
          for (let i = 0; i < t.W; i++) if (orange(row, i * 4)) { x = i; break; }
          const col = grab(el, clamp((x >= 0 ? x : st.lx) + t.w / 2, t.W), 0, 1, t.H);
          for (let j = 0; j < t.H; j++) if (orange(col, j * 4)) { y = j; break; }
          if (x >= 0 && y >= 0) {
            st.lx = x; st.ly = y;
            const last = st.track.at(-1);
            if (!last || last[0] !== x || last[1] !== y) st.track.push([x, y, now]);
          }
        }
        if (cfg.tracker) {
          const t = cfg.tracker, d = grab(el, t.x0, t.y, t.w, 1);
          let pos = -1;
          for (let x = 0; x < t.w; x++) {
            const i = x * 4;
            if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) { pos = t.x0 + x; break; }
          }
          if (pos !== st.lastPos) { st.lastPos = pos; st.track.push([pos, now]); }
        }
      } catch (e) { st.errs++; st.err = String(e); }
    };
    if (el.tagName === 'VIDEO' && el.requestVideoFrameCallback) {
      st.mode = 'rvfc';
      const cb = () => { if (st.stopped) return; sample(); el.requestVideoFrameCallback(cb); };
      el.requestVideoFrameCallback(cb);
    } else if (el.tagName === 'CANVAS' && hookCanvas(el, () => { if (!st.stopped) sample(); })) {
      st.mode = 'paint';
    } else {
      st.mode = 'raf';
      const tick = () => { if (st.stopped) return; sample(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
    return { mode: st.mode, tag: el.tagName };
  };

  dm.stop = () => {
    const st = dm.st;
    st.stopped = true;
    const h = st.el && hooked.get(st.el);
    if (h) h.cb = null;
    const lost = st.lost || !st.el.isConnected || findEl(null) !== st.el && findEl(null) && !(st.el.videoWidth || st.el.width);
    return { lost, mode: st.mode, frames: st.frames, errs: st.errs, err: st.err, marks: st.marks,
      track: st.track, durMs: performance.now() - st.t0 };
  };

  dm.crop = (sel, x, y, w, h) => {
    const el = findEl(sel);
    if (!el) throw new Error('stream lost: no stream element');
    const d = grab(el, x, y, w, h), rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < w * h * 4; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
    let s = '';
    for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
    return btoa(s);
  };
})();
