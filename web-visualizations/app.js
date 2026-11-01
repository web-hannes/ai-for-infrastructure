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
  // Manoeuvre classification. Must stay in sync with feature-analysis.ipynb
  // (HEADING_WINDOW, STRAIGHT_MAX_DEG, UTURN_MIN_DEG, STATIONARY_MAX_KMH).
  headingWindow:     10,   // frames averaged for a stable entry/exit heading
  straightMaxDeg:    30,
  uturnMinDeg:       150,
  stationaryMaxKmh:  5,
};

const MANEUVER_LABELS = {
  straight:   { symbol: '↑', text: 'Straight'   },
  left:       { symbol: '↰', text: 'Left turn'  },
  right:      { symbol: '↱', text: 'Right turn' },
  'u-turn':   { symbol: '↺', text: 'U-turn'     },
  stationary: { symbol: '■', text: 'Stationary' },
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
  selClass:     document.getElementById('sel-class'),
  selManeuver:  document.getElementById('sel-maneuver'),
  selCleaning:  document.getElementById('sel-cleaning'),
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
  infoDist:     document.getElementById('i-dist'),
  infoManeuver: document.getElementById('i-maneuver'),
  infoDelta:    document.getElementById('i-delta'),
  infoStatus:   document.getElementById('i-status'),
};

const ctx = dom.canvas.getContext('2d');

let bgImage          = null;
let tracksIndex      = {};  // trackId → [{xCenter, yCenter, heading, width, length, lonVelocity, latVelocity}]
let tracksMeta       = {};  // trackId → row from tracksMeta CSV
let trackManeuvers   = {};  // trackId → {maneuver, delta}
let currentRecId     = null;
let filteredTrackIds = [];

// Cleaning data loaded once at startup from the notebook outputs.
// Keys are "recordingId-trackId" strings for O(1) lookup.
let cleanSet = null;  // tracks_clean.csv  — null = file not available yet

// ── Cleaning data ────────────────────────────────────────────────────────────

async function loadCleaningData() {
  async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }
  try {
    const text = await fetchText('/tracks_clean.csv');
    const parseRows = t =>
      Papa.parse(t, { header: true, dynamicTyping: true })
          .data.filter(r => r.trackId != null);
    cleanSet = new Set(parseRows(text).map(r => `${r.recordingId}-${r.trackId}`));
    console.log(`[cleaning] cleanSet=${cleanSet.size}`);
    if (currentRecId !== null) {
      dom.selCleaning.disabled = false;
      populateTrackSelect();
    }
  } catch (e) {
    console.warn('[cleaning] failed:', e);
  }
}

function trackStatus(recId, trackId) {
  if (!cleanSet) return null;
  return cleanSet.has(`${recId}-${trackId}`) ? 'kept' : 'removed';
}

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

// ── Manoeuvre classification ─────────────────────────────────────────────────
// Mirrors wrap_to_180 / circular_mean_deg / classify_maneuver in
// feature-analysis.ipynb. heading is a counter-clockwise mathematical angle,
// so a positive change is a left turn.

// Wrap an angle difference into (-180, 180]. The doubled modulo is needed
// because JS % keeps the sign of the dividend.
function wrapTo180(deltaDeg) {
  return ((deltaDeg + 180) % 360 + 360) % 360 - 180;
}

// Mean of cyclic angles via unit vectors: averaging 359° and 1° arithmetically
// would give 180°, i.e. the exact opposite direction.
function circularMeanDeg(anglesDeg) {
  let sumSin = 0;
  let sumCos = 0;
  for (const angle of anglesDeg) {
    const rad = angle * Math.PI / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  const mean = Math.atan2(sumSin / anglesDeg.length, sumCos / anglesDeg.length);
  return (mean * 180 / Math.PI % 360 + 360) % 360;
}

// lonVelocity/latVelocity are vehicle-fixed, so their magnitude is ground speed.
function meanSpeedKmh(frames) {
  let total = 0;
  for (const f of frames) total += Math.hypot(f.lonVelocity, f.latVelocity);
  return total / frames.length * 3.6;
}

function classifyTrack(frames) {
  // A standing vehicle has no direction of travel, so its heading - and any
  // manoeuvre derived from it - is undefined noise.
  if (meanSpeedKmh(frames) < CONFIG.stationaryMaxKmh) {
    return { maneuver: 'stationary', delta: null };
  }

  const window = Math.min(CONFIG.headingWindow, frames.length);
  const entry  = circularMeanDeg(frames.slice(0, window).map(f => f.heading));
  const exit   = circularMeanDeg(frames.slice(-window).map(f => f.heading));
  const delta  = wrapTo180(exit - entry);
  const magnitude = Math.abs(delta);

  let maneuver;
  if (magnitude < CONFIG.straightMaxDeg)   maneuver = 'straight';
  else if (magnitude > CONFIG.uturnMinDeg) maneuver = 'u-turn';
  else                                     maneuver = delta > 0 ? 'left' : 'right';

  return { maneuver, delta };
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

// ── Tabs ─────────────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));
}

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ── Event handlers ───────────────────────────────────────────────────────────

dom.selLocation.addEventListener('change', () => {
  const loc = parseInt(dom.selLocation.value);

  dom.selRecording.innerHTML = '<option value="">Select recording…</option>';
  dom.selClass.disabled = true;
  dom.selClass.innerHTML = '<option value="">All classes</option>';
  dom.selManeuver.disabled = true;
  dom.selManeuver.value = '';
  dom.selCleaning.disabled = true;
  dom.selCleaning.value = '';
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

for (const select of [dom.selClass, dom.selManeuver, dom.selCleaning]) {
  select.addEventListener('change', () => {
    populateTrackSelect();
    dom.trackInfo.classList.remove('visible');
    ctx.drawImage(bgImage, 0, 0);
  });
}

document.addEventListener('keydown', (e) => {
  if (!filteredTrackIds.length) return;
  if (e.key === 'ArrowLeft')  { e.preventDefault(); navigateTrack(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); navigateTrack(1);  }
});

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadRecording(recId) {
  const pad = padId(recId);

  dom.selClass.disabled = true;
  dom.selClass.innerHTML = '<option value="">All classes</option>';
  dom.selManeuver.disabled = true;
  dom.selManeuver.value = '';
  dom.selCleaning.disabled = true;
  dom.selCleaning.value = '';
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

  const classes = [...new Set(Object.values(tracksMeta).map(r => r['class']).filter(Boolean))].sort();
  dom.selClass.innerHTML = '<option value="">All classes</option>';
  for (const cls of classes) {
    const opt = document.createElement('option');
    opt.value = cls;
    opt.textContent = cls;
    dom.selClass.appendChild(opt);
  }
  dom.selClass.value = '';
  dom.selClass.disabled = false;

  setStatus('Parsing trajectories…', true);
  tracksIndex = {};

  try {
    await new Promise((resolve, reject) =>
      Papa.parse(`${CONFIG.dataPath}/${pad}_tracks.csv`, {
        download: true,
        header: true,
        dynamicTyping: true,
        chunk({ data }) {
          for (const row of data) {
            if (row.trackId == null) continue;
            (tracksIndex[row.trackId] ??= []).push({
              xCenter:     row.xCenter,
              yCenter:     row.yCenter,
              heading:     row.heading,
              width:       row.width,
              length:      row.length,
              lonVelocity: row.lonVelocity,
              latVelocity: row.latVelocity,
            });
          }
        },
        complete: resolve,
        error: reject,
      })
    );
  } catch {
    setStatus('Failed to parse trajectories');
    return;
  }

  setStatus('Classifying manoeuvres…', true);
  trackManeuvers = Object.fromEntries(
    Object.entries(tracksIndex).map(([tid, frames]) => [tid, classifyTrack(frames)])
  );
  dom.selManeuver.disabled = false;
  if (cleanSet) dom.selCleaning.disabled = false;

  currentRecId = recId;
  populateTrackSelect();
}

// ── Track list helpers ────────────────────────────────────────────────────────

// Reads all filter dropdowns directly so every call site stays in sync.
function populateTrackSelect() {
  const classFilter    = dom.selClass.value;
  const maneuverFilter = dom.selManeuver.value;
  const cleaningFilter = dom.selCleaning.value;

  const ids = Object.keys(tracksIndex).map(Number).sort((a, b) => a - b);
  filteredTrackIds = ids.filter(tid => {
    if (classFilter    && tracksMeta[tid]?.class !== classFilter)              return false;
    if (maneuverFilter && trackManeuvers[tid]?.maneuver !== maneuverFilter)    return false;
    if (cleaningFilter && cleanSet) {
      const isKept = cleanSet.has(`${currentRecId}-${tid}`);
      if (cleaningFilter === 'kept'    && !isKept) return false;
      if (cleaningFilter === 'removed' &&  isKept) return false;
    }
    return true;
  });

  dom.selTrack.innerHTML = '<option value="">Select track…</option>';
  for (const tid of filteredTrackIds) {
    const meta    = tracksMeta[tid];
    const symbol  = MANEUVER_LABELS[trackManeuvers[tid]?.maneuver]?.symbol ?? '?';
    const status  = trackStatus(currentRecId, tid);
    const prefix  = status === 'removed' ? '[rm] ' : '';
    const option  = document.createElement('option');
    option.value = tid;
    option.textContent =
      `${prefix}#${tid} ${symbol} ${meta?.class ?? '?'}  (${meta?.numFrames ?? '?'} frames)`;
    dom.selTrack.appendChild(option);
  }

  dom.selTrack.disabled = filteredTrackIds.length === 0;

  const active = [classFilter, MANEUVER_LABELS[maneuverFilter]?.text].filter(Boolean);
  setStatus(active.length
    ? `${filteredTrackIds.length} tracks · ${active.join(' · ')}`
    : `Ready · ${filteredTrackIds.length} tracks`);
}

function navigateTrack(delta) {
  if (!filteredTrackIds.length) return;
  const currentTid = parseInt(dom.selTrack.value);
  const idx = filteredTrackIds.indexOf(currentTid);
  const newIdx = idx === -1
    ? (delta > 0 ? 0 : filteredTrackIds.length - 1)
    : (idx + delta + filteredTrackIds.length) % filteredTrackIds.length;
  const newTid = filteredTrackIds[newIdx];
  dom.selTrack.value = String(newTid);
  renderTrack(newTid);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTrack(trackId) {
  const frames = tracksIndex[trackId];
  if (!frames || !bgImage) return;

  const toPixel = makeCoordTransform(recToLocation[currentRecId]);
  const n       = frames.length;
  const isVRU   = frames[0].width === 0;
  const status  = trackStatus(currentRecId, trackId);

  ctx.drawImage(bgImage, 0, 0);

  // Path — colour encodes cleaning status
  const pathColor = status === 'removed' ? 'rgba(255,70,70,0.75)' : 'rgba(255,255,255,0.55)';

  ctx.beginPath();
  const [x0, y0] = toPixel(frames[0].xCenter, frames[0].yCenter);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < n; i++) {
    const [xi, yi] = toPixel(frames[i].xCenter, frames[i].yCenter);
    ctx.lineTo(xi, yi);
  }
  ctx.strokeStyle = pathColor;
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
  let totalDist = 0;
  for (let i = 1; i < n; i++) {
    totalDist += Math.hypot(frames[i].xCenter - frames[i-1].xCenter,
                            frames[i].yCenter - frames[i-1].yCenter);
  }
  dom.infoDist.textContent   = `${totalDist.toFixed(1)} m`;

  dom.infoSize.textContent   = meta?.length > 0
    ? `${meta.length.toFixed(2)} × ${meta.width.toFixed(2)} m`
    : 'N/A (VRU)';

  const classified = trackManeuvers[trackId];
  const label = MANEUVER_LABELS[classified?.maneuver];
  dom.infoManeuver.textContent = label ? `${label.symbol} ${label.text}` : '–';
  dom.infoDelta.textContent    = classified?.delta == null
    ? 'N/A'
    : `${classified.delta > 0 ? '+' : ''}${classified.delta.toFixed(1)}°`;

  const statusLabels = { kept: 'Kept', removed: 'Removed' };
  dom.infoStatus.textContent = statusLabels[status] ?? '–';
  dom.infoStatus.className   = status === 'kept' ? 'val status-kept'
                             : status === 'removed' ? 'val status-removed' : 'val';

  dom.trackInfo.classList.add('visible');
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadCleaningData();
