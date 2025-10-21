// filters.js - Filter pipeline and list (reduced palettes with LUT-based looks)

// Utility helpers
function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function mix(a, b, t) { return a + (b - a) * t; }

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max - min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [r, g, b];
}

function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// Gentle S-curve around 0.5; c in [-1, 1]
function sCurve(x, c) {
  // Map contrast param to slope factor
  const k = 1 + c; // c>0 increases contrast, c<0 decreases
  let y = (x - 0.5) * k + 0.5;
  return clamp01(y);
}

// 3D LUT generation (size^3 * 3 floats)
function generate3DLUT(size, transformFn) {
  const n = size;
  const data = new Float32Array(n * n * n * 3);
  let idx = 0;
  for (let ri = 0; ri < n; ri++) {
    for (let gi = 0; gi < n; gi++) {
      for (let bi = 0; bi < n; bi++) {
        const r = ri / (n - 1);
        const g = gi / (n - 1);
        const b = bi / (n - 1);
        const out = transformFn(r, g, b);
        data[idx++] = clamp01(out[0]);
        data[idx++] = clamp01(out[1]);
        data[idx++] = clamp01(out[2]);
      }
    }
  }
  return { size: n, data };
}

// Trilinear sampling from 3D LUT
function sampleLUT3D(lut, r, g, b) {
  const n = lut.size;
  const d = lut.data;
  const rf = r * (n - 1);
  const gf = g * (n - 1);
  const bf = b * (n - 1);
  const r0 = Math.floor(rf), r1 = Math.min(n - 1, r0 + 1);
  const g0 = Math.floor(gf), g1 = Math.min(n - 1, g0 + 1);
  const b0 = Math.floor(bf), b1 = Math.min(n - 1, b0 + 1);
  const tr = rf - r0, tg = gf - g0, tb = bf - b0;

  const idx = (ri, gi, bi) => ((ri * n + gi) * n + bi) * 3;

  const c000 = idx(r0, g0, b0);
  const c100 = idx(r1, g0, b0);
  const c010 = idx(r0, g1, b0);
  const c110 = idx(r1, g1, b0);
  const c001 = idx(r0, g0, b1);
  const c101 = idx(r1, g0, b1);
  const c011 = idx(r0, g1, b1);
  const c111 = idx(r1, g1, b1);

  const lerp3 = (i0, i1, t) => [
    mix(d[i0], d[i1], t),
    mix(d[i0 + 1], d[i1 + 1], t),
    mix(d[i0 + 2], d[i1 + 2], t),
  ];

  const x00 = lerp3(c000, c100, tr);
  const x10 = lerp3(c010, c110, tr);
  const x01 = lerp3(c001, c101, tr);
  const x11 = lerp3(c011, c111, tr);

  const y0 = [ mix(x00[0], x10[0], tg), mix(x00[1], x10[1], tg), mix(x00[2], x10[2], tg) ];
  const y1 = [ mix(x01[0], x11[0], tg), mix(x01[1], x11[1], tg), mix(x01[2], x11[2], tg) ];

  return [ mix(y0[0], y1[0], tb), mix(y0[1], y1[1], tb), mix(y0[2], y1[2], tb) ];
}

// Looks (procedural transforms)
function lookWongKarWaiNeon(r, g, b) {
  // High-contrast, teal/green shadows and warm highlights
  const y = luma(r, g, b);
  const shadows = Math.pow(1 - y, 1.25);
  const highs = Math.pow(y, 1.5);

  // Split tone
  r += -0.02 * shadows + 0.06 * highs;
  g +=  0.08 * shadows + 0.03 * highs;
  b +=  0.06 * shadows - 0.03 * highs;

  // S-curve contrast
  r = sCurve(r, 0.25);
  g = sCurve(g, 0.25);
  b = sCurve(b, 0.25);

  // Slight saturation boost
  let [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
  s = clamp01(s * 1.25);
  l = clamp01(l * 0.98 + 0.01); // tiny density
  const rgb = hslToRgb(h, s, l);
  return rgb;
}

function lookWesAndersonPastel(r, g, b) {
  // Warm, lifted shadows, pastel compression
  let [h, s, l] = rgbToHsl(r, g, b);
  // compress contrast and lift shadows
  l = mix(l, 0.5 + (l - 0.5) * 0.8, 0.6); // gentler contrast
  l = l * 0.95 + 0.03; // slight lift
  s = clamp01(s * 0.9 + 0.05); // pastel saturation

  // warm bias
  let [rr, gg, bb] = hslToRgb(h, s, l);
  const y = luma(rr, gg, bb);
  const warm = Math.pow(y, 1.2);
  rr += 0.04 * warm;
  gg += 0.02 * warm;
  bb -= 0.015 * warm;
  return [clamp01(rr), clamp01(gg), clamp01(bb)];
}

function lookWesAndersonVintageWarm(r, g, b) {
  // Slight sepia, gentle contrast, creamy highlights
  const y = luma(r, g, b);
  const lift = 0.05;
  r = mix(r, r + lift, 0.3);
  g = mix(g, g + lift, 0.25);
  b = mix(b, b + lift, 0.15);

  // Warm split toning
  const highs = Math.pow(y, 1.4);
  r += 0.05 * highs;
  g += 0.025 * highs;
  b -= 0.02 * highs;

  // Gentle desat
  let [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
  s = clamp01(s * 0.92);
  l = clamp01(l * 1.02);
  return hslToRgb(h, s, l);
}

function lookWongKarWaiVerdant(r, g, b) {
  // Verdant green mood: green/yellow cast, cooler blues, moderate contrast
  const y = luma(r, g, b);
  const shadows = Math.pow(1 - y, 1.3);
  const mids = Math.pow(1 - Math.abs(y - 0.5) * 2, 1.5);

  // Green cast especially in mids and shadows
  g += 0.06 * mids + 0.05 * shadows;
  r += 0.01 * mids - 0.02 * shadows;
  b -= 0.01 * mids + 0.015 * highsSafe(y);

  // Slight contrast and mild desat for mood
  r = sCurve(r, 0.15);
  g = sCurve(g, 0.15);
  b = sCurve(b, 0.15);

  let [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
  s = clamp01(s * 0.95);
  l = clamp01(l * 0.98 + 0.01);
  return hslToRgb(h, s, l);
}

function highsSafe(y) { return Math.pow(y, 1.2); }

// Build LUTs for each look (size 17 is a good trade-off)
const LUT_SIZE = 17;
const makeLUT_WKW_Neon = () => generate3DLUT(LUT_SIZE, lookWongKarWaiNeon);
const makeLUT_WKW_Verdant = () => generate3DLUT(LUT_SIZE, lookWongKarWaiVerdant);
const makeLUT_WA_Pastel = () => generate3DLUT(LUT_SIZE, lookWesAndersonPastel);
const makeLUT_WA_Vintage = () => generate3DLUT(LUT_SIZE, lookWesAndersonVintageWarm);

export const FilterList = [
  { key: 'normal', name: 'Normal', kind: 'css', value: 'none' },
  { key: 'wkw_neon', name: 'Wong Kar‑Wai • Neon Night', kind: 'lut', makeLUT: makeLUT_WKW_Neon, strength: 1.0 },
  { key: 'wkw_verdant', name: 'Wong Kar‑Wai • Verdant Mood', kind: 'lut', makeLUT: makeLUT_WKW_Verdant, strength: 0.95 },
  { key: 'wes_pastel', name: 'Wes Anderson • Pastel Pop', kind: 'lut', makeLUT: makeLUT_WA_Pastel, strength: 0.95 },
  { key: 'wes_vintage', name: 'Wes Anderson • Vintage Warm', kind: 'lut', makeLUT: makeLUT_WA_Vintage, strength: 0.95 },
];

export class FilterPipeline {
  constructor() {
    this.pixelCanvas = document.createElement('canvas');
    this.pixelCtx = this.pixelCanvas.getContext('2d', { willReadFrequently: false });

    this.edgeCache = {
      imageData: null,
      lastUpdateTs: 0,
      frameCounter: 0,
      skip: 1, // compute every (skip+1) frames
    };

    this.lutCache = new Map(); // key -> { size, data }

    this.w = 0;
    this.h = 0;
  }

  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    const targetSmallW = Math.max(32, Math.round(w / 24));
    const targetSmallH = Math.max(32, Math.round(h / 24));
    this.pixelCanvas.width = targetSmallW;
    this.pixelCanvas.height = targetSmallH;
  }

  drawMirrored(ctx, source, w, h, filterStr = 'none') {
    ctx.save();
    ctx.filter = filterStr || 'none';
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(source, 0, 0, w, h);
    ctx.restore();
    ctx.filter = 'none';
  }

  getOrCreateLUT(meta) {
    if (this.lutCache.has(meta.key)) return this.lutCache.get(meta.key);
    const built = meta.makeLUT();
    this.lutCache.set(meta.key, built);
    return built;
  }

  apply(offCtx, video, filterKey) {
    const w = this.w; const h = this.h;
    if (!w || !h) return;

    const meta = FilterList.find(f => f.key === filterKey);
    if (meta) {
      if (meta.kind === 'css' || meta.kind === 'simple') {
        this.drawMirrored(offCtx, video, w, h, meta.value || 'none');
        return;
      }
      if (meta.kind === 'lut') {
        this.renderLUT(offCtx, video, meta);
        return;
      }
      if (meta.kind === 'pixelate') {
        this.renderPixelate(offCtx, video);
        return;
      }
      if (meta.kind === 'edge') {
        this.renderEdge(offCtx, video);
        return;
      }
    }

    // Support special keys even if not present in FilterList
    if (filterKey === 'pixelate') {
      this.renderPixelate(offCtx, video);
    } else if (filterKey === 'edge') {
      this.renderEdge(offCtx, video);
    } else {
      this.drawMirrored(offCtx, video, w, h, 'none');
    }
  }

  renderPixelate(offCtx, video) {
    const w = this.w; const h = this.h;
    if (!w || !h) return;

    const pctx = this.pixelCtx;
    pctx.save();
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0,0,this.pixelCanvas.width, this.pixelCanvas.height);
    // Mirror into small canvas
    pctx.translate(this.pixelCanvas.width, 0);
    pctx.scale(-1, 1);
    pctx.drawImage(video, 0, 0, this.pixelCanvas.width, this.pixelCanvas.height);
    pctx.restore();

    offCtx.save();
    offCtx.imageSmoothingEnabled = false;
    offCtx.clearRect(0, 0, w, h);
    offCtx.drawImage(this.pixelCanvas, 0, 0, this.pixelCanvas.width, this.pixelCanvas.height, 0, 0, w, h);
    offCtx.restore();
  }

  renderEdge(offCtx, video) {
    const w = this.w; const h = this.h;
    if (!w || !h) return;

    // First draw mirrored frame into offscreen
    this.drawMirrored(offCtx, video, w, h, 'none');

    // Throttle heavy processing
    const ec = this.edgeCache;
    ec.frameCounter++;
    const shouldCompute = (ec.frameCounter % (ec.skip + 1)) === 0 || !ec.imageData;

    if (shouldCompute) {
      const frame = offCtx.getImageData(0, 0, w, h);
      const edged = sobelEdge(frame, w, h);
      ec.imageData = edged;
      ec.lastUpdateTs = performance.now();
    }

    if (ec.imageData) {
      offCtx.putImageData(ec.imageData, 0, 0);
    }
  }

  renderLUT(offCtx, video, meta) {
    const w = this.w; const h = this.h;
    if (!w || !h) return;

    // Draw mirrored frame first
    this.drawMirrored(offCtx, video, w, h, 'none');

    const frame = offCtx.getImageData(0, 0, w, h);
    const data = frame.data;
    const lut = this.getOrCreateLUT(meta);
    const strength = typeof meta.strength === 'number' ? meta.strength : 1.0;

    // Apply 3D LUT with trilinear interpolation
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const [lr, lg, lb] = sampleLUT3D(lut, r, g, b);
      data[i]     = Math.round(clamp01(mix(r, lr, strength)) * 255);
      data[i + 1] = Math.round(clamp01(mix(g, lg, strength)) * 255);
      data[i + 2] = Math.round(clamp01(mix(b, lb, strength)) * 255);
      // alpha preserved
    }

    offCtx.putImageData(frame, 0, 0);
  }
}

// Sobel edge detection on ImageData -> returns new ImageData
export function sobelEdge(imageData, width, height) {
  const src = imageData.data;
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const r = src[j], g = src[j+1], b = src[j+2];
    gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const out = new Uint8ClampedArray(src.length);
  const w = width, h = height;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1], tc = gray[i - w], tr = gray[i - w + 1];
      const ml = gray[i - 1],       mc = gray[i],     mr = gray[i + 1];
      const bl = gray[i + w - 1], bc = gray[i + w], br = gray[i + w + 1];

      const gx = -tl + tr + -2 * ml + 2 * mr + -bl + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;

      const mag = Math.sqrt(gx * gx + gy * gy) * 0.25; // scale
      const v = mag > 255 ? 255 : mag;
      const o = i * 4;
      out[o] = out[o+1] = out[o+2] = v;
      out[o+3] = 255;
    }
  }

  return new ImageData(out, width, height);
}
