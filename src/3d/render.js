// Three.js scene for the 3D builder. Rebuilds meshes from the solution on each change.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { legalCones, samplePoints } from './geometry.js';
import { minChordFor } from '../core/arcMath.js';
import { minRadiusFor, tangentAt, validRuns } from '../core/solve.js';
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

export function initScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  // The model treats +Z as up, so the camera must agree or orbiting feels wrong.
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 60000);
  camera.up.set(0, 0, 1);
  camera.position.set(700, -900, 600);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(600, -800, 1200);
  scene.add(key);

  const grid = new THREE.GridHelper(4000, 40, 0x2a3441, 0x1d2530);
  grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; the model works in XY
  scene.add(grid);

  const groups = {
    jacket: new THREE.Group(),
    duct: new THREE.Group(),
    path: new THREE.Group(),
    guides: new THREE.Group(),
    points: new THREE.Group(),
  };
  for (const g of Object.values(groups)) scene.add(g);

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

function addCenterline(group, solution) {
  for (const seg of solution.segments) {
    if (!seg.ok) {
      if (seg.reason === 'degenerate') continue;
      const geom = new THREE.BufferGeometry().setFromPoints([toVec3(seg.from), toVec3(seg.to)]);
      const line = new THREE.Line(geom, new THREE.LineDashedMaterial({ color: COLOR.error, dashSize: 14, gapSize: 10 }));
      line.computeLineDistances();
      group.add(line);
      continue;
    }

    const pts = samplePoints(seg, seg.arc.straight ? 1 : 24).map(toVec3);
    const material = new THREE.LineBasicMaterial({ color: seg.tooTight ? COLOR.tight : COLOR.ok });
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
  }
}

/**
 * Guide rings. In 3D a permitted sweep is a whole cone around the tangent, so the legal
 * directions form a circle rather than the two rays the 2D view shows (§3.5).
 * Each ring sits at that sweep's minimum bend distance when there is one, so the ring is
 * literally the nearest legal placement.
 */
function addGuides(group, state, solution, anchorIndex) {
  if (!state.features.guideRays || !state.showGuides) return;
  if (anchorIndex < 0 || anchorIndex >= state.points.length) return;

  const anchor = state.points[anchorIndex];
  const tangent = tangentAt(solution, anchorIndex, state.initialTangent);
  const minRadius = minRadiusFor(state);

  const seed = Math.abs(tangent.z) > 0.9 ? V.vec(1, 0, 0) : V.vec(0, 0, 1);
  const perp = V.normalize(V.cross(tangent, seed));

  for (const { theta, half } of legalCones()) {
    const dMin = minChordFor(theta, minRadius);
    const dist = Math.max(dMin, 260);
    const blocked = dMin > 0;

    if (theta === 0) {
      const end = V.add(anchor, V.scale(tangent, dist));
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([toVec3(anchor), toVec3(end)]),
        new THREE.LineBasicMaterial({ color: COLOR.guide }),
      ));
      continue;
    }

    const centre = V.add(anchor, V.scale(tangent, dist * Math.cos(half * Math.PI / 180)));
    const radius = dist * Math.sin((half * Math.PI) / 180);

    const ring = [];
    for (let i = 0; i <= 72; i++) {
      const spun = V.rotateAbout(perp, tangent, (i / 72) * Math.PI * 2);
      ring.push(toVec3(V.add(centre, V.scale(spun, radius))));
    }
    group.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({
        color: blocked ? COLOR.blocked : COLOR.guide,
        transparent: true,
        opacity: blocked ? 0.55 : 0.85,
      }),
    ));
  }
}

function addPoints(group, state) {
  const geom = new THREE.SphereGeometry(7, 18, 12);
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

  const runs = validRuns(solution);
  if (state.features.jacket && state.showJacket) addBand(groups.jacket, runs, state.jacketWidth, COLOR.jacket, 0.18, 1);
  if (state.features.duct && state.showDuct) addBand(groups.duct, runs, state.ductWidth, COLOR.duct, 0.34, 2);

  addCenterline(groups.path, solution);
  addGuides(groups.guides, state, solution, anchorIndex);
  addPoints(groups.points, state);
}

export function fitCamera(ctx, points) {
  const box = new THREE.Box3();
  if (points.length === 0) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(800, 800, 800));
  else for (const p of points) box.expandByPoint(toVec3(p));

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 120);
  const dist = radius / Math.sin((ctx.camera.fov * Math.PI) / 360) * 1.35;

  const dir = ctx.camera.position.clone().sub(ctx.controls.target).normalize();
  if (dir.lengthSq() === 0) dir.set(0.5, -0.7, 0.5).normalize();

  ctx.controls.target.copy(sphere.center);
  ctx.camera.position.copy(sphere.center.clone().add(dir.multiplyScalar(dist)));
  ctx.camera.near = Math.max(0.5, dist / 500);
  ctx.camera.far = dist * 12;
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
}
