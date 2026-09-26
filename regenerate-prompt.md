# Regeneration prompt — Arc Path Builder

You are implementing this application from scratch in a new empty folder. Do not copy code from anywhere. Do not mention remotes, hosting, or any source repository. Produce a complete local app that matches the product described here.

Work in millimetres. Do not silently rescale saved data. Do not invent extra shop kinds. Do not use a spline to draw the duct. Chat is not the spec after you start: keep a living `docs/requirements.md` and append every rule you implement.

---

## What to build

A browser plant-duct modeller. The user types an ordered list of points. The app connects each consecutive pair with a **legal centerline**. Invalid spans are flagged. They are never quietly redrawn as something else.

Two views share one geometry core:

- **2D** — SVG plan, page `index.html`, title “Arc Path Builder”
- **3D** — Three.js, page `index3d.html`, title “Arc Path Builder — 3D”, world `+Z` up

Zero-build ES modules. No framework, no bundler, no `npm install` to run the app. The only runtime library is Three.js, loaded from a public CDN via an import map (three version 0.160.0 is fine). Everything else is hand-written.

Serve with a static HTTP server (`python3 -m http.server 8000`). ES modules will not load from `file://`. Tests use Node 20 and the built-in `node --test` runner only. Geometry modules must not import a renderer, so they run under Node with no toolchain.

---

## Folder layout

Create this tree. `src/core/` must not import from `src/2d/` or `src/3d/` and must contain nothing that is 2D- or 3D-specific.

- `config.json` — sweep set, feature flags, seed defaults. Shared by both apps. Fetched at startup. Edit and reload; no rebuild.
- `index.html` — 2D page
- `index3d.html` — 3D page (import map for Three.js)
- `styles.css` — shared dark UI
- `package.json` — `"type": "module"`, scripts for `node --test tests/` and the static server only
- `docs/requirements.md` — living spec inbox. Append every agreed rule. If a rule is not written, it is not implemented.
- `src/core/` — dimension-free: sweep/angle helpers, arc maths, path walker, config merge, store, flange/piece layout, drain pitch, angled-straight routing, shop visual kinds, view helpers, piece-panel helpers
- `src/2d/` — bearings and legal rays, SVG render, 2D main
- `src/3d/` — unit tangents and cones, 3D classify/expand, Three.js render, 3D panel, 3D main, a tiny local vector helper so geometry never imports Three.js
- `tests/` — Node tests for core, 2D geometry, 3D geometry, flanges, slope, angled straight, shop drawing, and invariants that lock origin / row-focus / piece dropdown / millimetre labels

The path walker treats the incoming tangent as opaque: 2D passes a bearing in degrees, 3D a unit vector, through the same loop.

---

## Config (shipped values)

Three sections: `sweeps`, `features`, `defaults`. Merge section-wise over built-in defaults so a partial file is valid. A missing or malformed file logs a warning and falls back; it must never crash the app.

Sweeps: 0, 30, 45, 60, 90. Deduplicate, sort, drop any value outside `[0, 180)`. An empty resulting set is an error.

Feature flags (all **on** in the shipped file): duct, jacket, minBendRadius, guideRays, snapping, importExport, crossLink, threeD, flanges, drainSlope, autosave.

A disabled feature is **absent**: hide its UI and exclude it from behaviour. Tag HTML with `data-feature="name"`. A comma-separated list means every named flag must be on. Flag gating is a product switch, not security. The 3D page is still served. If `threeD` is off, `index3d.html` shows a short notice and a link back to 2D and must not create a WebGL context. The 2D cross-link button is hidden when 3D is off.

Seed defaults:

- initial heading 0°, initial elevation 0°
- angular tolerance 2°
- duct width 180 mm, jacket diameter 400 mm
- min radius ratio 1.5 (range 0.5–4)
- max piece length 1050 mm
- elbow flange offset 60 mm
- angled-straight minimum lead 100 mm
- drain pitch 3°, drain tolerance 1°

With autosave off, do not read or write localStorage, so config defaults win every reload.

---

## Look and feel

Dark theme. Background near `#0d1117`, left panel near `#141a22`, text near `#dfe6ef`, muted `#8a97a8`. Accents: cool blue for valid straights (`#4ea8ff`), amber for shop-elbow arcs (`#f0a020`), teal for angled-straight kicks (`#5ee0c0`), red for errors (`#ff5f56`), gold warning for too-tight (`#d9a441`).

Layout: 340 px left panel, remaining width is the stage. Panel is a column: header, settings accordion, layer toggles, notice, summary, scrollable middle (duct-pieces accordion + point table), footer buttons. The settings accordion must collapse so the table can scroll; do not let the left column overflow the viewport.

2D hint: every connection is one arc of 0° (straight), 30°, 45°, 60° or 90°, departing along the previous tangent. Coordinates are millimetres. A shop elbow is 60 mm lead, an amber circular arc, and 60 mm trail. Hover a piece for length and bend.

3D hint: three shop pieces — straight; elbow (60 mm lead, 30/45/60/90° amber arc, 60 mm trail); angled straight (≥ 100 mm along incoming, teal kick toward the next point, then a sloped straight). A span that moves in Y and Z uses an angled straight. The duct at the end is a cylinder on that heading, not locked to XY, YZ or XZ. Horizontal runs must rise or fall at least 3° so they drain either way.

---

## User interface

### Shared

- Points are added **only** via Add point and the table. Clicking empty canvas must not create a point.
- Each point is `{ id, x, y, z }`. 2D leaves `z` at 0 and does not edit it. 3D exposes `z`.
- User can edit coordinates (2D: type or drag on canvas; 3D: type in the table only), delete, and reorder (move up / move down). Reorder re-solves the whole path.
- Settings sliders: initial heading (−180…180), angular tolerance (0…15, step 0.5) with an inline note that slack is a kink at the joint and nothing is moved, duct width, jacket diameter, min bend ratio, max piece length, elbow flange offset. 3D also has initial elevation (−89…89) and drain pitch (1…10).
- Toggles: Duct, Jacket, Guide rays (labelled “Cones” in 3D), Snap.
- Footer: Add point, Fit, Clear, Export, Import. 3D also has Reset view. Cross-link: 2D has “Open this path in 3D →” (needs crossLink and threeD). 3D has “← Open this path in 2D”.
- Point table: #, x (mm), y (mm), Arc in, actions. 3D adds z (mm). Selecting a row pans onto that point.
- Duct pieces accordion: a dropdown of derived flange-to-flange pieces (kind, length, optional per-piece diameter later). It does not add table points. The user may split a leftover straight further.
- Summary line of valid / invalid / too-tight counts.
- Violations appear in three places: red dashed chord on the canvas, a marker at the segment midpoint, a badge on the table row.
- All length and diameter labels say `mm`.
- Jacket note: if jacket is narrower than duct, say it is hidden under the duct; otherwise report cover `(jacket − duct) / 2`.
- Ratio note: warn when ratio is below 1.0. Hard geometric floor is 0.5 × D.

### 2D stage

- Drag empty space to pan. Scroll wheel zooms about the cursor. Zoom clamp: viewport width 400–80000 mm.
- Drag a point to move it. Snap (optional) holds the point on the nearest legal ray and out of the dead zone.
- Fit frames all points with padding. Run Fit on load, after import, and after Add point if the new point would be off-screen.
- Pan and zoom are session-only: apply to the SVG viewBox, do not persist, do not export, do not re-render the path.
- Grid extends far beyond the base view so panning never shows an unpainted edge.
- Guide rays from the selected / last point: each legal bearing labelled with sweep and turn. Dead zone nearer than `d_min(θ)` is a blocked stub. Straight ray has no dead zone.
- `y` increases **downward** (SVG convention). Positive angles therefore look clockwise on screen. Apply this everywhere: input, storage, maths, render. No flip.

### 3D stage

- Drag to orbit, scroll to zoom, right-drag to pan. Coordinates are edited in the table, not by dragging points.
- Always draw an origin triad at `(0,0,0)`: X red, Y green, Z blue, plus a `0,0,0` label. Fit frames the path **and** the origin.
- Selecting a table row pans onto that point, keeps the current approach, and never closer than **9000 mm**.
- Reset view returns to a sensible default orbit that includes the origin.
- Guide marks are the four cardinal generators of each cone (left, right, up, down in the tangent’s frame) plus the straight-ahead ray — **not** a full ring.
- Hover a duct piece for a tooltip with flange-to-flange length (mm) and arc degrees. 2D must do the same.

---

## Persistence and handoff

- Autosave to `localStorage`, namespaced per app so the two builders never overwrite each other. Use a millimetre-era key such as `curve-path-builder/2d/v2` and `curve-path-builder/3d/v2`. Leave any older centimetre save unused.
- Export / import JSON using the 3D-ready point schema, including diameters.
- Cross-link uses a **one-shot `sessionStorage` slot**, consumed and cleared on arrival. It is a transfer, not a save. 2D → 3D always preserves validity (2D rays are the cones cut by `z = 0`). 3D → 2D must warn if any point has `z ≠ 0`, because the xy projection is a different path.

---

## Demo path (must look like this on first load)

Four points, millimetres:

1. `(0, 0, 0)`
2. `(1600, 0, 0)`
3. `(2083.0, 129.4, 0)`
4. `(3295.4, 829.4, 0)`

In 3D with drain on, set each point’s `z = x · tan(slopeDeg)` so the opening run drains. If an old save has all `z = 0` with drain on, the first span will look too-flat until the user clears storage.

Expected shop read of this demo:

1. Span 1: **angled straight** — 100 mm along +X, teal kick of a few degrees, then a long sloped straight to point 2.
2. Span 2: **30° plan elbow** — about 98 mm lead, a **short amber** circular arc at `r_min` (about 600 mm radius, about 314 mm of arc), about 98 mm trail already on the outgoing heading through point 3.
3. Span 3: a long **straight** on that same outgoing plane to point 4, auto-spliced at 1050 mm.

Point 3 is the **end of the span**, not a polyline corner. The orange elbow must finish as soon as the next plane can run straight. Do not draw a long gentle arc still turning at point 3.

---

## Core geometry (normative)

One table span `Pi → Pi+1` is **exactly one circular arc** of swept angle `θ` from the configured set. Multi-arc chains and splines are not valid table connections. Shop fabrication may still cut one legal span into several manufactured pieces.

For chord length `d` and sweep `θ`:

- radius `r = d / (2 · sin(θ/2))`
- at `θ = 0`, `r` is infinite: return a dedicated straight, do not divide by zero
- entry tangent is chord bearing minus `dir · θ/2`
- exit tangent is chord bearing plus `dir · θ/2`
- a non-zero arc may turn either way; a 0° sweep has no handedness
- radius is **derived**. It is never a user input.

Requiring the arc to leave along incoming tangent `τ` quantises the next chord bearing:

`τ ± 45°, τ ± 30°, τ ± 22.5°, τ ± 15°, τ`

Nine rays. The fan is `τ ± 45°`. Widest gap between adjacent rays is 7.5°. Ray count and fan width follow the configured sweep set.

Arc centre (non-straight): from the start point, radius along the inward perpendicular to the entry tangent. A straight has no centre.

**2D:** rays left and right of the bearing.

**3D:** each half-angle is a cone around the incoming unit tangent: the angle between the tangent and the chord must match `θ/2` within tolerance. The arc plane is spanned by the incoming tangent and the chord. If they are parallel and a turn is still required, pick any perpendicular.

**A shop elbow is planar.** It yaws in **plan** (world-horizontal left/right) **or** pitches in **elevation** (up/down in the tangent’s vertical plane). It does **not** roll in Y and Z at once.

Table points **may** differ in Y and Z. That span is **not** one rolling elbow. Primary route: an **angled straight**. Fallback: two compact 90° cardinals. `compound-bend` only if neither route can be built. Auto-fix / snap lands on the nearer plane.

**Entry tangent is reconstructed from the chord** so the arc lands on the endpoint. Angular slack stays as a **kink at the joint**. Copying the incoming tangent leaves a visible gap. Points are never silently moved.

**Tolerance** is angular, not positional. Default 2°. At 0° only exact placements pass. When a span is accepted within tolerance, build the arc from the **actual** chord so the swept angle is exactly one of the permitted values.

The path is solved front to back. The first span uses the user initial heading (and 3D elevation). After that, each exit tangent becomes the next incoming tangent. A 0° straight carries the tangent through unchanged.

**Errors do not cascade.** After an angular (or compound / off-slope / degenerate) failure, the outgoing tangent resets to the straight chord and solving continues. One bad point must not paint every downstream span red.

---

## Drainage (3D, gated by drainSlope)

A “horizontal” duct is never laid dead-level. Wash-down may run either way.

- Pitch = `asin(Δz / chord)` in degrees, `+Z` up.
- Floor = `slopeDeg − slopeToleranceDeg` (2° at shipped defaults).
- A **straight** flatter than the floor is `off-slope`. A rise **or** a fall at or above the floor is valid. A steeper riser or slant is valid. There is no riser checkbox.
- Elbows are not judged for drain.
- The 100 mm incoming stub of an angled straight may follow the previous heading (including a level start). Judge drain on the **outbound** straight after the kick.
- An elevation-only chord that is not a discrete elbow, but whose absolute pitch meets the floor, is a **sloped straight**, not a forced 30° fitting.
- Derived leftovers of a Y+Z split are pitched to `slopeDeg` so they drain; leftover elevation is a riser.
- **Fix** on a too-flat straight pitches `z` to `slopeDeg` (sign follows existing Δz, or up if level). It does not insert a table point.

---

## Minimum bend radius

A band of width `W` on a centerline of radius `r` has an inner edge `r − W/2`. When `r < W/2` that edge inverts and the duct creases.

- `r_min = ratio × max(duct, jacket)`. Default 1.5 × 400 = **600 mm**.
- The jacket counts even when its layer is hidden, because it still exists. A **disabled** duct or jacket is excluded from `r_min`.
- Below `r_min` the span is `too-tight`: the centerline is legal, the real arc is still drawn (warning colour), duct and jacket stay on, the run is **not** broken, and the exit tangent is still the arc’s exit. Only angular failures fall back to the chord.
- Each legal ray has a dead zone `d_min(θ) = 2 · r_min · sin(θ/2)`. The next point must lie on the ray **and** beyond that distance. Sharper sweeps have longer dead zones. The straight ray has none.
- Snap and auto-fix push a point out to `d_min` if it sits inside the dead zone.

---

## Failure reasons (use these names)

- `no-legal-arc` — off every legal ray / cone
- `compound-bend` — Y+Z that cannot be aimed as an angled straight and cannot be split into cardinal 90s
- `off-slope` — straight flatter than the drain floor
- `degenerate` — zero-length chord
- `too-tight` — legal angle, `r < r_min`
- `short-stub` — less than 60 mm of straight on each side of an elbow, or two elbows with less than 120 mm between their arcs
- `elbow-too-long` — even the tightest elbow that still fits one piece exceeds max piece length; do **not** split along the bend

Draw invalid angular / compound / off-slope / degenerate spans as a **red dashed straight chord**. Valid straights are solid in the normal colour. Too-tight keeps the real arc in the warning colour.

---

## Three manufactured kinds

Table points are **centerline waypoints**, not extra shop parts. Pieces are **derived**, flange to flange. Path ends count as flanges.

1. **Straight** — no turn. Must drain or be a riser/slant. If longer than 1050 mm, auto-splice into even pieces (`ceil(length / max)`). The duct is still drawn.
2. **Elbow** — always a circular arc of 30 / 45 / 60 / 90. Piece: flange, 60 mm stub, the arc, 60 mm stub, flange. Never put a flange on an arc.
3. **Angled straight** — used to incline off the current run without a shop elbow. Stay straight at least 100 mm along the incoming tangent, take a **slight** planar kick toward the next table point, then a straight to that point. The kick is **not** a 30/45/60/90 elbow and does **not** get 60 mm elbow flanges. Kick heading change must be between 0.5° and 60°. Kick plane = plane of incoming tangent and chord; for a Y+Z span that plane sits *between* plan and elevation, so the outbound cylinder and its end flange may be **oblique** (not locked to XY, YZ, or XZ). A span already along the incoming tangent stays a plain straight. If along-track is under 100 mm, the target is behind the tangent, or the kick would not be slight, this piece cannot form — then the cardinal-90 fallback.

Prefer **longer straights** over longer curved ducts. Compact elbows. Early short bend, then diagonal toward the target. Do not Manhattan (long straight then a late 90°).

---

## How to draw an elbow (this is the look)

Every shop elbow is three sub-segments:

1. **Lead** — straight along the entry tangent (or an angled-straight kick at the start if the incoming heading needs a slight aim and there is room for 100 mm)
2. **Circular arc** — the **shortest legal** fitting of that sweep
3. **Trail** — straight along the exit, already on the next span’s plane when that span continues the exit tangent

Shrink the drawn radius to `r_min` whenever leftover `(R − r) · tan(θ/2)` is still at least 60 mm on each side. The leftover of a circular fillet between two rays is equal on both sides. The orange arc must end as soon as the outgoing plane can run straight through the next table point. Do not keep a long gentle arc that is still turning when the next plane could already take over.

Only if `2 × offset + R × θ` (θ in radians) would exceed max piece length may the radius shrink further to whatever still fits one piece. If even that overflows, it is `elbow-too-long`.

When the table span itself can hold the 60 mm stubs, inset the arc along each tangent so adjacent straights are not eaten. Only a span too short to inset takes 60 mm from the neighbouring straights.

Layout of leftover after the elbow is reserved as: flange, 60 mm, arc, 60 mm, flange, then leftover straight (spliced at 1050). Do **not** swallow the entire leftover into the elbow piece.

---

## Drawing rules (2D and 3D)

- Duct and jacket are **strokes / tubes only**. Width maps to stroke width / tube diameter. No wall-thickness offset, no inner/outer boundary curves, no area or collision.
- Changing duct or jacket width must not move the centerline by even a pixel.
- Jacket is a **global absolute outer diameter**, drawn beneath the duct, sharing the same merged runs and flat (butt) ends. It is not a thickness added to the duct. It may be narrower than the duct; that is not an error and is not clamped.
- Ducts are drawn only for valid segments (too-tight still counts as a drawable legal centerline). Violating segments have no real path to thicken.
- Consecutive valid segments of one run are **one continuous path** so flat caps do not notch every joint. A violation breaks the run.
- Parameterize by **arc length** along the shop centerline: straight chords and circular arcs. Do **not** fit a Catmull-Rom or any spline through sample points. A spline through a sparse straight bulges around a table point that sits on a tangent.
- Overlay elbow stretches in **amber** and kick stretches in **teal** on that merged run so the circular middle reads.
- Point markers are **pins**, not a second duct. Drawn diameter stays under 20% of `max(duct, jacket)`. Use a small dot (about 6 px) and a larger hit target (about 18 px).
- A flange is a **collar plus plate** (L-profile), not a torus. 2D: plate edge-on plus a short collar. 3D: open-cylinder collar, ring plate, four bolt holes (visual only). Layout treats the station as a zero-thickness face. 2D and 3D share the same stations and dimensions; they only look different because of the projection.

---

## Classify a span (apply in this order)

Given points `p0 → p1` and incoming tangent `τ`:

1. Zero chord → `degenerate`.
2. Angle between `τ` and the chord must match a permitted half-angle within tolerance. Outside the fan → `no-legal-arc`.
3. If the span is a 30/45/60/90 shop elbow, it must be plan **or** elev. A 0° straight is exempt even if the chord has all three world components.
4. If the table span moves in Y and Z: try an angled straight aimed at the point. If that cannot be built, try two compact 90° cardinals. Only then `compound-bend`.
5. Elevation-only chords that miss a discrete elbow but meet the drain floor are sloped straights.
6. Straights flatter than the drain floor → `off-slope`.
7. Legal angle with `r < r_min` → `too-tight` (still drawable).
8. After shop layout: short stubs and overflowing elbows as above.

Two table points are **not** automatically valid. A two-point path is still judged against the initial heading and drain. The usual first-load failure for an old all-zero-z 3D save is `off-slope`.

---

## Feature work you must lock with tests

Write unit tests as you go. At minimum cover:

- sweep set sanitising; 0° is a first-class straight
- legal bearings / cones; fan width; reconstructed entry tangent
- errors do not cascade
- `r_min` and `d_min`; too-tight does not break a run
- 3D shop elbow is plan or elev; Y+Z aims as angled straight; cardinal 90s are fallback only
- drain floor; rise or fall both valid; sloped-straight vs forced elbow
- angled-straight lead ≥ 100 mm, kick 0.5°–60°, drain judged after the kick
- elbow is lead + short arc + trail; shrink to `r_min` when 60 mm leftovers fit; trail already on the next plane
- leftover straights splice at 1050; `elbow-too-long` is not split along the bend
- shop visual kinds: straight / elbow / kick
- millimetre labels; origin triad always present; row-select standoff ≥ 9000 mm; piece dropdown exists; hover reports length and degrees
- 2D `z` stays 0; cross-link 3D→2D warns on nonzero z
- core never imports 2d or 3d

---

## Out of scope

- Wall-thickness / offset outline geometry
- Self-intersection and collision
- Undo / redo
- Closed-loop mode
- Pinch-zoom or touch panning (single-pointer 2D pan/zoom is accepted)
- Multi-arc connections between a single pair of **table** points (shop pieces on one span are allowed)

---

## How to work

1. Scaffold the tree, `config.json`, both HTML shells, shared CSS, and the config/store/solve core.
2. Get 2D solving and SVG drawing of legal vs illegal spans working with the demo points.
3. Add duct/jacket bands, guides, snap, fit, autosave, import/export.
4. Add flanges, compact elbows, piece dropdown, hover.
5. Add 3D: cones, plan/elev elbows, drain, angled-straight Y+Z, origin triad, row focus, tube drawing along the true centerline.
6. Colour amber arcs and teal kicks.
7. Keep `docs/requirements.md` current.
8. Run `node --test tests/` on Node 20 until green.

Do not commit or push unless the user asks. Do not mention any remote repository or hosting URL in the product, comments, or docs.

When the demo path is loaded, a person looking at 3D should see: a teal kick off the origin run, a **short** amber 30° elbow that finishes before point 3, a trail already aimed at point 4, and long blue straights spliced at 1050 mm, sitting on a 3° drain ramp, with a visible origin triad.
