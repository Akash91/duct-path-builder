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
src/core/            dimension-free: angles, arcMath, solve, config, store,
                     slope, routing, pieces, polyline, piecePanel, view
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
`crossLink`, `threeD`, `flanges`, `drainSlope`, `autosave`. All ship **on**.

---

## 8a. Units

- **R-110** Every length in the model, the UI, the export and the config is a **millimetre**.
  Every label that shows a length or a diameter says `mm`.
- **R-111** Saved data is never silently rescaled. The current keys are
  `curve-path-builder/2d/v3` and `curve-path-builder/3d/v3`. Older millimetre (`/v2`) and
  centimetre saves are left where they are, unread.
- **R-112** Shipped seed values: duct 180, jacket 400, min radius ratio 1.5, max piece length
  1050, elbow flange offset 60, angled-straight minimum lead 100, drain pitch 3°, drain
  tolerance 1°.

---

## 8b. Shop pieces

Table points are **centerline waypoints**, not parts. Pieces are **derived**, flange to flange,
and the ends of a path count as flanges.

- **R-120** There are exactly three manufactured kinds: **straight**, **elbow**, **angled
  straight**. Their drawn stretches are tagged `straight`, `elbow` and `kick`.
- **R-121** A straight longer than `maxPieceLength` splices into `ceil(length / max)` **even**
  pieces. Consecutive straights merge across a table point first, because a waypoint is not a
  flange.
- **R-122** An elbow piece is flange, `offset` stub, the arc, `offset` stub, flange. A flange is
  never placed on an arc.
- **R-123** With `compactElbows` **on**, the drawn elbow radius shrinks to `r_min` whenever the
  leftover `(R − r)·tan(θ/2)` still carries a stub on each side. The leftover of a fillet between
  two rays is equal on both sides, so the lead and the trail are the same length. The arc must end
  as soon as the outgoing plane can run straight to the next point.
- **R-123a** With `compactElbows` **off** (the shipped default) the elbow keeps the radius its
  table points imply: leftover is zero and the arc fills the span edge to edge. This is what a
  radius taken off a drawing needs. The consequence is that `r_min` then only *flags* a too-tight
  bend rather than shaping one.
- **R-124** Only if `2·offset + R·θ` would exceed `maxPieceLength` may the radius shrink further,
  and never below `r_min`. If even that overflows, the span is **`elbow-too-long`** — the bend is
  *not* split.
- **R-125** Leftover after an elbow is laid out as flange, stub, arc, stub, flange, **then** the
  leftover straight, spliced at the maximum. The elbow never swallows the whole leftover.
- **R-126** Less than a stub of straight on either side of an elbow, or between two elbows, is
  **`short-stub`**.
- **R-127** An angled straight is at least `minLead` along the incoming tangent, a **kick** of
  between 0.5° and 5°, then a straight to the point. The kick takes no elbow flanges. Its plane
  is the plane of the incoming tangent and the chord, so its outbound end face may be oblique.
  The ceiling is deliberately small: a kick has no radius and no flanges, so on a drawing it is a
  mitred joint, and real duct drawings contain none. Anything beyond a few degrees of aim must be
  a radiused elbow at a standard angle, or fail.
- **R-128** The user may cut a derived straight further. That is a shop choice: it adds no table
  point and changes no geometry.
- **R-129** A flange is a **collar plus a plate**, not a torus. 2D draws the plate edge-on with a
  short collar; 3D draws an open-cylinder collar, a ring plate and four decorative bolt holes.
  Both use the same stations and the same diameters. The plate is sized from the **duct**, not the
  jacket: a flange bolts to the duct and sits under the insulation.
- **R-129a** The jacket diameter may be **0**, meaning no jacket. `r_min` then follows the duct
  alone and no jacket tube is drawn.

---

## 8c. Planarity and routing (3D)

- **R-130** A shop elbow is **planar**: its arc lies in one plane. That plane may be **rolled**
  about the incoming tangent to any angle — an ordinary rolling offset — so an elbow may turn in
  plan and elevation at once. Only the **sweep** is constrained, to the configured set. `route`
  reports `plan` (roll 0°), `elev` (roll ±90°) or `rolled`, and `roll` carries the plane's angle
  from horizontal for the shop.
- **R-131** A span **off every cone** that must also change elevation is not a fitting. Primary
  route: an **angled straight**. Fallback: **two compact 90° cardinals** — run on, turn onto the
  lateral cardinal, turn onto the vertical. Only if neither can be built is it **`compound-bend`**.
- **R-132** A purely lateral miss has no shop trick, and stays **`no-legal-arc`**. This is why 2D,
  which has no elevation, never produces an angled straight.
- **R-133** Guide marks in 3D are the **four cardinal generators** of each cone — left, right, up,
  down in the tangent's frame — plus the straight-ahead ray. Not a full ring.

---

## 8d. Drainage (3D, `drainSlope`)

- **R-140** Pitch is `asin(Δz / chord)` in degrees, `+Z` up. The floor is
  `slopeDeg − slopeToleranceDeg`.
- **R-141** A **straight** flatter than the floor is **`off-slope`**. A rise *or* a fall at or
  above the floor is valid; there is no riser checkbox. Elbows are not judged for drain.
- **R-142** The incoming stub of an angled straight may follow the old heading, including a level
  one. Drain is judged on the **outbound** run after the kick.
- **R-143** An elevation-only chord that misses every discrete elbow but meets the floor is a
  **sloped straight**, not a forced 30° fitting.
- **R-144** Fix on a too-flat straight pitches `z` to `slopeDeg`, sign following the fall already
  drawn, or up if level. It inserts no table point.

---

## 8e. Drawing

- **R-150** The drawn centerline is the **shop** centerline — straight chords and real circular
  arcs, walked by arc length. No Catmull-Rom and no spline is fitted through the samples: a spline
  through a sparse straight bulges around a table point that sits on a tangent.
- **R-151** Elbow stretches are overlaid in **amber**, kick stretches in **teal**, on the merged
  run, so the circular middle reads. In 3D the whole centerline is one **thin tube of constant
  diameter** whose colour changes with the kind — WebGL ignores line width, and a stretch drawn
  fatter than the rest reads as a second pipe rather than a marker on the run.
- **R-151a** Duct, jacket and flanges are toggleable layers and all three **start hidden**: the
  centerline is what the user is authoring. Hidden is not disabled — an unticked jacket still
  sets `r_min`.
- **R-152** Point markers are **pins**, not a second duct: the drawn diameter stays under 20% of
  `max(duct, jacket)`.
- **R-153** The 3D scene always draws an **origin triad** at `(0,0,0)` — X red, Y green, Z blue —
  with a `0,0,0` label. Fit frames the path **and** the origin. Reset view returns to a default
  orbit that includes it.
- **R-154** Selecting a table row pans onto that point, keeps the current approach, and never
  closes in nearer than **9000 mm**.
- **R-155** Hovering a duct piece reports its flange-to-flange length in mm and its arc degrees.
- **R-156** The settings panel collapses, so the point table always has somewhere to scroll and
  the left column never overflows the viewport.

---

## 9. Explicitly out of scope

- Wall thickness / offset outline geometry (R-32)
- Self-intersection and collision detection
- Undo / redo
- Closed-loop mode
- Pinch-zoom and touch panning
- Multi-arc connections between a single pair of **table** points (shop pieces on one span are
  allowed)

---

## 10. Open questions

1. The tolerance slider still tops out at 15°, but the widest gap between adjacent rays is only 7.5°.
   Above 7.5° every bearing inside the ±45° fan is accepted, so the upper half of the slider does
   nothing useful. Lower the maximum to ~8°?
2. Should reordering points preserve the initial heading, or re-derive it from the new first segment?
3. Should there be a "closed loop" mode where `Pn` reconnects to `P0`, with tangent continuity
   enforced across the seam?
4. Should consecutive straight runs be merged into one segment for export, or kept distinct?
5. The cardinal-90 fallback currently reaches a point by turning onto the lateral cardinal and
   then the vertical. Should it instead prefer whichever order gives the longer straights?
6. Extra splits chosen by hand are keyed on the piece's station, so they survive a re-solve but
   not a change of geometry upstream of them. Is that the right lifetime?

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
| 2026-09-24 | **Millimetre era** (§8a, R-110…R-112). Every length is now a millimetre and every label says so. Seeds moved to duct 180 / jacket 400. Storage keys bumped to `/v2` rather than rescaling any centimetre save. The demo path is the four shipped points, lifted onto the drain ramp in 3D. |
| 2026-09-24 | **Shop pieces** (§8b, R-120…R-129). The path is now cut into derived flange-to-flange parts: straight, elbow, angled straight. Added `core/pieces.js` (elbow fillet layout, even splicing, stub accounting), `core/polyline.js` (arc-length walking) and `core/piecePanel.js`. New failure names `elbow-too-long` and `short-stub`, which warn rather than break the run. Flanges are a collar plus a plate in both views, at the same stations. |
| 2026-09-24 | **Planarity and routing** (§8c, R-130…R-133). A legal cone angle is no longer sufficient in 3D: an elbow must yaw in plan or pitch in elevation, measured in the tangent's own frame. Y+Z spans route to an angled straight, then to two cardinal 90s, and only then fail as `compound-bend`. Guide marks dropped from full rings to the four cardinal generators plus the straight ray. `threeD` now ships on. |
| 2026-09-24 | **Drainage** (§8d, R-140…R-144). Added `core/slope.js` and the `drainSlope` flag. A horizontal straight flatter than `slopeDeg − slopeToleranceDeg` is `off-slope`; a rise and a fall are equally valid. Drain on an angled straight is judged after the kick, so the 100 mm stub may stay level. Fix pitches `z` without inserting a point. |
| 2026-09-24 | **Drawing correction** (§8e, R-150…R-156). The 3D duct was being tubed along a `CatmullRomCurve3` through sampled points, which bulges around a table point sitting on a tangent. Replaced with a curve that walks the real shop polyline by arc length. Added the amber/teal stretch overlay, the origin triad, the 9000 mm row-focus standoff, piece hover tooltips, and a collapsible settings accordion so the point table can scroll. |
| 2026-09-26 | **Layers** (R-151a). Flanges became a toggleable layer alongside duct and jacket, and all three now start hidden — a 500 mm jacket buries the centerline the user is authoring. Hidden still counts towards `r_min`; only a disabled feature is excluded. |
| 2026-09-27 | **Correction — a rolled elbow is a real fitting** (R-130, R-131). The rule that an elbow must yaw in plan *or* pitch in elevation was wrong: a standard elbow rolled about the incoming axis is an ordinary rolling offset, and it turns in both at once. Only the sweep is constrained. `route` gained `rolled` and segments carry the bend plane's `roll` angle. This alone fixed two spans of the worked example that had been failing as `compound-bend`. |
| 2026-09-27 | **Correction — the kick ceiling was far too high** (R-127). It was 60°, which silently accepted 43°, 52° and 58° mitres as valid. Thirteen spools of real drawings contain **no mitred joints at all** — every direction change is a radiused elbow at a standard angle, and the only off-angle is the drain slope, which comes from the run's direction rather than a fitting. Lowered to 5°, whose one honest use is starting a slope off a level run. |
| 2026-09-27 | **`compactElbows` made a flag, off by default** (R-123a). Shrinking every elbow to `r_min` is right when laying out a run from scratch and wrong when the radius came off a drawing — it replaced a specified 665 mm arc with a 360 mm one plus two straights. Off, the arc fills the span edge to edge. |
| 2026-09-27 | **`compound-bend` narrowed** . It was reported for any unroutable span reaching the routing branch, including pure-elevation ones with no lateral component at all — which sent the reader hunting for an offset that was not there. Now reserved for spans that move both sideways and vertically; elevation-only misses are `no-legal-arc`. |
| 2026-09-27 | **Real duct sizes, and the flange moved onto the duct** (R-129, R-129a). Extracted from a production DWG: duct ID 400×3, insulation ID 506×1.5, flange 485×12, `SLOPE 3°`. The flange plate had been sized from `max(duct, jacket)`; it bolts to the duct and sits under the insulation, so it is sized from the duct. Jacket may now be 0. See [source-data.md](source-data.md). |
| 2026-09-27 | **Drawing demo path.** The default table is the twelve-point run (start, 3° slope, 90° r 657, riser, 30° r 675, incline, 30° r 675, riser, 45° r 509, straight, 30° r 560, straight to end). z is authored, not re-ramped. Storage keys bumped to `/v3` so an old four-point save is not silently kept. |
