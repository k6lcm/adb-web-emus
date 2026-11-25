// Animated desktop wallpaper (WebGL).
//
// The scene is laid out in the coordinates of the original 2000x1125 still
// (css/images/adb-wallpaper.png) and scaled to cover the desktop:
//   - sky, sun, clouds and mountains come from the clean background photo,
//   - the neon floor grid is drawn procedurally with the photo's perspective
//     and scrolls toward the viewer,
//   - the Adrian's Digital Basement logo zooms out of a point at the centre
//     to its place in the still when the page loads.
// If WebGL is unavailable the static still is shown instead.

const STILL_W = 2000;
const STILL_H = 1125;

// Where the background photo sits in the still: still = photo * SCALE + OFFSET.
const SKY_SCALE = 1.2;
const SKY_OFFSET = [-199, -143];
const SKY_SIZE = [2000, 1333];

// Logo rectangle in still coordinates (css/images/adb-logo.png).
const LOGO = { x: 94, y: 260, w: 1815, h: 528 };

// Floor perspective measured from the photo, in still coordinates.
const VANISH_Y = 782.2;      // vanishing line (hidden behind the mountains)
const HORIZON_Y = 893.8;     // where the floor becomes visible
const CENTER_X = 989.6;      // vanishing point x
const GRID_X = 0.9018;       // screen width of one cell per pixel below the vanishing line
const GRID_Z = 3085.0;       // depth constant: Z = GRID_Z / (y - VANISH_Y)

const CRUISE = 0.32;         // cells per second once settled
const INTRO_BOOST = 2.6;     // extra cells travelled during the intro rush
const INTRO_TAU = 0.7;       // seconds
const STOP_AT = 6;           // the grid eases to a halt by this time (seconds)
const EASE_OUT = 2;          // seconds spent slowing down
const ZOOM_DELAY = 0.15;
const ZOOM_TIME = 1.5;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
uniform vec4 uRect;   // x, y, w, h in pixels (top-down), for the logo quad
uniform vec2 uRes;
uniform float uFull;  // 1 = full-screen quad
void main() {
  vUv = aPos;
  vec2 px = mix(uRect.xy + aPos * uRect.zw, aPos * uRes, uFull);
  vec2 clip = px / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const SCENE_FRAG = `
precision highp float;
uniform sampler2D uSky;
uniform vec2 uRes;
uniform float uScale;     // pixels per still unit
uniform vec2 uOrigin;     // pixel position of still (0,0), top-down
uniform float uScroll;    // floor scroll, in cells
uniform float uPulse;   // horizon haze strength
uniform float uFade;

const vec3 GROUND = vec3(22.0, 3.0, 35.0) / 255.0;
const vec3 MAGENTA = vec3(150.0, 22.0, 128.0) / 255.0;
const vec3 CORE = vec3(223.0, 159.0, 250.0) / 255.0;

// Brightness of a grid line at distance d (cells) with pixel footprint px (cells).
float line(float d, float px) {
  float a = 0.02 - 0.5 * px;
  float b = 0.05 + 0.5 * px;
  float i = 1.0 - smoothstep(a, b, d);
  return mix(i, 0.12, smoothstep(0.12, 0.45, px));
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 s = (frag - uOrigin) / uScale;           // still coordinates

  vec2 uv = (s - vec2(${SKY_OFFSET[0].toFixed(1)}, ${SKY_OFFSET[1].toFixed(1)})) / ${SKY_SCALE.toFixed(3)} / vec2(${SKY_SIZE[0].toFixed(1)}, ${SKY_SIZE[1].toFixed(1)});
  vec3 sky = texture2D(uSky, clamp(uv, 0.0, 1.0)).rgb;

  float dy = max(s.y - ${VANISH_Y.toFixed(2)}, 1.0);
  float X = (s.x - ${CENTER_X.toFixed(2)}) / (${GRID_X.toFixed(4)} * dy);
  float Z = ${GRID_Z.toFixed(1)} / dy;
  float pxX = 1.0 / (${GRID_X.toFixed(4)} * dy * uScale);
  float pxZ = ${GRID_Z.toFixed(1)} / (dy * dy * uScale);

  float dX = abs(fract(X) - 0.5);                       // lines at X = n + 0.5
  float zz = Z + uScroll - 0.08;
  float dZ = abs(fract(zz + 0.5) - 0.5);
  float i = max(line(dX, pxX), line(dZ, pxZ));

  vec3 floorCol = mix(GROUND, MAGENTA, smoothstep(0.0, 0.45, i));
  floorCol = mix(floorCol, CORE, smoothstep(0.45, 1.0, i));

  // Soft neon haze along the far edge of the floor.
  float depth = s.y - ${HORIZON_Y.toFixed(2)};
  floorCol += MAGENTA * 0.35 * uPulse * exp(-max(depth, 0.0) / 28.0);

  float onFloor = smoothstep(-0.6, 0.6, depth * uScale);
  vec3 col = mix(sky, floorCol, onFloor);
  gl_FragColor = vec4(mix(vec3(16.0, 5.0, 29.0) / 255.0, col, uFade), 1.0);
}`;

const LOGO_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uLogo;
uniform float uAlpha;
void main() {
  gl_FragColor = texture2D(uLogo, vUv) * uAlpha;   // premultiplied
}`;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load ' + src));
    img.src = src;
  });
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

function program(gl, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let k = 0; k < n; k++) {
    const name = gl.getActiveUniform(p, k).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

function texture(gl, img, mipmaps) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mipmaps) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  return t;
}

// Ease out with a small overshoot, so the logo lands with a gentle settle.
function easeOutBack(x) {
  const c1 = 1.2, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Distance the floor has scrolled by time t: an intro rush, a steady cruise,
// then a smooth slow-down that stops completely at STOP_AT.
function scrollAt(t) {
  t = Math.min(t, STOP_AT);
  const brake = STOP_AT - EASE_OUT;
  const u = clamp01((t - brake) / EASE_OUT);
  const cruise = Math.min(t, brake) + EASE_OUT * (u - u ** 3 + u ** 4 / 2);
  return CRUISE * cruise + INTRO_BOOST * (1 - Math.exp(-t / INTRO_TAU));
}

// Horizon haze breathes while the grid moves and settles when it stops.
function pulseAt(t) {
  const fade = 1 - clamp01((t - (STOP_AT - EASE_OUT)) / EASE_OUT);
  return 0.85 + 0.15 * Math.sin(Math.min(t, STOP_AT) * 1.3) * fade;
}

export async function startWallpaper(desktop) {
  const fallback = () => desktop.classList.add('wallpaper-static');
  const canvas = document.createElement('canvas');
  canvas.id = 'wallpaper';
  canvas.setAttribute('aria-hidden', 'true');

  const opts = { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' };
  const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
  if (!gl) { fallback(); return; }
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  let sky, logo;
  try {
    [sky, logo] = await Promise.all([
      loadImage('css/images/adb-sky.jpg'),
      loadImage('css/images/adb-logo.png'),
    ]);
  } catch (err) {
    console.warn(err);
    fallback();
    return;
  }

  let scene, logoProg, skyTex, logoTex;
  try {
    scene = program(gl, SCENE_FRAG);
    logoProg = program(gl, LOGO_FRAG);
    skyTex = texture(gl, sky, false);
    logoTex = texture(gl, logo, isGL2);
  } catch (err) {
    console.warn('Wallpaper shader failed:', err);
    fallback();
    return;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  desktop.prepend(canvas);

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let start = null;
  let raf = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw(now) {
    resize();
    const W = canvas.width, H = canvas.height;
    const still = reduceMotion.matches;
    if (start === null) start = now;
    const t = still ? STOP_AT : (now - start) / 1000;

    // Cover-fit the still, so the scene always fills the desktop.
    const k = Math.max(W / STILL_W, H / STILL_H);
    const ox = (W - STILL_W * k) / 2;
    const oy = (H - STILL_H * k) / 2;

    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(scene.p);
    gl.uniform2f(scene.u.uRes, W, H);
    gl.uniform1f(scene.u.uFull, 1);
    gl.uniform1f(scene.u.uScale, k);
    gl.uniform2f(scene.u.uOrigin, ox, oy);
    gl.uniform1f(scene.u.uScroll, still ? 0 : scrollAt(t));
    gl.uniform1f(scene.u.uPulse, still ? 0.85 : pulseAt(t));
    gl.uniform1f(scene.u.uFade, still ? 1 : clamp01(t / 0.4));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, skyTex);
    gl.uniform1i(scene.u.uSky, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Logo: same place as in the still, but shrunk to fit narrow screens.
    const p = clamp01((t - ZOOM_DELAY) / ZOOM_TIME);
    if (p > 0) {
      const fit = Math.min(k, (W * 0.94) / LOGO.w);
      const z = easeOutBack(p) * fit;
      const cx = ox + (LOGO.x + LOGO.w / 2) * k;
      const cy = oy + (LOGO.y + LOGO.h / 2) * k;
      // Zoom out of the centre of the desktop toward the logo's final spot.
      const e = easeOutBack(p);
      const px = W / 2 + (cx - W / 2) * e;
      const py = H / 2 + (cy - H / 2) * e;
      gl.enable(gl.BLEND);
      gl.useProgram(logoProg.p);
      gl.uniform2f(logoProg.u.uRes, W, H);
      gl.uniform1f(logoProg.u.uFull, 0);
      gl.uniform4f(logoProg.u.uRect, px - (LOGO.w * z) / 2, py - (LOGO.h * z) / 2, LOGO.w * z, LOGO.h * z);
      gl.uniform1f(logoProg.u.uAlpha, clamp01(p * 6));
      gl.bindTexture(gl.TEXTURE_2D, logoTex);
      gl.uniform1i(logoProg.u.uLogo, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Once everything has settled, only redraw on resize.
    const done = still || t >= Math.max(STOP_AT, ZOOM_DELAY + ZOOM_TIME);
    raf = done ? 0 : requestAnimationFrame(draw);
  }

  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
  new ResizeObserver(redraw).observe(canvas);
  reduceMotion.addEventListener('change', redraw);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    raf = 0;
    canvas.remove();
    fallback();
  });
  raf = requestAnimationFrame(draw);
}
