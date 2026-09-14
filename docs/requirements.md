# Arc Path Builder — Requirements

> **Living document.** Append new rules as they are agreed. Every change gets an entry in the
> [Changelog](#changelog) at the bottom. Nothing here is implied — if a rule is not written down,
> it is not implemented.

---

## 1. Purpose

A browser-based 2D tool where a user enters an ordered list of `(x, y)` points. The application
connects consecutive points with circular arcs subject to a strict angular constraint. Connections
that cannot satisfy the constraint are flagged visually instead of being silently drawn wrong.

The path is a **centerline**. Later it will represent a duct, rendered as a thick band around that
centerline.

---

## 2. Core model

### 2.1 Points

- An ordered list `P0, P1, ... Pn`. Order is significant; it defines traversal direction.
- Each point is stored as `{ id, x, y, z }`.
- `z` is **always 0** and is not editable. It exists so the schema is 3D-ready (R-13).

### 2.2 Connections

- Each consecutive pair `Pi -> Pi+1` is joined by **exactly one circular arc**.
- The arc's **swept angle** must be exactly **0°, 30°, 45°, 60° or 90°**.
- The permitted set is **configurable** (§9). Any angle in `[0, 180)` is admissible; the bound keeps
  an arc from taking the long way round.
- A **0° sweep is a straight run** — a circular arc of infinite radius. It is a first-class valid
  connection, not a special case bolted on, and not an error indicator.
- A non-zero arc may turn either direction (left or right). A 0° sweep has no handedness.
- Multi-arc chains and splines are **not** permitted as valid connections.

### 2.3 Tangent continuity (C1)

- Each arc must **depart along the exit tangent of the preceding arc**. The path is smooth; there
  are no corners.
- The first segment has no predecessor, so it takes its departure tangent from a user-supplied
  **initial heading** (R-11).

---

## 3. The geometry, worked out

This section is normative — the implementation must match it.

For an arc from `Pi` to `Pj` with swept angle `θ`:

- chord vector `(dx, dy) = Pj - Pi`
- chord length `d = hypot(dx, dy)`
- chord bearing `φ = atan2(dy, dx)`
- **radius** `r = d / (2·sin(θ/2))`
- turn direction `dir = +1` (increasing angle) or `dir = -1`
- entry tangent `t_start = φ − dir·θ/2`
- exit tangent `t_end = φ + dir·θ/2`

The tangent at either end deviates from the chord by exactly half the swept angle.

### 3.1 Radius is derived from the chord

`r` is solved from `d` and `θ`. Any chord length can be spanned by an arc of any swept angle simply
by choosing the right radius, so **radius is never a user input**.

At `θ = 0` the formula gives `r = ∞`, which is exactly right: the connection is a straight line. The
implementation returns a dedicated straight descriptor rather than dividing by zero.

Being derived does **not** mean being unconstrained. See §3.4 — once the duct has a diameter, the
radius acquires a lower bound.

### 3.2 Consequence: the *direction* of the next point is quantised

Given an incoming tangent `τ`, requiring `t_start = τ` gives:

```
τ = φ − dir·θ/2      =>      φ = τ + dir·θ/2
```

Substituting `θ ∈ {0, 30, 45, 60, 90}` and `dir ∈ {+1, −1}` yields **nine** legal chord bearings
(the `θ = 0` case collapses to a single ray, since it has no handedness):

```
φ ∈ { τ−45°, τ−30°, τ−22.5°, τ−15°, τ, τ+15°, τ+22.5°, τ+30°, τ+45° }
```

Nine rays fan out from each point and `Pi+1` must lie on one of them. The reachable fan spans
`τ ± 45°`; anything outside that cone is unreachable in a single segment. Inside the fan, the widest
gap between adjacent rays is **7.5°** — it occurs twice, between the straight ray and the 15° ray and
again between the 30° and 45° rays — which bounds the worst-case error of any near-miss.

The ray count and fan width both follow from the configured sweep set, so they change if that set
changes.

### 3.3 Arc centre

The centre lies perpendicular to the entry tangent, on the inside of the turn:

```
centre = Pi + r · ( cos(t_start + dir·90°), sin(t_start + dir·90°) )
```

A straight run has no centre.

### 3.4 The duct imposes a minimum radius, so distance matters too

> **Correction.** The initial draft claimed feasibility was *purely* angular and that distance never
> mattered. That holds only for a centerline of zero width. It is false as soon as the duct has a
> diameter.

A band of width `W` swept along an arc of radius `r` has edge radii:

```
outer edge = r + W/2
inner edge = r − W/2
```

When `r < W/2` the inner edge **inverts** — it folds back through itself and the duct creases into a
cusp. Even approaching that bound, the inner edge is far sharper than the centerline suggests, which
is a physically unbuildable bend.

So the centerline radius needs a floor, `r ≥ r_min`. Inverting `r = d / (2·sin(θ/2))` turns that
floor into a **minimum chord length**, per swept angle:

```
d_min(θ) = 2 · r_min · sin(θ/2)
```

**Distance therefore does matter.** Each legal ray now has a dead zone near its origin: the next
point must lie on the ray *and* at least `d_min(θ)` along it. Sharper sweeps have longer dead zones
(`d_min` is largest at 60°), and the straight ray has none at all, since `r = ∞`.

---

### 3.5 In 3D the rays become cones

Everything in §3.1–§3.4 is dimension-free. Only §3.2 changes shape.

In 2D the incoming tangent is a scalar bearing and a turn is left or right, so the permitted
half-angles give a finite set of **rays**. In 3D the tangent is a unit vector and the arc may bend
in *any plane containing it*, so each half-angle sweeps out a **cone**:

```
angle( t , normalise(Pi+1 - Pi) )  =  θ/2
```

The 2D rays are exactly these cones cut by the working plane — four non-zero sweeps × two sides,
plus the straight ray, gives the nine 2D bearings. Tests assert this correspondence directly.

Validation is consequently **simpler** in 3D, not harder: one angle between the tangent and the
chord, compared against `{0°, 15°, 22.5°, 30°, 45°}`. There is no handedness to choose, because
the arc's plane is already fixed by the tangent and the chord together.

| ID | Requirement |
|----|-------------|
| R-90 | A 3D segment is valid when the angle between the incoming tangent and the chord matches a permitted half-angle within tolerance. Every azimuth around the cone is equally valid. |
| R-91 | The arc's plane is spanned by the incoming tangent and the chord. Where they are parallel and a turn is still required, any perpendicular is chosen. |
| R-92 | The entry tangent is **reconstructed from the chord**, not copied from the incoming tangent, so the arc lands exactly on the endpoint. The slack permitted by tolerance stays a kink at the joint, matching R-17. Copying the tangent instead leaves a visible gap. |
| R-93 | Snapping corrects only the cone angle, preserving the azimuth around the tangent. A cone is a continuum, so this is the minimal correction. |
| R-94 | Point dragging on the canvas is 2D-only. In 3D, coordinates are edited in the table, since dragging needs a chosen depth plane. |

---

## 4. Project layout

Both builders share one core, because the scalar relationships in §3 are identical and a correction
to them must never need making twice.

```
config.json          one file, both apps
src/core/            dimension-free: angles, arcMath, solve, config, store
src/2d/              bearings and rays  -> SVG
src/3d/              tangent vectors and cones -> Three.js
index.html           2D          index3d.html   3D
```

| ID | Requirement |
|----|-------------|
| R-95 | `src/core/` must not import from `src/2d/` or `src/3d/`, and must contain nothing dimension-specific. |
| R-96 | `walkPath` treats the tangent as opaque, so 2D passes a bearing in degrees and 3D a unit vector through the same loop. |
| R-97 | Autosave keys are namespaced per app, so the two builders never overwrite each other. |
| R-98 | Points always carry `z`. The 2D app leaves it at 0 (R-13); the 3D app exposes it. |
| R-99 | Three.js is loaded from a CDN via an import map, preserving the no-build-step rule (N-01). |

---

## 5. Functional requirements

### Input

| ID | Requirement |
|----|-------------|
| R-01 | The user can add points by typing `x` and `y` values into a table. |
| R-02 | Points are added **only** via the Add point button and the table. Clicking empty canvas must **not** create a point — empty space belongs to panning (R-80). |
| R-03 | The user can edit an existing point's coordinates, both by typing and by dragging it on the canvas. |
| R-04 | The user can delete any point. |
| R-05 | The user can reorder points (move up / move down). Reordering re-solves the whole path. |

### Solving

| ID | Requirement |
|----|-------------|
| R-10 | The path is solved front-to-back, carrying the exit tangent forward as the next segment's incoming tangent. |
| R-11 | The first segment's incoming tangent comes from a user-editable **initial heading**, in degrees, default `0`. |
| R-12 | A segment is **valid** if its chord bearing is within the angular tolerance of one of the seven legal bearings (§3.2). |
| R-12a | A 0° (straight) connection carries the incoming tangent through unchanged: `t_end = t_start = φ`. |
| R-13 | Points carry a `z` field fixed at `0`, reserved for a future 3D mode. No 2D behaviour may depend on it. |
| R-14 | A zero-length segment (two identical consecutive points) is a **degenerate** error, reported separately from an angular violation. |

### Tolerance

| ID | Requirement |
|----|-------------|
| R-15 | Angular tolerance is user-adjustable via a slider, expressed in **degrees**, range `0°–15°`, default `2°`. |
| R-16 | Tolerance is angular, not positional. A pixel tolerance would be inconsistent, since the same pixel offset spans a different angle at different distances. |
| R-16a | Tolerance answers: *how far off an exact guide ray may a point sit and still be accepted?* At `0°` only exact placements pass. It is the only reason a segment is ever judged on anything other than exact equality, and it must be explained inline in the UI. |
| R-17 | When a segment is accepted *within* tolerance, the arc is built from the **actual** chord, so its swept angle is exactly 0/30/45/60. The residual tangent mismatch (up to the tolerance) is absorbed at the junction and reported as the segment's `error`. Points are never silently moved. |

### Errors

| ID | Requirement |
|----|-------------|
| R-18 | A violating segment is drawn as a **red dashed straight chord**, so the path remains continuous and readable. A *valid* straight run is drawn solid in the normal stroke colour, so the two are never confused. |
| R-19 | Errors **do not cascade**. After a violation, the outgoing tangent resets to that straight chord's bearing and solving resumes normally. One bad point must not paint every downstream segment red. |
| R-20 | While placing or dragging a point, the seven legal rays from the anchoring point are drawn as **ghost guides**, each labelled with its swept angle and turn direction. |
| R-21 | Optional **snap mode**: a point being placed or dragged snaps to the nearest legal ray, preserving its distance from the anchor. |
| R-22 | Each violating segment offers an **auto-fix** that moves the endpoint onto the nearest legal ray, keeping its current distance from the previous point. |
| R-23 | Violations are surfaced in three places: the canvas (red dashed segment), a marker at the segment midpoint, and a badge on the offending row in the point table. |

### Duct and jacket rendering

| ID | Requirement |
|----|-------------|
| R-30 | A **duct width** slider renders a thick translucent band around the centerline. |
| R-31 | The duct is a **stroke only**. Its width maps directly to `stroke-width`. |
| R-32 | Wall thickness is explicitly **out of scope**. No offset outline curves, no inner/outer boundary geometry, no area or collision computation. |
| R-33 | Changing duct width must not alter centerline geometry by even a pixel. |
| R-34 | Ducts are drawn only for valid segments. Violating segments have no real path to thicken. |
| R-35 | The duct has **flat (butt) ends**, like a cut cylinder — not rounded caps. |
| R-36 | Consecutive valid segments are merged into a **single continuous path** per run, so flat ends appear only at the genuinely open ends of a run. Drawing each segment separately would notch the outside of every joint. A violation breaks the run in two. |
| R-37 | **Jacketing** wraps the duct. It is a single **global** diameter for the whole path, not per-segment. |
| R-38 | The jacket diameter is an **absolute outer diameter**, not a thickness added to the duct. It is rendered as a wider stroke beneath the duct, sharing the duct's merged runs, flat ends and smooth joints. |
| R-39 | The jacket may be set narrower than the duct. This is **not** an error and is never clamped, but because the jacket is drawn beneath the duct it becomes invisible, so the UI says so explicitly and reports the cover (`(jacket − duct) / 2`) otherwise. |
| R-40 | Jacketing is always present and toggleable on/off, exactly like the duct layer. |
| R-41 | Like the duct, the jacket is a stroke only and has no effect on centerline geometry or on validation. |

### Bend radius

| ID | Requirement |
|----|-------------|
| R-60 | A segment whose arc radius falls below `r_min` is **too tight to bend** (§3.4). This is a distinct condition from an angular violation: the centerline is legal, but no band of that width can follow it. |
| R-61 | `r_min = ratio × D`, where `D` is the **widest band** in the assembly, `max(duct, jacket)`. The jacket counts even when its layer is hidden, because it physically exists either way. |
| R-62 | The `ratio` is user-adjustable, default `1.5 × D`, range `0.5–4`. Below `1.0` the UI warns; `0.5 × D` is the hard geometric floor at which the inner edge folds back on itself. |
| R-63 | Guide rays render their dead zone distinctly: the stretch nearer than `d_min(θ)` is drawn as a blocked stub, the remainder as a normal ray. The straight ray has no dead zone. |
| R-64 | A too-tight segment is drawn in the warning colour, keeps its duct and jacket bands, and does **not** break a run. Seeing the crease is the point. |
| R-65 | A too-tight segment carries its arc's exit tangent forward normally. Only angular violations fall back to the chord bearing. |
| R-66 | Snapping and auto-fix push a point out to `d_min(θ)` when it sits inside the dead zone, so snapped placement can never produce a too-tight bend. |

### Viewport

| ID | Requirement |
|----|-------------|
| R-80 | Dragging empty canvas **pans**. Dragging a point still moves that point. |
| R-81 | The scroll wheel **zooms about the cursor**, so the point under the pointer stays fixed. Zoom is clamped to a viewport width of 150–24000 units. |
| R-82 | Pan and zoom are **session state, not document state**. They live outside the store, are applied straight to the SVG `viewBox`, trigger no re-render, and are not exported or persisted. |
| R-83 | A **Fit** button frames all points with padding, preserving the base aspect ratio. |
| R-84 | Fit runs automatically on load, after import, and after Add point when the new point would fall outside the current viewport — a new point must never appear off-screen. |
| R-85 | The grid spans far beyond the base viewport so panning never reveals an unpainted edge. |

### Persistence

| ID | Requirement |
|----|-------------|
| R-50 | The full state exports to JSON using the 3D-ready point schema, including duct and jacket diameters. |
| R-51 | JSON can be imported, replacing current state. |
| R-52 | State autosaves to `localStorage` and restores on load. |

### Cross-link between the builders

| ID | Requirement |
|----|-------------|
| R-100 | Each app offers a button that hands the current path to the other, behind the `crossLink` flag. |
| R-101 | The handoff uses a **one-shot `sessionStorage` slot**, consumed and cleared on arrival. It is a transfer, not a save, so it must not linger or compete with either app's namespaced autosave (R-97). |
| R-102 | 2D → 3D always preserves validity, because the 2D rays are these cones cut by the `z = 0` plane (§3.5). 3D → 2D is **not** symmetric: if any point has a non-zero `z`, the 2D view shows the xy projection, which is a different path, and must say so rather than silently display angles the user did not author. |

---

## 6. Non-functional

| ID | Requirement |
|----|-------------|
| N-01 | No framework, no bundler, no build step, no `npm install`. |
| N-02 | Rendering uses native SVG in 2D. Arcs use the `A` path command, straight runs use `L`; bands use `stroke-width`. 3D uses Three.js. |
| N-03 | Geometry is a pure, DOM-free module so it can be unit-tested under Node. |
| N-04 | Served over a static HTTP server (ES modules are blocked on `file://`). |
| N-05 | **Exactly one runtime dependency: Three.js**, loaded from a CDN via an import map. Everything else — state store, config loader, SVG rendering, pan/zoom, feature flags, vector helpers — is hand-written. Reaffirmed 2026-09-14 after an explicit review. |
| N-06 | Geometry modules must not import a rendering library, so they keep running under `node --test` with no toolchain. This is why `src/3d/vec3.js` exists rather than using `THREE.Vector3`, despite the overlap. |
| N-07 | Tests use the built-in `node:test` runner only. |

### Known limitations accepted by N-05

- 2D pan/zoom is single-pointer: there is **no pinch-zoom or touch panning**. A library such as
  `svg-pan-zoom` or `d3-zoom` would provide it. Accepted deliberately in favour of zero install.
- `src/3d/vec3.js` duplicates a small part of `THREE.Vector3` (see N-06 for why).

---

## 7. Coordinate convention

**`y` increases downward**, matching SVG and canvas convention. Positive angles therefore rotate
clockwise on screen. This is applied consistently across input, storage, maths and rendering — there
is no flip anywhere in the pipeline.

---

## 8. Configuration and feature flags

All of this lives in `config.json` at the project root, fetched at startup. No rebuild — edit and
reload.

| ID | Requirement |
|----|-------------|
| R-70 | `config.json` holds three sections: `sweeps`, `features` and `defaults`. |
| R-71 | `sweeps` sets the permitted swept angles. Values are deduplicated, sorted, and any outside `[0, 180)` are dropped. An empty resulting set is an error. |
| R-72 | `defaults` seeds the initial values of `initialHeading`, `toleranceDeg`, `ductWidth`, `jacketWidth` and `minRadiusRatio`. Unknown or non-numeric keys are ignored. |
| R-73 | `features` holds booleans. A disabled feature hides its UI **and** is excluded from behaviour — it is absent, not merely switched off. |
| R-74 | Adding a flag must require no new plumbing: add the boolean, tag the owning elements with `data-feature="name"`, and gate behaviour on `state.features.name`. `data-feature` accepts a **comma-separated list**, and the element is shown only when every named flag is enabled. |
| R-75 | The config is merged section-wise over built-in defaults, so a partial file is valid. A missing or malformed file logs a warning and falls back to the built-ins — it must never take the app down. |
| R-76 | With `autosave` disabled, `localStorage` is neither written nor read, so config defaults always win on reload. |
| R-77 | A disabled `duct` or `jacket` is excluded from the `r_min` calculation (R-61). This differs from merely hiding the layer, where the band still counts because it physically exists. |
| R-78 | The **3D builder is gated behind `threeD`, which defaults to `false`**. When off, `index3d.html` renders a short notice and a link back to 2D, and must **not** create a WebGL context or initialise a scene. The 2D cross-link button is hidden, since its only destination is unavailable. |
| R-79 | Flag gating is a **product switch, not a security control**: `index3d.html` is still served and the flag lives in a client-readable file. Anything requiring real access control must be enforced server-side. |

Current flags: `duct`, `jacket`, `minBendRadius`, `guideRays`, `snapping`, `importExport`,
`crossLink`, `threeD` (off by default), `autosave`.

---

## 9. Explicitly out of scope

- Wall thickness / offset outline geometry (R-32)
- 3D rendering, though the data model is prepared for it (R-13)
- Multi-arc connections between a single pair of points
- Self-intersection and collision detection
- Undo / redo

---

## 10. Open questions

1. The tolerance slider still tops out at 15°, but the widest gap between adjacent rays is only 7.5°.
   Above 7.5° every bearing inside the ±45° fan is accepted, so the upper half of the slider does
   nothing useful. Lower the maximum to ~8°?
2. Should reordering points preserve the initial heading, or re-derive it from the new first segment?
3. Should there be a "closed loop" mode where `Pn` reconnects to `P0`, with tangent continuity
   enforced across the seam?
4. Should consecutive straight runs be merged into one segment for export, or kept distinct?

---

## Changelog

| Date | Change |
|------|--------|
| 2026-09-14 | Initial draft. Core model, worked geometry, R-01…R-42, N-01…N-04. Established that feasibility is purely angular (§3.2) and that radius is derived (§3.1). |
| 2026-09-14 | Added **0° (straight)** as a permitted swept angle — a duct may run straight. Legal bearings go from six to seven; the fan still spans `τ ± 30°` but now includes `τ` itself. Added R-12a, amended §2.2, §3.1–§3.3, R-17, R-18, R-20, N-02, and removed straight segments from the out-of-scope list. Widest gap between adjacent rays drops from 15° to 7.5°. |
| 2026-09-14 | Duct ends are now **flat**, not rounded (R-35). Required merging consecutive valid segments into one path per run (R-36), otherwise butt caps notch every joint. Added R-16a: tolerance must be explained inline in the UI. |
| 2026-09-14 | Added **jacketing** (R-37…R-41): a global, absolute outer diameter rendered as a wider band beneath the duct, reusing the duct's merged runs. Renumbered persistence to R-50…R-52 to make room. Still stroke-only — no geometry impact. |
| 2026-09-14 | **Correction — minimum bend radius (R-60…R-66, §3.4).** The claim in §3.1–§3.2 that distance never matters was only true for a zero-width centerline. A band of width `W` on an arc of radius `r` has an inner edge of radius `r − W/2`, which inverts when `r < W/2`, creasing the duct. Radius now has a floor of `ratio × max(duct, jacket)`, which becomes a per-sweep **minimum chord length** `d_min(θ) = 2·r_min·sin(θ/2)`. Each guide ray gained a dead zone near its origin. §3.1 retitled and §3.2 reworded to scope their claims to *direction*. |
| 2026-09-14 | Added **90°** to the permitted sweeps. Legal bearings go from seven to nine and the fan widens from `τ ± 30°` to `τ ± 45°`. The 7.5° worst-case gap is unchanged, but now occurs twice. |
| 2026-09-14 | Added **`config.json` with feature flags** (§9, R-70…R-77). Sweeps, seed values and seven feature toggles are now file-driven. A disabled feature is absent rather than hidden, which is why R-77 carves out the `r_min` case. |
| 2026-09-14 | Added **pan and zoom** (R-80…R-85) and **removed click-to-add** (R-02). The two are linked: freeing empty canvas from point creation is what makes drag-to-pan possible. Pan/zoom deliberately sits outside the store, so it neither re-renders nor persists. Added a Fit button, applied automatically on load, on import, and when Add point would place a point off-screen. Pan and zoom left the out-of-scope list. |
| 2026-09-14 | **Split into `src/core/` + `src/2d/` + `src/3d/`** (§4, R-95…R-99) and added the **3D builder** (§3.5, R-90…R-94). The generalisation is that each sweep becomes a cone around the tangent, of which the 2D rays are a planar slice; all the scalar maths moved to core unchanged. 3D rendering uses Three.js from a CDN import map. A single shared `config.json` now drives both apps, with per-app autosave namespaces. |
| 2026-09-14 | Added a **cross-link** between the two builders (R-100…R-102): a one-shot `sessionStorage` handoff, behind the `crossLink` flag. 2D → 3D is always safe because the 2D rays are the cones cut by the z = 0 plane; 3D → 2D warns when points had a non-zero z, since the projection is a different path. |
| 2026-09-14 | **Dependency policy reviewed and reaffirmed** (N-05…N-07). Confirmed the project is hand-written apart from Three.js. Noted that N-01 was originally stated more strictly than requested — frameworks were ruled out, libraries were not — and that hand-rolled pan/zoom costs touch and pinch support. Decision: keep it dependency-light, keep the no-build-step rule, and log the gaps rather than close them. |
| 2026-09-14 | **3D put behind the `threeD` flag, off by default** (R-78, R-79). `index3d.html` now refuses to initialise when the flag is off, before any WebGL context is created, and the 2D cross-link hides with it. `data-feature` gained comma-separated multi-flag support (R-74) so that button can require both `crossLink` and `threeD`. The duplicated flag applier moved into `core/config.js`. |
