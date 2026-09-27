# Source data: getting a centerline out of a drawing

Notes from reverse-engineering a real duct run (`7-860-200013.dwg`, AutoCAD 2018) to validate the
solver against something built. Written so the exercise does not have to be rediscovered.

The product goal is the other direction — coordinates in, centerline out, duct and jacket wrapped
around it. This document is about the validation problem: given a drawing of a duct that exists,
recover the centerline points.

---

## 1. What the drawings told us

### Confirmed the model

| Read from the drawing | Matches |
|---|---|
| `SLOPE 3°`, annotated | the drain rule and its 3° default |
| Two 90° and two 30° elbows, annotated | the sweep set `{0, 30, 45, 60, 90}` |
| Elbow sweeps measured at **87°** | a 90° fitting off a 3° sloped run — turning 87° to reach vertical |
| Risers measured at **±87°** from horizontal | a riser fed by that elbow leans 3° off vertical |
| Spools at 984 / 1150 / 704 mm | max-piece-length splicing |
| Generously radiused elbows | radius set by layout, not pulled to a minimum |

The 87° measurement is the strongest single confirmation. It was a *prediction* of the model —
slope into elbow into riser — and the drawing measured it independently in two places.

### Real specification values

```
DUCT ID.400 × 3 THK.        FLANGE 485 × 12
INSU. ID.506 × 1.5 THK.     CLADDING SHEET 1.5 MM THK. SS 304
```

So duct OD 406, insulated OD 509, flange plate 485. The flange is **on the duct, under the
insulation** — which is why the plate is sized from the duct rather than `max(duct, jacket)`.

Measured elbow centerline radii: **675 mm** (band 454 across) and **1200 mm** (band 1008 across).
Two duct sizes on one job.

### Contradicted the model

No mitred joints anywhere across thirteen spools. Every direction change is a radiused elbow at a
standard angle. This is what forced the kick ceiling down from 60° to 5° — see the changelog.

---

## 2. What is missing from the model

Found in the drawings, not represented:

- **Tapered / transition pieces.** The run off the equipment connection visibly changes diameter.
- **Expansion bellows** between nearly every spool. Inline components with real length, not
  flanges. The vertical run is split by bellows strategy, not by transport length.
- **Inline equipment** — dampers and instrument spools at 900, 1300, 75 mm.
- **Spool identity** — real spools are `ID-1 … ID-13` with balloon item numbers feeding a BOM.
- **Closure sheets** (`'X'`), field-fitted to absorb accumulated tolerance.
- **Penetrations, supports, hangers, sensor nozzles.**
- **Splice policy** — the drawing shows `704 + 984 + 984`, i.e. fill-to-standard-length with a
  remainder. The model divides evenly and would give `890 × 3`.

Also worth separating: the drawing's `±0.5 / ±1 mm` table is *manufacturing* tolerance. The
tolerance slider is *angular*, for accepting a point off a cone. Unrelated concepts.

---

## 3. Reading a DWG — what actually works

No DWG reader was installed and the network blocked Homebrew's bottle host, GNU FTP and PyPI.
What worked:

```sh
mkdir /tmp/dwgtool && cd /tmp/dwgtool && npm init -y
npm install @mlightcad/libredwg-web      # LibreDWG compiled to WASM
```

```js
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
const lib = await LibreDwg.create('./node_modules/@mlightcad/libredwg-web/wasm/');
const db = lib.convert(lib.dwg_read_data(readFileSync(path).buffer, Dwg_File_Type.DWG));
```

Keep this **outside the project**. The app is deliberately dependency-free and must stay so.

### Its limits, which are the whole story

- **Block contents are unreachable.** 545 block records, 563 inserts, and `convert()` exposes only
  their names. The duct linework is inside them. This was the hard stop.
- **Partial parse** — LibreDWG returns error 68 on this file.
- **Corrupt Z values** — `2.5e7`, `-2.9e8` appear where entities have extrusion data.
- **No 3D.** No `POLYLINE3D`, no `3DSOLID`, no mesh. It is 2D views. No format conversion
  invents 3D that is not there.

### Techniques that did work

- **Find elbows by concentric-arc signature.** An elbow drawn in section is a centerline arc with
  wall arcs symmetric about it. Group arcs by centre; a group of three or more with radii
  symmetric about a middle value is a fitting, and the middle radius is the centerline.
- **Search by angle, across all geometry types.** Filter straight stretches to those near a
  duct-like angle (3°, 30°, 60°, 87°). Include `LWPOLYLINE` segments and `ARC`, not just `LINE` —
  searching only `LINE` in model space found nothing and nearly ended the investigation early.
- **Layers are not a reliable discriminator.** A layer literally called `CENTER` held centre-marks
  on holes, not the duct route. The centerline was fragmented across layers `1`, `CENTER`, `0`
  and `3`.

### What did not work

Pairing the orthographic views automatically. The principle is sound — front gives `(x, z)`, side
gives `(y, z)`, shared `z` pairs them — but:

- clustering by spatial gaps put 302 of 461 duct features into one bucket;
- the offset histogram gave two candidate view separations (2580 and 3110) with neither dominant;
- two identically-oriented elbows 3107 apart are equally consistent with *one elbow in two views*
  and *two real elbows in one run*, and nothing in the data separates those.

With the blocks shut, this is reconstruction on partial evidence. Do not spend hours here.

---

## 4. Which format to ask for

Ranked by how much reconstruction each saves.

| Tier | Format | What you get |
|---|---|---|
| 1 | **PCF** (Piping Component File) | Plain text, `END-POINT x y z` per component. Literally the centerline as a coordinate list. One-click from Plant 3D / SP3D / Isogen. If this exists, everything else is moot. |
| 1 | **IFC4** | `IfcDuctSegment` / `IfcDuctFitting` with axis representations. |
| 1 | **STEP AP242** | Exact 3D, but solids — the centerline is implied by cylindrical faces and must be inferred. |
| 2 | **DXF, ASCII, R2013** | The practical answer for an existing DWG. See below. |
| 3 | SVG / vector PDF | Geometry survives, structure mostly does not. Last resort. |
| — | PNG / JPG / STL / OBJ | Not useful for this. |

**Why DXF specifically beats DWG**, based on what blocked us:

- The `BLOCKS` section is plain text, so the 563 inserts become readable — the hard stop, removed.
- `VIEWPORT` records carry view target, direction vector and height, which answers "which view is
  this and how does it project" directly instead of inferring it from offset histograms.
- `TABLES` gives layer → linetype → colour, so "which layer is the red centerline" is a lookup.
- No proprietary parser — a reader is about an hour's work with zero dependencies.

**Best single action:** select the red centerline in AutoCAD and `WBLOCK` just those entities to a
DXF. No dimensions, no equipment, no title block, no nested blocks. Extraction becomes exact.

---

## 5. Deriving points when the drawing will not give them

This is what we fell back on, and it is exact arithmetic rather than estimation.

Treat the supplied coordinates as the **apex** points where straight runs intersect, then derive
the tangent point either side of each bend from a chosen radius:

```
u = unit(apex[i]   - apex[i-1])        incoming run direction
v = unit(apex[i+1] - apex[i])          outgoing run direction
turn = angle(u, v)
T    = R · tan(turn / 2)                tangent length

entry = apex[i] - T·u
exit  = apex[i] + T·v
```

Table points are then `[start, entry₁, exit₁, entry₂, exit₂, …, end]`. Each `entryᵢ → exitᵢ` span
is the elbow; everything between is a straight.

### What this exposed

- The supplied list had **no tangent points at all** — every bend was missing both. That is why
  spans were being read as 43° mitres and U-bends.
- One supplied point back-solved to `R = 701.8` against a screenshot's `703.054`, which is how we
  knew the reconstruction was the right shape.
- Interior points on a straight run are **not** table points. Spool joints at 984 / 1150 mm are
  derived by the piece layout; adding them as waypoints is wrong.

### Traps hit while doing it

- **Sign errors put a corner behind its predecessor.** Always assert every leg length is positive
  and each `turn` is sane before trusting the output.
- **A radius that fits one corner can collide at the next.** Two elbows need
  `leg ≥ T_in + T_out` plus flange stubs. Iterate the radius down per corner and reject on layout
  issues — `short-stub` — not only on solver errors.
- **Errors do not cascade, so a failure contaminates the spans after it.** Fix top-down and
  re-run; fixing one point cleared two failures in the worked example.
- Verify against the solver every time, never by eye.

---

## 6. Worked example

Eleven supplied points became twelve derived ones. Settings: duct 406, jacket 509, ratio 1.0,
max piece 1250, tolerance 2°, initial elevation 3°, `compactElbows` off.

| # | x | y | z | Span into this point |
|---|---|---|---|---|
| 1 | 0 | 0 | 0 | start |
| 2 | 2180.33 | 0 | 114.27 | straight, 3° slope |
| 3 | 2820.00 | 0 | 788.34 | elbow 90°, r 657 |
| 4 | 2820.00 | 0 | 3612.53 | straight (riser) |
| 5 | 2820.00 | 90.44 | 3950.04 | elbow 30°, r 675 |
| 6 | 2820.00 | 1361.56 | 6151.66 | straight (incline) |
| 7 | 2820.00 | 1452.00 | 6489.17 | elbow 30°, r 675 |
| 8 | 2820.00 | 1452.00 | 9027.06 | straight (riser) |
| 9 | 2670.92 | 1452.00 | 9386.98 | elbow 45°, r 509 |
| 10 | 2511.84 | 1452.00 | 9546.06 | straight |
| 11 | 2260.79 | 1452.00 | 9691.00 | elbow 30°, r 560 |
| 12 | 1464.82 | 1452.00 | 9904.28 | straight to end |

11 of 11 spans valid, 16 pieces, no layout issues.

### Unresolved

- **The incline angle.** The supplied coordinates imply **22.76°**; the drawing annotates **30°**.
  The list above uses 30°, which moves point 6 by about 94 mm in Y and everything after it. This
  rests entirely on a text label and is the largest single assumption in the reconstruction.
- **The 90° elbow lands at r 657, not the measured 675** — the corner is an 87° turn but the
  sweep set only offers 90°, so the arc rebuilds tighter. If 675 is a procured fitting size, that
  gap matters.
- **Piece 14 is a 105 mm spool** between the top two elbows. It clears the flange stubs but is
  impractically short; those bends probably want relocating.
