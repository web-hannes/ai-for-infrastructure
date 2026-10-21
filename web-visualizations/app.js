const CONFIG = {
  dataPath: '/inD-dataset-v1.1/data',
  fps: 25,
  scaleDown: 12,
  maxBoundingBoxes: 80,
  locationMap: {
    1: [7,8,9,10,11,12,13,14,15,16,17],
    2: [18,19,20,21,22,23,24,25,26,27,28,29],
    3: [30,31,32],
    4: [0,1,2,3,4,5,6],
  },
  // orthoPxToMeter per location, from recordingMeta.csv
  orthoScale: {
    1: 0.0081463609172491,
    2: 0.008146360917245,
    3: 0.0081463537957561,
    4: 0.0126999352667008,
  },
};

// Reverse lookup: recording id → location id
const recToLocation = Object.fromEntries(
  Object.entries(CONFIG.locationMap).flatMap(([loc, recs]) =>
    recs.map(r => [r, parseInt(loc)])
  )
);

const dom = {
  selLocation:  document.getElementById('sel-location'),
  selRecording: document.getElementById('sel-recording'),
  selTrack:     document.getElementById('sel-track'),
  status:       document.getElementById('status'),
  canvas:       document.getElementById('canvas'),
  placeholder:  document.getElementById('placeholder'),
  canvasWrap:   document.getElementById('canvas-wrap'),
  trackInfo:    document.getElementById('track-info'),
  infoId:       document.getElementById('i-id'),
  infoClass:    document.getElementById('i-class'),
  infoFrames:   document.getElementById('i-frames'),
  infoDur:      document.getElementById('i-dur'),
  infoSize:     document.getElementById('i-size'),
};

const ctx = dom.canvas.getContext('2d');

let bgImage        = null;
let tracksIndex    = {};  // trackId → [{xCenter, yCenter, heading, width, length}]
let tracksMeta     = {};  // trackId → row from tracksMeta CSV
let currentRecId   = null;

// ── Utilities ────────────────────────────────────────────────────────────────

function setStatus(msg, loading = false) {
  dom.status.textContent = msg;
  dom.status.className = loading ? 'loading' : '';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function fetchCSV(url) {
  return new Promise((resolve, reject) =>
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: true,
      complete: result => resolve(result.data.filter(row => row.trackId != null)),
      error: reject,
    })
  );
}

function padId(id) {
  return String(id).padStart(2, '0');
}

// Converts local-metre coords to canvas pixels.
// Local origin (0,0) maps to pixel (0,0) of the background image.
// y is flipped because local +y is up while canvas +y is down.
function makeCoordTransform(locationId) {
  const pxPerMeter = 1 / (CONFIG.orthoScale[locationId] * CONFIG.scaleDown);
  return (x, y) => [x * pxPerMeter, -y * pxPerMeter];
}

function drawMarker(x, y, fill) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Event handlers ───────────────────────────────────────────────────────────

dom.selLocation.addEventListener('change', () => {
  const loc = parseInt(dom.selLocation.value);

  dom.selRecording.innerHTML = '<option value="">Select recording…</option>';
  dom.selTrack.disabled = true;
  dom.selTrack.innerHTML = '<option value="">Load a recording first…</option>';
  dom.trackInfo.classList.remove('visible');

  if (!loc) {
    dom.selRecording.disabled = true;
    return;
  }

  for (const id of CONFIG.locationMap[loc]) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `Recording ${padId(id)}`;
    dom.selRecording.appendChild(option);
  }

  dom.selRecording.disabled = false;
  setStatus('Select a recording');
});

dom.selRecording.addEventListener('change', async () => {
  if (!dom.selRecording.value) return;
  await loadRecording(parseInt(dom.selRecording.value));
});

dom.selTrack.addEventListener('change', () => {
  const tid = parseInt(dom.selTrack.value);
  if (!isNaN(tid)) renderTrack(tid);
});

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadRecording(recId) {
  const pad = padId(recId);

  dom.selTrack.disabled = true;
  dom.selTrack.innerHTML = '<option value="">Loading…</option>';
  dom.trackInfo.classList.remove('visible');

  setStatus('Loading background image…', true);
  try {
    bgImage = await loadImage(`${CONFIG.dataPath}/${pad}_background.png`);
  } catch {
    setStatus('Failed to load background image');
    return;
  }

  dom.placeholder.style.display = 'none';
  dom.canvasWrap.style.display = 'block';
  dom.canvas.width  = bgImage.width;
  dom.canvas.height = bgImage.height;
  ctx.drawImage(bgImage, 0, 0);

  setStatus('Loading track metadata…', true);
  try {
    const rows = await fetchCSV(`${CONFIG.dataPath}/${pad}_tracksMeta.csv`);
    tracksMeta = Object.fromEntries(rows.map(r => [r.trackId, r]));
  } catch {
    setStatus('Failed to load track metadata');
    return;
  }

  setStatus('Parsing trajectories…', true);
  tracksIndex = {};

  await new Promise((resolve, reject) =>
    Papa.parse(`${CONFIG.dataPath}/${pad}_tracks.csv`, {
      download: true,
      header: true,
      dynamicTyping: true,
      chunk({ data }) {
        for (const row of data) {
          if (row.trackId == null) continue;
          (tracksIndex[row.trackId] ??= []).push({
            xCenter: row.xCenter,
            yCenter: row.yCenter,
            heading: row.heading,
            width:   row.width,
            length:  row.length,
          });
        }
      },
      complete: resolve,
      error: reject,
    })
  );

  const ids = Object.keys(tracksIndex).map(Number).sort((a, b) => a - b);

  dom.selTrack.innerHTML = '<option value="">Select track…</option>';
  for (const tid of ids) {
    const meta   = tracksMeta[tid];
    const option = document.createElement('option');
    option.value = tid;
    option.textContent = `#${tid} – ${meta?.class ?? '?'}  (${meta?.numFrames ?? '?'} frames)`;
    dom.selTrack.appendChild(option);
  }

  dom.selTrack.disabled = false;
  currentRecId = recId;
  setStatus(`Ready · ${ids.length} tracks`);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTrack(trackId) {
  const frames = tracksIndex[trackId];
  if (!frames || !bgImage) return;

  const toPixel = makeCoordTransform(recToLocation[currentRecId]);
  const n       = frames.length;
  const isVRU   = frames[0].width === 0;

  ctx.drawImage(bgImage, 0, 0);

  // Path
  ctx.beginPath();
  const [x0, y0] = toPixel(frames[0].xCenter, frames[0].yCenter);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < n; i++) {
    const [xi, yi] = toPixel(frames[i].xCenter, frames[i].yCenter);
    ctx.lineTo(xi, yi);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.stroke();

  // Bounding boxes / VRU circles, subsampled for clarity
  const step = Math.max(1, Math.floor(n / CONFIG.maxBoundingBoxes));
  for (let i = 0; i < n; i += step) {
    const f = frames[i];
    const [cpx, cpy] = toPixel(f.xCenter, f.yCenter);
    const t = n > 1 ? i / (n - 1) : 0;

    // Colour gradient: blue (start) → orange-red (end)
    const colour = `rgba(${Math.round(t * 220)},80,${Math.round((1 - t) * 220)},0.75)`;

    if (!isVRU && f.length > 0) {
      const pxPerMeter = 1 / (CONFIG.orthoScale[recToLocation[currentRecId]] * CONFIG.scaleDown);
      const lp  = f.length * pxPerMeter;
      const wp  = f.width  * pxPerMeter;
      const ang = -f.heading * Math.PI / 180; // y-flip: canvas +y is down
      ctx.save();
      ctx.translate(cpx, cpy);
      ctx.rotate(ang);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-lp / 2, -wp / 2, lp, wp);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(cpx, cpy, 3, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
    }
  }

  const [ex, ey] = toPixel(frames[n - 1].xCenter, frames[n - 1].yCenter);
  drawMarker(ex, ey, '#ff4444');
  drawMarker(x0, y0, '#00ee77');

  const meta = tracksMeta[trackId];
  dom.infoId.textContent     = trackId;
  dom.infoClass.textContent  = meta?.class ?? '?';
  dom.infoFrames.textContent = n;
  dom.infoDur.textContent    = `${(n / CONFIG.fps).toFixed(1)} s`;
  dom.infoSize.textContent   = meta?.length > 0
    ? `${meta.length.toFixed(2)} × ${meta.width.toFixed(2)} m`
    : 'N/A (VRU)';

  dom.trackInfo.classList.add('visible');
}
