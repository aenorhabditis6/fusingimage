/* 溶光 · GIF decode / encode, no dependencies. Exposes window.GIFKit. */
'use strict';
(() => {

// ---------------------------------------------------------------- decode
function lzwDecode(minSize, data, npix) {
  const out = new Uint8Array(npix);
  const clear = 1 << minSize, eoi = clear + 1;
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let codeSize = minSize + 1, codeMask = (1 << codeSize) - 1, avail = clear + 2, old = -1, firstChar = 0;
  let bits = 0, datum = 0, pi = 0, op = 0;
  const n = data.length;
  while (op < npix) {
    while (bits < codeSize && pi < n) { datum |= data[pi++] << bits; bits += 8; }
    if (bits < codeSize) break;
    let code = datum & codeMask; datum >>>= codeSize; bits -= codeSize;
    if (code === clear) { codeSize = minSize + 1; codeMask = (1 << codeSize) - 1; avail = clear + 2; old = -1; continue; }
    if (code === eoi) break;
    if (old === -1) {
      if (code >= clear) break; // corrupt
      out[op++] = suffix[code]; old = code; firstChar = code; continue;
    }
    const inCode = code; let sp = 0;
    if (code >= avail) { stack[sp++] = firstChar; code = old; }
    while (code >= clear) { stack[sp++] = suffix[code]; code = prefix[code]; if (sp > 4096) break; }
    firstChar = suffix[code];
    stack[sp++] = firstChar;
    if (avail < 4096) {
      prefix[avail] = old; suffix[avail] = firstChar; avail++;
      if ((avail & codeMask) === 0 && avail < 4096) { codeSize++; codeMask += avail; }
    }
    old = inCode;
    while (sp > 0 && op < npix) out[op++] = stack[--sp];
  }
  return out;
}

// Count image frames without decoding pixels.
function count(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return 0;
  const flags = b[10];
  let p = 13, n = 0;
  if (flags & 0x80) p += (2 << (flags & 7)) * 3;
  const skipSub = () => { while (p < b.length && b[p] !== 0) p += b[p] + 1; p++; };
  while (p < b.length) {
    const blk = b[p++];
    if (blk === 0x21) { p++; skipSub(); continue; }
    if (blk !== 0x2C) break;
    const f = b[p + 8]; p += 9;
    if (f & 0x80) p += (2 << (f & 7)) * 3;
    p++; skipSub(); n++;
  }
  return n;
}

// Decode every frame, fully composited, calling onFrame(rgba, delayMs, index) with a live buffer
// (copy it if you keep it). Returns { w, h, count, truncated }.
function decode(buf, onFrame, maxFrames = 300) {
  const b = new Uint8Array(buf);
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) throw new Error('不是有效的 GIF 文件');
  const W = b[6] | (b[7] << 8), H = b[8] | (b[9] << 8), flags = b[10];
  let p = 13, gct = null;
  if (flags & 0x80) { const n = 2 << (flags & 7); gct = b.subarray(p, p + n * 3); p += n * 3; }
  const cv = new Uint8ClampedArray(W * H * 4);
  let nf = 0;
  let gce = null, lastDisp = 0, lastRect = null, saved = null, truncated = false;
  const skipSub = () => { while (p < b.length && b[p] !== 0) p += b[p] + 1; p++; };
  while (p < b.length) {
    const blk = b[p++];
    if (blk === 0x3B) break;
    if (blk === 0x21) {
      const label = b[p++];
      if (label === 0xF9 && b[p] >= 4) {
        const pf = b[p + 1];
        gce = { disp: (pf >> 2) & 7, delay: b[p + 2] | (b[p + 3] << 8), trans: (pf & 1) ? b[p + 4] : -1 };
      }
      skipSub();
      continue;
    }
    if (blk !== 0x2C) break;
    const fx = b[p] | (b[p + 1] << 8), fy = b[p + 2] | (b[p + 3] << 8);
    const fw = b[p + 4] | (b[p + 5] << 8), fh = b[p + 6] | (b[p + 7] << 8), f = b[p + 8];
    p += 9;
    let ct = gct;
    if (f & 0x80) { const n = 2 << (f & 7); ct = b.subarray(p, p + n * 3); p += n * 3; }
    const interlaced = !!(f & 0x40);
    const minCode = b[p++];
    let total = 0;
    for (let q = p; q < b.length && b[q] !== 0; q += b[q] + 1) total += b[q];
    const data = new Uint8Array(total);
    let o = 0;
    while (p < b.length && b[p] !== 0) {
      const n = Math.min(b[p], b.length - p - 1);
      data.set(b.subarray(p + 1, p + 1 + n), o); o += n; p += b[p] + 1;
    }
    p++;
    if (nf >= maxFrames) { truncated = true; gce = null; continue; }
    const px = lzwDecode(minCode, data, fw * fh);

    // dispose the previous frame
    if (lastDisp === 2 && lastRect) {
      const [rx, ry, rw, rh] = lastRect;
      for (let y = Math.max(0, ry); y < Math.min(H, ry + rh); y++)
        cv.fill(0, (y * W + Math.max(0, rx)) * 4, (y * W + Math.min(W, rx + rw)) * 4);
    } else if (lastDisp === 3 && saved) cv.set(saved);
    const disp = gce ? gce.disp : 0, trans = gce ? gce.trans : -1;
    if (disp === 3) saved = cv.slice();

    if (ct) {
      const rows = new Int32Array(fh);
      if (interlaced) {
        let r = 0;
        for (const [st, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = st; y < fh; y += step) rows[r++] = y;
      } else for (let y = 0; y < fh; y++) rows[y] = y;
      const ncol = ct.length / 3;
      for (let r = 0; r < fh; r++) {
        const y = fy + rows[r];
        if (y < 0 || y >= H) continue;
        for (let x = 0; x < fw; x++) {
          const X = fx + x;
          if (X >= W) break;
          const ci = px[r * fw + x];
          if (ci === trans || ci >= ncol) continue;
          const j = (y * W + X) * 4;
          cv[j] = ct[ci * 3]; cv[j + 1] = ct[ci * 3 + 1]; cv[j + 2] = ct[ci * 3 + 2]; cv[j + 3] = 255;
        }
      }
    }
    const d = gce ? gce.delay : 0;
    onFrame(cv, (d < 2 ? 10 : d) * 10, nf++, W, H);
    lastDisp = disp; lastRect = [fx, fy, fw, fh]; gce = null;
  }
  if (!nf) throw new Error('GIF 里没有读到画面');
  return { w: W, h: H, count: nf, truncated };
}

// ---------------------------------------------------------------- palette (median cut on a 5-bit histogram)
function buildPalette(samples, maxColors) {
  // samples: Uint8Array of rgb triples
  const cnt = new Uint32Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  for (let i = 0; i < samples.length; i += 3) {
    const r = samples[i], g = samples[i + 1], b = samples[i + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
  }
  const bins = [];
  for (let k = 0; k < 32768; k++) if (cnt[k]) bins.push(k);
  const comp = (k, c) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  const mkBox = list => {
    let lo = [31, 31, 31], hi = [0, 0, 0], n = 0;
    for (const k of list) {
      n += cnt[k];
      for (let c = 0; c < 3; c++) { const v = comp(k, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    }
    const rng = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    // weight green a little more, blue a little less (perceptual)
    const wr = rng[0] * 1.0, wg = rng[1] * 1.2, wb = rng[2] * 0.8;
    const axis = wg >= wr && wg >= wb ? 1 : wr >= wb ? 0 : 2;
    return { list, n, axis, score: Math.max(wr, wg, wb) * Math.sqrt(n) };
  };
  const boxes = [mkBox(bins)];
  while (boxes.length < maxColors) {
    let bi = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].list.length > 1 && boxes[i].score > best) { best = boxes[i].score; bi = i; }
    if (bi < 0) break;
    const bx = boxes[bi], ax = bx.axis;
    bx.list.sort((a, c) => comp(a, ax) - comp(c, ax));
    let acc = 0, cut = 1;
    for (let i = 0; i < bx.list.length; i++) { acc += cnt[bx.list[i]]; if (acc >= bx.n / 2) { cut = Math.max(1, Math.min(bx.list.length - 1, i + 1)); break; } }
    boxes.splice(bi, 1, mkBox(bx.list.slice(0, cut)), mkBox(bx.list.slice(cut)));
  }
  const pal = [];
  for (const bx of boxes) {
    let n = 0, r = 0, g = 0, b = 0;
    for (const k of bx.list) { n += cnt[k]; r += sr[k]; g += sg[k]; b += sb[k]; }
    pal.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  }
  if (!pal.length) pal.push([0, 0, 0]);
  return pal;
}

// ---------------------------------------------------------------- LZW encode
function lzwEncode(idx, minSize) {
  const clear = 1 << minSize, eoi = clear + 1;
  let codeSize = minSize + 1, next = eoi + 1;
  const tab = new Int16Array(4096 * 256), stamp = new Uint16Array(4096 * 256);
  let gen = 1;
  let cur = 0, shift = 0;
  const out = []; let blk = new Uint8Array(255), bl = 0;
  const pushByte = v => { blk[bl++] = v; if (bl === 255) { out.push(blk); blk = new Uint8Array(255); bl = 0; } };
  const emit = c => {
    cur |= c << shift; shift += codeSize;
    while (shift >= 8) { pushByte(cur & 255); cur >>>= 8; shift -= 8; }
  };
  emit(clear);
  let pre = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = (pre << 8) | k;
    if (stamp[key] === gen) { pre = tab[key]; continue; }
    emit(pre);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1; codeSize = minSize + 1;
      gen++; if (gen === 65536) { stamp.fill(0); gen = 1; }
    } else {
      if (next >= (1 << codeSize)) codeSize++;
      tab[key] = next++; stamp[key] = gen;
    }
    pre = k;
  }
  emit(pre);
  emit(eoi);
  if (shift > 0) pushByte(cur & 255);
  if (bl) out.push(blk.subarray(0, bl));
  return out;
}

// ---------------------------------------------------------------- encoder
// Streaming encoder with a single global palette, ordered dithering (stable between frames)
// and changed-rectangle + transparency optimisation.
class Encoder {
  constructor(w, h, palette) {
    this.w = w; this.h = h;
    this.pal = palette.slice(0, 255);
    this.TR = 255; // transparent index
    this.parts = [];
    this.prev = null; this.pending = null;
    this.cache = new Int16Array(1 << 18).fill(-1);
    const hdr = [];
    const s = 'GIF89a'; for (let i = 0; i < 6; i++) hdr.push(s.charCodeAt(i));
    hdr.push(w & 255, w >> 8, h & 255, h >> 8, 0xF7, 0, 0);
    for (let i = 0; i < 256; i++) { const c = this.pal[i] || [0, 0, 0]; hdr.push(c[0], c[1], c[2]); }
    // loop forever
    hdr.push(0x21, 0xFF, 0x0B); for (const ch of 'NETSCAPE2.0') hdr.push(ch.charCodeAt(0));
    hdr.push(3, 1, 0, 0, 0);
    this.parts.push(new Uint8Array(hdr));
  }
  nearest(r, g, b) {
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = this.cache[k];
    if (v >= 0) return v;
    const R = (r & 0xFC) + 2, G = (g & 0xFC) + 2, B = (b & 0xFC) + 2;
    let best = 1e9; v = 0;
    const pal = this.pal;
    for (let i = 0; i < pal.length; i++) {
      const c = pal[i], dr = c[0] - R, dg = c[1] - G, db = c[2] - B;
      const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
      if (d < best) { best = d; v = i; }
    }
    this.cache[k] = v;
    return v;
  }
  addFrame(rgba, delayMs) {
    const { w, h } = this, n = w * h, idx = new Uint8Array(n);
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const amp = 9;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i * 4;
      const t = (BAYER[((y & 3) << 2) | (x & 3)] / 16 - 0.47) * amp;
      let r = rgba[j] + t, g = rgba[j + 1] + t, b = rgba[j + 2] + t;
      r = r < 0 ? 0 : r > 255 ? 255 : r | 0; g = g < 0 ? 0 : g > 255 ? 255 : g | 0; b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      idx[i] = this.nearest(r, g, b);
    }
    const prev = this.prev;
    let rect = [0, 0, w, h];
    if (prev) {
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (idx[i] !== prev[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) { if (this.pending) this.pending.delay += delayMs; return; }
      rect = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
    }
    const [rx, ry, rw, rh] = rect, sub = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = (ry + y) * w + rx + x;
      sub[y * rw + x] = prev && idx[i] === prev[i] ? this.TR : idx[i];
    }
    this.flush();
    this.pending = { rect, sub, delay: delayMs, trans: !!prev };
    this.prev = idx;
  }
  flush() {
    const f = this.pending; if (!f) return;
    const [rx, ry, rw, rh] = f.rect, cs = Math.max(2, Math.round(f.delay / 10));
    this.parts.push(new Uint8Array([
      0x21, 0xF9, 4, (1 << 2) | (f.trans ? 1 : 0), cs & 255, cs >> 8, this.TR, 0,
      0x2C, rx & 255, rx >> 8, ry & 255, ry >> 8, rw & 255, rw >> 8, rh & 255, rh >> 8, 0,
      8,
    ]));
    for (const blk of lzwEncode(f.sub, 8)) { this.parts.push(new Uint8Array([blk.length])); this.parts.push(blk); }
    this.parts.push(new Uint8Array([0]));
    this.pending = null;
  }
  finish() {
    this.flush();
    this.parts.push(new Uint8Array([0x3B]));
    return new Blob(this.parts, { type: 'image/gif' });
  }
}

window.GIFKit = { count, decode, buildPalette, Encoder };
})();
