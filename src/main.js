import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SparkRenderer } from '@sparkjsdev/spark';
import { loadFromFiles, loadFromUrl, disposeObject, toProxy } from './loaders.js';
import {
  FileVideo, YouTubeVideo, createDome, eyeAspect, guessFormat, isVideoName, setEyeUV, youTubeId,
} from './video.js';
import { HeadTracker } from './headtracking.js';
import { XrOutput, XR_IPD } from './xr.js';
import { FileBrowser } from './filebrowser.js';
import { createUI } from './ui.js';

const SAMPLES = [
  { label: 'Sample splat', url: 'https://sparkjs.dev/assets/splats/butterfly.spz' },
  {
    label: 'Sample model',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb',
  },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`sbs.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`sbs.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const params = new URLSearchParams(location.search);
const PERSISTED = ['layout', 'depth', 'convergence', 'fov', 'swap', 'headMode', 'screenSize', 'displayFov', 'panel'];
const DEFAULT_PANEL = { x: 12, y: 12, width: 268, height: null };
const VIDEO_HISTORY_KEY = 'videoHistory';
const MAX_VIDEO_HISTORY = 30;

const state = {
  layout: 'sbs', // 'sbs' | 'hsbs' | 'mono'
  depth: 1, // eye separation multiplier (1 = target distance / 30)
  convergence: 1, // zero-parallax plane, as a multiple of the orbit distance
  // Camera field of view for models. ~30 degrees vertical is roughly what 50-57 degree
  // (diagonal) glasses show, so objects keep their natural proportions.
  fov: 30,
  swap: false,
  autoRotate: false,
  animate: true,
  headMode: 'look', // 'look' = turn the camera with the head | 'pinned' = image stays put in space
  screenSize: 0.6, // pinned screen height as a fraction of the display's
  displayFov: 57, // the glasses' diagonal field of view in degrees, as on their spec sheet
  showUI: true,
  dropdownOpen: null,
  panel: store.get('panel', DEFAULT_PANEL),
  browserOpen: false,
  video: null, // { kind, playing, time, duration, muted } while a video is loaded
  videoFormat: 'sbs',
  videoProjection: 'flat',
  videoQuality: 'default',
  videoHistory: store.get(VIDEO_HISTORY_KEY, []),
  browser: null,
  url: params.get('url') || '',
  status: 'Open a file, paste a model, video or YouTube link, or drop a file anywhere.',
  statusKind: '',
  note: '',
  hint: '',
  progress: -1,
  headTracking: false,
  xr: null, // 'vr' | 'ar' while a WebXR session runs
  xrSupport: { available: false, vr: false, ar: false },
  fullscreen: false,
  antialias: store.get('antialias', false),
};
if (!Array.isArray(state.videoHistory)) state.videoHistory = [];
for (const key of PERSISTED) state[key] = store.get(key, state[key]);
if (!state.panel || !Number.isFinite(state.panel.x) || !Number.isFinite(state.panel.y)
  || !Number.isFinite(state.panel.width)
  || (state.panel.height !== null && !Number.isFinite(state.panel.height))) {
  state.panel = { ...DEFAULT_PANEL };
  store.set('panel', state.panel);
}
if (['sbs', 'hsbs', 'mono'].includes(params.get('layout'))) state.layout = params.get('layout');

let ui = null;
function set(patch) {
  Object.assign(state, patch);
  for (const key of PERSISTED) if (key in patch) store.set(key, state[key]);
  if ('videoHistory' in patch) store.set(VIDEO_HISTORY_KEY, state.videoHistory);
  if ('layout' in patch) onResize();
  if ('videoFormat' in patch || 'layout' in patch) layoutYouTube();
  if ('videoQuality' in patch && model.kind === 'youtube') model.media.setQuality(state.videoQuality);
  if ('autoRotate' in patch) controls.autoRotate = state.autoRotate;
  updateHint();
  ui?.sync();
}

function rememberVideo(entry) {
  const history = [
    entry,
    ...state.videoHistory.filter((item) => item.url !== entry.url),
  ].slice(0, MAX_VIDEO_HISTORY);
  set({ videoHistory: history });
}

function forgetVideo(url) {
  const history = state.videoHistory.filter((item) => item.url !== url);
  set({ videoHistory: history });
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('view');
// MSAA is wasted on splats and costs a lot at 3840x1080, so it is opt-in (for meshes).
const renderer = new THREE.WebGLRenderer({ canvas, antialias: state.antialias, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 1);
renderer.setScissorTest(true);

const scene = new THREE.Scene();
// One splat update per frame, driven manually from the centre camera. Left on auto, Spark
// would re-sort for every eye because three.js counts each eye render as a new frame.
const spark = new SparkRenderer({ renderer, autoUpdate: false });
scene.add(spark);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.7;
pmrem.dispose();
scene.add(new THREE.AmbientLight(0xffffff, 0.25));

const camera = new THREE.PerspectiveCamera(state.fov, 16 / 9, 0.01, 1000);
camera.position.set(0, 0, 3);
const headlight = new THREE.DirectionalLight(0xffffff, 1.2);
headlight.position.set(0.3, 0.6, 1);
camera.add(headlight);
scene.add(camera);

const stereo = new THREE.StereoCamera();
stereo.aspect = 1;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotate = state.autoRotate;
controls.autoRotateSpeed = 1.5;
controls.zoomToCursor = false;

// world: identity on screen; in WebXR it places the desktop view in front of the viewer.
const world = new THREE.Group();
const pivot = new THREE.Group(); // carries the up-axis correction
world.add(pivot);
scene.add(world);

const model = { object: null, media: null, kind: null, mixer: null, radius: 1, up: 0 };
const timer = new THREE.Timer();
const tracker = new HeadTracker({
  onChange: () => set({ headTracking: tracker.connected }),
});

const xr = new XrOutput({
  renderer,
  onChange: () => set({ xr: xr.mode, xrSupport: { available: xr.available, ...xr.supported } }),
  onSelect: () => { if (model.media) actions.videoToggle(); },
});
state.xrSupport = { available: xr.available, ...xr.supported };

const files = new FileBrowser({ onChange: (browser) => set({ browser }) });
state.browser = files.snapshot();

// ---------------------------------------------------------------------------
// Layout & rendering
// ---------------------------------------------------------------------------

function onResize() {
  if (renderer.xr.isPresenting) return; // the runtime owns the framebuffer size
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Splat fill-rate is the bottleneck; don't multiply it by a phone's 3x pixel ratio.
  const cap = model.kind === 'splat' ? 1 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
  renderer.setSize(w, h, false);
  // Full SBS: each eye owns half the pixels at its true shape.
  // Half SBS: each half is a squeezed full-width image the display stretches back out.
  camera.aspect = state.layout === 'sbs' ? w / 2 / h : w / h;
  camera.updateProjectionMatrix();
  layoutYouTube();
  updateHint();
  ui?.sync();
}

function layoutYouTube() {
  if (model.kind === 'youtube') model.media.layout(state.videoFormat, state.layout, window.innerWidth, window.innerHeight);
}

function updateHint() {
  const aspect = window.innerWidth / window.innerHeight;
  let hint = '';
  if (state.layout === 'sbs' && aspect < 2.6) {
    hint = 'For 3D: switch the glasses to their side-by-side 3D mode (the display becomes 32:9, e.g. 3840×1080), then go fullscreen on it. If they stay 16:9 in 3D mode, choose "Half side-by-side".';
  } else if (!model.kind) {
    hint = 'Drop a model, Gaussian splat or 3D video anywhere';
  }
  state.hint = hint;
}

const baseQuat = new THREE.Quaternion();
const headQuat = new THREE.Quaternion();

// --- Pinned screen -----------------------------------------------------------------------
// With head tracking on, the stereo pair can be shown on a virtual screen that stays put in
// space, like a 3D cinema canvas: each eye's view is rendered to a texture, then drawn on a
// quad that a display-space camera looks at while turning with the head.
// The glasses' own vertical field of view in degrees, from the diagonal figure they are sold by.
// It sets how far a pinned screen moves across the display for a given head turn.
function displayVFov() {
  const half = Math.tan(THREE.MathUtils.degToRad(state.displayFov / 2)) / Math.hypot(camera.aspect, 1);
  return THREE.MathUtils.radToDeg(2 * Math.atan(half));
}
const halfTanDisplay = () => Math.tan(THREE.MathUtils.degToRad(displayVFov() / 2));
const pinned = {
  targets: [null, null],
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 10),
  quad: new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, depthWrite: false }),
  ),
  frame: new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => new THREE.Vector3(x, y, 0)),
    ),
    new THREE.LineBasicMaterial({ color: 0x3a4048, depthTest: false }),
  ),
};
pinned.quad.position.z = -1;
pinned.frame.position.z = -1;
pinned.scene.add(pinned.quad, pinned.frame);

function pinnedTarget(index, width, height) {
  let target = pinned.targets[index];
  if (!target || target.width !== width || target.height !== height) {
    target?.dispose();
    // Half-float keeps dark gradients smooth; three.js renders linear colour into targets.
    target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: state.antialias ? 4 : 0,
      generateMipmaps: false,
    });
    pinned.targets[index] = target;
  }
  return target;
}

// Size the pinned screen and turn the display camera with the head.
function aimPinned() {
  const height = 2 * halfTanDisplay() * state.screenSize;
  pinned.quad.scale.set(height * camera.aspect, height, 1);
  pinned.frame.scale.copy(pinned.quad.scale);
  pinned.camera.fov = displayVFov();
  pinned.camera.aspect = camera.aspect;
  pinned.camera.updateProjectionMatrix();
  pinned.camera.quaternion.copy(headQuat);
}

function renderEye(cam, index, x, width, height, usePinned, source = scene) {
  if (usePinned) {
    const ratio = renderer.getPixelRatio();
    const target = pinnedTarget(
      index,
      Math.max(2, Math.round(width * ratio * state.screenSize)),
      Math.max(2, Math.round(height * ratio * state.screenSize)),
    );
    renderer.setRenderTarget(target);
    renderer.render(source, cam);
    renderer.setRenderTarget(null);
    pinned.quad.material.map = target.texture;
  }
  renderer.setViewport(x, 0, width, height);
  renderer.setScissor(x, 0, width, height);
  if (usePinned) renderer.render(pinned.scene, pinned.camera);
  else renderer.render(source, cam);
}

// --- Video -------------------------------------------------------------------------------
// A flat video is a quad in display space (so it can be pinned like the model canvas); VR180 /
// VR360 video is the inside of a sphere around the viewer. Each eye samples its part of the frame.
// With head tracking on, a flat video is always a pinned screen; VR video follows the head mode:
// the head either turns the view inside the sphere, or that view sits on the pinned screen.
const videoMaterial = new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, side: THREE.DoubleSide });
const videoView = {
  scene: new THREE.Scene(),
  flatCamera: new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100),
  domeCamera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100),
  screen: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), videoMaterial),
  domes: { 180: new THREE.Mesh(createDome(180), videoMaterial), 360: new THREE.Mesh(createDome(360), videoMaterial) },
  look: new THREE.Euler(0, 0, 0, 'YXZ'), // drag-to-look for VR video
};
videoView.screen.position.z = -1;
videoView.scene.add(videoView.screen, videoView.domes[180], videoView.domes[360]);

function renderVideo(w, h) {
  const media = model.media;
  const tracking = tracker.connected;
  if (tracking) tracker.getRotation(headQuat);
  else headQuat.identity();
  const view = videoView;
  const flat = state.videoProjection === 'flat';
  view.screen.visible = flat;
  view.domes[180].visible = state.videoProjection === '180';
  view.domes[360].visible = state.videoProjection === '360';

  const usePinned = tracking && !flat && state.headMode === 'pinned';
  let cam;
  if (flat) {
    // Fills the view; with head tracking on it becomes a pinned screen of the chosen size.
    cam = view.flatCamera;
    cam.fov = displayVFov();
    cam.quaternion.copy(headQuat);
    const boxH = 2 * halfTanDisplay() * (tracking ? state.screenSize : 1);
    const boxW = boxH * camera.aspect;
    const content = eyeAspect(state.videoFormat, media.width, media.height);
    if (content > camera.aspect) view.screen.scale.set(boxW, boxW / content, 1);
    else view.screen.scale.set(boxH * content, boxH, 1);
  } else {
    cam = view.domeCamera;
    cam.fov = state.fov;
    cam.quaternion.setFromEuler(view.look);
    if (usePinned) aimPinned();
    else cam.quaternion.multiply(headQuat);
  }
  cam.aspect = camera.aspect;
  cam.updateProjectionMatrix();

  if (videoMaterial.map !== media.texture) {
    videoMaterial.map = media.texture;
    videoMaterial.needsUpdate = true;
  }
  const eyes = state.layout === 'mono' ? [[0, 0, w]] : [[0, 0, w / 2], [1, w / 2, w / 2]];
  for (const [eye, x, width] of eyes) {
    setEyeUV(media.texture, state.videoFormat, state.swap ? 1 - eye : eye);
    renderEye(cam, eye, x, width, h, usePinned, view.scene);
  }
}

// The YouTube embed is a DOM element, so head tracking moves it with CSS instead: either the
// whole frame slides to stay put in space (pinned), or a 360 video's own view is turned.
const ytDir = new THREE.Vector3();
const ytEuler = new THREE.Euler(0, 0, 0, 'YXZ');
function trackYouTube(w, h) {
  const media = model.media;
  if (!tracker.connected) return media.pin(0, 0);
  tracker.getRotation(headQuat);
  if (state.headMode === 'look' && media.spherical) {
    ytEuler.setFromQuaternion(headQuat);
    media.pin(0, 0);
    media.look(THREE.MathUtils.radToDeg(ytEuler.y), THREE.MathUtils.radToDeg(ytEuler.x));
    return;
  }
  // Where the screen centre (straight ahead at recentre) now sits in the head's view.
  ytDir.set(0, 0, -1).applyQuaternion(headQuat.invert());
  if (ytDir.z > -0.05) return media.pin(w * 4, 0); // beside or behind the viewer
  const focal = h / 2 / halfTanDisplay();
  const squeeze = state.layout === 'hsbs' ? 0.5 : 1;
  media.pin((focal * squeeze * ytDir.x) / -ytDir.z, (-focal * ytDir.y) / -ytDir.z);
}

// Drag to look around VR video (the orbit controls are off while a video is loaded).
canvas.addEventListener('pointermove', (e) => {
  if (model.kind !== 'video' || state.videoProjection === 'flat' || !(e.buttons & 1)) return;
  const k = THREE.MathUtils.degToRad(state.fov) / window.innerHeight;
  videoView.look.y += e.movementX * k;
  videoView.look.x = THREE.MathUtils.clamp(videoView.look.x + e.movementY * k, -1.5, 1.5);
});

// --- View navigation -----------------------------------------------------------------------
// Shared by the on-screen gizmo and the arrow keys; the orbit controls pick up the new pose.
const navOffset = new THREE.Vector3();
const navSpherical = new THREE.Spherical();
const navRight = new THREE.Vector3();
const navUp = new THREE.Vector3();

/** Orbit the camera about the target, in radians: positive theta = to the right, positive phi = downward. */
function orbitBy(dTheta, dPhi) {
  navOffset.copy(camera.position).sub(controls.target);
  navSpherical.setFromVector3(navOffset);
  navSpherical.theta += dTheta;
  navSpherical.phi = THREE.MathUtils.clamp(navSpherical.phi + dPhi, 1e-3, Math.PI - 1e-3);
  camera.position.copy(controls.target).add(navOffset.setFromSpherical(navSpherical));
  camera.lookAt(controls.target);
}

/** Slide camera and target together, as fractions of the view height at the target's distance. */
function panBy(right, up) {
  const span = 2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(state.fov) / 2);
  navRight.setFromMatrixColumn(camera.matrix, 0).multiplyScalar(right * span);
  navUp.setFromMatrixColumn(camera.matrix, 1).multiplyScalar(up * span);
  camera.position.add(navRight).add(navUp);
  controls.target.add(navRight).add(navUp);
}

/** Look at the target from along a world axis, keeping the distance. */
function snapView(x, y, z) {
  const dist = camera.position.distanceTo(controls.target);
  camera.position.copy(controls.target).add(navOffset.set(x, y, z).multiplyScalar(dist));
  controls.update(); // keeps straight-up / straight-down views well defined
}

// Arrow keys held down: orbit, or pan with Shift.
const heldArrows = new Map(); // key -> shift
const ORBIT_RATE = Math.PI / 2; // radians per second
const PAN_RATE = 0.6; // view heights per second
function applyHeldArrows(dt) {
  for (const [key, shift] of heldArrows) {
    const x = (key === 'arrowright') - (key === 'arrowleft');
    const y = (key === 'arrowup') - (key === 'arrowdown');
    if (shift) panBy(x * PAN_RATE * dt, y * PAN_RATE * dt);
    else orbitBy(x * ORBIT_RATE * dt, -y * ORBIT_RATE * dt);
  }
}
window.addEventListener('keyup', (e) => {
  heldArrows.delete(e.key.toLowerCase());
  // Releasing Shift turns a pan back into an orbit.
  if (e.key === 'Shift') for (const key of heldArrows.keys()) heldArrows.set(key, false);
});
window.addEventListener('blur', () => heldArrows.clear());

// --- WebXR -------------------------------------------------------------------------------
// In a headset the runtime supplies both eye cameras and the head pose. The orbit camera's pose
// from when the session started (or the last refit) is mapped onto the viewer's head, so the
// model sits in front of them as it did on screen. The scale follows the Depth slider the same
// way the on-screen stereo does: the scene is sized so the real eye separation matches the
// virtual one (Depth 1 puts the orbit target about 1.9 m away).
const xrDesk = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), dist: 1 };

function captureXrDesk() {
  xrDesk.position.copy(camera.position);
  xrDesk.quaternion.copy(camera.quaternion);
  xrDesk.dist = Math.max(1e-6, camera.position.distanceTo(controls.target));
}

renderer.xr.addEventListener('sessionstart', () => {
  captureXrDesk();
  controls.enabled = false;
  heldArrows.clear();
  renderer.setScissorTest(false); // three.js sets each eye's viewport itself
});

renderer.xr.addEventListener('sessionend', () => {
  world.position.set(0, 0, 0);
  world.quaternion.identity();
  world.scale.setScalar(1);
  camera.position.copy(xrDesk.position);
  camera.quaternion.copy(xrDesk.quaternion);
  camera.scale.setScalar(1);
  controls.enabled = !model.media;
  renderer.setScissorTest(true);
  onResize();
});

function renderXR() {
  if (model.kind === 'video') return xr.renderVideo(model.media, state, camera);
  if (model.kind === 'youtube') return renderer.render(xr.blank, camera);
  const scale = XR_IPD / ((xrDesk.dist / 30) * Math.max(state.depth, 0.05));
  xr.place(world, xrDesk.position, xrDesk.quaternion, scale);
  camera.near = 0.01;
  camera.far = 1000;
  const xrCamera = renderer.xr.getCamera();
  const update = spark.updateInternal
    ? spark.updateInternal({ scene, camera: xrCamera, autoUpdate: true })
    : spark.update({ scene, camera: xrCamera });
  update.catch(() => {});
  renderer.render(scene, camera);
}

function frame(time) {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (model.mixer && state.animate) model.mixer.update(dt);
  if (renderer.xr.isPresenting) return renderXR();
  if (model.media) heldArrows.clear();
  else applyHeldArrows(dt);
  controls.update(dt);
  ui?.setGizmo(camera.quaternion);

  const w = window.innerWidth;
  const h = window.innerHeight;
  if (model.kind === 'youtube') return trackYouTube(w, h); // the embed is on top of the canvas
  if (model.kind === 'video') return renderVideo(w, h);
  const dist = camera.position.distanceTo(controls.target);
  camera.near = Math.max(1e-4, Math.min(dist, model.radius) / 50);
  camera.far = (dist + model.radius) * 50;
  camera.fov = state.fov;
  camera.focus = Math.max(camera.near * 2, dist * state.convergence);
  camera.updateProjectionMatrix();

  const usePinned = tracker.connected && state.headMode === 'pinned';
  baseQuat.copy(camera.quaternion);
  if (tracker.connected) {
    tracker.getRotation(headQuat);
    if (usePinned) {
      // The scene camera stays where the orbit put it; the head only moves the display camera.
      aimPinned();
    } else {
      // Look-around: head rotation is layered on top of the orbit pose for this frame only.
      camera.quaternion.multiply(headQuat);
    }
  }
  camera.updateMatrixWorld(true);

  const update = spark.updateInternal
    ? spark.updateInternal({ scene, camera, autoUpdate: true })
    : spark.update({ scene, camera });
  update.catch(() => {});

  if (state.layout === 'mono') {
    renderEye(camera, 0, 0, w, h, usePinned);
  } else {
    stereo.eyeSep = (dist / 30) * state.depth;
    stereo.update(camera);
    for (const eye of [stereo.cameraL, stereo.cameraR]) {
      // StereoCamera only writes the local matrix; resolve the rest now so anything reading
      // the eye's world pose or inverse projection (Spark does) sees consistent values.
      eye.matrix.decompose(eye.position, eye.quaternion, eye.scale);
      eye.updateMatrixWorld(true);
      eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
    }
    const [left, right] = state.swap ? [stereo.cameraR, stereo.cameraL] : [stereo.cameraL, stereo.cameraR];
    renderEye(left, 0, 0, w / 2, h, usePinned);
    renderEye(right, 1, w / 2, w / 2, h, usePinned);
  }
  camera.quaternion.copy(baseQuat);
}

// ---------------------------------------------------------------------------
// Model handling
// ---------------------------------------------------------------------------

function modelBounds() {
  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3();
  if (model.kind === 'splat') {
    try {
      box.copy(model.object.getBoundingBox(true)).applyMatrix4(model.object.matrixWorld);
    } catch { /* paged / streaming splats may not have bounds yet */ }
  } else {
    box.setFromObject(pivot);
  }
  if (box.isEmpty() || !Number.isFinite(box.min.x + box.max.x)) {
    box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  }
  return box;
}

function fitView() {
  const box = modelBounds();
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-6);
  model.radius = radius;
  const vHalf = THREE.MathUtils.degToRad(state.fov) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  // Splat bounds include stray floaters far from the subject, so start well inside them.
  const margin = model.kind === 'splat' ? 0.8 : 1.1;
  const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * margin;
  const dir = model.kind === 'splat' ? new THREE.Vector3(0, 0.08, 1) : new THREE.Vector3(0.45, 0.3, 1);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir.normalize(), dist);
  controls.minDistance = radius * 1e-3;
  controls.maxDistance = radius * 40;
  controls.update();
  if (renderer.xr.isPresenting) captureXrDesk();
}

function clearModel() {
  if (model.media) {
    model.media.dispose();
    videoMaterial.map = null;
    xr.releaseVideo();
    controls.enabled = true;
    document.body.classList.remove('has-video');
    state.video = null;
  }
  if (model.object) {
    model.mixer?.stopAllAction();
    pivot.remove(model.object);
    disposeObject(model.object);
  }
  Object.assign(model, { object: null, media: null, kind: null, mixer: null });
}

function describe(result) {
  const parts = [result.format.toUpperCase()];
  if (result.kind === 'splat') {
    if (result.count) parts.push(`${result.count.toLocaleString()} splats`);
  } else {
    let tris = 0;
    let points = 0;
    result.object.traverse((n) => {
      const g = n.geometry;
      if (!g?.attributes?.position) return;
      if (n.isPoints) points += g.attributes.position.count;
      else if (n.isMesh) tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    if (tris) parts.push(`${Math.round(tris).toLocaleString()} triangles`);
    if (points) parts.push(`${points.toLocaleString()} points`);
  }
  parts.push(`${(result.bytes / 1048576).toFixed(1)} MB`);
  return `${result.name} — ${parts.join(' · ')}`;
}

let loadToken = 0;
async function load(run) {
  const token = ++loadToken;
  set({ status: 'Loading…', statusKind: 'busy', progress: 0, note: '' });
  const ctx = {
    renderer,
    onStatus: (status) => token === loadToken && set({ status }),
    onNote: (note) => token === loadToken && set({ note }),
    onProgress: (e) => {
      if (token !== loadToken) return;
      const progress = e.lengthComputable && e.total ? e.loaded / e.total : 0;
      if (Math.abs(progress - state.progress) > 0.01) set({ progress });
    },
  };
  try {
    const result = await run(ctx);
    if (token !== loadToken) {
      disposeObject(result.object);
      return;
    }
    clearModel();
    Object.assign(model, { object: result.object, kind: result.kind });
    // Trained splats are y-down (OpenCV); most mesh formats are already y-up.
    model.up = result.kind === 'splat' ? 2 : 0;
    pivot.rotation.set((model.up * Math.PI) / 2, 0, 0);
    pivot.add(result.object);
    if (result.animations?.length) {
      model.mixer = new THREE.AnimationMixer(result.object);
      model.mixer.clipAction(result.animations[0]).play();
    }
    onResize();
    fitView();
    set({ status: describe(result), statusKind: '', progress: -1 });
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    if (staleCodeReload(err)) return;
    set({ status: err?.message || String(err), statusKind: 'error', progress: -1 });
  }
}

// Format loaders are fetched on demand. If the site was rebuilt or the dev server re-bundled its
// dependencies after this page was opened, those files no longer exist under the names this page
// knows, and the import fails. A reload picks up the new names; do it once, not in a loop.
function staleCodeReload(err) {
  if (!/dynamically imported module|module script failed|error loading dynamically/i.test(err?.message || '')) return false;
  let last = 0;
  try { last = Number(sessionStorage.getItem('sbs.codeReload')) || 0; } catch { /* storage blocked */ }
  if (Date.now() - last < 30000) {
    set({ status: 'Could not load part of the viewer. Check that the server is running, then reload the page.', statusKind: 'error', progress: -1 });
    return true;
  }
  try { sessionStorage.setItem('sbs.codeReload', String(Date.now())); } catch { return false; }
  set({ status: 'The viewer was updated — reloading…', statusKind: 'busy', progress: -1 });
  location.reload();
  return true;
}

// --- Video loading ---

const clock = (t) => {
  const s = Math.max(0, Math.floor(t));
  const pad = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

async function loadMedia(label, create, historyEntry = null) {
  const token = ++loadToken;
  set({ status: `Loading ${label}…`, statusKind: 'busy', progress: -1, note: '' });
  let media;
  try {
    media = await create();
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    return set({ status: err?.message || String(err), statusKind: 'error' });
  }
  if (token !== loadToken) return media.dispose();
  if (historyEntry) rememberVideo({ ...historyEntry, title: media.title || historyEntry.title });
  clearModel();
  Object.assign(model, { media, kind: media.kind });
  controls.enabled = false;
  videoView.look.set(0, 0, 0);
  document.body.classList.add('has-video');
  const guess = guessFormat(media.title, media.width, media.height);
  const isYouTube = media.kind === 'youtube';
  let note = '';
  if (isYouTube) {
    // YouTube does not expose frame dimensions before playback, so an untagged SBS upload
    // cannot be distinguished from half-SBS by aspect ratio. Full-SBS is the safer default:
    // scaling a full-SBS frame as half-SBS makes the image look vertically compressed.
    if (guess.format === 'hsbs' && !/\bhsbs\b|\bhalf\s*(sbs|side\s*by\s*side)\b/i.test(media.title)) {
      guess.format = 'sbs';
    }
    // The embed can only be stretched, not re-cut, so it cannot split top-bottom or VR video
    // into the two display eyes. Keep the detected format so the frame is not distorted.
    if (guess.projection !== 'flat') note = 'YouTube VR180 / 360 videos cannot be shown through the embed. Download the video and open the file instead.';
    else if (!['sbs', 'hsbs'].includes(guess.format)) note = 'YouTube top-bottom video is shown as one frame. Download it to split the two eyes.';
    guess.projection = 'flat';
    media.onError = (err) => set({ status: err.message, statusKind: 'error' });
    if (xr.presenting) note = 'YouTube cannot be shown inside a WebXR session. Exit it to watch, or download the video and open the file.';
  }
  const size = media.width ? ` · ${media.width}×${media.height}` : '';
  set({
    videoFormat: guess.format,
    videoProjection: guess.projection,
    videoQuality: isYouTube ? 'default' : state.videoQuality,
    status: `${media.title}${size}`,
    statusKind: '',
    note,
  });
  onResize();
  pollVideo();
  try {
    await media.play();
  } catch {
    set({ note: 'Press Play to start the video.' });
  }
}

function openVideoFile(file) {
  return loadMedia(file.name, () => new FileVideo().load(file));
}

function openVideoUrl(url) {
  return loadMedia('video', async () => {
    try {
      return await new FileVideo().load(url, { crossOrigin: true });
    } catch (err) {
      if (new URL(url, location.href).origin === location.origin) throw err;
      // Most likely the host sends no CORS headers, which a video used as a texture needs.
      try {
        return await new FileVideo().load(toProxy(new URL(url).href), { title: decodeURIComponent(new URL(url).pathname.split('/').pop()) });
      } catch {
        throw new Error(`${err.message} If the server blocks cross-origin use and no local proxy is running, download the file and open it instead.`);
      }
    }
  }, { url, title: url });
}

function openYouTube(target) {
  // Only one embed can live in the container, so let go of a previous one first.
  if (model.kind === 'youtube') clearModel();
  return loadMedia('YouTube video', async () => {
    const media = new YouTubeVideo(document.getElementById('yt'));
    try {
      return await media.load(target);
    } catch (err) {
      media.dispose();
      throw err;
    }
  }, {
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(target.id)}${target.start ? `&t=${target.start}` : ''}`,
    title: 'YouTube video',
  });
}

/** Open picked/dropped files: a video goes to the player, anything else to the model loaders. */
function openPicked(files, main) {
  const list = [...files];
  const video = main || list.find((f) => f.type.startsWith('video/') || isVideoName(f.name));
  if (video && (video.type.startsWith('video/') || isVideoName(video.name))) return openVideoFile(video);
  return load((ctx) => loadFromFiles(list, ctx, main));
}

function pollVideo() {
  const media = model.media;
  if (!media) return;
  const next = {
    kind: media.kind,
    playing: media.playing,
    time: Math.round(media.time * 2) / 2,
    duration: media.duration,
    muted: media.muted,
    label: `${clock(media.time)} / ${clock(media.duration)}`,
  };
  const prev = state.video;
  if (!prev || Object.keys(next).some((k) => next[k] !== prev[k])) set({ video: next });
}
setInterval(pollVideo, 250);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let wakeLock = null;
const actions = {
  openFiles: (files) => openPicked(files),
  openUrl: (url) => {
    if (!url?.trim()) return set({ status: 'Enter a URL first.', statusKind: 'error' });
    set({ url });
    const youTube = youTubeId(url);
    if (youTube) return openYouTube(youTube);
    let parsed = null;
    try { parsed = new URL(url.trim(), location.href); } catch { /* reported by the model loader */ }
    if (parsed && (isVideoName(parsed.pathname) || params.get('format') === 'video')) return openVideoUrl(parsed.href);
    return load((ctx) => loadFromUrl(url, ctx, params.get('format') || undefined));
  },
  openVideoHistory: (url) => actions.openUrl(url),
  deleteVideoHistory: (url) => forgetVideo(url),
  clearVideoHistory: () => set({ videoHistory: [] }),
  resetView: () => fitView(),
  // Gizmo drags, in pixels; same feel as dragging the canvas.
  orbitDrag: (dx, dy) => orbitBy((-dx * 2 * Math.PI) / window.innerHeight, (-dy * 2 * Math.PI) / window.innerHeight),
  panDrag: (dx, dy) => panBy(-dx / window.innerHeight, dy / window.innerHeight),
  snapView,
  cycleUp: () => {
    model.up = (model.up + 1) % 4;
    pivot.rotation.set((model.up * Math.PI) / 2, 0, 0);
    fitView();
  },
  recentre: () => (xr.presenting ? xr.recentre() : tracker.recentre()),

  async toggleXR(kind) {
    try {
      if (xr.presenting) return await xr.exit();
      if (model.kind === 'youtube') {
        return set({ note: 'YouTube plays through an embedded web page, which WebXR cannot show. Download the video and open the file instead.' });
      }
      // Splats are fill-rate bound; render them below the headset's native resolution.
      await xr.enter(kind, { framebufferScale: model.kind === 'splat' ? 0.75 : 1 });
    } catch (err) {
      set({ note: `Could not start WebXR: ${err.message}` });
    }
  },

  videoToggle() {
    const media = model.media;
    if (!media) return;
    if (media.playing) media.pause();
    else media.play()?.catch?.(() => {});
    pollVideo();
  },
  videoSeek(time) { model.media?.seek(time); pollVideo(); },
  videoSkip(seconds) { if (model.media) actions.videoSeek(model.media.time + seconds); },
  videoMute() { model.media?.setMuted(!model.media.muted); pollVideo(); },

  async toggleHeadTracking() {
    try {
      if (tracker.connected) await tracker.disconnect();
      else await tracker.connect();
    } catch (err) {
      set({ note: err.message });
    }
  },

  // Switch the glasses' panels between 3D and 2D over USB, and the app layout with them.
  async setGlasses3D(on) {
    const is3D = () => screen.width / screen.height > 3;
    try {
      if (!(await tracker.setDisplay3D(on))) return;
    } catch (err) {
      return set({ note: err.message });
    }
    set({ layout: on ? 'sbs' : 'mono', note: 'Asked the glasses to switch…' });
    // The display re-enumerates at a new resolution; give the OS a moment to notice.
    for (let i = 0; i < 8 && is3D() !== on; i++) await new Promise((r) => setTimeout(r, 500));
    set({
      note: is3D() === on ? '' : `Sent the ${on ? '3D' : '2D'} command, but this screen did not change shape. Either this window is not on the glasses, or their firmware ignores the command — use the 3D mode button on the glasses instead.`,
    });
  },

  // In-page file browser
  browsePick: () => (files.nativeSupported ? files.pickFolder() : ui.pickDirectoryFallback()),
  browseFileList: (list) => files.setFileList(list),
  browseGrant: () => files.grant(),
  browseEnter: (name) => files.enter(name),
  browseUp: () => files.up(),
  browseGoTo: (depth) => files.goTo(depth),
  async browseOpen(name) {
    try {
      const picked = await files.filesFor(name);
      set({ browserOpen: false });
      await openPicked(picked.files, picked.main);
    } catch (err) {
      set({ status: err.message, statusKind: 'error' });
    }
  },
  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        screen.orientation?.lock?.('landscape').catch(() => {});
      }
    } catch (err) {
      set({ note: `Fullscreen failed: ${err.message}` });
    }
  },
  setAntialias(on) {
    store.set('antialias', !!on);
    location.reload();
  },
};

document.addEventListener('fullscreenchange', async () => {
  set({ fullscreen: !!document.fullscreenElement });
  try {
    if (document.fullscreenElement) wakeLock = await navigator.wakeLock?.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch { /* wake lock is a nicety */ }
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const key = e.key.toLowerCase();
  if (key === 'f') actions.toggleFullscreen();
  else if (key === 'h') set({ showUI: !state.showUI });
  else if (key === 'r') actions.resetView();
  else if (key === 'c') actions.recentre();
  else if (key === ' ' && model.media) actions.videoToggle();
  else if (key === 'arrowleft' && model.media) actions.videoSkip(-10);
  else if (key === 'arrowright' && model.media) actions.videoSkip(10);
  else if (key === 'm' && model.media) actions.videoMute();
  else if (key.startsWith('arrow') && !model.media && e.target.type !== 'range') heldArrows.set(key, e.shiftKey);
  else if (key === ' ') set({ autoRotate: !state.autoRotate });
  else if (key === 'escape' && state.browserOpen) set({ browserOpen: false });
  else return;
  e.preventDefault();
});

// Drag & drop anywhere.
const eyes = document.getElementById('eyes');
window.addEventListener('dragover', (e) => { e.preventDefault(); eyes.classList.add('drop'); });
window.addEventListener('dragleave', () => eyes.classList.remove('drop'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  eyes.classList.remove('drop');
  if (e.dataTransfer.files.length) return actions.openFiles(e.dataTransfer.files);
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (url) actions.openUrl(url.split('\n')[0]);
});

window.addEventListener('resize', onResize);
// The IMU keeps streaming after the page goes away unless told to stop.
window.addEventListener('pagehide', () => { tracker.close(); });

ui = createUI({ state, set, actions, samples: SAMPLES });
onResize();
renderer.setAnimationLoop(frame);
files.restore();
if (state.url) actions.openUrl(state.url);

// Handy for debugging from the console.
window.viewer = { files, stereo, state, set, actions, scene, camera, renderer, spark, model, tracker, xr, world };
