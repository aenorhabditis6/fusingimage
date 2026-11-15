/* 溶光 · OC 融图台 — all processing runs locally in the browser. */
'use strict';
(() => {

// ---------------------------------------------------------------- utils
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const c01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

const isMobile = matchMedia('(max-width: 820px)').matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const LIM = isMobile
  ? { prevBg: 1100, fullBg: 2400, prevCh: 760, fullCh: 2000 }
  : { prevBg: 1500, fullBg: 3200, prevCh: 1000, fullCh: 2800 };

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
const g2 = c => c.getContext('2d');
const readData = c => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

const pool = new Map();
function tmp(name, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let c = pool.get(name);
  if (!c) { c = mk(w, h); pool.set(name, c); }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
  x.clearRect(0, 0, w, h);
  return c;
}

const FILTER_OK = (() => {
  try {
    const c = mk(9, 9), x = c.getContext('2d', { willReadFrequently: true });
    x.filter = 'blur(2px)'; x.fillStyle = '#fff'; x.fillRect(4, 4, 1, 1);
    return x.getImageData(1, 4, 1, 1).data[3] > 0;
  } catch (e) { return false; }
})();

// Blur a canvas into a pooled canvas of the same size.
function blurTo(name, src, r) {
  const w = src.width, h = src.height;
  const out = tmp(name, w, h), x = g2(out);
  if (r < 0.6) { x.drawImage(src, 0, 0); return out; }
  if (FILTER_OK) {
    x.filter = `blur(${r.toFixed(2)}px)`; x.drawImage(src, 0, 0); x.filter = 'none';
    return out;
  }
  const f = Math.max(1.5, r / 1.2);
  const sw = Math.max(2, Math.round(w / f)), sh = Math.max(2, Math.round(h / f));
  const s = tmp(name + '_s', sw, sh), sx = g2(s);
  sx.imageSmoothingQuality = 'high'; sx.drawImage(src, 0, 0, sw, sh);
  const s2 = tmp(name + '_s2', Math.max(2, sw >> 1), Math.max(2, sh >> 1)), s2x = g2(s2);
  s2x.imageSmoothingQuality = 'high'; s2x.drawImage(s, 0, 0, s2.width, s2.height);
  sx.clearRect(0, 0, sw, sh); sx.drawImage(s2, 0, 0, sw, sh);
  x.imageSmoothingQuality = 'high'; x.drawImage(s, 0, 0, w, h);
  return out;
}

// Separable box blur on Float32 arrays, zero padding.
function boxBlur(src, w, h, r, out, tmpA) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w; let acc = 0;
    for (let x = 0; x <= r && x < w; x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      tmpA[row + x] = acc * inv;
      const xa = x + r + 1, xr = x - r;
      if (xa < w) acc += src[row + xa];
      if (xr >= 0) acc -= src[row + xr];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= r && y < h; y++) acc += tmpA[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv;
      const ya = y + r + 1, yr = y - r;
      if (ya < h) acc += tmpA[ya * w + x];
      if (yr >= 0) acc -= tmpA[yr * w + x];
    }
  }
  return out;
}
// ~Gaussian with sigma ≈ s (three box passes).
function gaussish(src, w, h, s) {
  const r = Math.max(1, Math.round(s));
  const a = new Float32Array(w * h), b = new Float32Array(w * h), t = new Float32Array(w * h);
  boxBlur(src, w, h, r, a, t); boxBlur(a, w, h, r, b, t); boxBlur(b, w, h, r, a, t);
  return a;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[s.length >> 1];
}
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}
function rgbToHex(r, g, b) {
  const h = v => Math.round(c01(v) * 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
// Normalize a color so its luma is 1 (a pure "tint").
function tintOf(rgb) {
  const l = luma(rgb[0], rgb[1], rgb[2]);
  if (l < 0.02) return [1, 1, 1];
  let v = rgb.map(c => clamp(c / l, 0.35, 2));
  const l2 = luma(v[0], v[1], v[2]);
  return v.map(c => c / l2);
}
const srgb2lin = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lin2srgb = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('图片读不出来，换一张试试（支持 PNG / JPG / WebP）'));
    im.src = src;
  });
}
// Draw an image into a canvas no larger than maxSide, halving in steps for quality.
function toCanvas(src, maxSide) {
  let w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  let cur = src, cw = w, ch = h;
  while (cw / 2 > tw * 1.05) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = mk(nw, nh), x = g2(c);
    x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const out = mk(tw, th), x = g2(out);
  x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, tw, th);
  return out;
}

// ---------------------------------------------------------------- 3D LUT
const LUT_N = 33;
function buildLUT(fn) {
  const N = LUT_N, lut = new Float32Array(N * N * N * 3), o = [0, 0, 0];
  let k = 0;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    fn(r / (N - 1), g / (N - 1), b / (N - 1), o);
    lut[k++] = o[0]; lut[k++] = o[1]; lut[k++] = o[2];
  }
  return lut;
}
const LS = (LUT_N - 1) / 255, DG = LUT_N * 3, DB = LUT_N * LUT_N * 3;
function lutPx(lut, r, g, b, o) {
  const fr = r * LS, fg = g * LS, fb = b * LS;
  let r0 = fr | 0, g0 = fg | 0, b0 = fb | 0;
  if (r0 > LUT_N - 2) r0 = LUT_N - 2;
  if (g0 > LUT_N - 2) g0 = LUT_N - 2;
  if (b0 > LUT_N - 2) b0 = LUT_N - 2;
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const i = ((b0 * LUT_N + g0) * LUT_N + r0) * 3;
  for (let c = 0; c < 3; c++) {
    const p = i + c;
    const c00 = lut[p] + (lut[p + 3] - lut[p]) * dr;
    const c10 = lut[p + DG] + (lut[p + DG + 3] - lut[p + DG]) * dr;
    const c01_ = lut[p + DB] + (lut[p + DB + 3] - lut[p + DB]) * dr;
    const c11 = lut[p + DB + DG] + (lut[p + DB + DG + 3] - lut[p + DB + DG]) * dr;
    const a = c00 + (c10 - c00) * dg, bb = c01_ + (c11 - c01_) * dg;
    o[c] = a + (bb - a) * db;
  }
}

// ---------------------------------------------------------------- params
const DEF = {
  // person
  size: 72, rot: 0,
  chBright: 0, chContrast: 0, chSat: 0, chTemp: 0,
  cut: false, cutTol: 18, border: false, borderTol: 22, borderWidth: 14, choke: 0,
  // blend
  matchLuma: 55, matchTint: 50, matchSat: 25, wrap: 45, wrapWidth: 35, feetFg: 0, haze: 0,
  // light
  lightPreset: 'auto', lightColor: '#ffd9a0', lightColorAuto: true,
  intensity: 100, lz: -30, range: 60, rim: 60, rimWidth: 30, dark: 35, shadowTint: 50, lightTint: 40,
  glow: 35, glowSize: 30, rays: 0,
  castShadow: false, shadowLen: 55, shadowOpacity: 70, shadowSoft: 40, halo: 25,
  // grade
  style: 'none', exposure: 0, temp: 0, contrast: 0, saturation: 0, fade: 0,
  splitShadow: '#2a4a7a', splitShadowAmt: 0, splitHigh: '#ffb070', splitHighAmt: 0,
  bloom: 0, vignette: 15, grain: 8,
};
const P = { ...DEF };
const REBUILD_KEYS = new Set(['cut', 'cutTol', 'border', 'borderTol', 'borderWidth', 'choke']);

const LIGHT_PRESETS = {
  auto:   { lz: -30, rim: 60, dark: 35, lightTint: 40 },
  front:  { lz: 85, rim: 15, dark: 15, lightTint: 45 },
  top:    { lz: 10, rim: 45, dark: 40, lightTint: 40 },
  back:   { lz: -85, rim: 90, dark: 50, lightTint: 25 },
  left:   { lz: 5, rim: 60, dark: 45, lightTint: 40 },
  right:  { lz: 5, rim: 60, dark: 45, lightTint: 40 },
  bottom: { lz: 20, rim: 45, dark: 40, lightTint: 40 },
  shadow: { dark: 45, shadowTint: 70 },
};
const STYLE_KEYS = ['exposure', 'temp', 'contrast', 'saturation', 'fade', 'splitShadow', 'splitShadowAmt', 'splitHigh', 'splitHighAmt', 'bloom', 'vignette', 'grain'];
const STYLES = {
  none:   { exposure: 0, temp: 0, contrast: 0, saturation: 0, fade: 0, splitShadowAmt: 0, splitHighAmt: 0, bloom: 0, vignette: 15, grain: 8 },
  film:   { exposure: 0, temp: 8, contrast: 12, saturation: -8, fade: 22, splitShadow: '#2f5a4a', splitShadowAmt: 22, splitHigh: '#ffd49a', splitHighAmt: 16, bloom: 10, vignette: 22, grain: 32 },
  cinema: { exposure: -5, temp: 0, contrast: 22, saturation: -10, fade: 8, splitShadow: '#1f4f6a', splitShadowAmt: 32, splitHigh: '#ffaa66', splitHighAmt: 24, bloom: 8, vignette: 32, grain: 14 },
  clear:  { exposure: 18, temp: -10, contrast: -12, saturation: -6, fade: 14, splitShadow: '#5a7aa0', splitShadowAmt: 12, splitHigh: '#fff2e0', splitHighAmt: 10, bloom: 22, vignette: 0, grain: 4 },
  dusk:   { exposure: 0, temp: 30, contrast: 10, saturation: 6, fade: 6, splitShadow: '#4a2a6a', splitShadowAmt: 30, splitHigh: '#ff9a50', splitHighAmt: 30, bloom: 26, vignette: 26, grain: 10 },
  night:  { exposure: -12, temp: -30, contrast: 16, saturation: -8, fade: 6, splitShadow: '#1a3a7a', splitShadowAmt: 36, splitHigh: '#9ab8ff', splitHighAmt: 14, bloom: 18, vignette: 36, grain: 12 },
  dream:  { exposure: 6, temp: 4, contrast: -16, saturation: 4, fade: 12, splitShadow: '#6a4a8a', splitShadowAmt: 16, splitHigh: '#ffc6e0', splitHighAmt: 20, bloom: 48, vignette: 12, grain: 6 },
};

// ---------------------------------------------------------------- state
const S = {
  bg: null,       // { full: level, prev: level, small: {w,h,data} }
  ch: null,       // { origData, w, h, full: level, prev: level, stats }
  light: { x: 0.72, y: 0.22 },
  lightSrc: 'auto',
  xf: { x: 0.5, y: 0.6, flip: false },
  view: 'blend', compare: false, pick: false,
};

function mkBgLevel(c) {
  return { canvas: c, w: c.width, h: c.height, _data: null, _blur: null, _blurData: null,
    get data() { return this._data || (this._data = readData(this.canvas).data); },
    get blur() {
      if (!this._blur) {
        const r = Math.hypot(this.w, this.h) * 0.008;
        const pad = Math.ceil(r * 3);
        const big = mk(this.w + pad * 2, this.h + pad * 2), bx = g2(big);
        bx.drawImage(this.canvas, -pad, -pad, this.w + pad * 4, this.h + pad * 4); // edge fill
        bx.drawImage(this.canvas, pad, pad);
        const b = blurTo('bgblurtmp', big, r);
        const out = mk(this.w, this.h); g2(out).drawImage(b, -pad, -pad);
        this._blur = out;
      }
      return this._blur;
    },
    get blurData() { return this._blurData || (this._blurData = readData(this.blur).data); },
  };
}
function mkLevel(c) {
  return { canvas: c, w: c.width, h: c.height, data: readData(c).data, A: null, body: null, rim: null, rimKey: null, out: null };
}

// ---------------------------------------------------------------- cutout & cleanup
function borderRef(d, w, h) {
  const rs = [], gs = [], bs = [];
  const step = Math.max(1, Math.round((w + h) / 400));
  const push = i => { rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); };
  for (let x = 0; x < w; x += step) { push(x * 4); push(((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y += step) { push(y * w * 4); push((y * w + w - 1) * 4); }
  return [median(rs), median(gs), median(bs)];
}
// Soft matte + colour decontamination for pixels that border removed ones.
function matteRing(d, w, h, removed, ref, T) {
  const n = w * h;
  const ring = [];
  for (let i = 0; i < n; i++) {
    if (removed[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && removed[i - 1]) || (x < w - 1 && removed[i + 1]) || (y > 0 && removed[i - w]) || (y < h - 1 && removed[i + w])) ring.push(i);
  }
  for (const i of ring) {
    const j = i * 4;
    const dd = Math.max(Math.abs(d[j] - ref[0]), Math.abs(d[j + 1] - ref[1]), Math.abs(d[j + 2] - ref[2]));
    let a = c01((dd - T * 0.5) / (T * 2.2));
    a = Math.max(a, 0.12);
    for (let c = 0; c < 3; c++) d[j + c] = clamp((d[j + c] - (1 - a) * ref[c]) / a, 0, 255);
    d[j + 3] = Math.round(d[j + 3] * a);
  }
  for (let i = 0; i < n; i++) if (removed[i]) d[i * 4 + 3] = 0;
}
// Remove a flat-colour background connected to the image border.
function cutoutBorder(img, tolSlider) {
  const { width: w, height: h, data: d } = img;
  const n = w * h, ref = borderRef(d, w, h), T = 6 + tolSlider * 2.2;
  const removed = new Uint8Array(n), q = new Int32Array(n);
  let qh = 0, qt = 0;
  const ok = i => {
    const j = i * 4;
    if (d[j + 3] < 16) return true;
    return Math.max(Math.abs(d[j] - ref[0]), Math.abs(d[j + 1] - ref[1]), Math.abs(d[j + 2] - ref[2])) < T;
  };
  const seed = i => { if (!removed[i] && ok(i)) { removed[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const i = q[qh++], x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  matteRing(d, w, h, removed, ref, T);
  return qt / n;
}
// Eat a sticker-style outline of similar colour, inward from transparency, up to maxW px deep.
function removeOutline(img, tolSlider, maxW) {
  const { width: w, height: h, data: d } = img;
  const n = w * h, T = 6 + tolSlider * 2.2;
  const solid = i => d[i * 4 + 3] >= 128;
  const rs = [], gs = [], bs = [];
  const depth = new Uint16Array(n), removed = new Uint8Array(n), q = new Int32Array(n);
  let qt = 0, qh = 0;
  for (let i = 0; i < n; i++) {
    if (solid(i)) continue;
    removed[i] = 1;
    const x = i % w;
    const nb = (x > 0 && solid(i - 1)) || (x < w - 1 && solid(i + 1)) || (i >= w && solid(i - w)) || (i < n - w && solid(i + w));
    if (nb) q[qt++] = i;
  }
  // reference colour = median of the outermost solid ring
  for (let k = 0; k < qt; k++) {
    const i = q[k], x = i % w;
    for (const m of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (m >= 0 && m < n && solid(m) && rs.length < 60000) { const j = m * 4; rs.push(d[j]); gs.push(d[j + 1]); bs.push(d[j + 2]); }
    }
  }
  if (!rs.length) return 0;
  const ref = [median(rs), median(gs), median(bs)];
  let eaten = 0;
  while (qh < qt) {
    const i = q[qh++], x = i % w, dp = depth[i];
    if (dp >= maxW) continue;
    const visit = m => {
      if (removed[m]) return;
      const j = m * 4;
      if (Math.max(Math.abs(d[j] - ref[0]), Math.abs(d[j + 1] - ref[1]), Math.abs(d[j + 2] - ref[2])) < T) {
        removed[m] = 1; depth[m] = dp + 1; q[qt++] = m; eaten++;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  matteRing(d, w, h, removed, ref, T);
  return eaten;
}
// Erode alpha by `px` pixels (min filter), then soften by one pixel.
function choke(img, px) {
  const { width: w, height: h, data: d } = img, n = w * h;
  let a = new Uint8Array(n), b = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3];
  for (let it = 0; it < px; it++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let m = a[i];
      if (x > 0 && a[i - 1] < m) m = a[i - 1];
      if (x < w - 1 && a[i + 1] < m) m = a[i + 1];
      if (y > 0 && a[i - w] < m) m = a[i - w];
      if (y < h - 1 && a[i + w] < m) m = a[i + w];
      b[i] = m;
    }
    [a, b] = [b, a];
  }
  for (let i = 0; i < n; i++) d[i * 4 + 3] = Math.min(d[i * 4 + 3], a[i]);
}
function cropToAlpha(img) {
  const { width: w, height: h, data: d } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const src = mk(w, h); g2(src).putImageData(img, 0, 0);
  const c = mk(x1 - x0 + 1, y1 - y0 + 1);
  g2(c).drawImage(src, -x0, -y0);
  return c;
}
function opaqueFraction(d) {
  let opaque = 0, cnt = 0;
  for (let i = 3; i < d.length; i += 4 * 7) { cnt++; if (d[i] > 250) opaque++; }
  return opaque / cnt;
}

// ---------------------------------------------------------------- stats
function charStats(lv) {
  const d = lv.data, n = lv.w * lv.h, step = Math.max(1, Math.floor(n / 50000));
  const ys = []; let sat = 0, cnt = 0, mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < n; i += step) {
    const j = i * 4;
    if (d[j + 3] < 200) continue;
    const r = d[j] / 255, g = d[j + 1] / 255, b = d[j + 2] / 255;
    ys.push(luma(r, g, b));
    sat += Math.max(r, g, b) - Math.min(r, g, b);
    mr += r; mg += g; mb += b; cnt++;
  }
  if (!cnt) return { med: 0.5, hi: 0.8, sat: 0.2, mean: [0.5, 0.5, 0.5] };
  const s = Float32Array.from(ys).sort();
  return { med: Math.max(0.03, s[cnt >> 1]), hi: Math.max(0.05, s[Math.floor(cnt * 0.92)]), sat: sat / cnt, mean: [mr / cnt, mg / cnt, mb / cnt] };
}
// Stats of the background region around (and behind) the character.
let bgStatsCache = { key: '', val: null };
function bgStats() {
  const sm = S.bg.small;
  const box = charBoxNorm();
  let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
  if (box) {
    const ex = box.hh * 0.6, exX = ex * sm.h / sm.w;
    x0 = box.cx - box.hw - exX; x1 = box.cx + box.hw + exX;
    y0 = box.cy - box.hh - ex * 0.5; y1 = box.cy + box.hh + ex * 0.3;
    x0 = clamp(x0, 0, 0.9); y0 = clamp(y0, 0, 0.9); x1 = clamp(x1, x0 + 0.1, 1); y1 = clamp(y1, y0 + 0.1, 1);
  }
  const key = [x0, y0, x1, y1].map(v => v.toFixed(2)).join(',') + S.bg.id;
  if (bgStatsCache.key === key) return bgStatsCache.val;
  const { w, h, data: d } = sm;
  const X0 = Math.floor(x0 * w), X1 = Math.ceil(x1 * w), Y0 = Math.floor(y0 * h), Y1 = Math.ceil(y1 * h);
  const px = [];
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const j = (y * w + x) * 4;
    const r = d[j] / 255, g = d[j + 1] / 255, b = d[j + 2] / 255;
    px.push([luma(r, g, b), r, g, b]);
  }
  px.sort((a, b) => a[0] - b[0]);
  const n = px.length;
  const avg = (from, to) => {
    const s = [0, 0, 0]; let c = 0;
    for (let i = Math.floor(from * n); i < Math.max(Math.floor(from * n) + 1, Math.floor(to * n)); i++) { s[0] += px[i][1]; s[1] += px[i][2]; s[2] += px[i][3]; c++; }
    return s.map(v => v / Math.max(1, c));
  };
  let sat = 0;
  for (const p of px) sat += Math.max(p[1], p[2], p[3]) - Math.min(p[1], p[2], p[3]);
  const val = {
    med: Math.max(0.02, px[n >> 1][0]), hi: Math.max(0.04, px[Math.floor(n * 0.92)][0]),
    mean: avg(0, 1), white: avg(0.94, 1), dark: avg(0.05, 0.4), sat: sat / n,
  };
  bgStatsCache = { key, val };
  return val;
}

// Find the brightest blob in the background: a guess for the light source.
function detectLight() {
  const { w, h, data: d } = S.bg.small, n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) / 255;
  const B = gaussish(Y, w, h, Math.max(2, w / 40));
  let best = -1, bi = 0;
  for (let i = 0; i < n; i++) {
    const y = (i / w) | 0;
    const v = B[i] + 0.04 * (1 - y / h);
    if (v > best) { best = v; bi = i; }
  }
  const bx = bi % w, by = (bi / w) | 0;
  const R = Math.max(3, w / 14), thr = Y[bi] * 0.85;
  const s = [0, 0, 0]; let c = 0;
  for (let y = Math.max(0, by - R); y < Math.min(h, by + R); y++) for (let x = Math.max(0, bx - R); x < Math.min(w, bx + R); x++) {
    const i = y * w + x;
    if (Y[i] >= thr) { s[0] += d[i * 4]; s[1] += d[i * 4 + 1]; s[2] += d[i * 4 + 2]; c++; }
  }
  let col = c ? s.map(v => v / c / 255) : [1, 0.85, 0.65];
  if (Math.max(...col) < 0.08) col = [1, 0.85, 0.65]; // nearly black background: default warm light
  const m = Math.max(...col, 0.01);
  col = col.map(v => v / m);
  const l = luma(...col);
  col = col.map(v => c01(l + (v - l) * 1.35));
  return { x: clamp(bx / w, 0.03, 0.97), y: clamp(by / h, 0.03, 0.97), color: rgbToHex(...col), dim: Y[bi] < 0.3 };
}

// ---------------------------------------------------------------- geometry of the character
function ensureGeom(lv) {
  const { w, h } = lv, n = w * h;
  if (!lv.A) {
    const A = new Float32Array(n), d = lv.data;
    for (let i = 0; i < n; i++) A[i] = d[i * 4 + 3] / 255;
    lv.A = A;
  }
  const A = lv.A;
  if (!lv.body) {
    // "Inflated" pseudo-normals from a wide blur of the silhouette.
    const s = Math.max(2, 0.055 * h), B = gaussish(A, w, h, s), k = 2.5 * s;
    const nx = new Int8Array(n), ny = new Int8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (A[i] === 0) continue;
      const gx = (B[x < w - 1 ? i + 1 : i] - B[x > 0 ? i - 1 : i]) * 0.5;
      const gy = (B[y < h - 1 ? i + w : i] - B[y > 0 ? i - w : i]) * 0.5;
      let vx = -gx * k, vy = -gy * k;
      const l = Math.hypot(vx, vy);
      if (l > 0.97) { vx *= 0.97 / l; vy *= 0.97 / l; }
      nx[i] = Math.round(vx * 127); ny[i] = Math.round(vy * 127);
    }
    lv.body = { nx, ny };
    let top = -1, bot = -1;
    for (let y = 0; y < h; y++) {
      let any = false;
      for (let x = 0; x < w; x++) if (A[y * w + x] > 0.5) { any = true; break; }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (top < 0) { top = 0; bot = h - 1; }
    let sx = 0, c = 0;
    for (let y = Math.max(0, Math.floor(bot - 0.03 * h)); y <= bot; y++) for (let x = 0; x < w; x++) if (A[y * w + x] > 0.5) { sx += x; c++; }
    lv.feet = { u: c ? sx / c : w / 2, v: bot + 1 };
    lv.topV = top;
  }
  if (lv.rimKey !== P.rimWidth) {
    const s = Math.max(1, h * (0.002 + P.rimWidth / 100 * 0.026));
    const B = gaussish(A, w, h, s);
    const rm = new Uint8Array(n), rx = new Int8Array(n), ry = new Int8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (A[i] === 0) continue;
      const m = c01(2.2 * A[i] * (1 - B[i]));
      if (m < 0.004) continue;
      const gx = B[x < w - 1 ? i + 1 : i] - B[x > 0 ? i - 1 : i];
      const gy = B[y < h - 1 ? i + w : i] - B[y > 0 ? i - w : i];
      const l = Math.hypot(gx, gy) + 1e-9;
      rm[i] = Math.round(m * 255); rx[i] = Math.round(-gx / l * 127); ry[i] = Math.round(-gy / l * 127);
    }
    lv.rim = { rm, rx, ry };
    lv.rimKey = P.rimWidth;
  }
}

// ---------------------------------------------------------------- transforms
function charXf(lv, W, H) {
  const drawH = P.size / 100 * H, k = drawH / lv.h;
  const cx = S.xf.x * W, cy = S.xf.y * H;
  const th = P.rot * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th), fx = S.xf.flip ? -1 : 1;
  const hw = lv.w / 2, hh = lv.h / 2;
  return {
    k, cx, cy, drawH, drawW: lv.w * k,
    toComp(u, v) { const x = (u - hw) * k * fx, y = (v - hh) * k; return { x: cx + x * cs - y * sn, y: cy + x * sn + y * cs }; },
    toLocal(X, Y) { const dx = X - cx, dy = Y - cy; const x = dx * cs + dy * sn, y = -dx * sn + dy * cs; return { u: x / (k * fx) + hw, v: y / k + hh }; },
    apply(x) { x.setTransform(cs * k * fx, sn * k * fx, -sn * k, cs * k, cx, cy); x.translate(-hw, -hh); },
  };
}
function charBoxNorm() {
  if (!S.ch || !S.bg) return null;
  const lv = S.ch.prev, bw = S.bg.prev.w, bh = S.bg.prev.h;
  const hh = P.size / 200, hw = hh * (lv.w / lv.h) * (bh / bw);
  return { cx: S.xf.x, cy: S.xf.y, hw, hh };
}

// ---------------------------------------------------------------- colour functions
let charLutCache = { key: '', lut: null };
function getCharLUT() {
  const bs = bgStats(), cs = S.ch.stats;
  const keyP = ['chBright', 'chContrast', 'chSat', 'chTemp', 'matchLuma', 'matchTint', 'matchSat'].map(k => P[k]).join(',');
  const key = keyP + '|' + bgStatsCache.key + '|' + S.ch.id;
  if (charLutCache.key === key) return charLutCache.lut;

  const mL = P.matchLuma / 100, mT = P.matchTint / 100, mS = P.matchSat / 100;
  // luminance curve f(y) = g * y^p through two anchor points
  // the subject may stay a little brighter than its surroundings
  const tMed = lerp(cs.med, Math.min(0.85, bs.med * 1.25 + 0.05), mL);
  const tHi = lerp(cs.hi, Math.min(0.97, Math.max(bs.hi, bs.med * 1.25 + 0.15)), mL);
  let p = 1;
  if (cs.hi / cs.med > 1.05 && tHi / tMed > 1.01) p = Math.log(tHi / tMed) / Math.log(cs.hi / cs.med);
  p = clamp(p, 0.7, 1.45);
  const gain = tMed / Math.pow(cs.med, p);
  const ref = tintOf(bs.mean.map((v, i) => v * 0.55 + bs.white[i] * 0.45));
  const wb = ref.map(v => Math.pow(clamp(v, 0.5, 1.7), mT * 0.75));
  const dk = tintOf(bs.dark);
  const satMatch = Math.pow(clamp((bs.sat + 0.03) / (cs.sat + 0.03), 0.55, 1.3), mS);
  const satK = satMatch * (1 + P.chSat / 100);
  const bright = Math.pow(2, P.chBright / 100), con = P.chContrast / 100, tmp_ = P.chTemp / 100;

  const lut = buildLUT((r, g, b, o) => {
    let v = [r, g, b];
    // manual adjustments
    v = v.map(c => c * bright);
    v[0] *= 1 + tmp_ * 0.12; v[2] *= 1 - tmp_ * 0.12;
    if (con !== 0) v = v.map(c => { c = c01(c); return con > 0 ? lerp(c, c * c * (3 - 2 * c), con) : lerp(c, 0.5 + (c - 0.5) * 0.5, -con); });
    // luminance match
    const y = Math.max(1e-4, luma(v[0], v[1], v[2]));
    const ratio = gain * Math.pow(y, p) / y;
    v = v.map(c => c * ratio);
    // ambient tint, stronger toward shadows
    const y2 = c01(luma(v[0], v[1], v[2]));
    for (let i = 0; i < 3; i++) {
      v[i] *= wb[i];
      v[i] = lerp(v[i], v[i] * dk[i], mT * 0.45 * (1 - y2) * (1 - y2));
    }
    // saturation
    const y3 = luma(v[0], v[1], v[2]);
    v = v.map(c => y3 + (c - y3) * satK);
    // soft shoulder
    for (let i = 0; i < 3; i++) { const c = v[i]; v[i] = c > 0.85 ? 0.85 + 0.15 * (1 - Math.exp(-(c - 0.85) / 0.15)) : Math.max(0, c); }
    o[0] = v[0]; o[1] = v[1]; o[2] = v[2];
  });
  charLutCache = { key, lut };
  return lut;
}

let gradeLutCache = { key: '', lut: null };
function gradeIsIdentity() {
  return !P.exposure && !P.temp && !P.contrast && !P.saturation && !P.fade && !P.splitShadowAmt && !P.splitHighAmt;
}
function getGradeLUT() {
  const key = STYLE_KEYS.map(k => P[k]).join(',');
  if (gradeLutCache.key === key) return gradeLutCache.lut;
  const ev = Math.pow(2, P.exposure / 60), t = P.temp / 100, con = P.contrast / 100, sat = P.saturation / 100, fade = P.fade / 100 * 0.2;
  const sh = hexToRgb(P.splitShadow), hi = hexToRgb(P.splitHigh);
  const shL = luma(...sh), hiL = luma(...hi);
  const sA = P.splitShadowAmt / 100 * 0.35, hA = P.splitHighAmt / 100 * 0.3;
  const lut = buildLUT((r, g, b, o) => {
    let v = [srgb2lin(r) * ev, srgb2lin(g) * ev, srgb2lin(b) * ev];
    v[0] *= 1 + t * 0.16; v[1] *= 1 + t * 0.02; v[2] *= 1 - t * 0.16;
    v = v.map(c => lin2srgb(c01(c)));
    if (con !== 0) v = v.map(c => (con > 0 ? lerp(c, c * c * (3 - 2 * c), con) : lerp(c, 0.5 + (c - 0.5) * 0.55, -con)));
    const y = luma(v[0], v[1], v[2]);
    if (sat !== 0) v = v.map(c => y + (c - y) * (1 + sat));
    const ws = (1 - y) * (1 - y), wh = y * y;
    for (let i = 0; i < 3; i++) v[i] += (sh[i] - shL) * sA * ws + (hi[i] - hiL) * hA * wh;
    v = v.map(c => fade + c01(c) * (1 - fade));
    o[0] = v[0]; o[1] = v[1]; o[2] = v[2];
  });
  gradeLutCache = { key, lut };
  return lut;
}

// ---------------------------------------------------------------- character shading
function lightPosComp(W, H) { return { x: S.light.x * W, y: S.light.y * H }; }

function processChar(lv, T, W, H) {
  ensureGeom(lv);
  const { w, h, data: d } = lv;
  if (!lv.out || lv.out.width !== w) { lv.out = new ImageData(w, h); lv.fx = new ImageData(w, h); }
  const o = lv.out.data, fx = lv.fx.data;
  const lut = getCharLUT(), C = [0, 0, 0];
  const bs = bgStats();
  const Lc = lightPosComp(W, H), Ll = T.toLocal(Lc.x, Lc.y);
  const lz = P.lz / 100 * 1.4;
  const inten = P.intensity / 100, isShadow = P.lightPreset === 'shadow';
  const lightCol = hexToRgb(P.lightColor), lightN = tintOf(lightCol), darkN = tintOf(bs.dark);
  const dark = P.dark / 100, sT = P.shadowTint / 100, lT = P.lightTint / 100;
  const sM = [0, 1, 2].map(i => (1 - 0.75 * dark) * lerp(1, darkN[i], sT * 0.85));
  const lM = [0, 1, 2].map(i => lerp(1, lightN[i], lT * 0.5) * (1 + 0.12 * inten * lT));
  const diag = Math.hypot(W, H), rng = 0.05 + P.range / 100 * 1.2;
  const attK = Math.pow(h * T.k / diag / rng, 2);
  const washK = 0.5 * inten * lT, rimK = 2.2 * inten * P.rim / 100;
  const backB = 0.7 + 0.7 * Math.max(0, -P.lz / 100);
  const { nx: bnx, ny: bny } = lv.body, { rm, rx, ry } = lv.rim;
  const invH = 1 / h, lu = Ll.u, lvv = Ll.v, lz2 = lz * lz;

  for (let v = 0; v < h; v++) {
    const dy = (lvv - v) * invH, dy2 = dy * dy;
    for (let u = 0; u < w; u++) {
      const i = v * w + u, j = i * 4, a = d[j + 3];
      fx[j + 3] = 0;
      if (a === 0) { o[j + 3] = 0; continue; }
      lutPx(lut, d[j], d[j + 1], d[j + 2], C);
      let r = C[0], g = C[1], b = C[2];
      const dx = (lu - u) * invH, dl2 = dx * dx + dy2;
      const inv = 1 / Math.sqrt(dl2 + lz2 + 1e-6);
      const nx = bnx[i] / 127, ny = bny[i] / 127;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const ndl = (nx * dx + ny * dy + nz * lz) * inv;
      let t = isShadow ? 0 : c01(ndl * 0.6 + 0.5);
      t = t * t * (3 - 2 * t);
      r *= sM[0] + (lM[0] - sM[0]) * t;
      g *= sM[1] + (lM[1] - sM[1]) * t;
      b *= sM[2] + (lM[2] - sM[2]) * t;
      if (!isShadow) {
        const att = 1 / (1 + dl2 * attK);
        let add = ndl > 0 ? ndl * ndl * att * washK : 0;
        const rmv = rm[i];
        if (rmv && rimK > 0) {
          const rd = (rx[i] * dx + ry[i] * dy) / (127 * (Math.sqrt(dl2) + 1e-6));
          if (rd > 0) add += rimK * att * (rmv / 255) * rd * Math.sqrt(rd) * backB;
        }
        if (add > 0) fx[j + 3] = (add > 1 ? 1 : add) * a;
      }
      o[j] = r * 255; o[j + 1] = g * 255; o[j + 2] = b * 255; o[j + 3] = a;
    }
  }
  const pc = tmp('charProc', w, h);
  g2(pc).putImageData(lv.out, 0, 0);
  // rim + highlight wash: a light-coloured layer screened on top later
  const lc = lightCol.map(v => Math.round(v * 255));
  for (let j = 0; j < fx.length; j += 4) { fx[j] = lc[0]; fx[j + 1] = lc[1]; fx[j + 2] = lc[2]; }
  const fc = tmp('charFx', w, h);
  g2(fc).putImageData(lv.fx, 0, 0);
  return { base: pc, fx: fc };
}

// ---------------------------------------------------------------- noise textures
let noiseTex = null, grainTex = null;
function getNoise() {
  if (noiseTex) return noiseTex;
  const S_ = 256, c = mk(S_, S_), x = g2(c);
  const layer = (n, a) => {
    const t = mk(n, n), tx = g2(t), id = tx.createImageData(n, n);
    for (let i = 0; i < n * n; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = Math.random() * 255; }
    tx.putImageData(id, 0, 0);
    x.globalAlpha = a; x.imageSmoothingQuality = 'high'; x.drawImage(t, 0, 0, S_, S_);
  };
  layer(4, 1); layer(8, 0.55); layer(16, 0.35); layer(32, 0.2);
  noiseTex = c;
  return c;
}
function getGrain() {
  if (grainTex) return grainTex;
  const n = 256, c = mk(n, n), x = g2(c), id = x.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 90;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  grainTex = c;
  return c;
}

// ---------------------------------------------------------------- compositing
const rgba = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

function silhouette(name, layer, fill) {
  const c = tmp(name, layer.width, layer.height), x = g2(c);
  x.drawImage(layer, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = fill; x.fillRect(0, 0, c.width, c.height);
  return c;
}

function render(full) {
  const bgL = full ? S.bg.full : S.bg.prev;
  const W = bgL.w, H = bgL.h, diag = Math.hypot(W, H);
  const comp = tmp(full ? 'compFull' : 'comp', W, H), c = g2(comp);
  c.drawImage(bgL.canvas, 0, 0);
  const view = S.compare ? 'sticker' : S.view;
  const lightCol = hexToRgb(P.lightColor);
  const Lc = lightPosComp(W, H);

  if (S.ch) {
    const lv = full ? ensureFullLevel() : S.ch.prev;
    const T = charXf(lv, W, H);
    if (view === 'sticker') {
      T.apply(c); c.drawImage(lv.canvas, 0, 0); c.setTransform(1, 0, 0, 1, 0, 0);
      return comp;
    }
    const proc = processChar(lv, T, W, H);
    const layer = tmp('layer', W, H), lx = g2(layer);
    lx.imageSmoothingQuality = 'high';
    T.apply(lx); lx.drawImage(proc.base, 0, 0); lx.setTransform(1, 0, 0, 1, 0, 0);
    const fxLayer = tmp('fxLayer', W, H), fxx = g2(fxLayer);
    fxx.imageSmoothingQuality = 'high';
    T.apply(fxx); fxx.drawImage(proc.fx, 0, 0); fxx.setTransform(1, 0, 0, 1, 0, 0);
    const bs = bgStats();
    const shadowCol = bs.dark.map(v => v * 0.22);
    const feetC = T.toComp(lv.feet.u, lv.feet.v);
    const headC = T.toComp(lv.feet.u, lv.topV);

    // contact halo behind the character
    if (P.halo > 0) {
      const sil = silhouette('sil', layer, rgba(shadowCol, 1));
      const b = blurTo('haloB', sil, T.drawH * 0.03);
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = P.halo / 100 * 0.85;
      c.drawImage(b, 0, 0);
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    }
    // cast shadow on the ground
    if (P.castShadow) drawCastShadow(c, layer, T, lv, feetC, headC, Lc, shadowCol, W, H);

    c.drawImage(layer, 0, 0);

    // light wrap: blurred background bleeding into the edges
    if (P.wrap > 0) {
      const sil = silhouette('sil', layer, '#fff');
      const bsil = blurTo('wrapB', sil, T.drawH * (0.003 + P.wrapWidth / 100 * 0.02));
      const band = tmp('band', W, H), bx = g2(band);
      bx.drawImage(sil, 0, 0);
      bx.globalCompositeOperation = 'destination-out'; bx.drawImage(bsil, 0, 0);
      bx.globalCompositeOperation = 'source-in'; bx.drawImage(bgL.blur, 0, 0);
      c.globalAlpha = P.wrap / 100 * 0.3; c.drawImage(band, 0, 0);
      c.globalCompositeOperation = 'screen'; c.globalAlpha = Math.min(1, P.wrap / 100 * 1.1); c.drawImage(band, 0, 0);
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    }
    c.globalCompositeOperation = 'screen'; c.drawImage(fxLayer, 0, 0); c.globalCompositeOperation = 'source-over';
    if (P.feetFg > 0) feetForeground(c, layer, T, bgL, feetC, W, H);
    if (P.haze > 0) drawHaze(c, layer, T, bs, lightCol, W, H);
    if (P.rays > 0) drawRays(c, Lc, { x: (feetC.x + headC.x) / 2, y: (feetC.y + headC.y) / 2 }, lightCol, diag, W, H);
  } else if (P.rays > 0) {
    drawRays(c, Lc, { x: W / 2, y: H / 2 }, lightCol, diag, W, H);
  }

  // glow at the light source
  if (P.glow > 0 && P.lightPreset !== 'shadow') {
    const R = diag * (0.04 + P.glowSize / 100 * 0.45), a = P.glow / 100;
    const rg = c.createRadialGradient(Lc.x, Lc.y, 0, Lc.x, Lc.y, R);
    rg.addColorStop(0, rgba(lightCol, a)); rg.addColorStop(0.08, rgba(lightCol, a * 0.75));
    rg.addColorStop(0.35, rgba(lightCol, a * 0.25)); rg.addColorStop(1, rgba(lightCol, 0));
    c.globalCompositeOperation = 'screen'; c.fillStyle = rg; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
  }

  finishGrade(comp, W, H, diag);
  if (view === 'luma' || view === 'color') inspectView(comp);
  return comp;
}

function drawCastShadow(c, layer, T, lv, feetC, headC, Lc, shadowCol, W, H) {
  const u = { x: headC.x - feetC.x, y: headC.y - feetC.y };
  const ul = Math.hypot(u.x, u.y) || 1;
  const wv = { x: -u.y / ul, y: u.x / ul }; // perpendicular unit
  let dx = feetC.x - Lc.x, dy = feetC.y - Lc.y;
  const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  const squash = 0.32;
  let sy = dy * squash;
  if (P.lz > 0) sy = -Math.abs(sy) - 0.12 * squash; // light in front → shadow falls behind
  else sy = Math.abs(sy) + 0.06;                    // light behind → shadow toward viewer
  const len = P.shadowLen / 100 * 1.4 * ul;
  const s = { x: dx * len, y: sy * len };
  // affine A with A·u = s, A·w = w
  const det = u.x * wv.y - u.y * wv.x;
  // solve [s w] = A [u w]
  const A11 = (s.x * wv.y - wv.x * u.y) / det, A12 = (wv.x * u.x - s.x * wv.x) / det;
  const A21 = (s.y * wv.y - wv.y * u.y) / det, A22 = (wv.y * u.x - s.y * wv.x) / det;
  const sc = tmp('shadow', W, H), sx = g2(sc);
  sx.setTransform(A11, A21, A12, A22, feetC.x - (A11 * feetC.x + A12 * feetC.y), feetC.y - (A21 * feetC.x + A22 * feetC.y));
  sx.drawImage(layer, 0, 0);
  sx.setTransform(1, 0, 0, 1, 0, 0);
  sx.globalCompositeOperation = 'source-in'; sx.fillStyle = rgba(shadowCol, 1); sx.fillRect(0, 0, W, H);
  // fade with distance from the feet
  const end = { x: feetC.x + s.x, y: feetC.y + s.y };
  const lg = sx.createLinearGradient(feetC.x, feetC.y, end.x, end.y);
  lg.addColorStop(0, 'rgba(0,0,0,1)'); lg.addColorStop(1, 'rgba(0,0,0,0.15)');
  sx.globalCompositeOperation = 'destination-in'; sx.fillStyle = lg; sx.fillRect(0, 0, W, H);
  // contact shadow at the feet
  sx.globalCompositeOperation = 'source-over';
  const cw = T.drawW * 0.35, ch = T.drawH * 0.025;
  sx.save(); sx.translate(feetC.x, feetC.y - ch * 0.3); sx.scale(1, ch / cw);
  const rg = sx.createRadialGradient(0, 0, 0, 0, 0, cw);
  rg.addColorStop(0, rgba(shadowCol, 0.9)); rg.addColorStop(1, rgba(shadowCol, 0));
  sx.fillStyle = rg; sx.fillRect(-cw, -cw, cw * 2, cw * 2); sx.restore();
  const bl = blurTo('shadowB', sc, T.drawH * (0.003 + P.shadowSoft / 100 * 0.03));
  c.globalCompositeOperation = 'multiply'; c.globalAlpha = P.shadowOpacity / 100;
  c.drawImage(bl, 0, 0);
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
}

function feetForeground(c, layer, T, bgL, feetC, W, H) {
  const chH = T.drawH, chW = T.drawW, band = chH * 0.16;
  const x0 = clamp(Math.floor(feetC.x - chW * 0.75), 0, W), x1 = clamp(Math.ceil(feetC.x + chW * 0.75), 0, W);
  const y0 = clamp(Math.floor(feetC.y - band), 0, H), y1 = clamp(Math.ceil(feetC.y + chH * 0.02), 0, H);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 2 || rh < 2) return;
  const cd = c.getImageData(x0, y0, rw, rh), cp = cd.data;
  const la = layer.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, rw, rh).data;
  const bd = bgL.data, bb = bgL.blurData, amt = P.feetFg / 100;
  for (let yy = 0; yy < rh; yy++) {
    const fy = c01((yy + y0 - (feetC.y - band)) / band), fade = fy * fy * (3 - 2 * fy);
    if (fade <= 0) continue;
    for (let xx = 0; xx < rw; xx++) {
      const k = (yy * rw + xx) * 4, a = la[k + 3];
      if (!a) continue;
      const bi = ((yy + y0) * W + xx + x0) * 4;
      const Y = luma(bd[bi], bd[bi + 1], bd[bi + 2]) / 255, Yb = luma(bb[bi], bb[bi + 1], bb[bi + 2]) / 255;
      const det = c01((Y - Yb - 0.01) * 12);
      const m = c01(amt * (det * fade * 1.2 + 0.4 * fade * fade * fade)) * (a / 255);
      cp[k] += (bd[bi] - cp[k]) * m; cp[k + 1] += (bd[bi + 1] - cp[k + 1]) * m; cp[k + 2] += (bd[bi + 2] - cp[k + 2]) * m;
    }
  }
  c.putImageData(cd, x0, y0);
}

function drawHaze(c, layer, T, bs, lightCol, W, H) {
  const hz = tmp('haze', W, H), x = g2(hz);
  const col = bs.mean.map((v, i) => lerp(v, 1, 0.35) * 0.7 + lightCol[i] * 0.3);
  x.fillStyle = rgba(col, 1); x.fillRect(0, 0, W, H);
  x.globalCompositeOperation = 'destination-in';
  const bx = T.cx - T.drawW, by = T.cy - T.drawH * 0.7;
  x.drawImage(getNoise(), bx, by, T.drawW * 2, T.drawH * 1.4);
  const sil = silhouette('sil', layer, '#fff');
  const bsil = blurTo('hazeB', sil, T.drawH * 0.07);
  x.drawImage(bsil, 0, 0);
  const lg = x.createLinearGradient(0, T.cy - T.drawH * 0.1, 0, T.cy + T.drawH * 0.5);
  lg.addColorStop(0, 'rgba(0,0,0,0.25)'); lg.addColorStop(1, 'rgba(0,0,0,1)');
  x.fillStyle = lg; x.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'screen'; c.globalAlpha = P.haze / 100 * 0.9;
  c.drawImage(hz, 0, 0);
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
}

function drawRays(c, Lc, target, lightCol, diag, W, H) {
  const r = tmp('rays', W, H), x = g2(r);
  const base = Math.atan2(target.y - Lc.y, target.x - Lc.x);
  const dist = Math.hypot(target.x - Lc.x, target.y - Lc.y);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 16; i++) {
    const a = base + (rnd() - 0.5) * 1.2, wd = 0.008 + rnd() * 0.03;
    const len = (dist * 1.5 + diag * 0.2) * (0.6 + rnd() * 0.6);
    const g = x.createRadialGradient(Lc.x, Lc.y, 0, Lc.x, Lc.y, len);
    g.addColorStop(0, rgba(lightCol, 0.5 + rnd() * 0.3)); g.addColorStop(1, rgba(lightCol, 0));
    x.fillStyle = g;
    x.beginPath(); x.moveTo(Lc.x, Lc.y);
    x.lineTo(Lc.x + Math.cos(a - wd) * len, Lc.y + Math.sin(a - wd) * len);
    x.lineTo(Lc.x + Math.cos(a + wd) * len, Lc.y + Math.sin(a + wd) * len);
    x.closePath(); x.fill();
  }
  const b = blurTo('raysB', r, diag * 0.005);
  c.globalCompositeOperation = 'screen'; c.globalAlpha = P.rays / 100;
  c.drawImage(b, 0, 0);
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
}

function finishGrade(comp, W, H, diag) {
  const c = g2(comp);
  if (P.bloom > 0) {
    const sw = Math.max(2, W >> 2), sh = Math.max(2, H >> 2);
    const s = tmp('bloomS', sw, sh), sx = s.getContext('2d', { willReadFrequently: true });
    sx.drawImage(comp, 0, 0, sw, sh);
    const id = sx.getImageData(0, 0, sw, sh), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = luma(d[i], d[i + 1], d[i + 2]) / 255, f = c01((y - 0.5) / 0.5);
      d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
    }
    sx.putImageData(id, 0, 0);
    const b = blurTo('bloomB', s, sw * 0.025 + 1.5);
    c.globalCompositeOperation = 'screen'; c.globalAlpha = P.bloom / 100;
    c.imageSmoothingQuality = 'high'; c.drawImage(b, 0, 0, W, H);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  }
  if (!gradeIsIdentity()) {
    const lut = getGradeLUT(), C = [0, 0, 0];
    const cx = comp.getContext('2d', { willReadFrequently: true });
    const id = cx.getImageData(0, 0, W, H), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      lutPx(lut, d[i], d[i + 1], d[i + 2], C);
      d[i] = C[0] * 255; d[i + 1] = C[1] * 255; d[i + 2] = C[2] * 255;
    }
    cx.putImageData(id, 0, 0);
  }
  if (P.vignette > 0) {
    const rg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, diag * 0.62);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, `rgba(0,0,0,${P.vignette / 100 * 0.75})`);
    c.fillStyle = rg; c.fillRect(0, 0, W, H);
  }
  if (P.grain > 0) {
    const pat = c.createPattern(getGrain(), 'repeat');
    const sc = Math.max(1, Math.max(W, H) / 1400);
    if (pat.setTransform) pat.setTransform(new DOMMatrix([sc, 0, 0, sc, 0, 0]));
    c.globalCompositeOperation = 'overlay'; c.globalAlpha = P.grain / 100 * 0.45;
    c.fillStyle = pat; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  }
}

function inspectView(comp) {
  const cx = comp.getContext('2d', { willReadFrequently: true });
  const id = cx.getImageData(0, 0, comp.width, comp.height), d = id.data;
  const colorMode = S.view === 'color';
  for (let i = 0; i < d.length; i += 4) {
    const y = luma(d[i], d[i + 1], d[i + 2]);
    if (colorMode) { const k = 140 - y; d[i] += k; d[i + 1] += k; d[i + 2] += k; }
    else d[i] = d[i + 1] = d[i + 2] = y;
  }
  cx.putImageData(id, 0, 0);
}

// ---------------------------------------------------------------- loading
let idSeq = 1;
function setBackground(img) {
  const full = toCanvas(img, LIM.fullBg), prev = toCanvas(full, LIM.prevBg), small = toCanvas(prev, 256);
  S.bg = { id: idSeq++, full: mkBgLevel(full), prev: mkBgLevel(prev), small: { w: small.width, h: small.height, data: readData(small).data } };
  bgStatsCache.key = '';
  $('#thumbBg').src = small.toDataURL();
  autoLight(true);
  layoutFrame();
  updateExportNote();
  schedule();
}

function setCharacter(img, opts = {}) {
  const c = toCanvas(img, LIM.fullCh);
  const data = readData(c);
  const opaque = opaqueFraction(data.data) > 0.985;
  S.ch = { id: idSeq++, origData: data, w: c.width, h: c.height };
  P.cut = opaque; P.border = false; P.choke = 0;
  if (!rebuildChar()) return;
  if (!opts.keepPos) {
    const lv = S.ch.prev;
    const bw = S.bg ? S.bg.prev.w : 1, bh = S.bg ? S.bg.prev.h : 1;
    P.size = clamp(Math.round(Math.min(78, 80 * (bw / bh) * (lv.h / lv.w))), 15, 90);
    S.xf = { x: 0.5, y: clamp(0.96 - P.size / 200, 0.2, 0.9), flip: false };
  }
  $('#thumbCh').src = toCanvas(S.ch.prev.canvas, 112).toDataURL();
  if (opaque && !opts.quiet) toast('这张人物图没有透明底，已自动抠掉纯色底。不满意可以到「人物」页调「抠底容差」。');
  syncUI();
  schedule();
}

function rebuildChar() {
  const o = S.ch.origData;
  const img = new ImageData(new Uint8ClampedArray(o.data), o.width, o.height);
  if (P.cut) cutoutBorder(img, P.cutTol);
  if (P.border) removeOutline(img, P.borderTol, Math.max(2, Math.round(P.borderWidth / 1000 * Math.max(o.width, o.height))));
  if (P.choke > 0) choke(img, P.choke);
  const full = cropToAlpha(img);
  if (!full) { toast('抠完什么都不剩了，把容差调小一点'); return false; }
  S.ch.full = null;
  S.ch.fullCanvas = full;
  S.ch.prev = mkLevel(toCanvas(full, LIM.prevCh));
  S.ch.stats = charStats(S.ch.prev);
  S.ch.id = idSeq++;
  charLutCache.key = '';
  return true;
}
function ensureFullLevel() {
  if (!S.ch.full) S.ch.full = mkLevel(S.ch.fullCanvas);
  return S.ch.full;
}

function autoLight(fromBg) {
  if (!S.bg) return;
  const L = detectLight();
  if (S.lightSrc === 'auto') { S.light.x = L.x; S.light.y = L.y; }
  if (P.lightColorAuto) P.lightColor = L.color;
  if (fromBg) syncUI();
}

async function handleFile(file, kind) {
  if (!file || !file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
  busy(true);
  try {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    if (!kind) kind = opaqueFraction(readData(toCanvas(img, 200)).data) < 0.985 ? 'ch' : 'bg';
    if (kind === 'bg') setBackground(img); else setCharacter(img);
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.message || String(e));
  } finally { busy(false); }
}

// ---------------------------------------------------------------- demo images
function demoBackground() {
  const W = 1500, H = 1000, c = mk(W, H), x = g2(c);
  let g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#22343a'); g.addColorStop(0.75, '#141d20'); g.addColorStop(1, '#0d1112');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // window
  const wx = 860, wy = 110, ww = 460, wh = 520;
  g = x.createLinearGradient(wx, wy, wx + ww, wy + wh);
  g.addColorStop(0, '#fff3d2'); g.addColorStop(0.6, '#ffd08a'); g.addColorStop(1, '#e79a52');
  x.fillStyle = g; x.fillRect(wx, wy, ww, wh);
  x.fillStyle = 'rgba(70,110,70,0.55)';
  for (let i = 0; i < 26; i++) { x.beginPath(); x.ellipse(wx + Math.random() * ww, wy + wh - Math.random() * 200, 30 + Math.random() * 50, 18 + Math.random() * 30, Math.random(), 0, 7); x.fill(); }
  x.fillStyle = '#1b1612';
  x.fillRect(wx + ww / 2 - 8, wy, 16, wh); x.fillRect(wx, wy + wh * 0.45, ww, 14);
  x.lineWidth = 22; x.strokeStyle = '#1b1612'; x.strokeRect(wx, wy, ww, wh);
  // glow
  x.globalCompositeOperation = 'screen';
  let rg = x.createRadialGradient(wx + ww / 2, wy + wh / 2, 40, wx + ww / 2, wy + wh / 2, 760);
  rg.addColorStop(0, 'rgba(255,190,120,0.45)'); rg.addColorStop(1, 'rgba(255,190,120,0)');
  x.fillStyle = rg; x.fillRect(0, 0, W, H);
  x.globalCompositeOperation = 'source-over';
  // floor
  g = x.createLinearGradient(0, 740, 0, H);
  g.addColorStop(0, '#2b211b'); g.addColorStop(1, '#120d0a');
  x.fillStyle = g; x.fillRect(0, 740, W, H - 740);
  x.fillStyle = 'rgba(255,196,130,0.22)';
  x.beginPath(); x.moveTo(820, 760); x.lineTo(1340, 760); x.lineTo(1150, 1000); x.lineTo(420, 1000); x.closePath(); x.fill();
  // plants
  for (let i = 0; i < 90; i++) {
    const px = Math.random() * W, py = 900 + Math.random() * 100;
    x.strokeStyle = `rgba(${60 + Math.random() * 60},${110 + Math.random() * 70},${60 + Math.random() * 30},0.9)`;
    x.lineWidth = 2 + Math.random() * 3;
    x.beginPath(); x.moveTo(px, H); x.quadraticCurveTo(px + (Math.random() - 0.5) * 40, py, px + (Math.random() - 0.5) * 60, py - 40 - Math.random() * 60); x.stroke();
  }
  // shelf at left
  x.fillStyle = '#18120f'; x.fillRect(80, 300, 300, 440);
  x.fillStyle = '#0f0b09'; for (let i = 0; i < 4; i++) x.fillRect(80, 330 + i * 100, 300, 10);
  return c;
}
function demoCharacter() {
  const w = 520, h = 1120, c = mk(w, h), x = g2(c);
  x.lineJoin = 'round'; x.lineCap = 'round';
  const outline = '#3a2b2b';
  const shape = (fill, path) => { x.beginPath(); path(); x.fillStyle = fill; x.fill(); x.lineWidth = 4; x.strokeStyle = outline; x.stroke(); };
  // hair back
  shape('#7a4b3a', () => { x.moveTo(140, 200); x.bezierCurveTo(80, 420, 110, 620, 160, 660); x.lineTo(370, 660); x.bezierCurveTo(420, 600, 450, 420, 380, 200); x.closePath(); });
  // legs
  shape('#f3d6c4', () => { x.rect(205, 820, 40, 230); }); shape('#f3d6c4', () => { x.rect(280, 820, 40, 230); });
  shape('#2b2a33', () => { x.ellipse(222, 1068, 34, 18, 0, 0, 7); }); shape('#2b2a33', () => { x.ellipse(302, 1068, 34, 18, 0, 0, 7); });
  // dress
  shape('#f4f1ea', () => { x.moveTo(195, 340); x.lineTo(330, 340); x.lineTo(430, 860); x.quadraticCurveTo(262, 900, 95, 860); x.closePath(); });
  shape('#5aa7b8', () => { x.moveTo(178, 470); x.lineTo(348, 470); x.lineTo(356, 530); x.lineTo(170, 530); x.closePath(); });
  // arms
  shape('#f4f1ea', () => { x.moveTo(195, 350); x.quadraticCurveTo(120, 450, 140, 600); x.lineTo(180, 600); x.quadraticCurveTo(175, 470, 220, 380); x.closePath(); });
  shape('#f4f1ea', () => { x.moveTo(330, 350); x.quadraticCurveTo(405, 450, 385, 600); x.lineTo(345, 600); x.quadraticCurveTo(350, 470, 305, 380); x.closePath(); });
  shape('#f3d6c4', () => { x.arc(160, 615, 24, 0, 7); }); shape('#f3d6c4', () => { x.arc(365, 615, 24, 0, 7); });
  // neck + head
  shape('#f3d6c4', () => { x.rect(240, 280, 44, 70); });
  shape('#f3d6c4', () => { x.ellipse(262, 210, 98, 110, 0, 0, 7); });
  // bangs
  shape('#8c5a45', () => { x.moveTo(160, 220); x.bezierCurveTo(150, 90, 370, 70, 365, 220); x.quadraticCurveTo(330, 150, 290, 170); x.quadraticCurveTo(262, 130, 230, 175); x.quadraticCurveTo(200, 150, 160, 220); x.closePath(); });
  // eyes & mouth
  x.fillStyle = '#3d6f8a'; x.beginPath(); x.ellipse(225, 232, 12, 17, 0, 0, 7); x.ellipse(300, 232, 12, 17, 0, 0, 7); x.fill();
  x.fillStyle = '#fff'; x.beginPath(); x.arc(229, 225, 4, 0, 7); x.arc(304, 225, 4, 0, 7); x.fill();
  x.strokeStyle = '#a0524a'; x.lineWidth = 3; x.beginPath(); x.arc(262, 272, 10, 0.2, Math.PI - 0.2); x.stroke();
  // ribbon
  shape('#5aa7b8', () => { x.moveTo(262, 350); x.lineTo(225, 330); x.lineTo(228, 372); x.closePath(); x.moveTo(262, 350); x.lineTo(299, 330); x.lineTo(296, 372); x.closePath(); });
  return c;
}
function loadDemo() {
  S.lightSrc = 'auto';
  setBackground(demoBackground());
  setCharacter(demoCharacter(), { quiet: true });
  S.xf.x = 0.42;
  $('#thumbBg').removeAttribute('src');
  $('#thumbCh').removeAttribute('src');
  schedule();
}

// ---------------------------------------------------------------- UI schema
const B = (k, label, min = 0, max = 100, extra = {}) => ({ k, label, min, max, ...extra });
const UI = {
  light: [
    { sec: '光从哪来' },
    { type: 'src' },
    { type: 'note', text: '自动：在背景里找最亮的一片当光源。找得不对就直接拖画面里的小太阳。' },
    { sec: '人物怎么被照' },
    { type: 'presets', k: 'lightPreset', items: [
      ['auto', '自动', '✦'], ['front', '正面光', '◉'], ['top', '顶光', '⬆'], ['back', '背光', '◐', '常用'],
      ['left', '左侧光', '◧'], ['right', '右侧光', '◨'], ['bottom', '底光', '⬇'], ['shadow', '在阴影里', '☁'],
    ] },
    { type: 'note', id: 'presetNote', text: '' },
    { type: 'color', k: 'lightColor', label: '光的颜色' },
    B('intensity', '光的强度', 0, 200),
    B('lz', '光在人后↔前', -100, 100),
    B('range', '照射范围'),
    { sec: '明暗与轮廓' },
    B('rim', '轮廓光'), B('rimWidth', '轮廓光宽度'),
    B('dark', '背光面压暗'), B('shadowTint', '暗面带环境色'), B('lightTint', '亮面带光色'),
    { sec: '画面里的光' },
    B('glow', '光晕'), B('glowSize', '光晕大小'), B('rays', '光束'),
    { sec: '投影' },
    { type: 'toggle', k: 'castShadow', label: '地面投影', note: '人物全身站在地上时打开；半身、头像别开' },
    B('shadowLen', '影子长度', 0, 100, { dep: 'castShadow' }), B('shadowOpacity', '影子浓度', 0, 100, { dep: 'castShadow' }), B('shadowSoft', '影子柔和', 0, 100, { dep: 'castShadow' }),
    B('halo', '贴身暗晕'),
  ],
  blend: [
    { sec: '颜色对齐' },
    B('matchLuma', '亮度对齐'), B('matchTint', '染环境色'), B('matchSat', '饱和度对齐'),
    { type: 'note', text: '按人物身后那一块背景来算。人物挪了位置，颜色会跟着重新算。' },
    { sec: '边缘' },
    B('wrap', '光包裹'), B('wrapWidth', '包裹宽度'),
    { type: 'note', text: '光包裹：人物边缘透进一点身后的背景色，最能去掉「贴上去」的感觉。' },
    { sec: '更融一点' },
    B('feetFg', '脚下融进前景'), B('haze', '边缘烟雾'),
    { type: 'note', text: '脚下融进前景：背景是草地、花丛时，把前面的草叶盖到脚上。边缘烟雾：下半身和边缘起一层薄雾。' },
  ],
  person: [
    { sec: '位置' },
    B('size', '大小', 5, 160), B('rot', '旋转', -45, 45),
    { type: 'actions', items: [['flip', '左右翻转'], ['center', '水平居中'], ['ground', '脚踩到底']] },
    { sec: '人物本身' },
    B('chBright', '亮度', -100, 100), B('chContrast', '对比', -100, 100), B('chSat', '饱和', -100, 100), B('chTemp', '冷暖', -100, 100),
    { sec: '抠图修边' },
    { type: 'toggle', k: 'cut', label: '抠掉纯色底', note: '白底、灰底、纯色底的图用这个' },
    B('cutTol', '抠底容差', 1, 60, { dep: 'cut', heavy: true }),
    { type: 'toggle', k: 'border', label: '去贴纸白边', note: '透明底但带一圈白描边的贴纸' },
    B('borderTol', '白边容差', 1, 60, { dep: 'border', heavy: true }), B('borderWidth', '白边粗细', 1, 40, { dep: 'border', heavy: true }),
    B('choke', '边缘收缩', 0, 4, { heavy: true, unit: 'px' }),
    { type: 'note', text: '边缘还有一圈杂色？把「边缘收缩」调到 1–2。' },
  ],
  grade: [
    { sec: '风格' },
    { type: 'presets', k: 'style', cls: 'three', items: [['none', '原样'], ['film', '胶片'], ['cinema', '电影感'], ['clear', '清透'], ['dusk', '暮光暖调'], ['night', '冷夜'], ['dream', '梦幻柔光']] },
    { sec: '细调' },
    B('exposure', '曝光', -100, 100), B('temp', '色温', -100, 100), B('contrast', '对比', -100, 100), B('saturation', '饱和', -100, 100), B('fade', '褪色'),
    { type: 'color', k: 'splitShadow', label: '暗部色调', noExtra: true }, B('splitShadowAmt', '暗部染色'),
    { type: 'color', k: 'splitHigh', label: '亮部色调', noExtra: true }, B('splitHighAmt', '亮部染色'),
    B('bloom', '柔光'), B('vignette', '暗角'), B('grain', '颗粒'),
  ],
};
const PRESET_NOTES = {
  auto: '按光源和人物的位置自动判断，默认光在人物稍后方。',
  front: '光从镜头这边打过来：整体亮、轮廓光弱，适合白天、室内顺光。',
  top: '光从头顶来：上半身亮，下半身渐暗。',
  back: '光在人物身后（窗户、夕阳、路灯）：边缘亮起一圈轮廓光，身体压暗带环境色。',
  left: '光从左边来：左侧亮、右侧暗。',
  right: '光从右边来：右侧亮、左侧暗。',
  bottom: '光从下往上：篝火、屏幕、地面反光。',
  shadow: '人物站在阴影里：整体压暗、带上环境色，没有亮边。',
};

const controls = [];
function buildUI() {
  for (const [tab, items] of Object.entries(UI)) {
    const root = $('#tab-' + tab);
    for (const it of items) {
      if (it.sec) { const d = document.createElement('div'); d.className = 'sec'; d.textContent = it.sec; root.append(d); continue; }
      if (it.type === 'note') {
        const p = document.createElement('p'); p.className = 'note'; p.textContent = it.text; if (it.id) p.id = it.id; root.append(p); continue;
      }
      if (it.type === 'src') {
        const g = document.createElement('div'); g.className = 'grid-btns two';
        g.innerHTML = '<button class="chip" data-src="auto">自动找光源</button><button class="chip" data-src="drag">拖画面里的光点</button>';
        g.addEventListener('click', e => {
          const b = e.target.closest('[data-src]'); if (!b) return;
          S.lightSrc = b.dataset.src;
          if (S.lightSrc === 'auto') autoLight();
          else toast('拖动画面里的小太阳来放光源');
          syncUI(); schedule();
        });
        root.append(g);
        controls.push({ sync() { $$('[data-src]', g).forEach(b => b.classList.toggle('on', b.dataset.src === S.lightSrc)); } });
        continue;
      }
      if (it.type === 'presets') {
        const g = document.createElement('div'); g.className = 'grid-btns ' + (it.cls || '');
        for (const [v, label, ico, tag] of it.items) {
          const b = document.createElement('button'); b.className = 'chip'; b.dataset.v = v;
          b.innerHTML = (ico ? `<span class="ico">${ico}</span>` : '') + label + (tag ? `<span class="tag">${tag}</span>` : '');
          g.append(b);
        }
        g.addEventListener('click', e => {
          const b = e.target.closest('[data-v]'); if (!b) return;
          if (it.k === 'lightPreset') applyLightPreset(b.dataset.v);
          else applyStyle(b.dataset.v);
        });
        root.append(g);
        controls.push({ sync() { $$('[data-v]', g).forEach(b => b.classList.toggle('on', b.dataset.v === P[it.k])); } });
        continue;
      }
      if (it.type === 'color') {
        const row = document.createElement('div'); row.className = 'color-row';
        row.innerHTML = `<label>${it.label}</label><input type="color" value="${P[it.k]}">` +
          (it.noExtra ? '<span></span>' : '<div class="mini"><button data-a="auto">跟背景</button><button data-a="pick">画面取色</button></div>');
        const inp = $('input', row);
        inp.addEventListener('input', () => {
          P[it.k] = inp.value;
          if (it.k === 'lightColor') P.lightColorAuto = false;
          if (it.k.startsWith('split')) P.style = 'custom';
          syncUI(); schedule();
        });
        if (!it.noExtra) {
          row.addEventListener('click', e => {
            const b = e.target.closest('[data-a]'); if (!b) return;
            if (b.dataset.a === 'auto') { P.lightColorAuto = true; autoLight(); }
            else { S.pick = !S.pick; $('#frame').classList.toggle('picking', S.pick); if (S.pick) toast('点一下画面，取那里的颜色当光色'); }
            syncUI(); schedule();
          });
        }
        root.append(row);
        controls.push({ sync() {
          inp.value = P[it.k];
          if (!it.noExtra) {
            $('[data-a=auto]', row).classList.toggle('on', P.lightColorAuto);
            $('[data-a=pick]', row).classList.toggle('on', S.pick);
          }
        } });
        continue;
      }
      if (it.type === 'toggle') {
        const row = document.createElement('div'); row.className = 'toggle-row';
        row.innerHTML = `<span class="t-label">${it.label}${it.note ? `<small>${it.note}</small>` : ''}</span><label class="switch"><input type="checkbox"><span></span></label>`;
        const inp = $('input', row);
        inp.addEventListener('change', () => { setParam(it.k, inp.checked); });
        root.append(row);
        controls.push({ sync() { inp.checked = !!P[it.k]; } });
        continue;
      }
      if (it.type === 'actions') {
        const g = document.createElement('div'); g.className = 'grid-btns three';
        for (const [a, label] of it.items) { const b = document.createElement('button'); b.className = 'chip'; b.dataset.act = a; b.textContent = label; g.append(b); }
        g.addEventListener('click', e => {
          const b = e.target.closest('[data-act]'); if (!b || !S.ch) return;
          const a = b.dataset.act;
          if (a === 'flip') S.xf.flip = !S.xf.flip;
          if (a === 'center') S.xf.x = 0.5;
          if (a === 'ground') groundFeet();
          schedule();
        });
        root.append(g);
        continue;
      }
      // slider
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<label>${it.label}</label><input type="range" min="${it.min}" max="${it.max}" step="1"><output></output>`;
      const inp = $('input', row), out = $('output', row);
      const paint = () => { inp.style.setProperty('--p', ((inp.value - it.min) / (it.max - it.min) * 100) + '%'); out.textContent = inp.value + (it.unit || ''); };
      inp.addEventListener('input', () => {
        paint();
        if (it.heavy) { out.textContent = inp.value + (it.unit || ''); return; }
        setParam(it.k, +inp.value);
      });
      if (it.heavy) inp.addEventListener('change', () => setParam(it.k, +inp.value));
      inp.addEventListener('dblclick', () => { inp.value = DEF[it.k]; paint(); setParam(it.k, DEF[it.k]); });
      root.append(row);
      controls.push({ sync() { inp.value = P[it.k]; paint(); if (it.dep) row.classList.toggle('disabled', !P[it.dep]); } });
    }
  }
}
function syncUI() {
  for (const c of controls) c.sync();
  const note = $('#presetNote'); if (note) note.textContent = PRESET_NOTES[P.lightPreset] || '';
  const sun = $('#sun');
  sun.style.setProperty('--sun', P.lightColor);
}
function setParam(k, v) {
  P[k] = v;
  if (STYLE_KEYS.includes(k)) P.style = 'custom';
  if (REBUILD_KEYS.has(k) && S.ch) {
    busy(true);
    setTimeout(() => { rebuildChar(); busy(false); syncUI(); schedule(); }, 20);
    syncUI();
    return;
  }
  syncUI(); schedule();
}

function applyLightPreset(id) {
  P.lightPreset = id;
  Object.assign(P, LIGHT_PRESETS[id] || {});
  const box = charBoxNorm();
  if (box && id !== 'auto' && id !== 'back' && id !== 'shadow') {
    const top = box.cy - box.hh, bot = box.cy + box.hh;
    const pos = {
      front: [box.cx + box.hw * 0.3, top + box.hh * 0.15],
      top: [box.cx, top - 0.12],
      left: [box.cx - box.hw - 0.18, box.cy - box.hh * 0.4],
      right: [box.cx + box.hw + 0.18, box.cy - box.hh * 0.4],
      bottom: [box.cx, bot + 0.04],
    }[id];
    S.light.x = clamp(pos[0], 0.02, 0.98); S.light.y = clamp(pos[1], 0.02, 0.98);
    S.lightSrc = 'drag';
  }
  if (id === 'auto') { S.lightSrc = 'auto'; autoLight(); }
  syncUI(); schedule();
}
function applyStyle(id) {
  P.style = id;
  Object.assign(P, STYLES[id]);
  syncUI(); schedule();
}
function groundFeet() {
  if (!S.ch || !S.bg) return;
  const lv = S.ch.prev; ensureGeom(lv);
  const H = S.bg.prev.h, W = S.bg.prev.w;
  const T = charXf(lv, W, H);
  const f = T.toComp(lv.feet.u, lv.feet.v);
  S.xf.y += (H * 0.975 - f.y) / H;
}

// ---------------------------------------------------------------- display & interaction
const view = $('#view'), frame = $('#frame'), wrap = $('#wrap'), sun = $('#sun');
let rafId = 0, lastRenderMs = 0;
function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!S.bg) return;
    const t0 = performance.now();
    const comp = render(false);
    if (view.width !== comp.width || view.height !== comp.height) { view.width = comp.width; view.height = comp.height; layoutFrame(); }
    g2(view).drawImage(comp, 0, 0);
    lastRenderMs = performance.now() - t0;
    placeSun();
  });
}
function layoutFrame() {
  if (!S.bg) return;
  const r = wrap.getBoundingClientRect();
  const aw = r.width - 16, ah = r.height - 16, ar = S.bg.prev.w / S.bg.prev.h;
  let w = aw, h = aw / ar;
  if (h > ah) { h = ah; w = ah * ar; }
  frame.style.width = Math.max(10, w) + 'px'; frame.style.height = Math.max(10, h) + 'px';
  placeSun();
}
function placeSun() {
  sun.style.left = (S.light.x * 100) + '%';
  sun.style.top = (S.light.y * 100) + '%';
  sun.classList.toggle('hidden', S.view === 'sticker' || S.compare);
}
new ResizeObserver(layoutFrame).observe(wrap);

function normPoint(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
const ptrs = new Map();
let drag = null;
wrap.addEventListener('pointerdown', e => {
  if (!S.bg) return;
  const p = normPoint(e);
  if (S.pick) {
    const sm = S.bg.prev, x = clamp(Math.floor(p.x * sm.w), 0, sm.w - 1), y = clamp(Math.floor(p.y * sm.h), 0, sm.h - 1);
    const j = (y * sm.w + x) * 4, d = sm.data;
    let col = [d[j] / 255, d[j + 1] / 255, d[j + 2] / 255];
    const m = Math.max(...col, 0.05); col = col.map(v => v / m);
    P.lightColor = rgbToHex(...col); P.lightColorAuto = false; S.pick = false;
    frame.classList.remove('picking');
    syncUI(); schedule();
    return;
  }
  wrap.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 1) {
    if (e.target === sun) { drag = { mode: 'light' }; sun.classList.add('active'); }
    else if (S.ch) { drag = { mode: 'char', start: p, x: S.xf.x, y: S.xf.y }; view.classList.add('dragging'); }
  } else if (ptrs.size === 2 && S.ch) {
    const [a, b] = [...ptrs.values()];
    drag = { mode: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), size: P.size, rot: P.rot, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, x: S.xf.x, y: S.xf.y };
  }
});
wrap.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId) || !drag) return;
  const p = normPoint(e);
  ptrs.set(e.pointerId, p);
  if (drag.mode === 'light') {
    S.light.x = clamp(p.x, 0, 1); S.light.y = clamp(p.y, 0, 1);
    if (S.lightSrc !== 'drag') { S.lightSrc = 'drag'; syncUI(); }
    placeSun(); schedule();
  } else if (drag.mode === 'char') {
    S.xf.x = drag.x + (p.x - drag.start.x); S.xf.y = drag.y + (p.y - drag.start.y);
    schedule();
  } else if (drag.mode === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    P.size = clamp(drag.size * d / Math.max(0.01, drag.d), 5, 160);
    let rot = drag.rot + (ang - drag.ang) * 180 / Math.PI;
    if (rot > 180) rot -= 360; if (rot < -180) rot += 360;
    P.rot = clamp(Math.round(rot), -45, 45);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    S.xf.x = drag.x + mid.x - drag.mid.x; S.xf.y = drag.y + mid.y - drag.mid.y;
    syncUI(); schedule();
  }
});
const endPtr = e => {
  ptrs.delete(e.pointerId);
  if (ptrs.size === 0) {
    drag = null; sun.classList.remove('active'); view.classList.remove('dragging');
  } else if (ptrs.size === 1 && drag && drag.mode === 'pinch') {
    const p = [...ptrs.values()][0];
    drag = { mode: 'char', start: p, x: S.xf.x, y: S.xf.y };
  }
};
wrap.addEventListener('pointerup', endPtr);
wrap.addEventListener('pointercancel', endPtr);
wrap.addEventListener('wheel', e => {
  if (!S.ch) return;
  e.preventDefault();
  if (e.shiftKey || e.altKey) P.rot = clamp(P.rot + Math.sign(e.deltaY) * 2, -45, 45);
  else P.size = clamp(P.size * Math.exp(-e.deltaY * 0.0015), 5, 160);
  syncUI(); schedule();
}, { passive: false });

// view modes
$('#viewSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  S.view = b.dataset.v;
  $$('#viewSeg button').forEach(x => x.classList.toggle('on', x === b));
  schedule();
});
const hold = $('#holdCompare');
const setCompare = v => { S.compare = v; hold.classList.toggle('on', v); schedule(); };
hold.addEventListener('pointerdown', e => { e.preventDefault(); setCompare(true); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => hold.addEventListener(ev, () => S.compare && setCompare(false)));

// tabs
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.t));
});

// files
$('#fileBg').addEventListener('change', e => { handleFile(e.target.files[0], 'bg'); e.target.value = ''; });
$('#fileCh').addEventListener('change', e => { handleFile(e.target.files[0], 'ch'); e.target.value = ''; });
for (const [id, kind] of [['#dropBg', 'bg'], ['#dropCh', 'ch']]) {
  const el = $(id);
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('over'); handleFile(e.dataTransfer.files[0], kind); });
}
const dropOver = $('#dropOver');
wrap.addEventListener('dragover', e => { e.preventDefault(); dropOver.classList.add('on'); });
wrap.addEventListener('dragleave', e => { if (!wrap.contains(e.relatedTarget)) dropOver.classList.remove('on'); });
wrap.addEventListener('drop', e => { e.preventDefault(); dropOver.classList.remove('on'); handleFile(e.dataTransfer.files[0]); });
document.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); handleFile(item.getAsFile(), 'ch'); }
});
$('#loadDemo').addEventListener('click', loadDemo);
$('#resetAll').addEventListener('click', () => {
  const keep = { cut: P.cut, border: P.border, cutTol: P.cutTol, borderTol: P.borderTol, borderWidth: P.borderWidth, choke: P.choke, size: P.size, rot: P.rot };
  Object.assign(P, DEF, keep);
  S.lightSrc = 'auto'; autoLight();
  syncUI(); schedule(); toast('参数已恢复默认');
});

// export
function updateExportNote() {
  if (!S.bg) return;
  $('#exportNote').textContent = `按背景尺寸导出：${S.bg.full.w} × ${S.bg.full.h}`;
}
async function save(type) {
  if (!S.bg) return;
  const btns = [$('#savePng'), $('#saveJpg')];
  btns.forEach(b => (b.disabled = true)); busy(true, '正在导出高清图…');
  await new Promise(r => setTimeout(r, 30));
  try {
    const prevView = S.view, prevCmp = S.compare;
    S.view = 'blend'; S.compare = false;
    const comp = render(true);
    S.view = prevView; S.compare = prevCmp;
    const blob = await new Promise(r => comp.toBlob(r, type, 0.95));
    if (!blob) throw new Error('导出失败，图片可能太大了');
    const name = `溶光-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${type === 'image/png' ? 'png' : 'jpg'}`;
    const file = new File([blob], name, { type });
    if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已保存 ' + name);
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    btns.forEach(b => (b.disabled = false)); busy(false);
    pool.delete('compFull'); S.ch && (S.ch.full = null);
    schedule();
  }
}
$('#savePng').addEventListener('click', () => save('image/png'));
$('#saveJpg').addEventListener('click', () => save('image/jpeg'));

// misc
let toastT = 0;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
}
function busy(on, text) {
  const b = $('#busy'); b.textContent = text || '处理中…'; b.classList.toggle('on', on);
}

buildUI();
syncUI();
loadDemo();
window.__rongguang = { S, P, render };
})();
