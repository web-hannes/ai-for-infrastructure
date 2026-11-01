// must stay in sync with app.js CONFIG
const CONFIG = {
  dataPath: '/inD-dataset-v1.1/data',
  scaleDown: 12,         // must stay in sync with app.js CONFIG.scaleDown
  locationMap: {         // must stay in sync with app.js CONFIG.locationMap
    1: [7,8,9,10,11,12,13,14,15,16,17],
    2: [18,19,20,21,22,23,24,25,26,27,28,29],
    3: [30,31,32],
    4: [0,1,2,3,4,5,6],
  },
  orthoScale: {          // must stay in sync with app.js CONFIG.orthoScale
    1: 0.0081463609172491,
    2: 0.008146360917245,
    3: 0.0081463537957561,
    4: 0.0126999352667008,
  },
  vehicleClasses: ['car', 'truck_bus'],  // must stay in sync with notebook VEHICLE_CLASSES
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const dom = {
  selLocation:  document.getElementById('sel-location'),
  selRecording: document.getElementById('sel-recording'),
  status:       document.getElementById('status'),
  validation:   document.getElementById('validation'),
  passRate:     document.getElementById('pass-rate'),
  prTotal:      document.getElementById('pr-total'),
  prPass:       document.getElementById('pr-pass'),
  prStarts:     document.getElementById('pr-starts'),
  prEnds:       document.getElementById('pr-ends'),
  prNever:      document.getElementById('pr-never'),
  pointHint:    document.getElementById('point-hint'),
  btnExport:    document.getElementById('btn-export'),
  btnReset:     document.getElementById('btn-reset'),
  snippet:      document.getElementById('export-snippet'),
  downloadLink: document.getElementById('download-link'),
  placeholder:  document.getElementById('placeholder'),
  canvasWrap:   document.getElementById('canvas-wrap'),
  canvas:       document.getElementById('canvas'),
};

const ctx = dom.canvas.getContext('2d');

// ── State ─────────────────────────────────────────────────────────────────────

// zones[locationId] = array of up to 4 points in metres: [[x,y], ...]
// Loaded from / saved to localStorage.
let zones = { 1: [], 2: [], 3: [], 4: [] };

let currentLocationId = null;
let bgImage           = null;
let dragIndex         = -1;     // index of vertex being dragged, or -1

// Loaded tracks for pass-rate overlay: [{trackId, xy: [[x,y],...]}]
let vehicleTracks  = [];
let failingTracks  = [];        // subset that fail the traversal test
let passRateLoaded = false;

// ── Persistence ───────────────────────────────────────────────────────────────

function loadStorage() {
  try {
    const raw = localStorage.getItem('zoneEditor_zones');
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const loc of [1, 2, 3, 4]) {
        if (Array.isArray(parsed[loc])) zones[loc] = parsed[loc];
      }
    }
  } catch (_) {}
}

function saveStorage() {
  try {
    localStorage.setItem('zoneEditor_zones', JSON.stringify(zones));
  } catch (_) {}
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

function pxPerMeter(locationId) {
  return 1 / (CONFIG.orthoScale[locationId] * CONFIG.scaleDown);
}

function toPixel(x, y, ppm) {
  return [x * ppm, -y * ppm];
}

function toMetres(px, py, ppm) {
  return [px / ppm, -py / ppm];
}

function canvasCoords(event) {
  const rect  = dom.canvas.getBoundingClientRect();
  const scale = dom.canvas.width / rect.width;
  return [
    (event.clientX - rect.left) * scale,
    (event.clientY - rect.top)  * scale,
  ];
}

// ── Geometry ─────────────────────────────────────────────────────────────────

// Cross product of 2-D vectors (a→b) × (a→c)
function cross2d(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// Test if segments (p1→p2) and (p3→p4) properly intersect (share an interior point).
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross2d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = cross2d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = cross2d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = cross2d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

// Shoelace area (signed). Positive = CCW (y-up). Vertices in metre coords.
function signedArea(pts) {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i][0] * pts[j][1];
    area -= pts[j][0] * pts[i][1];
  }
  return area / 2;
}

// Returns 'ok-ccw' | 'ok-cw' | 'self-intersecting' | 'concave' | 'insufficient'
function validateQuad(pts) {
  if (pts.length < 4) return 'insufficient';

  // Self-intersection: check non-adjacent edge pairs (0-1 vs 2-3, and 1-2 vs 3-0)
  if (segmentsIntersect(pts[0], pts[1], pts[2], pts[3])) return 'self-intersecting';
  if (segmentsIntersect(pts[1], pts[2], pts[3], pts[0])) return 'self-intersecting';

  // Convexity: all consecutive cross products must share the same sign
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cp = cross2d(a[0], a[1], b[0], b[1], c[0], c[1]);
    if (cp === 0) continue;
    const s = cp > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return 'concave';
  }

  return signedArea(pts) > 0 ? 'ok-ccw' : 'ok-cw';
}

// Return CCW-ordered copy of pts (reverse if CW).
function ensureCCW(pts) {
  return signedArea(pts) > 0 ? pts.slice() : pts.slice().reverse();
}

// ── Traversal geometry (mirrors Python traverses()) ───────────────────────────

// xy: array of [x,y] in metres. quad: [[x,y]×4] CCW in metres.
// Returns bool array of length xy.length — true if point is inside.
function insideMask(xy, quad) {
  const n = xy.length;
  const mask = new Array(n).fill(true);
  for (let e = 0; e < 4; e++) {
    const p  = quad[e];
    const q  = quad[(e + 1) % 4];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const dx = xy[i][0] - p[0];
      const dy = xy[i][1] - p[1];
      // cross product: ex*dy - ey*dx >= 0 means left of edge (inside for CCW)
      if (ex * dy - ey * dx < 0) mask[i] = false;
    }
  }
  return mask;
}

function traverses(xy, quad) {
  if (xy.length === 0) return false;
  const mask = insideMask(xy, quad);
  const startsInside = mask[0];
  const endsInside   = mask[mask.length - 1];
  const everInside   = mask.some(Boolean);
  return !startsInside && !endsInside && everInside;
}

// Classify why a track fails (returns 'pass'|'starts-inside'|'ends-inside'|'never-inside')
function classifyTraversal(xy, quad) {
  if (xy.length === 0) return 'never-inside';
  const mask        = insideMask(xy, quad);
  const startsIn    = mask[0];
  const endsIn      = mask[mask.length - 1];
  const everInside  = mask.some(Boolean);
  if (!startsIn && !endsIn && everInside) return 'pass';
  if (startsIn)  return 'starts-inside';
  if (endsIn)    return 'ends-inside';
  return 'never-inside';
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function redraw() {
  if (!bgImage || !currentLocationId) return;
  ctx.drawImage(bgImage, 0, 0);

  const pts  = zones[currentLocationId];
  const ppm  = pxPerMeter(currentLocationId);
  const pixPts = pts.map(([mx, my]) => toPixel(mx, my, ppm));

  // Faint failing track paths (drawn before polygon so handles appear on top)
  if (failingTracks.length > 0) {
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.25)';
    ctx.lineWidth   = 1;
    for (const { xy } of failingTracks) {
      if (xy.length < 2) continue;
      ctx.beginPath();
      const [px0, py0] = toPixel(xy[0][0], xy[0][1], ppm);
      ctx.moveTo(px0, py0);
      for (let i = 1; i < xy.length; i++) {
        const [pxi, pyi] = toPixel(xy[i][0], xy[i][1], ppm);
        ctx.lineTo(pxi, pyi);
      }
      ctx.stroke();
    }
  }

  if (pixPts.length < 2) {
    // Just draw placed handles
    drawHandles(pts, pixPts, ppm);
    return;
  }

  const valid = validateQuad(pts);

  if (pixPts.length === 4 && (valid === 'ok-ccw' || valid === 'ok-cw')) {
    // Filled polygon
    ctx.beginPath();
    ctx.moveTo(pixPts[0][0], pixPts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pixPts[i][0], pixPts[i][1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(100, 160, 255, 0.15)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(100, 160, 255, 0.8)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.stroke();
  } else {
    // Dashed partial outline (2–3 points, or invalid 4)
    ctx.beginPath();
    ctx.moveTo(pixPts[0][0], pixPts[0][1]);
    for (let i = 1; i < pixPts.length; i++) ctx.lineTo(pixPts[i][0], pixPts[i][1]);
    ctx.strokeStyle = pixPts.length === 4
      ? 'rgba(255, 100, 100, 0.7)'
      : 'rgba(100, 160, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawHandles(pts, pixPts, ppm);
}

function drawHandles(pts, pixPts, ppm) {
  for (let i = 0; i < pixPts.length; i++) {
    const [px, py] = pixPts[i];
    // Handle circle
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI * 2);
    ctx.fillStyle   = dragIndex === i ? 'rgba(200, 200, 255, 0.9)' : 'rgba(100, 160, 255, 0.85)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.stroke();

    // Metre-coordinate label
    const [mx, my] = pts[i];
    const label     = `(${mx.toFixed(2)}, ${my.toFixed(2)})`;
    ctx.font        = '11px -apple-system, sans-serif';
    ctx.fillStyle   = 'rgba(255,255,255,0.85)';
    // Offset label away from canvas edges
    const offsetX = px > dom.canvas.width  - 100 ? -8 : 12;
    const offsetY = py < 20 ? 20 : -10;
    ctx.fillText(label, px + offsetX, py + offsetY);
  }
}

// ── Validation UI ─────────────────────────────────────────────────────────────

function updateValidation() {
  const pts   = zones[currentLocationId] || [];
  const valid = validateQuad(pts);

  dom.validation.className = '';
  dom.btnExport.disabled   = true;

  if (pts.length < 4) {
    dom.validation.className   = 'empty';
    dom.validation.textContent = `Place ${4 - pts.length} more point${4 - pts.length !== 1 ? 's' : ''} to validate`;
    dom.pointHint.textContent  = `${pts.length}/4 points placed`;
    return;
  }

  switch (valid) {
    case 'self-intersecting':
      dom.validation.className   = 'invalid';
      dom.validation.textContent = 'Error: self-intersecting (bow-tie) — export blocked';
      break;
    case 'concave':
      dom.validation.className   = 'invalid';
      dom.validation.textContent = 'Error: concave quadrilateral — export blocked';
      break;
    case 'ok-ccw':
      dom.validation.className   = 'valid';
      dom.validation.textContent = 'Valid (CCW)';
      dom.btnExport.disabled     = false;
      break;
    case 'ok-cw':
      dom.validation.className   = 'valid';
      dom.validation.textContent = 'Valid (CW — will be reversed on export)';
      dom.btnExport.disabled     = false;
      break;
  }
  dom.pointHint.textContent = '4/4 points placed';
}

// ── Pass rate ─────────────────────────────────────────────────────────────────

function updatePassRate() {
  const pts   = zones[currentLocationId] || [];
  const valid = validateQuad(pts);
  if ((valid !== 'ok-ccw' && valid !== 'ok-cw') || vehicleTracks.length === 0) {
    dom.passRate.classList.remove('visible');
    failingTracks = [];
    return;
  }

  const quad = ensureCCW(pts);
  let total = 0, pass = 0, starts = 0, ends = 0, never = 0;
  failingTracks = [];

  for (const t of vehicleTracks) {
    total++;
    const result = classifyTraversal(t.xy, quad);
    if (result === 'pass') {
      pass++;
    } else {
      failingTracks.push(t);
      if (result === 'starts-inside') starts++;
      else if (result === 'ends-inside') ends++;
      else never++;
    }
  }

  dom.prTotal.textContent  = total;
  dom.prPass.textContent   = pass;
  dom.prStarts.textContent = starts;
  dom.prEnds.textContent   = ends;
  dom.prNever.textContent  = never;
  dom.passRate.classList.add('visible');
}

// ── Export ────────────────────────────────────────────────────────────────────

function buildExport() {
  const lines = [];
  const jsonObj = {};

  lines.push('# Zone quadrilaterals in inD local metres, CCW, from the zone editor.');
  lines.push('ZONES = {');

  for (const loc of [1, 2, 3, 4]) {
    const pts   = zones[loc];
    const valid = validateQuad(pts);
    if (pts.length === 4 && (valid === 'ok-ccw' || valid === 'ok-cw')) {
      const ccw = ensureCCW(pts);
      const coords = ccw.map(([x, y]) => `(${x.toFixed(2)}, ${y.toFixed(2)})`).join(', ');
      lines.push(`    ${loc}: [${coords}],`);
      jsonObj[loc] = ccw.map(([x, y]) => [parseFloat(x.toFixed(4)), parseFloat(y.toFixed(4))]);
    } else {
      lines.push(`    # ${loc}: not yet defined`);
    }
  }
  lines.push('}');

  return { snippet: lines.join('\n'), json: jsonObj };
}

function runExport() {
  const { snippet, json } = buildExport();

  dom.snippet.value = snippet;

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  dom.downloadLink.href = url;
  dom.downloadLink.classList.add('visible');
}

// ── Track data loading ────────────────────────────────────────────────────────

function fetchCSV(url) {
  return new Promise((resolve, reject) =>
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: true,
      complete: result => resolve(result.data.filter(r => r.trackId != null)),
      error: reject,
    })
  );
}

async function loadRecordingTracks(recId) {
  const pad = String(recId).padStart(2, '0');
  setStatus('Loading tracks…', true);
  try {
    const [meta, frames] = await Promise.all([
      fetchCSV(`${CONFIG.dataPath}/${pad}_tracksMeta.csv`),
      fetchCSV(`${CONFIG.dataPath}/${pad}_tracks.csv`),
    ]);

    const vehicleIds = new Set(
      meta.filter(r => CONFIG.vehicleClasses.includes(r.class)).map(r => r.trackId)
    );

    // Group frames by trackId, sorted by frame
    const byTrack = new Map();
    for (const f of frames) {
      if (!vehicleIds.has(f.trackId)) continue;
      if (!byTrack.has(f.trackId)) byTrack.set(f.trackId, []);
      byTrack.get(f.trackId).push(f);
    }

    vehicleTracks = [];
    for (const [tid, flist] of byTrack) {
      flist.sort((a, b) => a.frame - b.frame);
      vehicleTracks.push({
        trackId: tid,
        xy: flist.map(f => [f.xCenter, f.yCenter]),
      });
    }

    passRateLoaded = true;
    setStatus(`Recording ${pad} loaded`);
    updatePassRate();
    redraw();
  } catch (e) {
    setStatus('Failed to load recording tracks');
    console.warn('[zone-editor] track load failed:', e);
  }
}

// ── Background image ──────────────────────────────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src     = src;
  });
}

async function loadLocation(locationId) {
  currentLocationId = locationId;
  bgImage           = null;
  vehicleTracks     = [];
  failingTracks     = [];
  passRateLoaded    = false;
  dom.passRate.classList.remove('visible');

  // Populate recording selector
  dom.selRecording.innerHTML = '<option value="">Select recording…</option>';
  for (const id of CONFIG.locationMap[locationId]) {
    const opt       = document.createElement('option');
    opt.value       = id;
    opt.textContent = `Recording ${String(id).padStart(2, '0')}`;
    dom.selRecording.appendChild(opt);
  }
  dom.selRecording.disabled = false;

  // Load background from first recording of the location
  const firstRec = CONFIG.locationMap[locationId][0];
  const pad      = String(firstRec).padStart(2, '0');
  setStatus('Loading background…', true);

  try {
    bgImage = await loadImage(`${CONFIG.dataPath}/${pad}_background.png`);
  } catch {
    setStatus('Failed to load background image');
    return;
  }

  dom.canvas.width  = bgImage.naturalWidth;
  dom.canvas.height = bgImage.naturalHeight;
  dom.placeholder.style.display  = 'none';
  dom.canvasWrap.style.display   = 'block';

  dom.btnReset.disabled = false;
  setStatus(`Location ${locationId} — ${zones[locationId].length}/4 points placed`);

  updateValidation();
  redraw();
}

// ── Mouse interaction ─────────────────────────────────────────────────────────

dom.canvas.addEventListener('mousedown', e => {
  if (!currentLocationId) return;
  const [cx, cy] = canvasCoords(e);
  const pts      = zones[currentLocationId];
  const ppm      = pxPerMeter(currentLocationId);

  // Check if clicking an existing handle
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = toPixel(pts[i][0], pts[i][1], ppm);
    if (Math.hypot(cx - px, cy - py) <= 12) {
      dragIndex = i;
      return;
    }
  }

  // Otherwise place a new point (max 4)
  if (pts.length < 4) {
    const [mx, my] = toMetres(cx, cy, ppm);
    pts.push([mx, my]);
    saveStorage();
    updateValidation();
    updatePassRate();
    redraw();
    setStatus(`Location ${currentLocationId} — ${pts.length}/4 points placed`);
  }
});

dom.canvas.addEventListener('mousemove', e => {
  if (dragIndex === -1 || !currentLocationId) return;
  const [cx, cy] = canvasCoords(e);
  const ppm      = pxPerMeter(currentLocationId);
  const [mx, my] = toMetres(cx, cy, ppm);
  zones[currentLocationId][dragIndex] = [mx, my];
  saveStorage();
  updateValidation();
  updatePassRate();
  redraw();
});

dom.canvas.addEventListener('mouseup', () => {
  dragIndex = -1;
});

dom.canvas.addEventListener('mouseleave', () => {
  dragIndex = -1;
});

// ── Cursor styling ────────────────────────────────────────────────────────────

dom.canvas.addEventListener('mousemove', e => {
  if (!currentLocationId) return;
  const [cx, cy] = canvasCoords(e);
  const pts      = zones[currentLocationId];
  const ppm      = pxPerMeter(currentLocationId);

  let onHandle = false;
  for (const pt of pts) {
    const [px, py] = toPixel(pt[0], pt[1], ppm);
    if (Math.hypot(cx - px, cy - py) <= 12) { onHandle = true; break; }
  }
  dom.canvas.style.cursor = onHandle ? 'grab'
    : (dragIndex !== -1) ? 'grabbing'
    : (pts.length < 4)   ? 'crosshair'
    : 'default';
});

// ── Controls ──────────────────────────────────────────────────────────────────

dom.selLocation.addEventListener('change', () => {
  const loc = parseInt(dom.selLocation.value);
  if (!loc) return;
  loadLocation(loc);
});

dom.selRecording.addEventListener('change', async () => {
  const recId = parseInt(dom.selRecording.value);
  if (!recId) return;
  await loadRecordingTracks(recId);
});

dom.btnReset.addEventListener('click', () => {
  if (!currentLocationId) return;
  zones[currentLocationId] = [];
  saveStorage();
  vehicleTracks  = [];
  failingTracks  = [];
  passRateLoaded = false;
  dom.passRate.classList.remove('visible');
  dom.selRecording.value    = '';
  updateValidation();
  redraw();
  setStatus(`Location ${currentLocationId} — 0/4 points placed`);
});

dom.btnExport.addEventListener('click', () => {
  runExport();
});

// ── Status helper ─────────────────────────────────────────────────────────────

function setStatus(msg, loading = false) {
  dom.status.textContent = msg;
  dom.status.className   = loading ? 'loading' : '';
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadStorage();
