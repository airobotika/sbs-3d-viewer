// The whole UI is built twice — once per eye — from one shared state object, so that in
// side-by-side mode the panel appears at the same spot in both halves and fuses at screen depth.
import { ACCEPT } from './loaders.js';
import { FORMATS, PROJECTIONS } from './video.js';

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
};

const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
};

// World axes shown on the view gizmo: label, direction, colour class.
const GIZMO_AXES = [
  ['X', 1, 0, 0, 'x'], ['Y', 0, 1, 0, 'y'], ['Z', 0, 0, 1, 'z'],
  ['', -1, 0, 0, 'x'], ['', 0, -1, 0, 'y'], ['', 0, 0, -1, 'z'],
];
const GIZMO_RADIUS = 36;

/** Drag on a node: onMove(dx, dy) per pointer move; onClick(target) if it never really moved. */
function dragHandle(node, onMove, onClick) {
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    node.setPointerCapture(event.pointerId);
    const target = event.target;
    let travelled = 0;
    const move = (e) => {
      travelled += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (travelled > 3) onMove(e.movementX, e.movementY);
    };
    const done = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', done);
      node.removeEventListener('pointercancel', done);
      if (travelled <= 3) onClick?.(target);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', done);
    node.addEventListener('pointercancel', done);
  });
}

/** Keep the same element in both eyes scrolled to the same place. */
function linkScroll(nodes) {
  let syncing = false;
  for (const node of nodes) {
    node.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      for (const other of nodes) if (other !== node) other.scrollTop = node.scrollTop;
      syncing = false;
    }, { passive: true });
  }
}

export function createUI({ state, set, actions, samples }) {
  const root = document.getElementById('eyes');
  const syncers = [];
  const cursors = [];
  const panels = [];
  const lists = [];
  const gizmos = [];
  const fileInputs = [];
  const dirInputs = [];

  const slider = (label, key, min, max, step, fmt = (v) => v) => {
    const input = el('input', {
      type: 'range', min, max, step,
      oninput: () => set({ [key]: Number(input.value) }),
    });
    const val = el('span', { class: 'val' });
    syncers.push(() => {
      if (document.activeElement !== input) input.value = state[key];
      val.textContent = fmt(state[key]);
    });
    return el('div', { class: 'row' }, el('label', { text: label }), input, val);
  };

  const check = (label, key) => {
    const input = el('input', { type: 'checkbox', onchange: () => set({ [key]: input.checked }) });
    syncers.push(() => { input.checked = !!state[key]; });
    return el('label', { class: 'check' }, input, label);
  };

  const button = (label, onclick, cls = '') => el('button', { type: 'button', class: cls, text: label, onclick });

  const dropdown = (key, options) => {
    const menu = el('div', { class: 'dropdown-menu', hidden: '' });
    const trigger = button('', () => {
      set({ dropdownOpen: state.dropdownOpen === key ? null : key });
    }, 'dropdown-trigger');
    const wrapper = el('div', { class: 'dropdown' }, trigger, menu);
    for (const [value, text] of Object.entries(options)) {
      menu.append(button(text, () => {
        set({ [key]: value, dropdownOpen: null });
      }, 'dropdown-option'));
    }
    syncers.push(() => {
      const open = state.dropdownOpen === key;
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      trigger.textContent = options[state[key]] ?? state[key];
      trigger.disabled = (key === 'videoProjection' && state.video?.kind === 'youtube')
        || (key === 'videoQuality' && state.video?.kind !== 'youtube');
      for (const option of menu.children) option.classList.toggle('selected', option.textContent === trigger.textContent);
    });
    return wrapper;
  };

  // Hovering a row lights it up in both eyes; a one-eyed highlight is uncomfortable to look at.
  const setHot = (index) => {
    for (const list of lists) {
      list.querySelector('.frow.hot')?.classList.remove('hot');
      if (index >= 0) list.children[index]?.classList.add('hot');
    }
  };

  function buildBrowser() {
    const crumbs = el('div', { class: 'crumbs' });
    const message = el('p', { class: 'small' });
    const list = el('div', {
      class: 'flist',
      onpointerover: (e) => {
        const row = e.target.closest('.frow');
        setHot(row ? [...list.children].indexOf(row) : -1);
      },
      onpointerleave: () => setHot(-1),
      onclick: (e) => {
        const row = e.target.closest('.frow');
        if (!row) return;
        if (row.dataset.kind === 'dir') actions.browseEnter(row.dataset.name);
        else actions.browseOpen(row.dataset.name);
      },
    });
    lists.push(list);
    const pick = button('', () => actions.browsePick(), 'primary');
    const grant = button('', () => actions.browseGrant(), 'primary');
    const up = button('↑ Up', () => actions.browseUp());

    let shownEntries = null;
    let shownPath = '';
    syncers.push(() => {
      const b = state.browser;
      const pathKey = b.path.join('/');
      if (pathKey !== shownPath) {
        shownPath = pathKey;
        crumbs.replaceChildren(...b.path.flatMap((name, i) => {
          const last = i === b.path.length - 1;
          const crumb = el('button', {
            type: 'button', class: `crumb${last ? ' current' : ''}`, text: name,
            onclick: () => actions.browseGoTo(i),
          });
          return last ? [crumb] : [crumb, el('span', { class: 'sep', text: '/' })];
        }));
      }
      if (b.entries !== shownEntries) {
        shownEntries = b.entries;
        list.replaceChildren(...b.entries.map((entry) => el('div', {
          class: 'frow', 'data-kind': entry.kind, 'data-name': entry.name, title: entry.name,
        },
        el('span', { class: `tag ${entry.kind}`, text: entry.kind === 'dir' ? 'DIR' : entry.ext.toUpperCase() }),
        el('span', { class: 'fname', text: entry.name }))));
        list.scrollTop = 0;
      }
      pick.textContent = b.rootName ? 'Change folder…' : 'Choose folder…';
      grant.textContent = `Allow access to “${b.rootName}”`;
      grant.hidden = !b.needsPermission;
      up.disabled = b.path.length < 2;
      up.hidden = !b.ready;
      list.hidden = !b.ready;
      crumbs.hidden = !b.ready;
      message.textContent = b.error
        || (b.needsPermission ? 'The browser needs you to confirm access to this folder again.'
          : !b.rootName ? 'Choose a folder once with the system dialog. After that you browse it here, inside the glasses view, and it is remembered next time.'
            : b.busy ? 'Reading folder…'
              : b.ready && !b.entries.length ? 'No folders or supported files here.' : '');
      message.className = `small${b.error ? ' error' : ''}`;
    });

    return el('div', { class: 'panel browser' },
      el('div', { class: 'row' },
        el('h1', { text: 'Files' }),
        button('✕', () => set({ browserOpen: false }), 'icon')),
      el('div', { class: 'row' }, up, grant, pick, button('System dialog…', () => fileInputs[0].click())),
      crumbs, message, list);
  }

  // View gizmo, as in 3D modelling tools: drag the ball to orbit, click an axis to look along
  // it, drag the handle underneath to pan.
  function buildGizmo() {
    // In half-SBS the overlay is squeezed 2x, so pointer travel across it is halved.
    const dx = (v) => (state.layout === 'hsbs' ? v * 2 : v);
    const lines = [];
    const dots = GIZMO_AXES.map(([label, , , , cls], i) => {
      const dot = svg('g', { class: `gizmo-axis ${cls}${label ? '' : ' neg'}`, 'data-axis': i },
        svg('circle', { r: label ? 9 : 7 }));
      if (label) {
        const text = svg('text', { 'text-anchor': 'middle', dy: '0.36em' });
        text.textContent = label;
        dot.append(text);
        lines.push(svg('line', { class: `gizmo-line ${cls}`, x1: 0, y1: 0 }));
      }
      return dot;
    });
    const layer = svg('g', {}, ...dots);
    const ball = svg('svg', { class: 'gizmo-ball', viewBox: '-50 -50 100 100' },
      svg('circle', { class: 'gizmo-bg', r: 49 }), ...lines, layer);
    dragHandle(ball, (mx, my) => actions.orbitDrag(dx(mx), my), (target) => {
      const index = target.closest?.('[data-axis]')?.dataset.axis;
      if (index !== undefined) actions.snapView(...GIZMO_AXES[index].slice(1, 4));
    });
    const pan = el('button', { type: 'button', class: 'gizmo-pan', title: 'Drag to pan', text: '✥' });
    dragHandle(pan, (mx, my) => actions.panDrag(dx(mx), my));
    // points: one [x, y, z] per axis in view space (x right, y up, z towards the viewer).
    let order = '';
    gizmos.push((points) => {
      points.forEach(([x, y, z], i) => {
        const px = (x * GIZMO_RADIUS).toFixed(1);
        const py = (-y * GIZMO_RADIUS).toFixed(1);
        dots[i].setAttribute('transform', `translate(${px} ${py})`);
        dots[i].style.opacity = (0.5 + 0.25 * (z + 1)).toFixed(2);
        if (i < 3) {
          lines[i].setAttribute('x2', px);
          lines[i].setAttribute('y2', py);
        }
      });
      // Nearest axis on top, so it is also the one that takes the click.
      const sorted = dots.map((dot, i) => i).sort((a, b) => points[a][2] - points[b][2]);
      if (sorted.join() !== order) {
        order = sorted.join();
        layer.append(...sorted.map((i) => dots[i]));
      }
    });
    return el('div', { class: 'gizmo' }, ball, pan);
  }

  function buildEye(side) {
    const file = el('input', {
      type: 'file', multiple: '', accept: ACCEPT, hidden: '',
      onchange: () => { if (file.files.length) actions.openFiles(file.files); file.value = ''; },
    });
    fileInputs.push(file);
    // Folder snapshot for browsers without directory handles.
    const dir = el('input', {
      type: 'file', webkitdirectory: '', hidden: '',
      onchange: () => { if (dir.files.length) actions.browseFileList(dir.files); dir.value = ''; },
    });
    dirInputs.push(dir);

    const url = el('input', {
      type: 'text', placeholder: 'Model, video or YouTube URL', spellcheck: 'false', autocomplete: 'off',
      oninput: () => set({ url: url.value }),
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') actions.openUrl(state.url); },
    });
    syncers.push(() => { if (url.value !== state.url) url.value = state.url; });

    const playButton = button('', () => actions.videoToggle(), 'primary');
    const muteButton = button('', () => actions.videoMute());
    const seek = el('input', { type: 'range', min: 0, max: 1, step: 0.5, oninput: () => actions.videoSeek(Number(seek.value)) });
    const time = el('span', { class: 'time' });
    const projection = dropdown('videoProjection', PROJECTIONS);
    const quality = dropdown('videoQuality', {
      default: 'Auto quality',
      small: 'Low (240p)',
      medium: 'Medium (360p)',
      large: '480p',
      hd720: '720p',
      hd1080: '1080p',
      hd1440: '1440p',
      hd2160: '2160p',
    });
    const historyList = el('div', { class: 'video-history' });
    const clearHistory = button('Clear all', () => actions.clearVideoHistory());
    let shownHistory = null;
    syncers.push(() => {
      if (state.videoHistory !== shownHistory) {
        shownHistory = state.videoHistory;
        historyList.replaceChildren(...state.videoHistory.map((item) => el('div', { class: 'history-row' },
          button(item.title || item.url, () => actions.openVideoHistory(item.url), 'history-open'),
          button('×', () => actions.deleteVideoHistory(item.url), 'icon history-delete'))));
      }
      clearHistory.disabled = !state.videoHistory.length;
    });
    syncers.push(() => {
      const v = state.video;
      if (!v) return;
      playButton.textContent = v.playing ? 'Pause' : 'Play';
      muteButton.textContent = v.muted ? 'Unmute' : 'Mute';
      seek.max = v.duration || 1;
      if (document.activeElement !== seek) seek.value = v.time;
      time.textContent = v.label;
    });

    const status = el('div', { class: 'status' });
    const bar = el('div', { class: 'bar' }, el('i'));
    const note = el('p', { class: 'note' });
    const hint = el('div', { class: 'hint' });
    const htButton = button('', () => actions.toggleHeadTracking());
    const fsButton = button('', () => actions.toggleFullscreen(), 'primary');
    const browseButton = button('', () => set({ browserOpen: !state.browserOpen }), 'primary');
    const msaa = el('input', { type: 'checkbox', onchange: () => actions.setAntialias(msaa.checked) });

    syncers.push(() => {
      status.textContent = state.status;
      status.className = `status ${state.statusKind}`;
      bar.classList.toggle('on', state.progress >= 0);
      bar.firstChild.style.width = `${Math.round(Math.max(0, state.progress) * 100)}%`;
      note.textContent = state.note;
      hint.textContent = state.hint;
      htButton.textContent = state.headTracking ? 'Stop head tracking' : 'Start head tracking';
      fsButton.textContent = state.fullscreen ? 'Exit fullscreen' : 'Fullscreen';
      browseButton.textContent = state.browserOpen ? 'Close files' : 'Browse files…';
      msaa.checked = state.antialias;
    });

    const title = el('h1', { text: 'SBS 3D Viewer', class: 'settings-title' });
    const panel = el('div', { class: 'panel main' },
      el('div', { class: 'panel-header' }, title,
        button('Hide', () => set({ showUI: false }), 'panel-hide')),
      file, dir,
      el('div', { class: 'row' }, browseButton, fsButton),
      el('div', { class: 'row' }, url, button('Load', () => actions.openUrl(state.url))),
      el('div', { class: 'row' }, ...samples.map((s) => button(s.label, () => actions.openUrl(s.url)))),
      bar, status, note,

      el('h2', { class: 'video-only', text: 'Video' }),
      el('div', { class: 'row video-only' }, playButton, muteButton,
        button('−10s', () => actions.videoSkip(-10)), button('+10s', () => actions.videoSkip(10))),
      el('div', { class: 'row video-only' }, seek, time),
      el('div', { class: 'row video-only' }, dropdown('videoFormat', Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.label])))),
      el('div', { class: 'row video-only' }, projection),
      el('div', { class: 'row video-only' }, quality),
      el('h2', { text: 'Video history' }),
      historyList,
      el('div', { class: 'row' }, clearHistory),

      el('h2', { text: 'Display' }),
      el('div', { class: 'row' }, dropdown('layout', {
        sbs: 'Side-by-side (full, 32:9)',
        hsbs: 'Half side-by-side (16:9)',
        mono: '2D (single view)',
      })),
      slider('Depth', 'depth', 0, 3, 0.05, (v) => `${v.toFixed(2)}×`),
      slider('Convergence', 'convergence', 0.3, 3, 0.05, (v) => `${v.toFixed(2)}×`),
      slider('Field of view', 'fov', 10, 100, 1, (v) => `${v}°`),
      check('Swap left / right eye', 'swap'),

      el('h2', { class: 'model-only', text: 'Model' }),
      el('div', { class: 'row model-only' },
        button('Reset view', () => actions.resetView()),
        button('Rotate up-axis', () => actions.cycleUp())),
      check('Auto-rotate', 'autoRotate'),
      check('Play animations', 'animate'),

      el('h2', { text: 'Head tracking (experimental · RayNeo)' }),
      el('div', { class: 'row' }, htButton, button('Recentre', () => actions.recentre())),
      el('div', { class: 'row' },
        button('Glasses 3D on', () => actions.setGlasses3D(true)),
        button('Glasses 2D', () => actions.setGlasses3D(false))),
      el('div', { class: 'row' }, dropdown('headMode', {
        look: 'Look around (model / VR video)',
        pinned: 'Pinned screen (3D canvas)',
      })),
      slider('Screen size', 'screenSize', 0.25, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      slider('Glasses FOV', 'displayFov', 30, 75, 1, (v) => `${v}°`),

      el('h2', { text: 'Rendering' }),
      el('label', { class: 'check' }, msaa, 'Anti-alias meshes (reloads page)'),
      el('p', { class: 'small', text: 'Drag: orbit · Right-drag / two fingers: pan · Wheel / pinch: zoom · Arrows: orbit · Shift + arrows: pan · F fullscreen · H hide panel · R reset · C recentre' }),
    );
    panels.push(panel);

    const settingsToggle = button('Settings', () => set({ showUI: true }), 'settings-toggle');
    title.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      title.setPointerCapture(event.pointerId);
      const logicalX = (clientX) => {
        const half = window.innerWidth / 2;
        const x = state.layout === 'mono' ? clientX : clientX % half;
        return state.layout === 'hsbs' ? x * 2 : x;
      };
      const startX = logicalX(event.clientX);
      const startY = event.clientY;
      const start = { ...state.panel };
      const move = (moveEvent) => set({
        panel: {
          ...start,
          x: Math.max(0, start.x + logicalX(moveEvent.clientX) - startX),
          y: Math.max(0, start.y + moveEvent.clientY - startY),
        },
      });
      const done = () => {
        title.removeEventListener('pointermove', move);
        title.removeEventListener('pointerup', done);
        title.removeEventListener('pointercancel', done);
      };
      title.addEventListener('pointermove', move);
      title.addEventListener('pointerup', done);
      title.addEventListener('pointercancel', done);
    });
    const cursor = el('div', { class: 'cursor' });
    cursors.push(cursor);
    root.append(el('div', { class: `eye ${side}` }, panel, buildBrowser(), buildGizmo(), hint, settingsToggle, cursor));
  }

  buildEye('left');
  buildEye('right');
  linkScroll(panels);
  linkScroll(lists);
  window.addEventListener('pointerdown', (event) => {
    if (state.dropdownOpen && !event.target.closest('.dropdown')) set({ dropdownOpen: null });
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.dropdownOpen) set({ dropdownOpen: null });
  });
  const panelObserver = new ResizeObserver(([entry]) => {
    const box = entry.borderBoxSize?.[0];
    const width = Math.round(box?.inlineSize ?? entry.contentRect.width);
    const height = Math.round(box?.blockSize ?? entry.contentRect.height);
    if (width !== state.panel.width || height !== state.panel.height) {
      set({ panel: { ...state.panel, width, height } });
    }
  });
  panelObserver.observe(panels[0]);

  // The OS cursor is only visible to one eye in SBS, so draw one per eye instead.
  window.addEventListener('pointermove', (e) => {
    const stereo = state.layout !== 'mono';
    const half = window.innerWidth / 2;
    const x = stereo ? e.clientX % half : e.clientX;
    // In half-SBS each overlay is full-width and squeezed 2x, so un-squeeze the position.
    const local = state.layout === 'hsbs' ? x * 2 : x;
    for (const c of cursors) {
      c.style.left = `${local}px`;
      c.style.top = `${e.clientY}px`;
    }
  }, { passive: true });

  const sync = () => {
    document.body.dataset.layout = state.layout;
    document.body.classList.toggle('stereo', state.layout !== 'mono');
    document.body.classList.toggle('ui-hidden', !state.showUI);
    document.body.classList.toggle('ht-on', state.headTracking);
    document.body.classList.toggle('browsing', state.browserOpen);
    for (const panel of panels) {
      panel.style.left = `${state.panel.x}px`;
      panel.style.top = `${state.panel.y}px`;
      panel.style.width = `${state.panel.width}px`;
      panel.style.height = state.panel.height ? `${state.panel.height}px` : '';
    }
    for (const fn of syncers) fn();
  };
  sync();

  // Turn the gizmos to match the camera (a unit quaternion); skipped while nothing changes.
  let gizmoKey = '';
  const setGizmo = (q) => {
    const key = `${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}`;
    if (key === gizmoKey) return;
    gizmoKey = key;
    // Columns of the camera's rotation matrix are its axes in the world, so a world axis seen
    // from the camera is its dot product with each of them.
    const { x, y, z, w } = q;
    const cols = [
      [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
      [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
      [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
    ];
    const points = GIZMO_AXES.map(([, ax, ay, az]) => cols.map((c) => c[0] * ax + c[1] * ay + c[2] * az));
    for (const update of gizmos) update(points);
  };
  return { sync, setGizmo, pickDirectoryFallback: () => dirInputs[0].click() };
}
