# Arc Path Builder

Two builders, **2D** ([index.html](index.html)) and **3D** ([index3d.html](index3d.html)), sharing
one geometry core. Work is in **millimetres** throughout.

Enter an ordered list of points; the app connects each consecutive pair with a **single circular
arc** whose swept angle is exactly **0°, 30°, 45°, 60° or 90°** (configurable), with each arc
departing along the previous arc's exit tangent. A 0° sweep is a straight run. Connections that
cannot satisfy that are flagged instead of being drawn wrong.

The path is then cut into **derived shop pieces**, flange to flange — straights spliced at the
maximum piece length, compact elbows, and angled straights. Table points are centerline waypoints,
not parts.

Full spec: [docs/requirements.md](docs/requirements.md).

## Run

ES modules do not load over `file://`, so serve the folder:

```sh
cd curve-path-builder
python3 -m http.server 8000
```

Then open <http://localhost:8000> for 2D, or <http://localhost:8000/index3d.html> for 3D. No build
step and no install; Three.js loads from a CDN via an import map.

## Test

```sh
node --test tests/
```

## The two things worth knowing

**Direction is quantised.** For an arc of swept angle `θ` over a chord of length `d`, the radius is
derived: `r = d / (2·sin(θ/2))`, and each end tangent deviates from the chord by `θ/2`. At `θ = 0`
that gives an infinite radius — a straight line. Requiring the arc to depart along the incoming
tangent `τ` pins the *chord bearing*:

```
φ ∈ { τ±45°, τ±30°, τ±22.5°, τ±15°, τ }
```

Nine rays fan out from every point. The fan spans `τ ± 45°`: you can carry straight on or turn by up
to 45°, but nothing sharper is reachable in a single segment.

**Distance is bounded too.** A band of width `W` swept along an arc of radius `r` has an inner edge
of radius `r − W/2`. When `r < W/2` that edge folds back through itself and the duct creases into a
cusp. So `r` needs a floor, and inverting the radius formula turns it into a minimum chord length:

```
d_min(θ) = 2 · r_min · sin(θ/2)
```

Each ray therefore has a dead zone near its origin — drawn as an amber stub — and the next point
must lie on the ray *and* beyond it. Sharper sweeps have longer dead zones; the straight ray has
none, since `r = ∞`.

**In 3D the rays become cones.** The tangent is a vector, so the arc can bend in any plane
containing it, and each half-angle sweeps out a cone rather than a pair of rays. The 2D rays are
these cones cut by the working plane.

But a cone angle is not on its own enough, because **a shop elbow is planar**: it yaws in plan or
pitches in elevation, never both at once. A span that has to move both laterally and vertically is
routed as an **angled straight** — run on for at least 100 mm, take a slight kick toward the point,
then a straight — falling back to two compact 90° cardinals, and only then failing as a compound
bend. And a horizontal duct is never laid dead level: a straight flatter than the drain floor is
`off-slope`, though it may fall or rise.

## Configuration

Everything tunable lives in [config.json](config.json), fetched at startup. Edit and reload — no
rebuild.

```json
{
  "sweeps": [0, 30, 45, 60, 90],
  "features": { "duct": true, "jacket": true, "minBendRadius": true,
                "guideRays": true, "snapping": true, "importExport": true,
                "crossLink": true, "threeD": true, "flanges": true,
                "drainSlope": true, "autosave": true },
  "defaults": { "initialHeading": 0, "toleranceDeg": 2,
                "ductWidth": 180, "jacketWidth": 400, "minRadiusRatio": 1.5,
                "maxPieceLength": 1050, "elbowFlangeOffset": 60,
                "angledMinLead": 100, "slopeDeg": 3, "slopeToleranceDeg": 1 }
}
```

- `sweeps` — permitted swept angles. Anything in `[0, 180)`; values are deduplicated and sorted, and
  out-of-range ones dropped.
- `features` — a disabled feature is **absent**, not just hidden. Turning off `jacket` also removes
  it from the minimum bend radius calculation, whereas merely unticking the Jacket box leaves it
  counted, because the jacket still physically exists.
- `defaults` — seed values. Saved state overrides them, so set `autosave: false` if you want the
  config to win every reload.

The file is merged section-wise over built-in defaults, so a partial file is fine and a missing or
malformed one just logs a warning.

**To add a flag:** add the boolean, tag the owning elements with `data-feature="yourFlag"` in
[index.html](index.html), and gate behaviour on `state.features.yourFlag`. No other plumbing.
`data-feature` accepts a comma-separated list when an element needs several flags at once.

Flag gating is a product switch, not a security control — `index3d.html` is still served, and the
flag lives in a file the browser can read. Anything needing real access control has to be enforced
server-side.

## Layout

| Path | Role |
|------|------|
| `config.json` | Sweep set, feature flags and seed values — shared by both apps. |
| `src/core/` | Dimension-free: `angles`, `arcMath`, `solve`, `config`, `store`, `slope`, `routing`, `pieces`, `polyline`, `piecePanel`, `view`. Never imports from `2d/` or `3d/`. |
| `src/2d/` | Bearings and rays, rendered to SVG. |
| `src/3d/` | Tangent vectors and cones, rendered with Three.js. |
| `tests/` | `core`, `geometry2d`, `geometry3d`, `slope`, `pieces`, `shop3d`, `invariants`. |

`walkPath` in core treats the tangent as opaque, so 2D passes a bearing in degrees and 3D a unit
vector through the very same loop.

## Notes

- **Canvas (2D):** drag empty space to pan, scroll to zoom about the cursor, drag a point to move it.
  **Fit** frames everything, and runs automatically on load, on import, and whenever Add point would
  place a point off-screen. Points are added only via Add point or the table — clicking empty canvas
  does nothing, since that gesture belongs to panning.
- **Canvas (3D):** drag to orbit, scroll to zoom, right-drag to pan. Coordinates are edited in the
  table; point dragging is 2D-only, since dragging in 3D needs a chosen depth plane.
- `y` increases **downward** (SVG convention), so positive angles turn clockwise on screen.
- A 0° sweep renders with `L` rather than `A`, and carries the tangent through unchanged.
- Errors do not cascade: after a violation the tangent resets to that segment's straight chord.
- `too-tight` is legal but unbendable: the real arc is still drawn, in the warning colour, and the
  run is not broken.
- The duct is a stroke or a tube only — width maps to `stroke-width` or tube diameter. Wall
  thickness is out of scope.
- The drawn centerline is the *shop* centerline: real chords and real arcs, walked by arc length.
  No spline is fitted through the samples.
- All lengths and diameters are millimetres.
