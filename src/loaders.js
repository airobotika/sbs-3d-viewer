import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import { VIDEO_EXTS } from './video.js';

// ---------------------------------------------------------------------------
// Format tables
// ---------------------------------------------------------------------------

// Gaussian splat containers handled by Spark. `.ply` and `.zip` are decided by sniffing.
const SPLAT_EXTS = new Set(['spz', 'splat', 'ksplat', 'sog', 'rad']);

const defaultMaterial = () =>
  new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.65, metalness: 0.05 });

function meshFromGeometry(geometry) {
  const hasColor = geometry.hasAttribute('color');
  const hasFaces = geometry.index !== null || !geometry.userData.pointCloud;
  if (!hasFaces) return pointsFromGeometry(geometry);
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
  const material = defaultMaterial();
  if (hasColor) { material.vertexColors = true; material.color.set(0xffffff); }
  material.side = THREE.DoubleSide;
  return new THREE.Mesh(geometry, material);
}

function pointsFromGeometry(geometry) {
  geometry.computeBoundingSphere();
  const size = (geometry.boundingSphere?.radius || 1) / 400;
  const material = new THREE.PointsMaterial({ size, sizeAttenuation: true });
  if (geometry.hasAttribute('color')) material.vertexColors = true;
  else material.color.set(0xd0d4da);
  return new THREE.Points(geometry, material);
}

// Each entry: async (url, manager, ctx) => { object, animations? }
const MESH_LOADERS = {
  async gltf(url, manager, ctx) {
    const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/DRACOLoader.js'),
      import('three/addons/loaders/KTX2Loader.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
    ]);
    const draco = new DRACOLoader(manager).setDecoderPath('/libs/draco/');
    const ktx2 = new KTX2Loader(manager).setTranscoderPath('/libs/basis/').detectSupport(ctx.renderer);
    try {
      const gltf = await new GLTFLoader(manager)
        .setDRACOLoader(draco)
        .setKTX2Loader(ktx2)
        .setMeshoptDecoder(MeshoptDecoder)
        .loadAsync(url, ctx.onProgress);
      return { object: gltf.scene || gltf.scenes[0], animations: gltf.animations };
    } finally {
      draco.dispose();
      ktx2.dispose();
    }
  },
  async obj(url, manager, ctx) {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    const loader = new OBJLoader(manager);
    // Honour `mtllib` if the material file is reachable (uploaded alongside, or next to the URL).
    const text = await (await fetch(url)).text();
    const mtl = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (mtl) {
      try {
        const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
        const base = THREE.LoaderUtils.extractUrlBase(url);
        const materials = await new MTLLoader(manager).setResourcePath(base).loadAsync(base + mtl);
        materials.preload();
        loader.setMaterials(materials);
      } catch {
        ctx.onNote?.(`Material file "${mtl}" not found — showing the OBJ without materials.`);
      }
    }
    return { object: loader.parse(text) };
  },
  async fbx(url, manager, ctx) {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    const object = await new FBXLoader(manager).loadAsync(url, ctx.onProgress);
    return { object, animations: object.animations };
  },
  async stl(url, manager, ctx) {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
    return { object: meshFromGeometry(await new STLLoader(manager).loadAsync(url, ctx.onProgress)) };
  },
  async ply(url, manager, ctx) {
    const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
    const geometry = await new PLYLoader(manager).loadAsync(url, ctx.onProgress);
    if (geometry.index === null) geometry.userData.pointCloud = true;
    return { object: meshFromGeometry(geometry) };
  },
  async dae(url, manager, ctx) {
    const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
    const result = await new ColladaLoader(manager).loadAsync(url, ctx.onProgress);
    return { object: result.scene, animations: result.animations || result.scene.animations };
  },
  async '3mf'(url, manager, ctx) {
    const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
    return { object: await new ThreeMFLoader(manager).loadAsync(url, ctx.onProgress) };
  },
  async usd(url, manager, ctx) {
    const { USDLoader } = await import('three/addons/loaders/USDLoader.js');
    const object = await new USDLoader(manager).loadAsync(url, ctx.onProgress);
    return { object, animations: object.animations };
  },
  async '3ds'(url, manager, ctx) {
    const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js');
    return { object: await new TDSLoader(manager).loadAsync(url, ctx.onProgress) };
  },
  async amf(url, manager, ctx) {
    const { AMFLoader } = await import('three/addons/loaders/AMFLoader.js');
    return { object: await new AMFLoader(manager).loadAsync(url, ctx.onProgress) };
  },
  async wrl(url, manager, ctx) {
    const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js');
    return { object: await new VRMLLoader(manager).loadAsync(url, ctx.onProgress) };
  },
  async pcd(url, manager, ctx) {
    const { PCDLoader } = await import('three/addons/loaders/PCDLoader.js');
    const points = await new PCDLoader(manager).loadAsync(url, ctx.onProgress);
    return { object: pointsFromGeometry(points.geometry) };
  },
  async xyz(url, manager, ctx) {
    const { XYZLoader } = await import('three/addons/loaders/XYZLoader.js');
    return { object: pointsFromGeometry(await new XYZLoader(manager).loadAsync(url, ctx.onProgress)) };
  },
  async vtk(url, manager, ctx) {
    const { VTKLoader } = await import('three/addons/loaders/VTKLoader.js');
    return { object: meshFromGeometry(await new VTKLoader(manager).loadAsync(url, ctx.onProgress)) };
  },
  async gcode(url, manager, ctx) {
    const { GCodeLoader } = await import('three/addons/loaders/GCodeLoader.js');
    return { object: await new GCodeLoader(manager).loadAsync(url, ctx.onProgress) };
  },
  async '3dm'(url, manager, ctx) {
    const { Rhino3dmLoader } = await import('three/addons/loaders/3DMLoader.js');
    const loader = new Rhino3dmLoader(manager).setLibraryPath('https://cdn.jsdelivr.net/npm/rhino3dm@8.4.0/');
    try {
      return { object: await loader.loadAsync(url, ctx.onProgress) };
    } finally {
      loader.dispose();
    }
  },
  async kmz(url, manager, ctx) {
    const { KMZLoader } = await import('three/addons/loaders/KMZLoader.js');
    return { object: (await new KMZLoader(manager).loadAsync(url, ctx.onProgress)).scene };
  },
  async vox(url, manager, ctx) {
    const { VOXLoader, VOXMesh } = await import('three/addons/loaders/VOXLoader.js');
    const result = await new VOXLoader(manager).loadAsync(url, ctx.onProgress);
    if (result.scene) return { object: result.scene };
    const group = new THREE.Group();
    for (const chunk of result.chunks || result) group.add(new VOXMesh(chunk));
    return { object: group };
  },
  async lwo(url, manager, ctx) {
    const { LWOLoader } = await import('three/addons/loaders/LWOLoader.js');
    const result = await new LWOLoader(manager).loadAsync(url, ctx.onProgress);
    const group = new THREE.Group();
    group.add(...result.meshes);
    return { object: group };
  },
  async md2(url, manager, ctx) {
    const { MD2Loader } = await import('three/addons/loaders/MD2Loader.js');
    return { object: meshFromGeometry(await new MD2Loader(manager).loadAsync(url, ctx.onProgress)) };
  },
  async drc(url, manager, ctx) {
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    const loader = new DRACOLoader(manager).setDecoderPath('/libs/draco/');
    try {
      const geometry = await loader.loadAsync(url, ctx.onProgress);
      if (geometry.index === null) geometry.userData.pointCloud = true;
      return { object: meshFromGeometry(geometry) };
    } finally {
      loader.dispose();
    }
  },
};

// Extension -> key in MESH_LOADERS
const MESH_EXTS = {
  glb: 'gltf', gltf: 'gltf', vrm: 'gltf',
  obj: 'obj', fbx: 'fbx', stl: 'stl', ply: 'ply', dae: 'dae', '3mf': '3mf',
  usdz: 'usd', usd: 'usd', usda: 'usd', usdc: 'usd',
  '3ds': '3ds', amf: 'amf', wrl: 'wrl', vrml: 'wrl', pcd: 'pcd', xyz: 'xyz',
  vtk: 'vtk', vtp: 'vtk', gcode: 'gcode', '3dm': '3dm', kmz: 'kmz', vox: 'vox',
  lwo: 'lwo', md2: 'md2', drc: 'drc',
};

export const SUPPORTED_EXTS = [...new Set([...SPLAT_EXTS, 'zip', ...Object.keys(MESH_EXTS)])].sort();
export const ACCEPT = [...SUPPORTED_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`).join(',');

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function extOf(name) {
  const clean = String(name).split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

const ascii = (bytes, start = 0, len = bytes.length) =>
  new TextDecoder('latin1').decode(bytes.subarray(start, Math.min(bytes.length, start + len)));

/** A PLY is a Gaussian splat if its header carries splat properties (or SuperSplat chunks). */
function plyIsSplat(bytes) {
  const header = ascii(bytes, 0, 8192);
  const end = header.indexOf('end_header');
  const h = end >= 0 ? header.slice(0, end) : header;
  return /property\s+\w+\s+(f_dc_0|scale_0|rot_0|opacity)\b/.test(h) || /element\s+chunk\b/.test(h);
}

/** Guess a format from the leading bytes when the name tells us nothing. */
function sniff(bytes) {
  const head = ascii(bytes, 0, 2048);
  if (head.startsWith('glTF')) return 'glb';
  if (head.startsWith('ply')) return 'ply';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'spz';
  if (head.startsWith('Kaydara FBX Binary') || /^;\s*FBX/.test(head)) return 'fbx';
  if (head.startsWith('#VRML')) return 'wrl';
  if (head.startsWith('# vtk')) return 'vtk';
  if (head.startsWith('DRACO')) return 'drc';
  if (head.startsWith('VOX ')) return 'vox';
  if (head.startsWith('PXR-USDC') || head.startsWith('#usda')) return 'usd';
  if (head.startsWith('RAD')) return 'rad';
  if (head.startsWith('PK')) {
    // Zip container: look at the first entry names.
    const names = ascii(bytes, 0, 65536);
    if (/meta\.json|manifest\.json|means_l\.webp/.test(names)) return 'sog';
    if (/\.usd[ac]?\b/.test(names)) return 'usdz';
    if (/3D\/.*\.model|\[Content_Types\]\.xml/.test(names)) return '3mf';
    if (/\.kml|\.dae/.test(names)) return 'kmz';
    return 'sog';
  }
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') && /"asset"\s*:/.test(ascii(bytes, 0, 1 << 20))) return 'gltf';
  if (/<COLLADA/i.test(head)) return 'dae';
  if (/<amf/i.test(head)) return 'amf';
  if (/^solid\b/.test(trimmed)) return 'stl';
  if (/^(#.*\n)*\s*(v|vn|vt|o|g|mtllib)\s/m.test(head)) return 'obj';
  return '';
}

function classify(ext, bytes) {
  if (ext === 'ply') return plyIsSplat(bytes) ? { kind: 'splat', ext } : { kind: 'mesh', ext };
  if (ext === 'zip') {
    const inner = sniff(bytes);
    return inner && inner !== 'sog' ? classify(inner, bytes) : { kind: 'splat', ext: 'zip' };
  }
  if (SPLAT_EXTS.has(ext)) return { kind: 'splat', ext };
  if (MESH_EXTS[ext]) return { kind: 'mesh', ext };
  return null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadSplat(bytes, name, ext) {
  // Spark auto-detects ply/spz/sog/zip/rad from content; .splat/.ksplat need the name hint.
  const fileName = extOf(name) === ext ? name : `model.${ext}`;
  const mesh = new SplatMesh({ fileBytes: bytes, fileName });
  await mesh.initialized;
  let count = 0;
  try { count = mesh.numSplats ?? mesh.splats?.getNumSplats?.() ?? 0; } catch { /* count is cosmetic */ }
  return { object: mesh, kind: 'splat', animations: [], count };
}

/**
 * Load a mesh through a blob URL so every loader takes the same path. Loaders resolve
 * sibling resources against the blob URL's base; the URL modifier maps those back to
 * uploaded files (by basename) or to the real remote directory.
 */
async function loadMesh(bytes, ext, ctx, { siblings, baseUrl }) {
  const blobUrl = URL.createObjectURL(new Blob([bytes]));
  const blobBase = THREE.LoaderUtils.extractUrlBase(blobUrl);
  const created = [blobUrl];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url === blobUrl || url.startsWith('data:')) return url;
    if (!url.startsWith(blobBase)) return url;
    const rel = url.slice(blobBase.length);
    // Blob URLs a loader minted itself (embedded GLB textures) share our base; leave them alone.
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(rel)) return url;
    let decoded = rel;
    try { decoded = decodeURIComponent(rel); } catch { /* keep raw */ }
    const base = decoded.split(/[?#]/)[0].split(/[\\/]/).pop().toLowerCase();
    const file = siblings?.get(base);
    if (file) {
      const u = URL.createObjectURL(file);
      created.push(u);
      return u;
    }
    if (baseUrl) return new URL(rel, baseUrl).href;
    return url;
  });
  try {
    const result = await MESH_LOADERS[MESH_EXTS[ext]](blobUrl, manager, ctx);
    if (!result.object) throw new Error('The file contained no displayable scene.');
    return { object: result.object, kind: 'mesh', animations: result.animations || [] };
  } finally {
    // Textures decode asynchronously; give them a moment before revoking.
    setTimeout(() => created.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
}

async function loadBytes(bytes, name, ctx, opts = {}) {
  let ext = (opts.format || extOf(name)).toLowerCase().replace(/^\./, '');
  let type = classify(ext, bytes);
  if (!type) {
    ext = sniff(bytes);
    type = classify(ext, bytes);
  }
  if (!type) {
    throw new Error(
      `Unrecognised format${name ? ` for "${name}"` : ''}. Supported: ${SUPPORTED_EXTS.join(', ')}.`,
    );
  }
  ctx.onStatus?.(`Parsing ${type.ext.toUpperCase()}${type.kind === 'splat' ? ' splat' : ''}…`);
  const result = type.kind === 'splat'
    ? await loadSplat(bytes, name, type.ext)
    : await loadMesh(bytes, type.ext, ctx, opts);
  return { ...result, name, format: type.ext, bytes: bytes.byteLength };
}

/** Uploaded / dropped files. Extra files (.bin, .mtl, textures) are used as siblings. */
export async function loadFromFiles(fileList, ctx, mainFile) {
  const files = [...fileList];
  if (!files.length) throw new Error('No file selected.');
  const rank = (f) => {
    const e = extOf(f.name);
    if (e === 'gltf' || e === 'obj') return 0; // the file that references the others
    if (SPLAT_EXTS.has(e) || (MESH_EXTS[e] && e !== 'ply')) return 1;
    if (e === 'ply' || e === 'zip') return 2;
    return 9;
  };
  const main = mainFile || files.slice().sort((a, b) => rank(a) - rank(b))[0];
  const siblings = new Map(files.filter((f) => f !== main).map((f) => [f.name.toLowerCase(), f]));
  ctx.onStatus?.(`Reading ${main.name}…`);
  const bytes = new Uint8Array(await main.arrayBuffer());
  return loadBytes(bytes, main.name, ctx, { siblings });
}

export const toProxy = (url) => {
  const u = new URL(url);
  return `/proxy/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}`;
};

async function fetchBytes(url, ctx) {
  const res = await fetch(url);
  const proxied = res.headers.get('x-model-proxy') === '1';
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`.trim()), { http: true, proxied });
  const type = res.headers.get('content-type') || '';
  const total = Number(res.headers.get('content-length')) || 0;
  const disposition = res.headers.get('content-disposition') || '';
  const dispName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    ctx.onProgress?.({ loaded, total, lengthComputable: total > 0 });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return { bytes, dispName, type, proxied };
}

/** Turn common "view this file" page links into links to the file itself. */
function directLink(url) {
  const u = new URL(url.href);
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
    if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
  } else if (host === 'huggingface.co') {
    u.pathname = u.pathname.replace('/blob/', '/resolve/');
  } else if (host === 'dropbox.com') {
    u.searchParams.set('dl', '1');
  } else if (host === 'drive.google.com') {
    const id = /\/file\/d\/([^/]+)/.exec(u.pathname)?.[1] || u.searchParams.get('id');
    if (id) return new URL(`https://drive.google.com/uc?export=download&id=${id}`);
  }
  return u;
}

const looksLikeHtml = (data) =>
  /text\/html/i.test(data.type) || /^\s*<(!doctype html|html)/i.test(ascii(data.bytes, 0, 256));

const PAGE_ERROR =
  'That link opens a web page, not a model file. Use the direct download link to the file (or download it and open it as a file).';

/** Remote URL. Falls back to the dev server's /proxy when the host doesn't send CORS headers. */
export async function loadFromUrl(input, ctx, format) {
  let url;
  try {
    url = new URL(input.trim(), location.href);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) URLs can be loaded.');
  url = directLink(url);

  ctx.onStatus?.('Downloading…');
  let effective = url.href;
  let data;
  try {
    data = await fetchBytes(effective, ctx);
  } catch (err) {
    if (url.origin === location.origin) throw err;
    if (err.http) throw new Error(`The server answered ${err.message} for that URL.`);
    // A network-level failure on a cross-origin URL is almost always CORS: retry via the proxy.
    ctx.onStatus?.('Downloading via local proxy…');
    effective = new URL(toProxy(url.href), location.href).href;
    const NO_PROXY =
      'Could not download the file. The server blocks cross-origin requests (CORS) and this site has no proxy (it only exists under "npm run dev" / "npm run preview") — download the file and open it instead.';
    try {
      data = await fetchBytes(effective, ctx);
    } catch (proxyErr) {
      if (!proxyErr.proxied) throw new Error(NO_PROXY);
      if (/^HTTP 502/.test(proxyErr.message)) {
        throw new Error('The local proxy could not reach that server. Check the address and your connection.');
      }
      throw new Error(`The server answered ${proxyErr.message} for that URL.`);
    }
    // A static host answers /proxy/* with its own fallback page rather than the model.
    if (!data.proxied) throw new Error(NO_PROXY);
  }
  if (!format && looksLikeHtml(data)) throw new Error(PAGE_ERROR);
  const pathName = decodeURIComponent(url.pathname.split('/').pop() || '');
  const name = extOf(pathName) ? pathName : data.dispName || pathName || url.hostname;
  return loadBytes(data.bytes, name, ctx, { baseUrl: effective, format });
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

export function disposeObject(object) {
  object.traverse((node) => {
    if (typeof node.dispose === 'function' && node !== object) {
      try { node.dispose(); } catch { /* best effort */ }
    }
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && value.isTexture) value.dispose();
      }
      material.dispose?.();
    }
  });
  if (typeof object.dispose === 'function') {
    try { object.dispose(); } catch { /* best effort */ }
  }
}
