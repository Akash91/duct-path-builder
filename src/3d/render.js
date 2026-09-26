// Three.js scene for the 3D builder. Rebuilds meshes from the solution on each change.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { coneGuides, expandRun } from './geometry.js';
import { minChordFor } from '../core/arcMath.js';
import { minRadiusFor, tangentAt, validRuns, shopOptions } from '../core/solve.js';
import { layoutPieces, pieceLabel } from '../core/pieces.js';
import { cumulative, stationAt, slice } from '../core/polyline.js';
import { focusEye, boundsWithOrigin, FOCUS_STANDOFF } from '../core/view.js';
import * as V from './vec3.js';

const COLOR = {
  ok: 0x4ea8ff,
  elbow: 0xf0a020,
  kick: 0x5ee0c0,
  tight: 0xd9a441,
  error: 0xff5f56,
  duct: 0x4ea8ff,
  jacket: 0x8ba0bd,
  flange: 0xa9b6c7,
  point: 0xdfe6ef,
  selected: 0x4ea8ff,
  guide: 0x3a4a5e,
  blocked: 0xd9a441,
};

/** The triad is the only thing in the scene that never moves, so it reads as the datum. */
const AXIS_LENGTH = 1500;
const AXIS_COLOR = { x: 0xff5f56, y: 0x5ee08a, z: 0x4ea8ff };

const toVec3 = (p) => new THREE.Vector3(p.x, p.y, p.z ?? 0);
const mm = (v) => `${v.toFixed(0)} mm`;

/**
 * A curve that walks a polyline by arc length. The samples are already real straights and real
 * circular arcs, so interpolating between them *is* the centerline; fitting a spline through
 * them would bulge around any table point that happens to sit on a tangent.
 */
class ShopCurve extends THREE.Curve {
  constructor(points) {
    super();
    this.pts = points;
    this.cum = cumulative(points);
    this.total = this.cum[this.cum.length - 1];
  }

  getPoint(t, target = new THREE.Vector3()) {
    const at = stationAt(this.pts, t * this.total, this.cum);
    return target.set(at.point.x, at.point.y, at.point.z);
  }
}

function labelSprite(text, color = 0x8a97a8) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.font = '32px ui-sans-serif, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 8, 32);

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false,
  }));
  sprite.scale.set(900, 225, 1);
  return sprite;
}

/** X red, Y green, Z blue at (0,0,0), always drawn, plus the label that names it. */
function originTriad() {
  const group = new THREE.Group();
  const axes = { x: [AXIS_LENGTH, 0, 0], y: [0, AXIS_LENGTH, 0], z: [0, 0, AXIS_LENGTH] };

  for (const [name, end] of Object.entries(axes)) {
    const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...end)]);
    group.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: AXIS_COLOR[name], depthTest: false })));
  }

  const label = labelSprite('0,0,0');
  label.position.set(120, 120, 120);
  group.add(label);
  group.name = 'origin-triad';
  return group;
}

export function initScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  // The model treats +Z as up, so the camera must agree or orbiting feels wrong.
  const camera = new THREE.PerspectiveCamera(45, 1, 10, 600000);
  camera.up.set(0, 0, 1);
  camera.position.set(7000, -9000, 6000);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(6000, -8000, 12000);
  scene.add(key);

  const grid = new THREE.GridHelper(40000, 40, 0x2a3441, 0x1d2530);
  grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; the model works in XY
  scene.add(grid);
  scene.add(originTriad());

  const groups = {
    jacket: new THREE.Group(),
    duct: new THREE.Group(),
    flanges: new THREE.Group(),
    path: new THREE.Group(),
    guides: new THREE.Group(),
    points: new THREE.Group(),
    pieces: new THREE.Group(),
  };
  for (const g of Object.values(groups)) scene.add(g);

  const ctx = { scene, camera, renderer, controls, groups, container, raycaster: new THREE.Raycaster() };

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  resize();
  new ResizeObserver(resize).observe(container);

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return ctx;
}

/** Meshes are rebuilt wholesale, so their GPU resources must be released explicitly. */
function clearGroup(group) {
  for (const child of [...group.children]) {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
    else child.material?.dispose();
    group.remove(child);
  }
}

/** Flat end caps, matching the 2D butt-cap rule (R-35). */
function addCaps(group, curve, radius, material) {
  for (const t of [0, 1]) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), material);
    const at = curve.getPointAt(t);
    disc.position.copy(at);
    disc.lookAt(at.clone().add(curve.getTangentAt(t)));
    group.add(disc);
  }
}

function addBand(group, runs, diameter, color, opacity) {
  const material = new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
  });

  for (const r of runs) {
    if (r.points.length < 2) continue;
    const curve = new ShopCurve(r.points);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(32, r.points.length * 2), diameter / 2, 24, false), material));
    addCaps(group, curve, diameter / 2, material);
  }
}

/**
 * The centerline, stretch by stretch, as one thin core whose colour changes with the shop kind.
 * It has to be a tube rather than a line: WebGL ignores line width, so a one-pixel thread next
 * to a 180 mm duct reads as nothing at all — and a stretch drawn fatter than the rest stops
 * looking like a marker on the run and starts looking like a second pipe.
 */
function addCenterline(group, state, solution, runs) {
  const core = Math.max(state.ductWidth * 0.06, 8);

  for (const r of runs) {
    for (const st of r.stretches) {
      if (st.points.length < 2) continue;
      const seg = solution.segments[st.segIndex];
      const color = st.kind === 'elbow' ? COLOR.elbow
        : st.kind === 'kick' ? COLOR.kick
          : seg?.tooTight ? COLOR.tight : COLOR.ok;

      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
      const geom = new THREE.TubeGeometry(new ShopCurve(st.points), Math.max(8, st.points.length), core, 10, false);
      group.add(new THREE.Mesh(geom, material));
    }
  }

  for (const seg of solution.segments) {
    if (seg.ok || seg.reason === 'degenerate') continue;
    const geom = new THREE.BufferGeometry().setFromPoints([toVec3(seg.from), toVec3(seg.to)]);
    const line = new THREE.Line(geom, new THREE.LineDashedMaterial({ color: COLOR.error, dashSize: 140, gapSize: 100 }));
    line.computeLineDistances();
    group.add(line);
  }
}

/**
 * A flange is a collar plus a plate, not a torus: an open cylinder, a ring and four bolt holes.
 * The station is treated as a zero-thickness face, so 2D and 3D agree on where it sits.
 */
function addFlanges(group, state, runs, pieces) {
  if (!state.features.flanges || !state.showFlanges) return;

  const outer = Math.max(state.features.duct ? state.ductWidth : 0, state.features.jacket ? state.jacketWidth : 0);
  const inner = outer / 2;
  const plate = inner * 1.15;
  const collar = 22;

  const metal = new THREE.MeshStandardMaterial({ color: COLOR.flange, roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide });
  const up = new THREE.Vector3(0, 1, 0);

  runs.forEach((r, runIndex) => {
    const stations = new Set([0]);
    for (const piece of pieces) {
      if (piece.runIndex !== runIndex) continue;
      stations.add(piece.start);
      stations.add(piece.end);
    }

    for (const s of stations) {
      const at = stationAt(r.points, s, r.cum);
      if (!at) continue;
      const origin = toVec3(at.point);
      const tangent = toVec3(at.tangent).normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(up, tangent);

      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(inner, inner, collar, 24, 1, true), metal);
      sleeve.quaternion.copy(quat);
      sleeve.position.copy(origin).addScaledVector(tangent, -collar / 2);
      group.add(sleeve);

      const ring = new THREE.Mesh(new THREE.RingGeometry(inner, plate, 28), metal);
      ring.quaternion.copy(quat).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
      ring.position.copy(origin);
      group.add(ring);

      // Bolt holes are decoration: they say "flange", they carry no geometry.
      const boltR = Math.max(plate * 0.06, 6);
      for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2;
        const bolt = new THREE.Mesh(new THREE.CircleGeometry(boltR, 10), metal);
        bolt.quaternion.copy(ring.quaternion);
        const offset = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle))
          .multiplyScalar((inner + plate) / 2)
          .applyQuaternion(quat);
        bolt.position.copy(origin).add(offset).addScaledVector(tangent, 1);
        group.add(bolt);
      }
    }
  });
}

/** Invisible tubes, one per piece, so the raycaster can report what the pointer is over. */
function addPieceHits(group, state, runs, pieces) {
  const radius = Math.max(state.ductWidth, 120) / 2;
  const material = new THREE.MeshBasicMaterial({ visible: false });

  for (const piece of pieces) {
    const r = runs[piece.runIndex];
    if (!r) continue;
    const pts = slice(r.points, piece.start, piece.end, r.cum);
    if (pts.length < 2) continue;
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(new ShopCurve(pts), 8, radius, 8, false), material);
    mesh.userData.piece = piece;
    group.add(mesh);
  }
}

/**
 * Guide marks. A permitted sweep is a whole cone around the tangent, but a full ring reads as
 * clutter, so only the four cardinal generators are drawn — left, right, up and down in the
 * tangent's own frame — plus the straight-ahead ray, which has no dead zone at all.
 */
function addGuides(group, state, solution, anchorIndex) {
  if (!state.features.guideRays || !state.showGuides) return;
  if (anchorIndex < 0 || anchorIndex >= state.points.length) return;

  const anchor = state.points[anchorIndex];
  const tangent = tangentAt(solution, anchorIndex, state.initialTangent);
  const minRadius = minRadiusFor(state);
  const reach = Math.max(2600, state.maxPieceLength * 2);

  for (const { theta, dir } of coneGuides(tangent)) {
    // Nearer than this, a band of the current width cannot make the bend.
    const blocked = Math.min(minChordFor(theta, minRadius), reach);

    if (blocked > 0) {
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([toVec3(anchor), toVec3(V.add(anchor, V.scale(dir, blocked)))]),
        new THREE.LineDashedMaterial({ color: COLOR.blocked, dashSize: 60, gapSize: 60, transparent: true, opacity: 0.6 }),
      ).computeLineDistances());
    }

    const from = V.add(anchor, V.scale(dir, blocked));
    const to = V.add(anchor, V.scale(dir, reach));
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([toVec3(from), toVec3(to)]),
      new THREE.LineBasicMaterial({ color: COLOR.guide }),
    ));
  }
}

/** Markers are pins, not a second duct: a small node on the core, far under the band diameter. */
function addPoints(group, state) {
  const radius = Math.max(state.ductWidth * 0.09, 12);
  const geom = new THREE.SphereGeometry(radius, 16, 12);

  for (const p of state.points) {
    const mesh = new THREE.Mesh(geom.clone(), new THREE.MeshBasicMaterial({
      color: p.id === state.selectedId ? COLOR.selected : COLOR.point,
    }));
    mesh.position.set(p.x, p.y, p.z);
    group.add(mesh);
  }
  geom.dispose();
}

export function renderScene(ctx, state, solution, anchorIndex) {
  const { groups } = ctx;
  for (const g of Object.values(groups)) clearGroup(g);

  const runs = validRuns(solution).map((run) => {
    const { points, stretches } = expandRun(run);
    return { run, points, stretches, cum: cumulative(points) };
  });
  const { pieces } = layoutPieces(solution, shopOptions(state));

  if (state.features.jacket && state.showJacket) addBand(groups.jacket, runs, state.jacketWidth, COLOR.jacket, 0.18);
  if (state.features.duct && state.showDuct) addBand(groups.duct, runs, state.ductWidth, COLOR.duct, 0.34);

  addFlanges(groups.flanges, state, runs, pieces);
  addCenterline(groups.path, state, solution, runs);
  addGuides(groups.guides, state, solution, anchorIndex);
  addPoints(groups.points, state);
  addPieceHits(groups.pieces, state, runs, pieces);

  return pieces;
}

/** What the pointer is over, as a one-line shop read. Returns null over empty space. */
export function pickPiece(ctx, clientX, clientY) {
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  ctx.raycaster.setFromCamera(ndc, ctx.camera);

  const [hit] = ctx.raycaster.intersectObjects(ctx.groups.pieces.children, false);
  if (!hit) return null;

  const piece = hit.object.userData.piece;
  return { piece, label: pieceLabel(piece), text: `${piece.kind} · ${mm(piece.length)} flange to flange · ${piece.arcDeg.toFixed(1)}°` };
}

/** Fit frames the path *and* the origin, so the datum never drops out of view. */
export function fitCamera(ctx, points) {
  const { min, max } = boundsWithOrigin(points);
  const box = new THREE.Box3(new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, max.y, max.z));

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, AXIS_LENGTH);
  const dist = (radius / Math.sin((ctx.camera.fov * Math.PI) / 360)) * 1.35;

  const dir = ctx.camera.position.clone().sub(ctx.controls.target).normalize();
  if (dir.lengthSq() === 0) dir.set(0.5, -0.7, 0.5).normalize();

  ctx.controls.target.copy(sphere.center);
  ctx.camera.position.copy(sphere.center.clone().add(dir.multiplyScalar(dist)));
  ctx.camera.near = Math.max(1, dist / 500);
  ctx.camera.far = dist * 12;
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
}

/** Selecting a row pans onto the point, keeps the approach, and never closes in past the standoff. */
export function focusOn(ctx, point) {
  const eye = focusEye(ctx.camera.position, ctx.controls.target, point, FOCUS_STANDOFF);
  ctx.controls.target.set(point.x, point.y, point.z ?? 0);
  ctx.camera.position.set(eye.x, eye.y, eye.z);
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
}

/** A default orbit that always includes the origin. */
export function resetView(ctx, points) {
  ctx.camera.position.set(1, -1.4, 1).multiplyScalar(FOCUS_STANDOFF);
  ctx.controls.target.set(0, 0, 0);
  fitCamera(ctx, points);
}
