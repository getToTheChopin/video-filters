// filters.js - Filter pipeline and list

export const FilterList = [
  { key: 'normal', name: 'Normal', kind: 'simple', value: 'none' },
  { key: 'grayscale', name: 'Grayscale', kind: 'simple', value: 'grayscale(1)' },
  { key: 'sepia', name: 'Sepia', kind: 'simple', value: 'sepia(1)' },
  { key: 'invert', name: 'Invert', kind: 'simple', value: 'invert(1)' },
  { key: 'hue', name: 'Hue Rotate', kind: 'simple', value: 'hue-rotate(180deg)' },
  { key: 'blur', name: 'Blur', kind: 'simple', value: 'blur(4px)' },
  { key: 'pixelate', name: 'Pixelate', kind: 'pixelate' },
  { key: 'edge', name: 'Edge Detect', kind: 'edge' },
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

    switch (filterKey) {
      case 'normal':
        this.drawMirrored(offCtx, video, w, h, 'none');
        break;
      case 'grayscale':
        this.drawMirrored(offCtx, video, w, h, 'grayscale(1)');
        break;
      case 'sepia':
        this.drawMirrored(offCtx, video, w, h, 'sepia(1)');
        break;
      case 'invert':
        this.drawMirrored(offCtx, video, w, h, 'invert(1)');
        break;
      case 'hue':
        this.drawMirrored(offCtx, video, w, h, 'hue-rotate(180deg)');
        break;
      case 'blur':
        this.drawMirrored(offCtx, video, w, h, 'blur(4px)');
        break;
      case 'pixelate':
        this.renderPixelate(offCtx, video);
        break;
      case 'edge':
        this.renderEdge(offCtx, video);
        break;
      default:
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
