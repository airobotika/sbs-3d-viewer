// In-page file browser, so picking a model doesn't throw up a native dialog that only one
// eye (or neither) can see. A folder is granted once through the system dialog; after that
// it is browsed entirely inside the page, and the grant is remembered between visits.
//
// Two backends with the same interface:
//   'fs'   — File System Access API directory handle (Chrome / Edge), persisted in IndexedDB
//   'list' — snapshot of a folder from <input webkitdirectory> (Safari / Firefox), per visit
import { SUPPORTED_EXTS, extOf } from './loaders.js';
import { VIDEO_EXTS } from './video.js';

const LOADABLE = new Set([...SUPPORTED_EXTS, ...VIDEO_EXTS]);
// Files a model may reference; gathered automatically from next to the chosen file.
const COMPANION = new Set([
  'bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'ktx2', 'basis', 'tga', 'bmp', 'gif', 'dds',
  'tif', 'tiff', 'exr', 'hdr', 'avif',
]);
const REFERENCING = new Set(['gltf', 'obj', 'fbx', 'dae', '3ds', 'wrl', 'vrml', 'lwo', 'usd', 'usda']);
const MAX_COMPANIONS = 2000;

// --- tiny IndexedDB key/value store (directory handles can't go in localStorage) ---
function idb(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('sbs-viewer', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = run(tx.objectStore('kv'));
      tx.oncomplete = () => { open.result.close(); resolve(req?.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}
const idbGet = (key) => idb('readonly', (s) => s.get(key)).catch(() => undefined);
const idbSet = (key, value) => idb('readwrite', (s) => s.put(value, key)).catch(() => {});

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

export class FileBrowser {
  constructor({ onChange } = {}) {
    this.onChange = onChange;
    this.nativeSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    this.mode = null;
    this.stack = []; // directory nodes from the root down to the current folder
    this.names = []; // their display names
    this.entries = [];
    this.busy = false;
    this.error = '';
    this.needsPermission = false;
  }

  snapshot() {
    return {
      ready: this.stack.length > 0 && !this.needsPermission,
      rootName: this.names[0] || '',
      path: this.names.slice(),
      entries: this.entries,
      busy: this.busy,
      error: this.error,
      needsPermission: this.needsPermission,
    };
  }

  _emit() { this.onChange?.(this.snapshot()); }

  /** Re-attach to the folder granted on a previous visit, if any. */
  async restore() {
    if (!this.nativeSupported) return;
    const handle = await idbGet('root');
    if (!handle) return;
    this.mode = 'fs';
    this.stack = [handle];
    this.names = [handle.name];
    try {
      const permission = await handle.queryPermission({ mode: 'read' });
      if (permission === 'granted') return this._list();
    } catch { /* fall through to asking again */ }
    this.needsPermission = true;
    this._emit();
  }

  /** Must be called from a click: the browser shows a small permission prompt. */
  async grant() {
    const root = this.stack[0];
    if (!root) return;
    try {
      if ((await root.requestPermission({ mode: 'read' })) === 'granted') {
        this.needsPermission = false;
        await this._list();
      }
    } catch (err) {
      this.error = err.message;
      this._emit();
    }
  }

  /** Native folder dialog — the one unavoidable trip outside the page. */
  async pickFolder() {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'sbs-models', mode: 'read' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.error = err.message;
      return this._emit();
    }
    await idbSet('root', handle);
    this.mode = 'fs';
    this.stack = [handle];
    this.names = [handle.name];
    this.needsPermission = false;
    await this._list();
  }

  /** Fallback for browsers without directory handles: a FileList from <input webkitdirectory>. */
  setFileList(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const root = { dirs: new Map(), files: new Map() };
    let rootName = 'Folder';
    for (const file of files) {
      const parts = (file.webkitRelativePath || file.name).split('/');
      if (parts.length > 1) rootName = parts.shift();
      let node = root;
      while (parts.length > 1) {
        const dir = parts.shift();
        if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: new Map() });
        node = node.dirs.get(dir);
      }
      node.files.set(parts[0], file);
    }
    this.mode = 'list';
    this.stack = [root];
    this.names = [rootName];
    this.needsPermission = false;
    return this._list();
  }

  async enter(name) {
    const current = this.stack.at(-1);
    try {
      const next = this.mode === 'fs' ? await current.getDirectoryHandle(name) : current.dirs.get(name);
      if (!next) return;
      this.stack.push(next);
      this.names.push(name);
      await this._list();
    } catch (err) {
      this.error = err.message;
      this._emit();
    }
  }

  /** Jump to an ancestor by depth (0 = root). */
  goTo(depth) {
    if (depth < 0 || depth >= this.stack.length - 1) return;
    this.stack.length = depth + 1;
    this.names.length = depth + 1;
    return this._list();
  }

  up() { return this.goTo(this.stack.length - 2); }

  async _children(node) {
    const dirs = [];
    const files = [];
    if (this.mode === 'fs') {
      for await (const [name, handle] of node.entries()) {
        (handle.kind === 'directory' ? dirs : files).push({ name, handle });
      }
    } else {
      for (const name of node.dirs.keys()) dirs.push({ name });
      for (const [name, file] of node.files) files.push({ name, file });
    }
    return { dirs, files };
  }

  async _list() {
    this.busy = true;
    this.error = '';
    this._emit();
    try {
      const { dirs, files } = await this._children(this.stack.at(-1));
      this._files = files;
      this._dirs = dirs;
      this.entries = [
        ...dirs.filter((d) => !d.name.startsWith('.')).sort(byName).map((d) => ({ name: d.name, kind: 'dir' })),
        ...files
          .filter((f) => !f.name.startsWith('.') && LOADABLE.has(extOf(f.name)))
          .sort(byName)
          .map((f) => ({ name: f.name, kind: 'file', ext: extOf(f.name) })),
      ];
    } catch (err) {
      this.entries = [];
      this.error = err.name === 'NotAllowedError' ? '' : err.message;
      if (err.name === 'NotAllowedError') this.needsPermission = true;
    }
    this.busy = false;
    this._emit();
  }

  /**
   * Resolve a listed file to File objects: the model itself plus, for formats that reference
   * other files, the textures / buffers / materials found beside it (one folder level deep).
   */
  async filesFor(name) {
    const toFile = (entry) => (entry.file ? entry.file : entry.handle.getFile());
    const entry = this._files.find((f) => f.name === name);
    if (!entry) throw new Error(`"${name}" is no longer in this folder.`);
    const main = await toFile(entry);
    const files = [main];
    if (REFERENCING.has(extOf(name))) {
      const pending = this._files.filter((f) => f !== entry && COMPANION.has(extOf(f.name)));
      for (const dir of this._dirs) {
        if (pending.length >= MAX_COMPANIONS) break;
        try {
          const node = this.mode === 'fs' ? dir.handle : this.stack.at(-1).dirs.get(dir.name);
          const sub = await this._children(node);
          pending.push(...sub.files.filter((f) => COMPANION.has(extOf(f.name))));
        } catch { /* unreadable subfolder: skip */ }
      }
      files.push(...(await Promise.all(pending.slice(0, MAX_COMPANIONS).map(toFile))));
    }
    return { main, files };
  }
}
