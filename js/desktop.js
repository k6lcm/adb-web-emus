// ADB Web Emulators: a small GNOME-style window manager.
// Each emulator is a static web app listed in apps/manifest.json and runs
// inside an iframe in its own window, so emulators never share globals,
// audio contexts or keyboard handlers.

import { startWallpaper } from './wallpaper.js';

const TOPBAR_H = 32;          // keep in sync with --topbar-h in desktop.css
const MIN_W = 320;
const MIN_H = 200;
const STORE_PREFIX = 'adb-web-emus:';
const MOBILE_QUERY = matchMedia('(max-width: 720px), (pointer: coarse) and (max-height: 520px)');

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  apps: [],
  windows: new Map(),   // app id -> window record
  focused: null,
  z: 10,
  cascade: 0,
  dockHover: false,
  lastPointerType: 'mouse',
};

addEventListener('pointerdown', (e) => { state.lastPointerType = e.pointerType; }, true);

const isMobile = () => document.body.classList.contains('mobile');

// ---------------------------------------------------------------- storage

function loadGeom(id) {
  try { return JSON.parse(localStorage.getItem(STORE_PREFIX + 'geom:' + id)); } catch { return null; }
}

function saveGeom(w) {
  try {
    localStorage.setItem(STORE_PREFIX + 'geom:' + w.app.id,
      JSON.stringify({ ...w.geom, maximized: w.maximized }));
  } catch { /* storage unavailable */ }
}

function resetLayout() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(STORE_PREFIX + 'geom:'))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
  state.cascade = 0;
  for (const w of state.windows.values()) {
    w.maximized = false;
    w.geom = defaultGeom(w.app);
    applyGeom(w);
  }
  updateDockAutohide();
}

// --------------------------------------------------------------- geometry

function desktopRect() {
  return { x: 0, y: TOPBAR_H, w: innerWidth, h: innerHeight - TOPBAR_H };
}

function defaultGeom(app) {
  const d = desktopRect();
  const w = Math.min(app.window?.width ?? 960, d.w - 32);
  const h = Math.min(app.window?.height ?? 720, d.h - 96);
  const off = (state.cascade++ % 6) * 32;
  return clampGeom({
    x: Math.round((d.w - w) / 2) + off,
    y: d.y + Math.max(12, Math.round((d.h - 80 - h) / 2)) + off,
    w,
    h,
  });
}

function clampGeom(g) {
  const d = desktopRect();
  const w = Math.max(MIN_W, Math.min(g.w, d.w));
  const h = Math.max(MIN_H, Math.min(g.h, d.h));
  return {
    w,
    h,
    // Keep at least part of the headerbar on screen so the window can be grabbed.
    x: Math.max(96 - w, Math.min(g.x, d.w - 96)),
    y: Math.max(d.y, Math.min(g.y, d.y + d.h - 46)),
  };
}

function applyGeom(w) {
  const s = w.el.style;
  s.left = w.geom.x + 'px';
  s.top = w.geom.y + 'px';
  s.width = w.geom.w + 'px';
  s.height = w.geom.h + 'px';
  w.el.classList.toggle('maximized', w.maximized);
  const btn = $('[data-action="maximize"]', w.el);
  const label = w.maximized ? 'Restore' : 'Maximize';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function windowRect(w) {
  if (w.maximized || isMobile()) return { ...desktopRect() };
  return { ...w.geom };
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// ---------------------------------------------------------------- windows

function findApp(id) {
  return state.apps.find((a) => a.id === id);
}

function openApp(id) {
  const app = findApp(id);
  if (!app) return;
  const existing = state.windows.get(id);
  if (existing) {
    if (existing.minimized) restore(existing);
    else focusWindow(existing);
    return;
  }
  const w = createWindow(app);
  state.windows.set(id, w);
  focusWindow(w);
  updateDockAutohide();
}

function createWindow(app) {
  const el = $('#window-tpl').content.firstElementChild.cloneNode(true);
  el.dataset.app = app.id;
  el.setAttribute('aria-label', app.name);
  $('.hb-title span', el).textContent = app.name;
  $('.hb-icon', el).src = app.icon;

  const iframe = $('iframe', el);
  iframe.title = app.name;
  if (app.video) {
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allowFullscreen = true;
    iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    $('[data-action="minimize"]', el).hidden = true;
    const reload = $('[data-action="reload"]', el);
    reload.title = 'Reload video';
    reload.setAttribute('aria-label', 'Reload video');
    el.classList.add('video-window');
  }
  iframe.src = app.video || app.path.includes('?') ? app.path : `${app.path}?v=3`;

  const saved = loadGeom(app.id);
  const w = {
    app,
    el,
    iframe,
    minimized: false,
    maximized: Boolean(saved?.maximized),
    geom: saved ? clampGeom(saved) : defaultGeom(app),
  };
  applyGeom(w);

  el.addEventListener('pointerdown', () => focusWindow(w), true);

  const hb = $('.headerbar', el);
  hb.addEventListener('pointerdown', (e) => startMove(e, w));
  hb.addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) toggleMaximize(w);
  });
  el.querySelectorAll('.rz').forEach((handle) =>
    handle.addEventListener('pointerdown', (e) => startResize(e, w, handle.dataset.dir)));

  const actions = {
    close: () => closeWindow(w),
    minimize: () => minimize(w),
    maximize: () => toggleMaximize(w),
    reload: () => {
      try { iframe.contentWindow.location.reload(); } catch { iframe.src = app.path; }
    },
    newtab: () => window.open(new URL(app.externalUrl || app.path, location.href), '_blank', 'noopener'),
  };
  el.querySelectorAll('[data-action]').forEach((b) =>
    b.addEventListener('click', () => actions[b.dataset.action]()));

  // Clicks inside a same-origin iframe never reach the parent document, so
  // listen inside it to raise the window.
  iframe.addEventListener('load', () => {
    try {
      iframe.contentWindow.addEventListener('pointerdown', () => focusWindow(w), true);
    } catch { /* cross-origin app: handled by the window blur fallback */ }
  });

  $('#windows').append(el);
  return w;
}

function focusWindow(w) {
  if (state.focused !== w) {
    state.focused?.el.classList.remove('focused');
    state.focused = w;
    w.el.classList.add('focused');
    w.el.style.zIndex = String(++state.z);
    updateDockIndicators();
    updateHash();
  }
  // Give the emulator keyboard focus once the browser has finished its own
  // mousedown focus handling, without stealing focus from an active text input.
  requestAnimationFrame(() => {
    if (state.focused !== w || w.minimized) return;
    try {
      const innerActive = w.iframe.contentDocument?.activeElement;
      if (
        innerActive &&
        (innerActive.tagName === 'INPUT' ||
          innerActive.tagName === 'TEXTAREA' ||
          innerActive.isContentEditable)
      ) {
        return;
      }
    } catch { /* cross-origin */ }
    if (document.activeElement !== w.iframe) {
      try { w.iframe.contentWindow.focus(); } catch { w.iframe.focus(); }
    }
  });
}

function focusTopmost() {
  let best = null;
  for (const w of state.windows.values()) {
    if (!w.minimized && (!best || Number(w.el.style.zIndex) > Number(best.el.style.zIndex))) best = w;
  }
  if (best) {
    focusWindow(best);
  } else {
    state.focused = null;
    updateDockIndicators();
    updateHash();
  }
}

function notifyVisibility(w, visible) {
  // Optional hook: emulators may listen for this message to pause when hidden.
  try { w.iframe.contentWindow.postMessage({ type: 'adb-web-emus:visibility', visible }, '*'); } catch { /* ignore */ }
}

function minimize(w) {
  w.minimized = true;
  w.el.classList.add('minimized');
  w.el.classList.remove('focused');
  notifyVisibility(w, false);
  if (state.focused === w) {
    state.focused = null;
    focusTopmost();
  }
  updateDockIndicators();
  updateDockAutohide();
}

function restore(w) {
  w.minimized = false;
  w.el.classList.remove('minimized');
  notifyVisibility(w, true);
  focusWindow(w);
  updateDockAutohide();
}

function toggleMaximize(w) {
  if (isMobile()) return;
  w.maximized = !w.maximized;
  applyGeom(w);
  saveGeom(w);
  updateDockAutohide();
}

function closeWindow(w) {
  w.el.remove();            // destroys the iframe, its audio and its WASM instance
  state.windows.delete(w.app.id);
  if (state.focused === w) {
    state.focused = null;
    focusTopmost();
  }
  updateDockIndicators();
  updateDockAutohide();
}

// ------------------------------------------------------- drag and resize

function trackPointer(e, target, onMove, onEnd) {
  target.setPointerCapture(e.pointerId);
  const move = (ev) => onMove(ev);
  const end = (ev) => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    document.body.classList.remove('wm-busy');
    onEnd(ev);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

function startMove(e, w) {
  if (e.button !== 0 || e.target.closest('button') || isMobile()) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const before = { ...w.geom };
  let started = false;
  let g0;

  trackPointer(e, e.currentTarget, (ev) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    if (!started) {
      if (Math.hypot(dx, dy) < 5) return;
      started = true;
      document.body.classList.add('wm-busy');
      if (w.maximized) {
        // Unmaximize under the pointer, keeping the grab point proportional.
        const ratio = sx / innerWidth;
        w.maximized = false;
        w.geom.x = Math.round(sx - ratio * w.geom.w);
        w.geom.y = TOPBAR_H;
      }
      g0 = { ...w.geom };
    }
    w.geom.x = g0.x + dx;
    w.geom.y = Math.max(TOPBAR_H, g0.y + dy);
    applyGeom(w);
  }, (ev) => {
    if (!started) return;
    if (ev.clientY <= TOPBAR_H + 2) {
      // Dropped on the top edge: snap to maximized (GNOME behaviour).
      w.geom = before;
      w.maximized = true;
    } else {
      w.geom = clampGeom(w.geom);
    }
    applyGeom(w);
    saveGeom(w);
    updateDockAutohide();
  });
}

function startResize(e, w, dir) {
  if (e.button !== 0 || w.maximized || isMobile()) return;
  e.preventDefault();
  e.stopPropagation();
  focusWindow(w);
  const sx = e.clientX;
  const sy = e.clientY;
  const g0 = { ...w.geom };
  document.body.classList.add('wm-busy');

  trackPointer(e, e.currentTarget, (ev) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    let { x, y, w: width, h: height } = g0;
    if (dir.includes('e')) width = g0.w + dx;
    if (dir.includes('s')) height = g0.h + dy;
    if (dir.includes('w')) { width = g0.w - dx; x = g0.x + dx; }
    if (dir.includes('n')) { height = g0.h - dy; y = g0.y + dy; }
    if (width < MIN_W) { if (dir.includes('w')) x -= MIN_W - width; width = MIN_W; }
    if (height < MIN_H) { if (dir.includes('n')) y -= MIN_H - height; height = MIN_H; }
    if (y < TOPBAR_H) { height -= TOPBAR_H - y; y = TOPBAR_H; }
    w.geom = { x, y, w: width, h: height };
    applyGeom(w);
  }, () => {
    w.geom = clampGeom(w.geom);
    applyGeom(w);
    saveGeom(w);
    updateDockAutohide();
  });
}

// For cross-origin apps: a click inside the iframe blurs the parent window
// and makes the iframe the active element.
addEventListener('blur', () => setTimeout(() => {
  const active = document.activeElement;
  if (active?.tagName !== 'IFRAME') return;
  for (const w of state.windows.values()) {
    if (w.iframe === active && state.focused !== w) focusWindow(w);
  }
}));

// ------------------------------------------------------------------- dock

function iconImg(app, size) {
  const img = document.createElement('img');
  img.src = app.icon;
  img.alt = '';
  img.width = size;
  img.height = size;
  img.draggable = false;
  return img;
}

function renderDock() {
  const box = $('#dock-apps');
  for (const app of state.apps) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dock-item';
    b.dataset.app = app.id;
    b.title = app.name;
    b.setAttribute('aria-label', app.name);
    const dot = document.createElement('span');
    dot.className = 'dock-dot';
    b.append(iconImg(app, 48), dot);
    b.addEventListener('click', () => dockClick(app.id));
    box.append(b);
  }
}

function dockClick(id) {
  const w = state.windows.get(id);
  if (!w) openApp(id);
  else if (w.minimized) restore(w);
  else if (state.focused === w) minimize(w);
  else focusWindow(w);
}

function updateDockIndicators() {
  document.querySelectorAll('.dock-item[data-app]').forEach((b) => {
    const w = state.windows.get(b.dataset.app);
    b.classList.toggle('running', Boolean(w));
    b.classList.toggle('focused', Boolean(w) && state.focused === w);
  });
}

// Intellihide: hide the dock while a window overlaps it, reveal it when the
// pointer touches the bottom edge of the screen.
function updateDockAutohide() {
  const dock = $('#dock');
  const r = $('#dock-wrap').getBoundingClientRect();
  const zone = { x: r.left, y: r.top, w: r.width, h: r.height };
  const covered = [...state.windows.values()].some((w) => !w.minimized && overlaps(windowRect(w), zone));
  const hide = covered && !state.dockHover;
  dock.classList.toggle('hidden', hide);
  document.body.classList.toggle('dock-autohidden', covered);
}

function setupDockAutohide() {
  $('#dock-reveal').addEventListener('pointerenter', () => {
    state.dockHover = true;
    updateDockAutohide();
  });
  $('#dock').addEventListener('pointerleave', () => {
    state.dockHover = false;
    updateDockAutohide();
  });
}

// ---------------------------------------------------------- desktop icons

function selectIcon(btn) {
  document.querySelectorAll('.desktop-icon.selected').forEach((b) => b.classList.remove('selected'));
  btn?.classList.add('selected');
}

function renderDesktopIcons() {
  const box = $('#desktop-icons');
  for (const app of state.apps) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'desktop-icon';
    b.dataset.app = app.id;
    b.title = app.description || app.name;
    const label = document.createElement('span');
    label.textContent = app.name;
    b.append(iconImg(app, 64), label);
    b.addEventListener('click', () => {
      selectIcon(b);
      // Touch and pen open on a single tap; mouse needs a double-click.
      if (state.lastPointerType === 'touch' || state.lastPointerType === 'pen') openApp(app.id);
    });
    b.addEventListener('dblclick', () => openApp(app.id));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); openApp(app.id); }
    });
    box.append(b);
  }
  $('#desktop').addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.desktop-icon')) selectIcon(null);
  });
}

// ------------------------------------------------------------ system menu

function closeSystemMenu() {
  $('#system-menu').hidden = true;
  $('#tray-btn').classList.remove('active');
  $('#tray-btn').setAttribute('aria-expanded', 'false');
}

function setupSystemMenu() {
  const menu = $('#system-menu');
  const btn = $('#tray-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeSystemMenu();
  });
  const commands = {
    about: showAbout,
    'reset-layout': resetLayout,
    'close-all': () => [...state.windows.values()].forEach(closeWindow),
  };
  menu.querySelectorAll('[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => { closeSystemMenu(); commands[b.dataset.cmd](); }));
}

function watchVideo(machine, video) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(video.id)) return;
  $('#about-dialog').close();
  // Reuse one player window. Closing it destroys the iframe and stops playback.
  const previous = state.windows.get('video-player');
  if (previous) closeWindow(previous);
  const app = {
    id: 'video-player',
    name: video.title,
    icon: machine.icon,
    video: true,
    path: `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&playsinline=1&rel=0`,
    externalUrl: `https://www.youtube.com/watch?v=${video.id}`,
    window: { width: 960, height: 600 },
  };
  const w = createWindow(app);
  const fallback = document.createElement('a');
  fallback.className = 'video-fallback';
  fallback.href = app.externalUrl;
  fallback.target = '_blank';
  fallback.rel = 'noopener';
  fallback.textContent = 'Watch on YouTube ↗';
  $('.window-body', w.el).append(fallback);
  state.windows.set(app.id, w);
  focusWindow(w);
  updateDockAutohide();
}

async function showAbout() {
  const list = $('#about-apps');
  list.replaceChildren();
  for (const app of state.apps) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = app.name;
    const info = document.createElement('small');
    info.textContent = app.description ?? '';
    meta.append(name, info);
    if (app.videos?.length) {
      const section = document.createElement('details');
      section.className = 'machine-videos';
      const heading = document.createElement('summary');
      heading.className = 'video-heading';
      heading.textContent = `Watch videos (${app.videos.length})`;
      const videos = document.createElement('ul');
      videos.className = 'video-list';
      for (const video of app.videos) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `https://www.youtube.com/watch?v=${video.id}`;
        link.textContent = video.title;
        link.title = 'Watch in desktop';
        link.addEventListener('click', (e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          watchVideo(app, video);
        });
        const creator = document.createElement('small');
        creator.textContent = video.channel;
        item.append(link, creator);
        videos.append(item);
      }
      section.append(heading, videos);
      meta.append(section);
    }
    li.append(iconImg(app, 32), meta);
    list.append(li);
    // sync-info.json is written by tools/sync-app.sh and records the build source.
    fetch(new URL('sync-info.json', new URL(app.path, location.href)), { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s?.revision) info.textContent = `${app.description ?? ''} · build ${s.revision}`.replace(/^ · /, '');
      })
      .catch(() => {});
  }
  $('#about-dialog').showModal();
}

// ----------------------------------------------------------- clock + hash

function startClock() {
  const clock = $('#clock');
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const tick = () => {
    const now = new Date();
    clock.textContent = fmt.format(now).replace(/,/g, '');
    clock.dateTime = now.toISOString();
  };
  tick();
  setInterval(tick, 10_000);
}

function updateHash() {
  if (state.focused?.app.video) return;
  const id = state.focused?.app.id;
  const want = id ? '#/' + id : '';
  if (location.hash !== want) {
    history.replaceState(null, '', want || location.pathname + location.search);
  }
}

function openFromHash() {
  const m = location.hash.match(/^#\/?([\w-]+)$/);
  if (m && findApp(m[1])) openApp(m[1]);
}

// ------------------------------------------------------------------- boot

function applyMobile() {
  document.body.classList.toggle('mobile', MOBILE_QUERY.matches);
}

function onViewportResize() {
  applyMobile();
  for (const w of state.windows.values()) {
    w.geom = clampGeom(w.geom);
    applyGeom(w);
  }
  updateDockAutohide();
}

function showMessage(text) {
  const p = $('#desktop-message');
  p.textContent = text;
  p.hidden = false;
}

async function boot() {
  startWallpaper($('#desktop')).catch((err) => {
    console.warn('Wallpaper failed:', err);
    $('#desktop').classList.add('wallpaper-static');
  });
  applyMobile();
  startClock();
  setupSystemMenu();
  setupDockAutohide();
  addEventListener('resize', onViewportResize);
  MOBILE_QUERY.addEventListener('change', onViewportResize);
  addEventListener('hashchange', openFromHash);
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSystemMenu();
  });

  try {
    const res = await fetch('apps/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.apps = (await res.json()).apps ?? [];
  } catch (err) {
    showMessage(`Could not load apps/manifest.json (${err.message}).`);
    return;
  }
  if (!state.apps.length) showMessage('No emulators installed yet.');

  renderDesktopIcons();
  renderDock();
  openFromHash();
}

boot();
