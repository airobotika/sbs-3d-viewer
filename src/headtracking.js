// Experimental 3DoF head tracking over WebHID. The viewer itself works with any glasses that
// have a side-by-side 3D mode; this optional part talks to one specific family of hardware,
// currently RayNeo GT / GT Max. To support other glasses, add their USB ids to FILTERS and
// teach _send() / _handle() their protocol.
//
// There is no official web SDK for these glasses. The wire protocol below follows the
// community reverse-engineering work in HaloneXR/halone (GT Max driver) and
// verncat/RayNeo-Air-3S-Pro-OpenVR. It has not been verified against hardware here.
//
//   command  : 64 bytes, 66 <cmd> <value> 00...
//   IMU frame: 64 bytes, 99 65 .., float32 LE: accel xyz @4 (m/s^2), gyro xyz @16 (deg/s), tick u32 @40 (100us)
//   sensor frame: +X forward, +Y left, +Z up  ->  three.js: X = -sY, Y = +sZ, Z = -sX
import * as THREE from 'three';

const FILTERS = [{ vendorId: 0x3941, productId: 0xaf50 }];
const CMD = { INFO: 0x00, IMU_ON: 0x01, IMU_OFF: 0x02, DISPLAY_3D: 0x06, DISPLAY_2D: 0x07, ANCHOR: 0x08 };
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

export class HeadTracker {
  constructor({ onChange } = {}) {
    this.onChange = onChange;
    this.device = null;
    this.connected = false;
    this.samples = 0;

    this._q = new THREE.Quaternion(); // IMU body -> world
    this._bias = new THREE.Vector3();
    this._lastTick = null;
    this._needsRecentre = true;
    this._onReport = (e) => this._handle(e);
    this._onDisconnect = (e) => { if (e.device === this.device) this._reset(); };
    this._tmp = {
      w: new THREE.Vector3(), a: new THREE.Vector3(), v: new THREE.Vector3(),
      e: new THREE.Vector3(), dq: new THREE.Quaternion(), qi: new THREE.Quaternion(),
      heading: new THREE.Quaternion(), refInv: new THREE.Quaternion(),
    };
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  /** Open the glasses' vendor HID interface. Reuses a previously granted device silently. */
  async open() {
    if (this.device?.opened) return true;
    if (!HeadTracker.supported) {
      throw new Error('WebHID is not available. Use Chrome or Edge on a computer, over https or localhost.');
    }
    const match = (d) => FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);
    let devices = (await navigator.hid.getDevices()).filter(match);
    if (!devices.length) devices = await navigator.hid.requestDevice({ filters: FILTERS });
    if (!devices.length) return false; // picker dismissed
    // The glasses can expose several HID interfaces; commands go to the vendor-defined one.
    const device = devices.find((d) => d.collections?.some((c) => c.usagePage >= 0xff00)) || devices[0];
    try {
      if (!device.opened) await device.open();
    } catch (err) {
      throw new Error(
        `Could not open the glasses (${err.message}). On Linux, add the udev rule from the README; otherwise close other apps using them.`,
      );
    }
    this.device = device;
    device.addEventListener('inputreport', this._onReport);
    navigator.hid.addEventListener('disconnect', this._onDisconnect);
    return true;
  }

  /** Start head tracking. */
  async connect() {
    if (!(await this.open())) return false;
    await this._send(CMD.IMU_OFF).catch(() => {});
    await this._send(CMD.INFO).catch(() => {});
    // "Follow" mode, so the glasses' own 3DoF anchoring doesn't counter-rotate the image.
    await this._send(CMD.ANCHOR, 0x00);
    await this._send(CMD.IMU_ON);

    this.connected = true;
    this.samples = 0;
    this._lastTick = null;
    this._q.identity();
    this._bias.set(0, 0, 0);
    this._needsRecentre = true;
    this.onChange?.();
    return true;
  }

  /** Stop head tracking but keep the device open for display commands. */
  async disconnect() {
    if (!this.device) return;
    // The IMU stream outlives the page unless it is stopped explicitly.
    await this._send(CMD.IMU_OFF).catch(() => {});
    this.connected = false;
    this.onChange?.();
  }

  async close() {
    const device = this.device;
    if (!device) return;
    if (this.connected) await this._send(CMD.IMU_OFF).catch(() => {});
    await device.close().catch(() => {});
    this._reset();
  }

  /**
   * Ask the glasses to switch their panels between 3D (3840x1080 side-by-side) and 2D.
   * Uses the 0x06 / 0x07 display commands known from the RayNeo Air firmware family; whether
   * GT Max firmware honours them is unverified, so callers should check the screen afterwards.
   */
  async setDisplay3D(on) {
    if (!(await this.open())) return false;
    await this._send(on ? CMD.DISPLAY_3D : CMD.DISPLAY_2D);
    return true;
  }

  /** Escape hatch for experimenting with other commands from the console. */
  async sendRaw(cmd, value = 0) {
    if (cmd === 0x66) throw new Error('0x66 reboots the glasses into firmware-update mode; refusing.');
    if (!(await this.open())) return false;
    await this._send(cmd, value);
    return true;
  }

  /** Make the current head pose the "looking straight at the model" pose. */
  recentre() {
    this._needsRecentre = true;
  }

  /**
   * Head rotation since the last recentre, in camera axes (X right, Y up, -Z forward).
   *
   * Worked out in the gravity-aligned world frame rather than the IMU's own frame, so it does
   * not depend on how the IMU board is tilted inside the glasses: turning the head left/right
   * is always a rotation about true vertical, and so always a pan. The view is taken to be
   * level and facing along the IMU's forward heading at the moment of recentring.
   */
  getRotation(out) {
    if (!this.connected || this.samples < 20) return out.identity();
    const { v, heading, refInv } = this._tmp;
    if (this._needsRecentre) {
      this._needsRecentre = false;
      refInv.copy(this._q).invert();
      v.set(0, 0, -1).applyQuaternion(this._q);
      heading.setFromAxisAngle(UP, Math.hypot(v.x, v.z) > 1e-3 ? Math.atan2(-v.x, -v.z) : 0);
    }
    // world-frame delta (q * ref^-1), re-expressed in the view frame at recentre
    return out.copy(heading).invert().multiply(this._q).multiply(refInv).multiply(heading);
  }

  _reset() {
    this.device?.removeEventListener('inputreport', this._onReport);
    navigator.hid?.removeEventListener('disconnect', this._onDisconnect);
    this.device = null;
    this.connected = false;
    this.onChange?.();
  }

  _send(cmd, value = 0) {
    const frame = new Uint8Array(64);
    frame[0] = 0x66;
    frame[1] = cmd;
    frame[2] = value;
    return this.device.sendReport(0, frame);
  }

  _handle(event) {
    let view = event.data;
    // Some stacks keep a leading zero report id in the payload.
    if (view.byteLength >= 65 && view.getUint8(0) === 0x00) {
      view = new DataView(view.buffer, view.byteOffset + 1, view.byteLength - 1);
    }
    if (view.byteLength < 56 || view.getUint8(0) !== 0x99 || view.getUint8(1) !== 0x65) return;

    const f = (o) => view.getFloat32(o, true);
    const ax = f(4), ay = f(8), az = f(12);
    const gx = f(16), gy = f(20), gz = f(24);
    if (![ax, ay, az, gx, gy, gz].every(Number.isFinite)) return;

    const tick = view.getUint32(40, true);
    const last = this._lastTick;
    this._lastTick = tick;
    if (last === null) return;
    const dt = (((tick - last) >>> 0) * 100e-6);
    if (dt <= 0 || dt > 0.1) return;

    const { w, a, v, e, dq, qi } = this._tmp;
    // Sensor frame -> three.js frame.
    w.set(-gy, gz, -gx).multiplyScalar(DEG);
    a.set(-ay, az, -ax);
    const accelMag = a.length();
    if (accelMag < 1e-3) return;

    // Learn gyro bias while the head is still, otherwise yaw creeps.
    const still = w.distanceTo(this._bias) < 2.5 * DEG && Math.abs(accelMag - 9.81) < 0.6;
    if (still) this._bias.lerp(w, 0.0005);
    w.sub(this._bias);

    // Mahony-style tilt correction from gravity; stronger while converging at start-up.
    a.multiplyScalar(1 / accelMag);
    v.copy(UP).applyQuaternion(qi.copy(this._q).invert());
    e.crossVectors(a, v);
    const kp = this.samples < 400 ? 8 : 0.4;
    w.addScaledVector(e, kp);

    const angle = w.length() * dt;
    if (angle > 1e-9) {
      dq.setFromAxisAngle(w.normalize(), angle);
      this._q.multiply(dq).normalize();
    }
    this.samples++;
  }
}
