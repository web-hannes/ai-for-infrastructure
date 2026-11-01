# Zone Traversal Filter — Implementation Brief

Development brief for Claude Code. Two deliverables: a standalone zone-editor web app
(Part 1) and a new cleaning check in `data-cleaning.ipynb` (Part 2).

## 1 · Problem

`data-cleaning.ipynb` currently rejects fragments via `flag_short_path`: a track is flagged
when its path length falls below `0.9 × MIN_PATH_M[locationId]`, where `MIN_PATH_M` holds the
hand-measured minimum distance needed to cross each intersection.

That test is a proxy and fails on the long approach arms. A track can travel 40 m down the
northern arm of Bendplatz, lose tracking before reaching the intersection, and still clear a
35 m threshold — it covers half a street and never crosses anything.

The fix is geometric instead of metric: define a zone per location and require every track to
have *passed through* it.

## 2 · Definition of the rule

A zone is a **convex quadrilateral** per location, stored as four vertices in inD local metre
coordinates. Its edges are drawn so that they cut across the intersection arms, well inside
the drone's field of view — so a vehicle approaching on an arm is outside the zone when its
track begins.

For a track with per-frame centre positions `xy` (shape `(n, 2)`), build the boolean mask
`inside[t]` and require all three:

| # | Condition | Meaning |
|---|---|---|
| 1 | `inside[0] == False` | starts outside the zone |
| 2 | `inside[-1] == False` | ends outside the zone |
| 3 | `inside.any() == True` | was inside at some point |

`inside[-1]` is Python's negative index, i.e. the last frame of the track.

Nothing else. Two conditions were considered and **deliberately rejected**:

- *Entry edge ≠ exit edge.* Would reject U-turns, which are fully observed, legitimate
  tracks and an explicit manoeuvre class in `feature-analysis.ipynb` and the visualizer.
  The rule is about completeness of observation, not direction of travel.
- *Minimum path length inside the zone.* Would guard against a vehicle clipping only a
  corner of the quadrilateral. Rejected as unnecessary complexity; corner placement in the
  editor avoids the case, and the live pass-rate feedback (§4) makes it visible if it occurs.

The entry/exit edge is still worth deriving later as a **feature** (entry arm → exit arm =
turning movement), but it is not part of this filter.

## 3 · Geometry: the half-plane test

For a convex quadrilateral with vertices ordered counter-clockwise, "inside" is simply "left
of all four edges". For edge *i* from `P[i]` to `P[i+1]` with edge vector `e`, the 2-D cross
product `e × (q − P[i])` is positive when point `q` lies to the left. Pure NumPy, no new
dependency, fully vectorised over all frames and all four edges at once:

```python
def side_matrix(xy, quad):
    """(n, 4) cross products per point and edge. Inside = all >= 0 for a CCW quad."""
    q = np.asarray(quad, float)
    e = np.roll(q, -1, axis=0) - q                        # edge vectors
    d = np.asarray(xy, float)[:, None, :] - q             # point - edge start
    return e[:, 0] * d[:, :, 1] - e[:, 1] * d[:, :, 0]


def traverses(xy, quad):
    """True if the track starts outside, passes through the zone, and ends outside."""
    inside = (side_matrix(xy, quad) >= 0).all(axis=1)
    return not inside[0] and not inside[-1] and bool(inside.any())
```

Two preconditions, both enforced by the editor in Part 1:

- **Convex.** With a concave quadrilateral, "all signs ≥ 0" is no longer equal to "inside".
- **Counter-clockwise.** Checked via the shoelace area in metre coordinates (y points up),
  so CCW means area > 0. Reverse the vertex list otherwise.

`matplotlib.path.Path(quad).contains_points(xy)` would give the same mask for arbitrary
polygons without those preconditions; the half-plane test is used here by choice because it
is explicit, dependency-free and trivially vectorised.

## 4 · Part 1: zone editor web app

A standalone page, not wired into the existing visualizer's tab UI:

```
web-visualizations/zone-editor.html
web-visualizations/zone-editor.js
```

It reuses `styles.css` and is served by the existing static server
(`python -m http.server`, then `/web-visualizations/zone-editor.html`).

### Behaviour

1. **Location selector** (1–4). Loads that location's background image. Because every
   recording of a location shares one coordinate frame (verified, §6), any recording's
   background will do — use the first one in `locationMap`.
2. **Place four points** by clicking on the background. Existing points can be dragged to
   adjust. A reset button clears them. Clicking a fifth time does nothing until a point is
   removed — exactly four per location.
3. **Draw** the polygon with a translucent fill, visible edges and vertex handles, and label
   each handle with its metre coordinates.
4. **Validate** continuously and show the result inline:
   - self-intersecting ("bow-tie") quadrilateral → error, export blocked
   - concave quadrilateral → error, export blocked (the half-plane test requires convexity)
   - otherwise → valid; order the vertices CCW on export
5. **Live pass rate.** A recording selector loads that recording's `*_tracks.csv` and
   `*_tracksMeta.csv`, filters to `car` and `truck_bus` (project scope: motorised vehicles
   only), runs the *same three checks* in JS and reports the counts:
   - total vehicle tracks
   - pass
   - fail: starts inside
   - fail: ends inside
   - fail: never inside

   Failing tracks should be drawable as faint overlay paths, so a badly placed edge is
   immediately visible while dragging. This is the main reason the editor is worth building
   rather than eyeballing coordinates.
6. **Export** the zones in two forms:
   - a copy-ready Python snippet for the notebook's config cell, metres at two decimals:
     `ZONES = {1: [(x, y), (x, y), (x, y), (x, y)], 2: [...], ...}`
   - a `zones.json` download, so the existing visualizer can later draw the zone as an
     overlay (same pattern as it already uses for `tracks_clean.csv`)

   Zones should also survive a page reload (`localStorage`), so work on four locations is not
   lost by accident.

### Coordinate conversion

`app.js` converts metres to pixels as:

```js
const pxPerMeter = 1 / (CONFIG.orthoScale[locationId] * CONFIG.scaleDown);
const toPixel = (x, y) => [x * pxPerMeter, -y * pxPerMeter];
```

Local origin `(0, 0)` maps to pixel `(0, 0)` of the background image, and y is negated
because local +y is up while canvas +y is down. The editor needs the inverse:

```js
const toMetres = (px, py) => [px / pxPerMeter, -py / pxPerMeter];
```

**Mouse coordinates are not canvas coordinates.** `styles.css` sets
`canvas { max-width: 100%; height: auto; }`, so the canvas is CSS-scaled. Convert via the
bounding rect before anything else:

```js
const rect  = canvas.getBoundingClientRect();
const scale = canvas.width / rect.width;
const px = (event.clientX - rect.left) * scale;
const py = (event.clientY - rect.top)  * scale;
```

`orthoScale`, `scaleDown` (= 12) and `locationMap` are duplicated from `CONFIG` in `app.js`.
Mark them with a "must stay in sync" comment, matching the existing comment style there.

## 5 · Part 2: notebook integration

In `data-cleaning.ipynb`:

1. **Config cell** — add the `ZONES` constant next to `MIN_PATH_M`, with a comment stating
   that the values come from the zone editor and are in inD local metres, CCW.
2. **Helpers** — `side_matrix` and `traverses` go into the helper block at the top of the
   notebook, not into the loop.
3. **Reuse the existing pass over the CSVs.** The config cell already loops over
   `*_tracks.csv` to compute `path_m` and already filters to vehicle `valid_ids`. Compute the
   traversal flag in that same loop; do not add a third full read of the track files.
4. **New section `## 4 · Zone Traversal`**, placed after the teleportation section and before
   Export, following the existing section layout (markdown explanation, then the check).
   It should report:
   - flagged count and percentage
   - the breakdown by failure reason (starts inside / ends inside / never inside)
   - a crosstab against `flag_short_path`, so the report can quantify what the geometric
     check adds over the metric proxy — this is the interesting number for the write-up
   - a handful of example offenders, printed with `recordingId` **and** `trackId` so they can
     be looked up in the visualizer
   - use percentiles rather than means for any distribution summary
5. **Flags** — add `flag_not_traversed` to `FLAG_COLS`. `flag_short_path` and `MIN_PATH_M`
   stay as they are: both filters run, and the overlap is reported rather than assumed.
   `STATIC_PATH_M` and the early drop of stationary tracks are unaffected.

Optionally the visualizer can read `zones.json` and draw the zone outline, which makes a
flagged track self-explanatory when inspected. Nice to have, not required.

## 6 · Verified facts about the data

Established by inspection; the implementation may rely on these.

- **One coordinate frame per location.** Grouping `*_recordingMeta.csv` by `locationId`
  gives exactly one distinct `xUtmOrigin`, `yUtmOrigin` and `orthoPxToMeter` per location.
  A single quadrilateral per location is therefore well defined across its recordings.
- **Bendplatz construction site needs no separate zone.** Recordings 11–17 have their own
  lanelet map, but the same quadrilateral fits (confirmed by the user), so `locationMap`
  stays as it is and `ZONES` has exactly four entries.
- **No frame gaps, maximum step ≈ 1 m.** Checked on recordings 00, 07, 18 and 30: zero
  per-track frame gaps and a maximum per-frame displacement of 1.031 m at 25 Hz (location 4,
  the coarsest). A zone several metres wide therefore cannot be skipped between frames, which
  is why a per-frame point-in-polygon test is sufficient and no segment–segment intersection
  test is needed.
- **Centre point only.** `xCenter`/`yCenter` are used; the rotated bounding box is not. With
  a sub-metre sampling step and a ~1.8 m vehicle width, corner-based testing would only
  shift the zone boundary by about a vehicle half-width without changing any verdict.
- **Dependencies.** `pyproject.toml` has `ipykernel`, `matplotlib`, `pandas` (NumPy via
  pandas). The half-plane test adds nothing; do not introduce `shapely`.
- **Vehicle scope.** `VEHICLE_CLASSES = ["car", "truck_bus"]` — pedestrians and cyclists are
  out of scope for the whole project, in the notebook and in the editor's pass rate alike.

## 7 · Acceptance criteria

- Four points can be placed and dragged per location; all four zones persist across reloads.
- A concave or self-intersecting quadrilateral is reported and cannot be exported.
- The exported Python snippet pastes into the config cell without edits and the vertices are
  CCW.
- The editor's live pass count for a given recording and zone equals the notebook's result
  for that recording — same three checks, same numbers.
- The notebook writes `tracks_clean.csv` with `flag_not_traversed` applied alongside the
  existing flags, and prints the crosstab against `flag_short_path`.
- No additional read pass over `*_tracks.csv`, no new dependency.

## 8 · Known trade-offs to document

- **Vehicles that legitimately start or end inside the zone get flagged**: a car pulling out
  of a parking space, a bus departing a stop at Aseag, a vehicle leaving a driveway. These
  are real traffic and fully observed, yet they violate condition 1 or 2. This is a
  deliberate precision/recall trade-off and introduces a bias away from such manoeuvres.
  Report the count per location so the magnitude is known rather than hidden.
- **U-turns are kept on purpose** — see §2.
- **The zone is hand-drawn**, so the filter depends on a judgement call. Map matching against
  the shipped lanelet2 maps (`inD-dataset-v1.1/maps/lanelets`) would be the rigorous
  alternative, requiring no drawing; it was rejected here as disproportionate for a cleaning
  criterion, but it is the obvious next step if the filter ever needs defending.
