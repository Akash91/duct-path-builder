// Three.js scene for the 3D builder. Rebuilds meshes from the solution on each change.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { legalCones, legalDirections, samplePoints, poseAlong, expandRun } from './geometry.js';
import { minChordFor } from '../core/arcMath.js';
import { minRadiusFor, tangentAt, validRuns } from '../core/solve.js';
import {
  flangeOptionsFor, layoutPieces, flangeDrawDims, poseOnRun, defaultAddReach, pickPieceAt3d,
} from '../core/flange.js';
import { POINT_SPHERE_R, ORIGIN_AXIS_MM, MIN_FOCUS_STANDOFF, focusCameraOnPoint } from '../core/view.js';
import * as V from './vec3.js';

const COLOR = {
  ok: 0x4ea8ff,
  tight: 0xd9a441,
  error: 0xff5f56,
  duct: 0x4ea8ff,
  jacket: 0x8ba0bd,
  point: 0xdfe6ef,
  selected: 0x4ea8ff,
  guide: 0x3a4a5e,
  blocked: 0xd9a441,
};

const toVec3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

/** World origin (0,0,0): RGB triad is XYZ, plus a labelled dot, so the grid has a readable zero. */
function originReference() {
  const group = new THREE.Group();
  group.name = 'origin-reference';
  group.add(new THREE.AxesHelper(ORIGIN_AXIS_MM));

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(6, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  group.add(dot);

  const label = (text, color, position) => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const c = canvas.getContext('2d');
    c.fillStyle = color;
    c.font = '600 36px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 128, 32);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      depthTest: false,
      transparent: true,
    }));
    sprite.position.copy(position);
    sprite.scale.set(180, 45, 1);
    sprite.renderOrder = 20;
    return sprite;
  };

  const a = ORIGIN_AXIS_MM * 1.12;
  group.add(label('X', '#ff5f56', new THREE.Vector3(a, 0, 0)));
  group.add(label('Y', '#3dd68c', new THREE.Vector3(0, a, 0)));
  group.add(label('Z', '#4ea8ff', new THREE.Vector3(0, 0, a)));
  group.add(label('0,0,0', '#dfe6ef', new THREE.Vector3(48, 48, -32)));
  return group;
}

export function initScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  // The model treats +Z as up, so the camera must agree or orbiting feels wrong.
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 60000);
  camera.up.set(0, 0, 1);
  camera.position.set(2400, -2800, 1800);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(1800, -2400, 3600);
  scene.add(key);

  const grid = new THREE.GridHelper(20000, 40, 0x2a3441, 0x1d2530);
  grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; the model works in XY
  scene.add(grid);
  scene.add(originReference());

  const groups = {
    jacket: new THREE.Group(),
    duct: new THREE.Group(),
    path: new THREE.Group(),
    flanges: new THREE.Group(),
    hits: new THREE.Group(),
    guides: new THREE.Group(),
    points: new THREE.Group(),
  };
  for (const g of Object.values(groups)) scene.add(g);
  groups.hits.visible = true;

  const ctx = { scene, camera, renderer, controls, groups, container };

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

/** One continuous curve through a run, so bands join smoothly and cap only at the open ends. */
function curveForRun(run) {
  const points = [];
  for (const seg of run) {
    const sampled = samplePoints(seg, seg.arc.straight ? 1 : 24);
    for (let i = 0; i < sampled.length; i++) {
      if (i === 0 && points.length > 0) continue; // joints are shared
      points.push(toVec3(sampled[i]));
    }
  }
  return points.length >= 2 ? new THREE.CatmullRomCurve3(points, false, 'centripetal') : null;
}

/** Flat end caps, matching the 2D butt-cap rule (R-35). */
function addCaps(group, curve, radius, material, order) {
  for (const t of [0, 1]) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), material);
    const at = curve.getPointAt(t);
    disc.position.copy(at);
    disc.lookAt(at.clone().add(curve.getTangentAt(t)));
    disc.renderOrder = order;
    group.add(disc);
  }
}

/**
 * `order` layers the bands the way the 2D view stacks its SVG layers: jacket first, duct over it.
 * The bands are coaxial, so their bounding spheres share a centre and the renderer's own
 * back-to-front sort cannot separate them; without depthWrite off, whichever draws first would
 * depth-reject the other outright rather than blending with it.
 */
function addBand(group, runs, diameter, color, opacity, order) {
  const material = new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
    depthWrite: false,
  });

  for (const run of runs) {
    const curve = curveForRun(run);
    if (!curve) continue;
    const segments = Math.max(24, run.length * 26);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, diameter / 2, 24, false), material);
    tube.renderOrder = order;
    group.add(tube);
    addCaps(group, curve, diameter / 2, material, order);
  }
}

function addCenterline(group, solution, shopRuns, flangesOn) {
  if (flangesOn) {
    for (const run of shopRuns ?? []) {
      for (const seg of run) {
        const pts = samplePoints(seg, seg.arc.straight ? 1 : 24).map(toVec3);
        const material = new THREE.LineBasicMaterial({ color: seg.tooTight ? COLOR.tight : COLOR.ok });
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
      }
    }
  } else {
    for (const seg of solution.segments) {
      if (!seg.ok) continue;
      const pts = samplePoints(seg, seg.arc.straight ? 1 : 24).map(toVec3);
      const material = new THREE.LineBasicMaterial({ color: seg.tooTight ? COLOR.tight : COLOR.ok });
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
    }
  }

  for (const seg of solution.segments) {
    if (seg.ok || seg.reason === 'degenerate') continue;
    const geom = new THREE.BufferGeometry().setFromPoints([toVec3(seg.from), toVec3(seg.to)]);
    const line = new THREE.Line(geom, new THREE.LineDashedMaterial({ color: COLOR.error, dashSize: 14, gapSize: 10 }));
    line.computeLineDistances();
    group.add(line);
  }
}

/**
 * Guide marks: straight ahead, plus four cardinals per cone (plan left/right, elev up/down).
 * A full ring would imply a rolling offset is legal (R-90b).
 */
function addGuides(group, state, solution, anchorIndex) {
  if (!state.features.guideRays || !state.showGuides) return;
  if (anchorIndex < 0 || anchorIndex >= state.points.length) return;

  const anchor = state.points[anchorIndex];
  const tangent = tangentAt(solution, anchorIndex, state.initialTangent);
  const minRadius = minRadiusFor(state);

  for (const { theta, half } of legalCones()) {
    const dMin = minChordFor(theta, minRadius);
    const dist = Math.max(dMin, defaultAddReach(state, 1600));
    const blocked = dMin > 0;

    for (const dir of legalDirections(tangent, half)) {
      const start = V.add(anchor, V.scale(dir, blocked ? dMin : 0));
      const end = V.add(anchor, V.scale(dir, dist));
      if (blocked) {
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([toVec3(anchor), toVec3(start)]),
          new THREE.LineBasicMaterial({ color: COLOR.blocked, transparent: true, opacity: 0.55 }),
        ));
      }
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([toVec3(start), toVec3(end)]),
        new THREE.LineBasicMaterial({ color: COLOR.guide }),
      ));
    }
  }
}

function addPoints(group, state) {
  const geom = new THREE.SphereGeometry(POINT_SPHERE_R, 18, 12);
  for (const p of state.points) {
    const mesh = new THREE.Mesh(geom.clone(), new THREE.MeshBasicMaterial({
      color: p.id === state.selectedId ? COLOR.selected : COLOR.point,
    }));
    mesh.position.set(p.x, p.y, p.z);
    group.add(mesh);
  }
  geom.dispose();
}

function flangeMaterial(err) {
  return new THREE.MeshStandardMaterial({
    color: err ? COLOR.error : 0xc5d0dc,
    metalness: 0.4,
    roughness: 0.35,
    side: THREE.DoubleSide,
  });
}

function addFlange(group, pose, dims, err) {
  const origin = new THREE.Vector3(pose.x, pose.y, pose.z);
  const t = toVec3(pose.tangent).normalize();
  const yQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), t);
  const zQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), t);

  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(dims.innerR, dims.innerR, dims.collarL, 28, 1, true),
    flangeMaterial(err),
  );
  collar.quaternion.copy(yQuat);
  collar.position.copy(origin);
  group.add(collar);

  const plate = new THREE.Mesh(
    new THREE.RingGeometry(dims.innerR, dims.plateR, 36),
    flangeMaterial(err),
  );
  plate.quaternion.copy(zQuat);
  plate.position.copy(origin);
  group.add(plate);

  let radial = new THREE.Vector3(0, 0, 1);
  if (Math.abs(t.dot(radial)) > 0.9) radial = new THREE.Vector3(1, 0, 0);
  radial.cross(t).normalize();
  const holeR = dims.plateR * 0.78;
  for (let i = 0; i < 4; i++) {
    const dir = radial.clone().applyAxisAngle(t, (i * Math.PI) / 2);
    const hole = new THREE.Mesh(
      new THREE.CylinderGeometry(dims.holeR, dims.holeR, dims.plateT + 1, 10),
      new THREE.MeshBasicMaterial({ color: 0x0d1117 }),
    );
    hole.quaternion.copy(yQuat);
    hole.position.copy(origin.clone().add(dir.multiplyScalar(holeR)));
    group.add(hole);
  }
}

function addFlanges(group, state, solution, spatial) {
  const options = flangeOptionsFor(state);
  if (!options) return;
  const laid = layoutPieces(solution, options);
  const dims = flangeDrawDims(state);
  const bad = new Set(laid.errors.flatMap((e) => [e.piece.s0, e.piece.s1].map((s) => s.toFixed(3))));
  for (const f of laid.flanges) {
    const pose = poseOnRun(spatial(f.run), f.s, poseAlong);
    if (!pose) continue;
    addFlange(group, pose, dims, bad.has(f.s.toFixed(3)));
  }
}

function addPieceHits(group, state, solution, spatial) {
  const options = flangeOptionsFor(state);
  if (!options) return;
  const laid = layoutPieces(solution, options);
  const radius = Math.max(state.ductWidth, state.jacketWidth) / 2 + 8;
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  for (const piece of laid.pieces) {
    const run = spatial(piece.run);
    const n = Math.max(2, Math.ceil(piece.length / 40) + 1);
    const samples = [];
    for (let i = 0; i < n; i++) {
      const s = piece.s0 + (piece.length * i) / (n - 1);
      const pose = poseOnRun(run, s, poseAlong);
      if (pose) samples.push(toVec3(pose));
    }
    if (samples.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(samples, false, 'centripetal');
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.max(8, n), radius, 8, false),
      material.clone(),
    );
    mesh.userData.piece = { ...piece, run };
    mesh.name = `piece-hit-${piece.id}`;
    group.add(mesh);
  }
}

function spatialFor(state) {
  const options = flangeOptionsFor(state);
  const cache = new Map();
  return (run) => {
    if (!run) return run;
    if (!cache.has(run)) cache.set(run, expandRun(run, options));
    return cache.get(run);
  };
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

export function pickPieceFromEvent(ctx, event) {
  if (!ctx?.camera || !ctx?.container) return null;
  const rect = ctx.container.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, ctx.camera);
  const objects = ['duct', 'jacket', 'hits']
    .flatMap((name) => ctx.groups[name]?.children ?? []);
  const hits = raycaster.intersectObjects(objects, true);
  if (!hits.length) return null;
  if (hits[0].object.userData.piece) return hits[0].object.userData.piece;
  const p = hits[0].point;
  return pickPieceAt3d(ctx.hoverPieces ?? [], { x: p.x, y: p.y, z: p.z }, poseAlong, 600);
}

export function renderScene(ctx, state, solution, anchorIndex) {
  const { groups } = ctx;
  for (const g of Object.values(groups)) clearGroup(g);

  const options = flangeOptionsFor(state);
  const solverRuns = validRuns(solution);
  const spatial = spatialFor(state);
  const runs = solverRuns.map((run) => spatial(run));

  if (state.features.jacket && state.showJacket) addBand(groups.jacket, runs, state.jacketWidth, COLOR.jacket, 0.18, 1);
  if (state.features.duct && state.showDuct) addBand(groups.duct, runs, state.ductWidth, COLOR.duct, 0.34, 2);

  addCenterline(groups.path, solution, runs, true);
  addFlanges(groups.flanges, state, solution, spatial);
  addPieceHits(groups.hits, state, solution, spatial);
  addGuides(groups.guides, state, solution, anchorIndex);
  addPoints(groups.points, state);

  ctx.hoverPieces = options
    ? layoutPieces(solution, options).pieces.map((p) => ({ ...p, run: spatial(p.run) }))
    : [];
}

export function fitCamera(ctx, points) {
  const box = new THREE.Box3();
  box.expandByPoint(new THREE.Vector3(0, 0, 0)); // origin stays in frame as the spatial reference (R-137)
  if (points.length === 0) box.expandByPoint(new THREE.Vector3(2400, 2400, 800));
  else for (const p of points) box.expandByPoint(toVec3(p));

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 400);
  const dist = radius / Math.sin((ctx.camera.fov * Math.PI) / 360) * 1.75;

  const dir = ctx.camera.position.clone().sub(ctx.controls.target).normalize();
  if (dir.lengthSq() === 0) dir.set(0.5, -0.7, 0.5).normalize();

  ctx.controls.target.copy(sphere.center);
  ctx.camera.position.copy(sphere.center.clone().add(dir.multiplyScalar(dist)));
  ctx.camera.near = Math.max(0.5, dist / 500);
  ctx.camera.far = dist * 12;
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
}

/** Pan onto one table point. Keep the approach; pull back if the camera is too close (R-154). */
export function focusPoint(ctx, point) {
  if (!ctx || !point) return;
  const next = focusCameraOnPoint(
    ctx.camera.position,
    ctx.controls.target,
    point,
    MIN_FOCUS_STANDOFF,
  );
  ctx.controls.target.set(next.target.x, next.target.y, next.target.z);
  ctx.camera.position.set(next.camera.x, next.camera.y, next.camera.z);
  ctx.camera.near = Math.max(0.5, next.standoff / 500);
  ctx.camera.far = Math.max(ctx.camera.far, next.standoff * 12);
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
}
