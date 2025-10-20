import { FilterList, FilterPipeline } from './filters.js';

const state = {
  filterIndex: 0,
  handsBusy: false,
  lastHandsSend: 0,
  handsResults: null,
  videoReady: false,
};

// UI Elements
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d', { alpha: false });
const video = document.getElementById('webcam');
const hud = document.getElementById('hud');
const labelEl = document.getElementById('label');
const errorEl = document.getElementById('error');
const retryBtn = document.getElementById('retryBtn');

let rafId = 0;
const offscreen = document.createElement('canvas');
const offctx = offscreen.getContext('2d', { willReadFrequently: true });
const pipeline = new FilterPipeline();
let coverRect = { x: 0, y: 0, w: 0, h: 0 };
let overlayTimer = null;

// Clap detection state
const clapDetector = createClapDetector();

function showHUD() {
  hud.classList.remove('hidden');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => hud.classList.add('hidden'), 2800);
}

function setLabel(text) {
  labelEl.textContent = text;
  showHUD();
}

function nextFilter() {
  state.filterIndex = (state.filterIndex + 1) % FilterList.length;
  setLabel(`${FilterList[state.filterIndex].name} • Clap to change • Space = next`);
}

function prevFilter() {
  state.filterIndex = (state.filterIndex - 1 + FilterList.length) % FilterList.length;
  setLabel(`${FilterList[state.filterIndex].name} • Clap to change • Space = next`);
}

function computeCoverRect(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const x = Math.round((dstW - w) / 2);
  const y = Math.round((dstH - h) / 2);
  return { x, y, w, h };
}

function handleResize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (video.videoWidth && video.videoHeight) {
    coverRect = computeCoverRect(video.videoWidth, video.videoHeight, canvas.width, canvas.height);
  }
}

window.addEventListener('resize', handleResize);

function showError(msg) {
  errorEl.querySelector('p').textContent = msg;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

retryBtn.addEventListener('click', () => {
  hideError();
  stop();
  start();
});

function startDrawLoop() {
  cancelAnimationFrame(rafId);
  const draw = () => {
    rafId = requestAnimationFrame(draw);
    if (!state.videoReady) return;

    // Ensure offscreen is sized to the video dimensions
    if (offscreen.width !== video.videoWidth || offscreen.height !== video.videoHeight) {
      offscreen.width = video.videoWidth;
      offscreen.height = video.videoHeight;
      pipeline.resize(offscreen.width, offscreen.height);
      coverRect = computeCoverRect(offscreen.width, offscreen.height, canvas.width, canvas.height);
    }

    // Apply current filter into offscreen (mirrored)
    const currentKey = FilterList[state.filterIndex].key;
    pipeline.apply(offctx, video, currentKey);

    // Draw to visible canvas with cover behaviour
    ctx.save();
    ctx.imageSmoothingEnabled = currentKey !== 'pixelate';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, coverRect.x, coverRect.y, coverRect.w, coverRect.h);
    ctx.restore();

    // Try to run hands every ~33ms without blocking RAF
    const now = performance.now();
    if (!state.handsBusy && now - state.lastHandsSend > 33 && video.readyState >= 2) {
      state.handsBusy = true;
      state.lastHandsSend = now;
      hands.send({ image: video }).then(() => {
        state.handsBusy = false;
      }).catch(() => {
        state.handsBusy = false;
      });
    }
  };
  draw();
}

function createClapDetector() {
  const thresholdRel = 0.12; // relative to min(width,height)
  const minDurationMs = 120;
  const cooldownMs = 800;
  const hysteresisUp = thresholdRel * 1.3;

  let belowSince = null;
  let cooldownUntil = 0;
  let inClapZone = false;

  return {
    update(distNorm, bothHands, now) {
      if (!bothHands) {
        belowSince = null;
        inClapZone = false;
        return false;
      }
      if (now < cooldownUntil) {
        return false;
      }

      if (!inClapZone && distNorm < thresholdRel) {
        if (belowSince == null) belowSince = now;
        if (now - belowSince >= minDurationMs) {
          inClapZone = true;
          cooldownUntil = now + cooldownMs;
          belowSince = null;
          return true; // trigger
        }
      } else if (inClapZone && distNorm > hysteresisUp) {
        // Reset when hands moved apart sufficiently
        inClapZone = false;
      } else if (!inClapZone && distNorm >= thresholdRel) {
        belowSince = null;
      }
      return false;
    }
  };
}

// Lightweight exponential smoother for 2D points
function makePointSmoother(alpha = 0.5) {
  let pt = null;
  return {
    push(x, y) {
      if (pt == null) { pt = { x, y }; }
      else { pt = { x: pt.x * (1 - alpha) + x * alpha, y: pt.y * (1 - alpha) + y * alpha } }
      return pt;
    },
    get() { return pt; },
    reset() { pt = null; }
  };
}

const leftSmoother = makePointSmoother(0.4);
const rightSmoother = makePointSmoother(0.4);

function palmCenter(landmarks) {
  // Use wrist + MCP joints for a stable palm center
  const idx = [0, 1, 5, 9, 13, 17];
  let sx = 0, sy = 0;
  for (let i = 0; i < idx.length; i++) {
    const p = landmarks[idx[i]];
    sx += p.x; sy += p.y;
  }
  return { x: sx / idx.length, y: sy / idx.length };
}

// MediaPipe Hands
let hands = null;

async function initHands() {
  hands = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({
    selfieMode: true,
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  hands.onResults(onHandsResults);
}

function onHandsResults(results) {
  state.handsResults = results;

  const multi = results.multiHandLandmarks || [];
  const handed = results.multiHandedness || [];

  // Map hands by label
  let leftLm = null, rightLm = null;
  for (let i = 0; i < multi.length; i++) {
    const label = handed[i] && handed[i].label || '';
    if (label.toLowerCase() === 'left') leftLm = multi[i];
    else if (label.toLowerCase() === 'right') rightLm = multi[i];
  }

  const both = !!(leftLm && rightLm);
  if (!both) {
    leftSmoother.reset();
    rightSmoother.reset();
    return;
  }

  const lC = palmCenter(leftLm);
  const rC = palmCenter(rightLm);

  const ls = leftSmoother.push(lC.x, lC.y);
  const rs = rightSmoother.push(rC.x, rC.y);

  // Compute normalized distance in pixels relative to min dimension
  const vw = video.videoWidth || offscreen.width || 1;
  const vh = video.videoHeight || offscreen.height || 1;
  const dx = (ls.x - rs.x) * vw;
  const dy = (ls.y - rs.y) * vh;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const norm = dist / Math.min(vw, vh);

  const fired = clapDetector.update(norm, true, performance.now());
  if (fired) {
    nextFilter();
  }
}

async function initCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('getUserMedia is not supported in this browser.');
  }
  const constraints = {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user'
    },
    audio: false
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
  await new Promise(res => {
    if (video.readyState >= 2) return res();
    video.onloadedmetadata = () => res();
  });
  state.videoReady = true;
  handleResize();
}

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (e.shiftKey) prevFilter(); else nextFilter();
    }
  });
}

async function start() {
  try {
    hideError();
    await initHands();
    await initCamera();
    handleResize();
    setLabel(`${FilterList[state.filterIndex].name} • Clap to change • Space = next`);
    startDrawLoop();
  } catch (err) {
    console.error(err);
    showError((err && err.message) ? err.message : 'Unknown error starting camera.');
  }
}

function stop() {
  cancelAnimationFrame(rafId);
  const stream = video.srcObject;
  if (stream && stream.getTracks) {
    stream.getTracks().forEach(t => t.stop());
  }
  video.srcObject = null;
  state.videoReady = false;
}

bindKeys();
handleResize();
start();
