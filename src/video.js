// 3D video playback.
//
//   FileVideo    — a <video> element (local file or direct URL) used as a texture. Each eye
//                  samples its own part of the frame, so every layout / projection works and
//                  the picture can sit on the head-tracked pinned screen.
//   YouTubeVideo — the official YouTube embed. Its pixels can't be read, so it is positioned
//                  and stretched with CSS so the side-by-side frame lines up with the eyes;
//                  head tracking slides the whole frame or turns a 360 video's view.
import * as THREE from 'three';

export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'];

export const isVideoName = (name) =>
  VIDEO_EXTS.includes((/\.([a-z0-9]+)$/i.exec(String(name).split(/[?#]/)[0])?.[1] || '').toLowerCase());

// How the two eyes are packed into one frame.
//   half = each eye is squeezed to half resolution along the packing axis.
export const FORMATS = {
  sbs: { label: 'Side-by-side (full width)', pack: 'sbs', half: false },
  hsbs: { label: 'Side-by-side (half width)', pack: 'sbs', half: true },
  tb: { label: 'Top-bottom (full height)', pack: 'tb', half: false },
  htb: { label: 'Top-bottom (half height)', pack: 'tb', half: true },
  '2d': { label: '2D (not 3D)', pack: 'mono', half: false },
};

export const PROJECTIONS = {
  flat: 'Flat screen',
  180: 'VR180 (equirectangular)',
  360: 'VR360 (equirectangular)',
};

/** YouTube video id (and start time) from any of the usual link shapes. */
export function youTubeId(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:embed|shorts|live|v)\/([^/?]+)/.exec(url.pathname)?.[1] || null;
  }
  if (!id || !/^[\w-]{6,}$/.test(id)) return null;
  const t = url.searchParams.get('t') || url.searchParams.get('start') || '';
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  const start = m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  return { id, start };
}

/**
 * Guess packing and projection from the conventional file-name tags (SBS, HSBS, LR, TB, OU,
 * 3DH, 3DV, 180, 360 …) and the frame shape. Untagged files are assumed side-by-side, since
 * that is what this viewer is for; the user can change it in the panel.
 */
export function guessFormat(name, width = 0, height = 0) {
  const n = ` ${String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const has = (...words) => words.some((w) => n.includes(` ${w} `));
  const aspect = width && height ? width / height : 0;

  let projection = 'flat';
  if (has('360', 'vr360') || /\b360\s?(vr|3d|°)|\bvr\s?360/.test(n)) projection = '360';
  else if (has('180', 'vr180', '180x180') || /\b180\s?(vr|3d)|\bvr\s?180/.test(n)) projection = '180';

  let pack = '';
  if (has('sbs', 'hsbs', 'fsbs', 'lr', 'rl', '3dh', 'lrf', 'sidebyside') || /half sbs|full sbs|side by side/.test(n)) pack = 'sbs';
  else if (has('tb', 'htb', 'ou', 'hou', 'tab', 'htab', '3dv', 'topbottom', 'overunder') || /top (and )?bottom|over under/.test(n)) pack = 'tb';
  else if (has('2d', 'mono')) pack = 'mono';
  else if (aspect && aspect < 1.1 && projection === 'flat') pack = 'tb';
  else if (projection === '360' && aspect && aspect < 1.5) pack = 'tb'; // 360 3D is usually over-under
  else pack = 'sbs';

  if (pack === 'mono') return { format: '2d', projection };
  let half;
  if (has('hsbs', 'htb', 'hou', 'htab') || /half (sbs|tb|ou)/.test(n)) half = true;
  else if (has('fsbs') || /full (sbs|tb|ou)/.test(n)) half = false;
  else if (!aspect) half = true;
  else half = pack === 'sbs' ? aspect <= 2.5 : aspect >= 1.2;
  return { format: (half ? 'h' : '') + pack, projection };
}

/** Shape of one eye's picture once unpacked. */
export function eyeAspect(format, width, height) {
  const { pack, half } = FORMATS[format];
  if (!width || !height) return 16 / 9;
  if (pack === 'sbs' && !half) return width / 2 / height;
  if (pack === 'tb' && !half) return width / (height / 2);
  return width / height;
}

/** Point a texture at one eye's part of the frame (eye 0 = left, 1 = right). */
export function setEyeUV(texture, format, eye) {
  const { pack } = FORMATS[format];
  if (pack === 'sbs') {
    texture.repeat.set(0.5, 1);
    texture.offset.set(eye * 0.5, 0);
  } else if (pack === 'tb') {
    // Left eye on top by convention; v runs upward.
    texture.repeat.set(1, 0.5);
    texture.offset.set(0, eye === 0 ? 0.5 : 0);
  } else {
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
  }
}

/** Inside of a sphere section, mapped equirectangularly, centred on straight ahead (-Z). */
export function createDome(spanDegrees) {
  const span = THREE.MathUtils.degToRad(spanDegrees);
  const cols = spanDegrees > 180 ? 96 : 64;
  const rows = 48;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    const lat = (v - 0.5) * Math.PI;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const lon = (u - 0.5) * span;
      positions.push(Math.sin(lon) * Math.cos(lat) * 10, Math.sin(lat) * 10, -Math.cos(lon) * Math.cos(lat) * 10);
      uvs.push(u, v);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      indices.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

const DECODE_HELP =
  'This browser cannot play that video. H.264 / HEVC in MP4 or MOV and VP9 / AV1 in WebM or MKV usually work in Chrome; AVI, WMV and Apple spatial (MV-HEVC) video do not — convert those to side-by-side MP4 first.';

export class FileVideo {
  constructor() {
    this.kind = 'video';
    this.el = document.createElement('video');
    this.el.playsInline = true;
    this.el.preload = 'auto';
    this.texture = new THREE.VideoTexture(this.el);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.title = '';
    this._blobUrl = null;
  }

  /** src: a File or a URL string. */
  load(src, { crossOrigin = false, title = '' } = {}) {
    const el = this.el;
    if (typeof src !== 'string') {
      this._blobUrl = URL.createObjectURL(src);
      this.title = src.name;
      src = this._blobUrl;
    } else {
      this.title = title || decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() || 'video');
    }
    if (crossOrigin) el.crossOrigin = 'anonymous';
    else el.removeAttribute('crossorigin');
    return new Promise((resolve, reject) => {
      const done = (fn, value) => {
        el.removeEventListener('loadedmetadata', ok);
        el.removeEventListener('error', fail);
        fn(value);
      };
      const ok = () => (el.videoWidth
        ? done(resolve, this)
        : done(reject, new Error('That file has no video track this browser can decode (audio only?).')));
      const fail = () => done(reject, new Error(
        el.error?.code === 2 ? 'The video could not be downloaded.' : DECODE_HELP,
      ));
      el.addEventListener('loadedmetadata', ok);
      el.addEventListener('error', fail);
      el.src = src;
      el.load();
    });
  }

  get width() { return this.el.videoWidth; }
  get height() { return this.el.videoHeight; }
  get duration() { return Number.isFinite(this.el.duration) ? this.el.duration : 0; }
  get time() { return this.el.currentTime; }
  get playing() { return !this.el.paused && !this.el.ended; }
  get muted() { return this.el.muted; }
  play() { return this.el.play(); }
  pause() { this.el.pause(); }
  seek(t) { this.el.currentTime = Math.max(0, Math.min(this.duration || t, t)); }
  setMuted(on) { this.el.muted = on; }

  dispose() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.texture.dispose();
    if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
  }
}

let youTubeApi = null;
function loadYouTubeApi() {
  youTubeApi ||= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { youTubeApi = null; reject(new Error('Could not reach YouTube.')); };
    document.head.append(script);
  });
  return youTubeApi;
}

const YT_ERRORS = {
  2: 'YouTube did not recognise that video link.',
  5: 'YouTube could not play that video here.',
  100: 'That YouTube video is private or has been removed.',
  101: 'The owner of that YouTube video does not allow it to be played on other sites.',
  150: 'The owner of that YouTube video does not allow it to be played on other sites.',
};

export class YouTubeVideo {
  /** container: an element that fills the window, sits above the canvas and clips its content. */
  constructor(container) {
    this.kind = 'youtube';
    this.container = container;
    this.player = null;
    this.title = 'YouTube video';
    this.width = 0;
    this.height = 0;
    this._state = -1;
    this._mask = null;
    this._pin = '';
    this._look = '';
  }

  async load({ id, start = 0 }) {
    const YT = await loadYouTubeApi();
    const mount = document.createElement('div');
    // Black bar over the seam between the eyes, so a shifted frame can't leak into the other eye.
    this._mask = document.createElement('div');
    Object.assign(this._mask.style, { position: 'absolute', top: '0', height: '100%', background: '#000', display: 'none' });
    this.container.replaceChildren(mount, this._mask);
    this.container.hidden = false;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('YouTube took too long to respond.')), 20000);
      this.player = new YT.Player(mount, {
        videoId: id,
        width: '100%',
        height: '100%',
        // The player's own controls would be stretched and split across the eyes, so they are
        // off; playback is driven from the viewer's panel instead.
        playerVars: {
          autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1,
          rel: 0, start: start || undefined, origin: location.origin,
        },
        events: {
          onReady: () => { clearTimeout(timeout); resolve(); },
          onError: (e) => {
            clearTimeout(timeout);
            const error = new Error(YT_ERRORS[e.data] || `YouTube error ${e.data}.`);
            this.onError?.(error);
            reject(error);
          },
          onStateChange: (e) => { this._state = e.data; },
        },
      });
    });
    this.setQuality('default');
    this.title = this.player.getVideoData?.().title || this.title;
    return this;
  }

  get duration() { return this.player?.getDuration?.() || 0; }
  get time() { return this.player?.getCurrentTime?.() || 0; }
  get playing() { return this._state === 1 || this._state === 3; }
  get muted() { return !!this.player?.isMuted?.(); }
  play() { this.player?.playVideo(); return Promise.resolve(); }
  pause() { this.player?.pauseVideo(); }
  seek(t) { this.player?.seekTo(t, true); }
  setMuted(on) { if (on) this.player?.mute(); else this.player?.unMute(); }
  setQuality(quality) { this.player?.setPlaybackQuality?.(quality || 'default'); }

  /** True for 360 videos, whose view direction the embed lets us set. */
  get spherical() {
    try { return Object.keys(this.player?.getSphericalProperties?.() || {}).length > 0; } catch { return false; }
  }

  /** Turn a 360 video's view: yaw to the left and pitch upward, in degrees. */
  look(yaw, pitch) {
    const key = `${yaw.toFixed(1)},${pitch.toFixed(1)}`;
    if (key === this._look) return;
    this._look = key;
    this.player?.setSphericalProperties?.({
      yaw: ((yaw % 360) + 360) % 360,
      pitch: Math.max(-90, Math.min(90, pitch)),
      enableOrientationSensor: false,
    });
  }

  /**
   * Slide the frame by (dx, dy) CSS pixels, for the head-tracked pinned screen. Both eyes live
   * in one element, so it can only be moved as a whole: no resizing, no roll.
   */
  pin(dx, dy) {
    const iframe = this.player?.getIframe?.();
    if (!iframe) return;
    const { format, appLayout, width } = this._layout || {};
    const sbs = format && FORMATS[format].pack === 'sbs';
    // A frame that spans both eyes without being side-by-side can't be moved consistently.
    if (!sbs && appLayout !== 'mono') dx = dy = 0;
    dx = Math.round(dx * 2) / 2;
    dy = Math.round(dy * 2) / 2;
    const key = `${dx},${dy}`;
    if (key === this._pin) return;
    this._pin = key;
    iframe.style.translate = `${dx}px ${dy}px`;
    const seam = appLayout === 'mono' ? width : width / 2;
    Object.assign(this._mask.style, {
      display: sbs && dx ? 'block' : 'none',
      left: `${seam + Math.min(0, dx)}px`,
      width: `${Math.min(Math.abs(dx), seam)}px`,
    });
  }

  /**
   * Size and stretch the embed so the frame's left half covers the left eye's region.
   * `format` is the video's packing; `appLayout` is how the display expects its input.
   */
  layout(format, appLayout, width, height) {
    const iframe = this.player?.getIframe?.();
    if (!iframe) return;
    this._layout = { format, appLayout, width };
    this._pin = ''; // re-apply the head-tracking offset against the new layout
    if (FORMATS[format].pack !== 'sbs') {
      // Not side-by-side: nothing to line up with the eyes, show the frame as it is.
      Object.assign(iframe.style, {
        position: 'absolute', left: '0', top: '0', border: '0',
        width: `${width}px`, height: `${height}px`, transform: 'none',
      });
      return;
    }
    // 2x when the frame's halves are squeezed, undone again if the display stretches halves itself.
    const stretch = (FORMATS[format].pack === 'sbs' && !FORMATS[format].half ? 1 : 2) / (appLayout === 'hsbs' ? 2 : 1);
    // On a 2D display only the left-eye half is shown: lay out double width and let it clip.
    const region = appLayout === 'mono' ? width * 2 : width;
    Object.assign(iframe.style, {
      position: 'absolute', left: '0', top: '0', border: '0',
      width: `${region / stretch}px`, height: `${height}px`,
      transformOrigin: '0 0', transform: `scaleX(${stretch})`,
    });
  }

  dispose() {
    try { this.player?.destroy(); } catch { /* already gone */ }
    this.player = null;
    this.container.replaceChildren();
    this.container.hidden = true;
  }
}
