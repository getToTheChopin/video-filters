// filters.js - Filter pipeline and list

export const FilterList = [
  { key: 'normal', name: 'Normal', kind: 'css', value: 'none' },
  { key: 'teal_orange', name: 'Cinematic Teal & Orange', kind: 'css', value: 'contrast(1.15) saturate(1.2) sepia(0.25) hue-rotate(330deg) saturate(1.2)' },
  { key: 'kodak_warm', name: 'Kodak Warm', kind: 'css', value: 'contrast(1.1) brightness(1.05) saturate(1.15) sepia(0.15)' },
  { key: 'fuji_cool', name: 'Fuji Cool', kind: 'css', value: 'contrast(1.05) brightness(1.03) saturate(1.1) hue-rotate(205deg)' },
  { key: 'bleach_bypass', name: 'Bleach Bypass', kind: 'css', value: 'contrast(1.4) saturate(0.3) brightness(1.02)' },
  { key: 'film_noir', name: 'Film Noir', kind: 'css', value: 'grayscale(1) contrast(1.2) brightness(1.02)' },
  { key: 'vintage_fade', name: 'Vintage Fade', kind: 'css', value: 'contrast(0.9) brightness(1.06) saturate(0.8) sepia(0.2)' },
  { key: 'matte_pastel', name: 'Matte Pastel', kind: 'css', value: 'contrast(0.85) brightness(1.08) saturate(0.9)' },
  { key: 'vivid_pop', name: 'Vivid Pop', kind: 'css', value: 'contrast(1.2) saturate(1.35) brightness(1.02)' },
  { key: 'muted', name: 'Muted', kind: 'css', value: 'contrast(0.95) saturate(0.75)' },
  { key: 'golden_hour', name: 'Golden Hour', kind: 'css', value: 'sepia(0.2) hue-rotate(345deg) contrast(1.05) brightness(1.1) saturate(1.1)' },
  { key: 'cool_night', name: 'Cool Night', kind: 'css', value: 'hue-rotate(210deg) contrast(1.08) brightness(0.98) saturate(1.05)' },
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

  apply(offCtx, video, filterKey) {
    const w = this.w; const h = this.h;
    if (!w || !h) return;

    const meta = FilterList.find(f => f.key === filterKey);
    if (meta) {
      if (meta.kind === 'css' || meta.kind === 'simple') {
        this.drawMirrored(offCtx, video, w, h, meta.value || 'none');
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
