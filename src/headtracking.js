// Experimental 3DoF head tracking over WebHID. The viewer itself works with any glasses that
// have a side-by-side 3D mode; this optional part reads the IMU of specific glasses over USB.
// Each vendor speaks its own protocol, described by one entry in PROTOCOLS below. To support
// more glasses, add an entry: its USB ids, how to start / stop the IMU stream, and how to turn
// one input report into a gyro + accelerometer sample.
//
// None of these vendors publish a web SDK. The wire formats follow community reverse-engineering:
//   RayNeo — HaloneXR/halone (GT Max) and verncat/RayNeo-Air-3S-Pro-OpenVR (Air 3S Pro, Air 4 Pro, GT)
//   XREAL Air / Rokid — badicsalex/ar-drivers-rs (after thejackimonster/nrealAirLinuxDriver)
// Only the RayNeo GT path has been used on hardware here; the others are unverified.
//
// Not covered: VITURE (IMU access only through the vendor's closed SDK) and XREAL One / One Pro
// (they stream the IMU over a network socket on the USB link, which a web page cannot open).
//
// All samples are converted to three.js axes: X right, Y up, Z backwards; gyro in rad/s,
// accelerometer in m/s^2 reading +9.81 on Y when the glasses are level.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const G = 9.81;
const UP = new THREE.Vector3(0, 1, 0);

// --- Protocol helpers ------------------------------------------------------------------------

const view = (bytes, offset = 0) => new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
const int24 = (b, o) => ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8) >> 8;
const nsBetween = (a, b) => Number(b - a) * 1e-9; // two BigInt nanosecond timestamps -> seconds

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --- RayNeo (GT / GT Max, Air 3S Pro, Air 4 Pro) -----------------------------------------------
//   command  : 64 bytes, 66 <cmd> <value> 00...
//   IMU frame: 64 bytes, 99 65 .., float32 LE: accel xyz @4 (m/s^2), gyro xyz @16 (deg/s), tick u32 @40 (100us)
//   sensor frame: +X forward, +Y left, +Z up  ->  three.js: X = -sY, Y = +sZ, Z = -sX
const RAYNEO_CMD = { INFO: 0x00, IMU_ON: 0x01, IMU_OFF: 0x02, DISPLAY_3D: 0x06, DISPLAY_2D: 0x07, ANCHOR: 0x08 };
const rayneoCommand = (cmd, value = 0) => {
  const frame = new Uint8Array(64);
  frame[0] = 0x66;
  frame[1] = cmd;
  frame[2] = value;
  return frame;
};

const RAYNEO = {
  name: 'RayNeo',
  ids: [
    [0x3941, 0xaf50], // GT, GT Max
    [0x1bbb, 0xaf50], // Air 3S Pro, Air 4 Pro (and other Air models sharing the id)
  ],
  async start(send) {
    await send(rayneoCommand(RAYNEO_CMD.IMU_OFF)).catch(() => {});
    await send(rayneoCommand(RAYNEO_CMD.INFO)).catch(() => {});
    // "Follow" mode, so the glasses' own 3DoF anchoring doesn't counter-rotate the image.
    await send(rayneoCommand(RAYNEO_CMD.ANCHOR, 0x00));
    await send(rayneoCommand(RAYNEO_CMD.IMU_ON));
  },
  stop: (send) => send(rayneoCommand(RAYNEO_CMD.IMU_OFF)),
  // Display commands known from the RayNeo Air firmware family; GT Max firmware may ignore them.
  display3D: (on) => rayneoCommand(on ? RAYNEO_CMD.DISPLAY_3D : RAYNEO_CMD.DISPLAY_2D),
  parse(bytes, ctx) {
    // Some stacks keep a leading zero report id in the payload.
    const o = bytes.length >= 65 && bytes[0] === 0x00 ? 1 : 0;
    if (bytes.length - o < 56 || bytes[o] !== 0x99 || bytes[o + 1] !== 0x65) return null;
    const v = view(bytes, o);
    const f = (off) => v.getFloat32(off, true);
    const ax = f(4), ay = f(8), az = f(12);
    const gx = f(16), gy = f(20), gz = f(24);
    const tick = v.getUint32(40, true);
    const last = ctx.tick;
    ctx.tick = tick;
    if (last === undefined) return null;
    return {
      w: [-gy * DEG, gz * DEG, -gx * DEG],
      a: [-ay, az, -ax],
      dt: ((tick - last) >>> 0) * 100e-6,
    };
  },
};

// --- XREAL Air, Air 2, Air 2 Pro, Air 2 Ultra --------------------------------------------------
//   IMU command: aa <crc32 LE> <len u16 LE> <cmd> <data…>, crc over the bytes from `len` on;
//                0x19 [1] / [0] starts / stops the IMU stream.
//   IMU report : 01 02 .., timestamp u64 @4 (ns), gyro mul u16 @12, div u32 @14, xyz int24 @18,
//                accel mul u16 @27, div u32 @29, xyz int24 @33. Gyro in deg/s, accel in g.
//   Axes as in ar-drivers-rs: right = -x, up = z, back = y.
function xrealImuCommand(cmd, data = []) {
  const frame = new Uint8Array(64);
  const length = data.length + 3;
  frame[0] = 0xaa;
  frame[5] = length & 0xff;
  frame[6] = length >> 8;
  frame[7] = cmd;
  frame.set(data, 8);
  view(frame).setUint32(1, crc32(frame.subarray(5, 5 + length)), true);
  return frame;
}

const XREAL = {
  name: 'XREAL',
  ids: [
    [0x3318, 0x0424], // Air
    [0x3318, 0x0428], // Air 2
    [0x3318, 0x0432], // Air 2 Pro
    [0x3318, 0x0426], // Air 2 Ultra
  ],
  start: (send) => send(xrealImuCommand(0x19, [0x01])),
  stop: (send) => send(xrealImuCommand(0x19, [0x00])),
  parse(bytes, ctx) {
    if (bytes.length < 42 || bytes[0] !== 0x01 || bytes[1] !== 0x02) return null;
    const v = view(bytes);
    const gyroDiv = v.getUint32(14, true);
    const accDiv = v.getUint32(29, true);
    if (!gyroDiv || !accDiv) return null;
    const kg = (v.getUint16(12, true) / gyroDiv) * DEG;
    const ka = (v.getUint16(27, true) / accDiv) * G;
    const time = v.getBigUint64(4, true);
    const last = ctx.time;
    ctx.time = time;
    if (last === undefined) return null;
    return {
      w: [-int24(bytes, 18) * kg, int24(bytes, 24) * kg, int24(bytes, 21) * kg],
      a: [-int24(bytes, 33) * ka, int24(bytes, 39) * ka, int24(bytes, 36) * ka],
      dt: nsBetween(last, time),
    };
  },
};

// --- Rokid Air, Max (and the ids the Rokid SDK lists for later models) -------------------------
// Streams on its own; no start command. Report id = packet type:
//   17: combined — timestamp u64 @1 (ns), accel f32 xyz @9 (m/s^2), gyro f32 xyz @21 (rad/s)
//    4: one sensor — sensor type @1 (1 accel, 2 gyro), timestamp u64 @9, f32 xyz @21
// Axes already right / up / back.
const ROKID = {
  name: 'Rokid',
  ids: [0x162b, 0x162c, 0x162d, 0x162e, 0x162f, 0x2002, 0x2180].map((pid) => [0x04d2, pid]),
  start: async () => {},
  stop: async () => {},
  parse(bytes, ctx, event) {
    const v = view(bytes);
    const vec = (off) => [v.getFloat32(off, true), v.getFloat32(off + 4, true), v.getFloat32(off + 8, true)];
    if (bytes[0] === 17 && bytes.length >= 33) {
      const time = v.getBigUint64(1, true);
      const last = ctx.time;
      ctx.time = time;
      if (last === undefined) return null;
      return { a: vec(9), w: vec(21), dt: nsBetween(last, time) };
    }
    if (bytes[0] === 4 && bytes.length >= 33) {
      const time = v.getBigUint64(9, true);
      if (bytes[1] === 1) ctx.acc = { time, a: vec(21) };
      else if (bytes[1] === 2) ctx.gyro = { time, w: vec(21) };
      if (!ctx.acc || !ctx.gyro || ctx.acc.time !== ctx.gyro.time) return null;
      const sample = { a: ctx.acc.a, w: ctx.gyro.w };
      ctx.acc = ctx.gyro = null;
      // This packet's timestamp unit is not documented; pace it by the host clock instead.
      const last = ctx.host;
      ctx.host = event.timeStamp;
      if (last === undefined) return null;
      return { ...sample, dt: (event.timeStamp - last) / 1000 };
    }
    return null;
  },
};

const PROTOCOLS = [RAYNEO, XREAL, ROKID];
const FILTERS = PROTOCOLS.flatMap((p) => p.ids.map(([vendorId, productId]) => ({ vendorId, productId })));
const protocolFor = (device) =>
  PROTOCOLS.find((p) => p.ids.some(([vid, pid]) => vid === device.vendorId && pid === device.productId));

// Rebuild the report the way hidapi on Linux returns it: a numbered report's id byte first.
function reportBytes(event) {
  const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
  if (!event.reportId) return data;
  const bytes = new Uint8Array(data.length + 1);
  bytes[0] = event.reportId;
  bytes.set(data, 1);
  return bytes;
}

export class HeadTracker {
  constructor({ onChange } = {}) {
    this.onChange = onChange;
    this.devices = []; // every HID interface of the glasses (some send IMU data, some take commands)
    this.protocol = null;
    this.connected = false;
    this.samples = 0;

    this._q = new THREE.Quaternion(); // IMU body -> world
    this._bias = new THREE.Vector3();
    this._ctx = {}; // per-protocol parser state (last timestamp, half-received samples)
    this._needsRecentre = true;
    this._onReport = (e) => this._handle(e);
    this._onDisconnect = (e) => { if (this.devices.includes(e.device)) this._reset(); };
    this._tmp = {
      w: new THREE.Vector3(), a: new THREE.Vector3(), v: new THREE.Vector3(),
      e: new THREE.Vector3(), dq: new THREE.Quaternion(), qi: new THREE.Quaternion(),
      heading: new THREE.Quaternion(), refInv: new THREE.Quaternion(),
    };
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  /** Name of the connected glasses, e.g. "XREAL Air 2". */
  get deviceName() {
    return this.devices[0]?.productName || this.protocol?.name || '';
  }

  /** Open the glasses' HID interfaces. Reuses previously granted glasses silently. */
  async open() {
    if (this.devices.length && this.devices.some((d) => d.opened)) return true;
    if (!HeadTracker.supported) {
      throw new Error('WebHID is not available. Use Chrome or Edge on a computer, over https or localhost.');
    }
    let granted = (await navigator.hid.getDevices()).filter(protocolFor);
    if (!granted.length) granted = await navigator.hid.requestDevice({ filters: FILTERS });
    granted = granted.filter(protocolFor);
    if (!granted.length) return false; // picker dismissed
    // One pair of glasses can show up as several HID interfaces; keep all of the first one's.
    const [first] = granted;
    const devices = granted.filter((d) => d.vendorId === first.vendorId && d.productId === first.productId);
    const errors = [];
    for (const device of devices) {
      try {
        if (!device.opened) await device.open();
      } catch (err) {
        errors.push(err.message);
      }
    }
    const opened = devices.filter((d) => d.opened);
    if (!opened.length) {
      throw new Error(
        `Could not open the glasses (${errors[0] || 'unknown error'}). On Linux, add the udev rule from the README; otherwise close other apps using them.`,
      );
    }
    this.protocol = protocolFor(first);
    this.devices = opened;
    for (const device of opened) device.addEventListener('inputreport', this._onReport);
    navigator.hid.addEventListener('disconnect', this._onDisconnect);
    return true;
  }

  /** Start head tracking. */
  async connect() {
    if (!(await this.open())) return false;
    this._ctx = {};
    this.samples = 0;
    this._q.identity();
    this._bias.set(0, 0, 0);
    this._needsRecentre = true;
    await this.protocol.start((frame) => this._send(frame));
    this.connected = true;
    this.onChange?.();
    return true;
  }

  /** Stop head tracking but keep the device open for display commands. */
  async disconnect() {
    if (!this.devices.length) return;
    // The IMU stream outlives the page unless it is stopped explicitly.
    await this.protocol.stop((frame) => this._send(frame)).catch(() => {});
    this.connected = false;
    this.onChange?.();
  }

  async close() {
    const devices = this.devices;
    if (!devices.length) return;
    if (this.connected) await this.protocol.stop((frame) => this._send(frame)).catch(() => {});
    await Promise.all(devices.map((d) => d.close().catch(() => {})));
    this._reset();
  }

  /**
   * Ask the glasses to switch their panels between 3D (side-by-side) and 2D. Only RayNeo has a
   * known command; callers should check the screen afterwards, as the firmware may ignore it.
   */
  async setDisplay3D(on) {
    if (!(await this.open())) return false;
    if (!this.protocol.display3D) {
      throw new Error(`Switching 3D mode from the page is not supported on ${this.deviceName}. Use the glasses' own button or menu.`);
    }
    await this._send(this.protocol.display3D(on));
    return true;
  }

  /** Escape hatch for experimenting with RayNeo commands from the console. */
  async sendRaw(cmd, value = 0) {
    if (cmd === 0x66) throw new Error('0x66 reboots the glasses into firmware-update mode; refusing.');
    if (!(await this.open())) return false;
    if (this.protocol !== RAYNEO) throw new Error('sendRaw speaks the RayNeo protocol only.');
    await this._send(rayneoCommand(cmd, value));
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
    for (const device of this.devices) device.removeEventListener('inputreport', this._onReport);
    navigator.hid?.removeEventListener('disconnect', this._onDisconnect);
    this.devices = [];
    this.protocol = null;
    this.connected = false;
    this.onChange?.();
  }

  /**
   * Send a 64-byte output report. It goes to every interface that takes output reports; the
   * glasses ignore commands meant for another interface. Succeeds if any interface accepted it.
   */
  async _send(frame) {
    const takesOutput = (d) => d.collections?.some((c) => c.outputReports?.length);
    const targets = this.devices.filter(takesOutput);
    const results = await Promise.allSettled((targets.length ? targets : this.devices).map((d) => d.sendReport(0, frame)));
    const ok = results.some((r) => r.status === 'fulfilled');
    if (!ok) throw results.find((r) => r.status === 'rejected')?.reason || new Error('No interface accepted the command.');
  }

  _handle(event) {
    if (!this.protocol) return;
    const sample = this.protocol.parse(reportBytes(event), this._ctx, event);
    if (sample) this._integrate(sample);
  }

  _integrate({ w: gyro, a: accel, dt }) {
    if (!(dt > 0 && dt <= 0.1)) return;
    if (![...gyro, ...accel].every(Number.isFinite)) return;
    const { w, a, v, e, dq, qi } = this._tmp;
    w.fromArray(gyro);
    a.fromArray(accel);
    const accelMag = a.length();
    if (accelMag < 1e-3) return;

    // Learn gyro bias while the head is still, otherwise yaw creeps.
    const still = w.distanceTo(this._bias) < 2.5 * DEG && Math.abs(accelMag - G) < 0.6;
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
