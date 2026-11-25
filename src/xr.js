// WebXR output, for browsers that expose a real XR runtime: Quest / Pico / Android XR browsers,
// Safari on Apple Vision Pro, desktop Chrome/Edge with an OpenXR runtime (SteamVR, WMR), or the
// Immersive Web Emulator extension. There the runtime does the stereo, lens correction and
// 6DoF/3DoF tracking itself, so the page renders the scene once per frame with three.js's XR camera.
//
// USB-C display glasses (RayNeo, XREAL, VITURE, Rokid…) are plain external monitors to the browser
// and register no XR runtime, so `immersive-vr` is never offered for them. They keep using the
// side-by-side canvas plus the WebHID head tracker; this module only adds the headset path.
import * as THREE from 'three';
import { createDome, eyeAspect, setEyeUV } from './video.js';

const MODES = { vr: 'immersive-vr', ar: 'immersive-ar' };
const UP = new THREE.Vector3(0, 1, 0);
// Average adult interpupillary distance, in metres; the runtime uses the real one.
export const XR_IPD = 0.063;
// A flat video hangs this far in front of the viewer, at up to this vertical angle (Screen size = 100%).
const SCREEN_DISTANCE = 2.5;
const SCREEN_MAX_ANGLE = 60;

const yawOf = (q, v) => {
  v.set(0, 0, -1).applyQuaternion(q);
  return Math.hypot(v.x, v.z) > 1e-3 ? Math.atan2(-v.x, -v.z) : 0;
};

export class XrOutput {
  constructor({ renderer, onChange, onSelect }) {
    this.renderer = renderer;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.available = typeof navigator !== 'undefined' && 'xr' in navigator;
    this.supported = { vr: false, ar: false };
    this.mode = null; // 'vr' | 'ar' while a session runs
    this.session = null;
    // Where "straight ahead" is: the viewer's head when the session started or was recentred.
    this.anchor = { position: new THREE.Vector3(), yaw: 0 };
    this._needsAnchor = true;
    this._tmp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(), v: new THREE.Vector3(), yq: new THREE.Quaternion() };

    // 'local': origin at the head when the session starts, which is what a seated viewer wants.
    renderer.xr.setReferenceSpaceType('local');
    renderer.xr.enabled = true;
    this.video = this._buildVideo();
    this.blank = new THREE.Scene();

    if (this.available) {
      navigator.xr.addEventListener?.('devicechange', () => this.detect());
      this.detect();
    }
  }

  get presenting() {
    return !!this.session;
  }

  async detect() {
    const check = async (mode) => {
      try { return !!(await navigator.xr.isSessionSupported(mode)); } catch { return false; }
    };
    this.supported = { vr: await check(MODES.vr), ar: await check(MODES.ar) };
    this.onChange?.();
  }

  /** Start an immersive session. Must be called from a user gesture (a click). */
  async enter(kind, { framebufferScale = 1 } = {}) {
    if (this.session) return;
    if (!this.available) throw new Error('This browser has no WebXR. Use a headset browser, or Chrome/Edge with an OpenXR runtime.');
    const session = await navigator.xr.requestSession(MODES[kind]);
    session.addEventListener('end', () => {
      this.session = null;
      this.mode = null;
      this.onChange?.();
    });
    session.addEventListener('select', () => this.onSelect?.());
    session.addEventListener('squeeze', () => this.recentre());
    this.renderer.xr.setFramebufferScaleFactor(framebufferScale);
    this.session = session;
    this.mode = kind;
    this._needsAnchor = true;
    try {
      await this.renderer.xr.setSession(session);
    } catch (err) {
      session.end().catch(() => {});
      throw err;
    }
    this.onChange?.();
  }

  exit() {
    return this.session?.end();
  }

  /** Make the current head pose "straight ahead" again. */
  recentre() {
    this._needsAnchor = true;
  }

  /** The viewer's head this frame (from the last rendered XR pose), in reference-space metres. */
  headPose(position, quaternion) {
    const { s } = this._tmp;
    this.renderer.xr.getCamera().matrixWorld.decompose(position, quaternion, s);
  }

  _updateAnchor() {
    if (!this._needsAnchor) return;
    this._needsAnchor = false;
    const { q, v } = this._tmp;
    this.headPose(this.anchor.position, q);
    this.anchor.yaw = yawOf(q, v);
  }

  /**
   * Put the desktop view in front of the viewer: `group` gets the transform that maps the orbit
   * camera (position, orientation; only its heading counts, so the world stays level) onto the
   * anchored head, scaled by `scale` scene units -> metres.
   */
  place(group, cameraPosition, cameraQuaternion, scale) {
    this._updateAnchor();
    const { v } = this._tmp;
    group.quaternion.setFromAxisAngle(UP, this.anchor.yaw - yawOf(cameraQuaternion, v));
    group.scale.setScalar(scale);
    group.position.copy(cameraPosition).multiplyScalar(-scale).applyQuaternion(group.quaternion).add(this.anchor.position);
  }

  // --- Video ---------------------------------------------------------------------------------
  // The runtime renders both eyes in one call, so each eye gets its own mesh on its own camera
  // layer (three.js puts the left eye on layer 1, the right on layer 2), with its own copy of
  // the video texture pointed at its half of the frame.
  _buildVideo() {
    const scene = new THREE.Scene();
    const materials = [0, 1].map(() => new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide }));
    const pair = (geometry) => {
      const group = new THREE.Group();
      materials.forEach((material, eye) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.layers.set(eye + 1);
        mesh.frustumCulled = false;
        group.add(mesh);
      });
      scene.add(group);
      return group;
    };
    return {
      scene,
      materials,
      textures: [null, null],
      source: null,
      screen: pair(new THREE.PlaneGeometry(1, 1)),
      domes: { 180: pair(createDome(180)), 360: pair(createDome(360)) },
    };
  }

  releaseVideo() {
    const v = this.video;
    for (const texture of v.textures) texture?.dispose();
    v.textures = [null, null];
    v.source = null;
    for (const material of v.materials) material.map = null;
  }

  renderVideo(media, { videoFormat, videoProjection, swap, screenSize }, camera) {
    const v = this.video;
    if (v.source !== media.texture) {
      this.releaseVideo();
      v.source = media.texture;
      v.textures = [0, 1].map(() => media.texture.clone());
      v.materials.forEach((material, eye) => {
        material.map = v.textures[eye];
        material.needsUpdate = true;
      });
    }
    v.textures.forEach((texture, eye) => setEyeUV(texture, videoFormat, swap ? 1 - eye : eye));

    this._updateAnchor();
    const { p, q, yq } = this._tmp;
    yq.setFromAxisAngle(UP, this.anchor.yaw);
    const flat = videoProjection === 'flat';
    v.screen.visible = flat;
    v.domes[180].visible = videoProjection === '180';
    v.domes[360].visible = videoProjection === '360';
    if (flat) {
      // A screen fixed in the room, straight ahead of where the viewer faced at recentre.
      const height = 2 * SCREEN_DISTANCE * Math.tan(THREE.MathUtils.degToRad(SCREEN_MAX_ANGLE * screenSize) / 2);
      const aspect = eyeAspect(videoFormat, media.width, media.height);
      v.screen.scale.set(height * aspect, height, 1);
      v.screen.quaternion.copy(yq);
      v.screen.position.set(0, 0, -SCREEN_DISTANCE).applyQuaternion(yq).add(this.anchor.position);
    } else {
      // The sphere is centred on the eyes wherever the head moves, as the footage was shot.
      const dome = v.domes[videoProjection];
      this.headPose(p, q);
      dome.position.copy(p);
      dome.quaternion.copy(yq);
    }
    camera.near = 0.05;
    camera.far = 100;
    this.renderer.render(v.scene, camera);
  }
}
