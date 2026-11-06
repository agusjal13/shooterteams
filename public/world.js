// Armado 3D de los mapas: texturas dibujadas por codigo (sin imagenes externas),
// materiales por tipo de objeto, escaleras, decoracion y luces de cada ambiente.
import * as THREE from '/vendor/three/three.module.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Sombreado "de dibujo animado" suave: la luz pasa de oscuro a claro con transiciones suaves
// (filtro lineal) en vez de escalones duros que se ven como bandas
export const toonRamp = (() => {
  const t = new THREE.DataTexture(new Uint8Array([135, 180, 222, 250, 255]), 5, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
})();
export const toon = (opts) => new THREE.MeshToonMaterial({ ...opts, gradientMap: toonRamp });

// UV segun la posicion (sirve para cajas con bordes redondeados y cualquier forma):
// cada cara toma la textura de las dos direcciones que la recorren.
function projUV(geo, tile, w, h, d) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    const x = pos.getX(i) + w / 2, y = pos.getY(i) + h / 2, z = pos.getZ(i) + d / 2;
    let u, v, su, sv;
    if (ax >= ay && ax >= az) { u = z; v = y; su = d; sv = h; }
    else if (ay >= az) { u = x; v = z; su = w; sv = d; }
    else { u = x; v = y; su = w; sv = h; }
    if (tile === 'fit') uv.setXY(i, u / su, v / sv);
    else uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}

// Caja con bordes redondeados (r = radio de la curva)
export function roundBox(w, h, d, r = 4, tile) {
  const rr = Math.min(r, Math.min(w, h, d) / 2 - 0.05);
  const geo = rr > 0.6 ? new RoundedBoxGeometry(w, h, d, 2, rr) : new THREE.BoxGeometry(w, h, d);
  if (tile) projUV(geo, tile, w, h, d);
  return geo;
}

// ---------- Texturas (se dibujan en un canvas) ----------
const texCache = {};
const rnd = (a, b) => a + Math.random() * (b - a);

function canvasTex(name, size, draw) {
  if (texCache[name]) return texCache[name];
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  soften(g, c, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  texCache[name] = t;
  return t;
}

// Difumina toda la textura un poquito (sin cortes en los bordes, asi se sigue repitiendo bien)
function soften(g, c, s) {
  if (!('filter' in g)) return; // navegadores viejos: queda sin difuminar
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = s * 3;
  const tg = tmp.getContext('2d');
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) tg.drawImage(c, x * s, y * s);
  g.clearRect(0, 0, s, s);
  g.filter = `blur(${(s / 256) * 1.4}px)`;
  g.drawImage(tmp, -s, -s);
  g.filter = 'none';
}

// El mismo color pero transparente (para que las manchas se desvanezcan hacia afuera)
function clearOf(col) {
  if (col[0] === '#') {
    const n = parseInt(col.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0)`;
  }
  return col.replace(/,\s*[\d.]+\)$/, ',0)');
}

// Manchas suaves y difuminadas (antes eran miles de puntitos que de lejos se veian granulados)
function noise(g, s, n, colors, rMin = 0.5, rMax = 1.6) {
  const count = Math.max(24, Math.round(n / 22));
  for (let i = 0; i < count; i++) {
    let col = colors[(Math.random() * colors.length) | 0];
    const x = Math.random() * s, y = Math.random() * s;
    const r = rnd(rMin, rMax) * rnd(7, 15) * (s / 256);
    g.globalAlpha = col[0] === '#' ? 0.35 : 0.8;
    // se dibuja tambien del otro lado si toca un borde (asi la textura repite sin cortes)
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
      const cx = x + dx, cy = y + dy;
      if (cx + r < 0 || cx - r > s || cy + r < 0 || cy - r > s) continue;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, col);
      gr.addColorStop(1, clearOf(col));
      g.fillStyle = gr;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
  g.globalAlpha = 1;
}

const TEX = {
  sand: () => canvasTex('sand', 256, (g, s) => {
    g.fillStyle = '#d8b47c'; g.fillRect(0, 0, s, s);
    noise(g, s, 2600, ['rgba(255,240,210,0.35)', 'rgba(150,110,60,0.25)', 'rgba(190,150,95,0.4)']);
    g.strokeStyle = 'rgba(255,245,220,0.18)'; g.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      const y = rnd(0, s);
      for (let x = -10; x <= s + 10; x += 16) g.lineTo(x, y + Math.sin(x / 28 + i) * 6);
      g.stroke();
    }
  }),
  sandstone: () => canvasTex('sandstone', 256, (g, s) => {
    let y = 0;
    while (y < s) {
      const h = rnd(14, 38);
      const l = rnd(-14, 12);
      g.fillStyle = `rgb(${200 + l},${156 + l},${100 + l})`;
      g.fillRect(0, y, s, h);
      g.fillStyle = 'rgba(90,60,30,0.25)'; g.fillRect(0, y + h - 2, s, 2);
      y += h;
    }
    noise(g, s, 1800, ['rgba(255,235,200,0.25)', 'rgba(110,75,40,0.25)']);
    g.strokeStyle = 'rgba(80,50,25,0.45)'; g.lineWidth = 1.5;
    for (let i = 0; i < 7; i++) {
      g.beginPath();
      let x = rnd(0, s), yy = rnd(0, s);
      g.moveTo(x, yy);
      for (let k = 0; k < 5; k++) { x += rnd(-14, 14); yy += rnd(4, 14); g.lineTo(x, yy); }
      g.stroke();
    }
  }),
  wood: () => canvasTex('wood', 256, (g, s) => {
    const n = 5, pw = s / n;
    for (let i = 0; i < n; i++) {
      const l = rnd(-18, 14);
      g.fillStyle = `rgb(${160 + l},${110 + l},${60 + l})`;
      g.fillRect(i * pw, 0, pw, s);
      g.strokeStyle = 'rgba(80,45,15,0.35)'; g.lineWidth = 1;
      for (let k = 0; k < 6; k++) {
        g.beginPath(); const x = i * pw + rnd(4, pw - 4);
        g.moveTo(x, 0); g.bezierCurveTo(x + rnd(-6, 6), s / 3, x + rnd(-6, 6), (2 * s) / 3, x, s); g.stroke();
      }
      g.fillStyle = 'rgba(40,20,5,0.6)'; g.fillRect(i * pw, 0, 2, s);
    }
    // marco de cajon
    g.strokeStyle = '#6b4320'; g.lineWidth = 16; g.strokeRect(8, 8, s - 16, s - 16);
    g.beginPath(); g.moveTo(16, 16); g.lineTo(s - 16, s - 16); g.stroke();
  }),
  planks: () => canvasTex('planks', 256, (g, s) => {
    const n = 4, ph = s / n;
    for (let i = 0; i < n; i++) {
      const l = rnd(-16, 14);
      g.fillStyle = `rgb(${165 + l},${118 + l},${70 + l})`;
      g.fillRect(0, i * ph, s, ph);
      g.fillStyle = 'rgba(50,25,5,0.55)'; g.fillRect(0, i * ph, s, 2);
    }
    noise(g, s, 600, ['rgba(90,50,20,0.3)']);
  }),
  concrete: () => canvasTex('concrete', 256, (g, s) => {
    g.fillStyle = '#8e9296'; g.fillRect(0, 0, s, s);
    noise(g, s, 2500, ['rgba(255,255,255,0.12)', 'rgba(0,0,0,0.12)']);
    for (let i = 0; i < 5; i++) {
      const x = rnd(0, s), y = rnd(0, s), r = rnd(20, 60);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(50,45,40,0.22)'); gr.addColorStop(1, 'rgba(50,45,40,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
    }
    g.strokeStyle = 'rgba(40,40,40,0.35)'; g.lineWidth = 2; g.strokeRect(0, 0, s, s);
  }),
  metal: () => canvasTex('metal', 256, (g, s) => {
    for (let x = 0; x < s; x += 16) {
      const gr = g.createLinearGradient(x, 0, x + 16, 0);
      gr.addColorStop(0, '#d9dde2'); gr.addColorStop(0.5, '#9aa1a8'); gr.addColorStop(1, '#e6e9ec');
      g.fillStyle = gr; g.fillRect(x, 0, 16, s);
    }
    noise(g, s, 500, ['rgba(120,80,40,0.15)']);
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, 0, s, 4); g.fillRect(0, s - 4, s, 4);
  }),
  rack: () => canvasTex('rack', 256, (g, s) => {
    g.fillStyle = '#1f2329'; g.fillRect(0, 0, s, s);
    // cajas en los estantes
    for (let row = 0; row < 2; row++) {
      let x = 10;
      while (x < s - 20) {
        const w = rnd(40, 80), h = rnd(60, 100);
        const l = rnd(-20, 20);
        g.fillStyle = `rgb(${175 + l},${135 + l},${85 + l})`;
        g.fillRect(x, row * 128 + 120 - h, Math.min(w, s - 10 - x), h);
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, row * 128 + 120 - h, 3, h);
        x += w + rnd(4, 12);
      }
    }
    g.fillStyle = '#e8792b';
    for (const y of [0, 120, 248]) g.fillRect(0, y, s, 10);
    g.fillStyle = '#2f5fa6';
    for (const x of [0, 248]) g.fillRect(x, 0, 8, s);
  }),
  grate: () => canvasTex('grate', 128, (g, s) => {
    g.fillStyle = '#3a3f47'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#5c636d'; g.lineWidth = 3;
    for (let i = 0; i <= s; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); }
  }),
  facade: () => canvasTex('facade', 256, (g, s) => {
    g.fillStyle = '#f2ede4'; g.fillRect(0, 0, s, s);
    noise(g, s, 900, ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.2)']);
    // ventana
    g.fillStyle = '#ffffff'; g.fillRect(58, 60, 140, 130);
    const gr = g.createLinearGradient(0, 70, 0, 180);
    gr.addColorStop(0, '#3f6d96'); gr.addColorStop(1, '#22384f');
    g.fillStyle = gr; g.fillRect(66, 68, 124, 114);
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(74, 76, 30, 98);
    g.fillStyle = '#ffffff'; g.fillRect(125, 68, 6, 114);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(50, 190, 156, 10); // alfeizar
  }),
  gravel: () => canvasTex('gravel', 128, (g, s) => {
    g.fillStyle = '#7f7c77'; g.fillRect(0, 0, s, s);
    noise(g, s, 1500, ['#6b6863', '#96938d', '#5d5a56'], 0.8, 2.2);
  }),
  brick: () => canvasTex('brick', 256, (g, s) => {
    g.fillStyle = '#d9d2c5'; g.fillRect(0, 0, s, s);
    const bh = 32, bw = 64;
    for (let r = 0; r < s / bh; r++) {
      const off = r % 2 ? bw / 2 : 0;
      for (let x = -bw; x < s + bw; x += bw) {
        const l = rnd(-20, 20);
        g.fillStyle = `rgb(${165 + l},${75 + l / 2},${55 + l / 2})`;
        g.fillRect(x + off + 3, r * bh + 3, bw - 6, bh - 6);
      }
    }
  }),
  asphalt: () => canvasTex('asphalt', 256, (g, s) => {
    g.fillStyle = '#4a4d52'; g.fillRect(0, 0, s, s);
    noise(g, s, 3500, ['rgba(255,255,255,0.08)', 'rgba(0,0,0,0.15)', 'rgba(120,120,120,0.2)']);
  }),
  sidewalk: () => canvasTex('sidewalk', 128, (g, s) => {
    g.fillStyle = '#bdb8ad'; g.fillRect(0, 0, s, s);
    noise(g, s, 500, ['rgba(0,0,0,0.07)', 'rgba(255,255,255,0.15)']);
    g.strokeStyle = 'rgba(80,75,70,0.45)'; g.lineWidth = 3;
    g.strokeRect(0, 0, s, s); g.beginPath(); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.stroke();
  }),
  tiles: () => canvasTex('tiles', 128, (g, s) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      g.fillStyle = (x + y) % 2 ? '#e9e0cc' : '#8f5f3f';
      g.fillRect(x * 32, y * 32, 32, 32);
    }
  }),
  plaza: () => canvasTex('plaza', 256, (g, s) => {
    g.fillStyle = '#b8a991'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 32) for (let x = (y / 32) % 2 ? -16 : 0; x < s; x += 32) {
      const l = rnd(-14, 14);
      g.fillStyle = `rgb(${190 + l},${175 + l},${150 + l})`;
      g.fillRect(x + 2, y + 2, 28, 28);
    }
  }),
  stone: () => canvasTex('stone', 128, (g, s) => {
    g.fillStyle = '#8f8a83'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 32) for (let x = (y / 32) % 2 ? -24 : 0; x < s; x += 48) {
      const l = rnd(-16, 16);
      g.fillStyle = `rgb(${175 + l},${170 + l},${162 + l})`;
      g.fillRect(x + 2, y + 2, 44, 28);
    }
  }),
};

function stripes(c1, c2) {
  const key = 'stripes' + c1 + '_' + c2;
  return canvasTex(key, 64, (g, s) => {
    for (let i = 0; i < 4; i++) {
      g.fillStyle = '#' + (i % 2 ? c2 : c1).toString(16).padStart(6, '0');
      g.fillRect(i * 16, 0, 16, s);
    }
  });
}

// UV en "unidades del mundo" para que la textura se repita con el mismo tamaño en cualquier caja
function boxUV(geo, w, h, d, tile) {
  const uv = geo.attributes.uv;
  // caras: +x, -x, +y, -y, +z, -z (4 vertices cada una)
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [du, dv] = dims[f];
    const su = tile === 'fit' ? 1 : du / tile, sv = tile === 'fit' ? 1 : dv / tile;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
}
function planeUV(geo, w, h, tile) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  uv.needsUpdate = true;
}

// ---------- Ambientes ----------
const THEMES = {
  desert: {
    skyTop: '#3f8fdc', skyMid: '#9cc9ea', skyLow: '#f3e3c3',
    sky: 0xcfe1ea, fogNear: 900, fogFar: 3200, hemi: [0xfff3dc, 0x8a6f4a, 2.4], sun: [0xfff0d0, 2.2],
    floor: 'sand', floorTile: 300, border: { tex: 'sandstone', tile: 160, h: 170, c: 0xffffff },
  },
  warehouse: {
    sky: 0x1b1e23, fogNear: 1000, fogFar: 3400, hemi: [0xfff4e0, 0x50545c, 2.4], sun: [0xfff6e8, 0.7],
    floor: 'concrete', floorTile: 260, border: { tex: 'metal', tile: 120, h: 330, c: 0xa9b6c4 }, ceiling: 330,
  },
  town: {
    skyTop: '#3d8ee6', skyMid: '#8fc6f2', skyLow: '#dff0fb',
    sky: 0x9fcbf0, fogNear: 1000, fogFar: 3600, hemi: [0xeaf4ff, 0x5c6a50, 2.4], sun: [0xfff4e0, 2.1],
    floor: 'asphalt', floorTile: 260, border: { tex: 'brick', tile: 128, h: 200, c: 0xffffff },
  },
};

// Que tan redondeados son los bordes de cada tipo de objeto
const ROUNDNESS = {
  rock: 18, crate: 7, fruitCrate: 7, pallet: 5, dumpster: 9, planter: 9, fountain: 16, kiosk: 9,
  counter: 5, container: 8, cab: 12, forklift: 12, partition: 6, rack: 4, building: 5, parapet: 2.5,
  shopWall: 4, shopRoof: 3, balcony: 3, pillar: 6, platform: 4,
};

// ---------- Materiales por tipo de objeto ----------
const matCache = {};
function lam(key, opts) {
  if (!matCache[key]) matCache[key] = toon(opts);
  return matCache[key];
}
// Devuelve [material o lista de materiales, tamaño de repeticion de la textura]
function materialFor(w) {
  const c = w.c ?? 0xffffff;
  switch (w.k) {
    case 'rock': return [lam('rock', { map: TEX.sandstone() }), 140];
    case 'crate': return [lam('crate', { map: TEX.wood() }), 'fit'];
    case 'pallet': return [lam('pallet', { map: TEX.wood(), color: 0xe3c69a }), 'fit'];
    case 'container': return [lam('container' + c, { map: TEX.metal(), color: c }), 90];
    case 'cab': return [[lam('cab' + c, { color: c }), lam('cab' + c, { color: c }), lam('cabTop', { color: 0x333a42 }),
      lam('cab' + c, { color: c }), lam('glass', { color: 0x2a3b4d }), lam('glass', { color: 0x2a3b4d })], 'fit'];
    case 'rack': return [lam('rack', { map: TEX.rack() }), 88];
    case 'forklift': return [lam('forklift', { color: 0xf2b705 }), 'fit'];
    case 'partition': return [lam('partition', { map: TEX.concrete(), color: 0xc4c8cc }), 120];
    case 'platform': return [lam('platform', { map: TEX.grate() }), 48];
    case 'railing': return [lam('railing', { color: 0xf2c94c }), 'fit'];
    case 'balcony': return [lam('platform', { map: TEX.grate() }), 48];
    case 'pillar': return [lam('pillar', { color: 0x4a5059 }), 'fit'];
    case 'building': {
      const side = lam('facade' + c, { map: TEX.facade(), color: c });
      const top = lam('roof', { map: TEX.gravel() });
      return [[side, side, top, top, side, side], 65];
    }
    case 'parapet': return [lam('parapet' + c, { color: new THREE.Color(c).multiplyScalar(0.85) }), 'fit'];
    case 'shopWall': return [lam('shopWall' + c, { map: TEX.brick(), color: c }), 80];
    case 'counter': return [lam('counter', { map: TEX.planks() }), 60];
    case 'shopRoof': return [lam('shopRoof' + c, { map: TEX.metal(), color: new THREE.Color(c).multiplyScalar(0.8) }), 60];
    case 'fruitCrate': return [lam('crate', { map: TEX.wood() }), 'fit'];
    case 'dumpster': return [lam('dumpster', { map: TEX.metal(), color: 0x2e7d4f }), 60];
    case 'car': return [lam('car' + c, { color: c }), 'fit'];
    case 'carTop': {
      const glass = lam('glass', { color: 0x2a3b4d });
      return [[glass, glass, lam('car' + c, { color: c }), glass, glass, glass], 'fit'];
    }
    case 'planter': return [lam('planter', { map: TEX.brick(), color: 0xd8c8b8 }), 50];
    case 'fountain': return [lam('fountain', { map: TEX.stone() }), 60];
    case 'kiosk': return [lam('kiosk' + c, { map: TEX.planks(), color: c }), 60];
    default: return [lam('default', { color: 0x999999 }), 'fit'];
  }
}

// ---------- Autos con forma real ----------
// Silueta lateral de un sedan (largo 150, alto 64): paragolpes, baul, luneta, techo, parabrisas, capo.
const CAR_PROFILE = [[0, 14], [0, 33], [4, 39], [32, 42], [46, 61], [95, 63], [117, 45], [145, 40], [150, 33], [150, 14]];
const CAR_SIDE_WINDOW = [[38, 44], [49, 59], [93, 60.5], [112, 46]];
const paintCache = {};
function carPaint(c) {
  if (!paintCache[c]) paintCache[c] = toon({ color: c });
  return paintCache[c];
}
const glassMat = () => paintCache.glass || (paintCache.glass = new THREE.MeshPhongMaterial({
  color: 0x1d2a38, shininess: 120, specular: 0x8899aa, side: THREE.DoubleSide,
}));
const chromeMat = () => paintCache.chrome || (paintCache.chrome = new THREE.MeshPhongMaterial({ color: 0xcfd4da, shininess: 120, specular: 0xffffff }));

function carModel(parent, w) {
  const horizontal = w.w >= w.h;
  const L = horizontal ? w.w : w.h;
  const Wd = horizontal ? w.h : w.w;
  const sx = L / 150;
  const car = new THREE.Group();
  const half = Wd / 2;

  // carroceria: silueta extruida a lo ancho, con bordes redondeados
  const shape = new THREE.Shape();
  CAR_PROFILE.forEach(([x, y], i) => (i ? shape.lineTo(x * sx, y) : shape.moveTo(x * sx, y)));
  const depth = Wd - 8;
  const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 4, bevelSize: 3, bevelSegments: 3 });
  bodyGeo.translate(-L / 2, 0, -depth / 2);
  car.add(new THREE.Mesh(bodyGeo, carPaint(w.c ?? 0xc0392b)));

  // vidrios laterales (un poco por fuera de la chapa)
  const winShape = new THREE.Shape();
  CAR_SIDE_WINDOW.forEach(([x, y], i) => (i ? winShape.lineTo(x * sx, y) : winShape.moveTo(x * sx, y)));
  const winGeo = new THREE.ShapeGeometry(winShape);
  winGeo.translate(-L / 2, 0, 0);
  for (const s of [1, -1]) {
    const win = new THREE.Mesh(winGeo, glassMat());
    win.position.z = s * (half + 0.4);
    car.add(win);
  }
  // parabrisas y luneta: planos apoyados sobre las partes inclinadas
  // (los puntos van en el orden que deja la cara "de afuera" mirando hacia arriba)
  const slopePlane = (x0, y0, x1, y1) => {
    const dx = (x1 - x0) * sx, dy = y1 - y0;
    const ang = Math.atan2(dy, dx);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(Math.hypot(dx, dy) * 0.86, Wd - 12), glassMat());
    p.rotation.x = -Math.PI / 2; // acostado, mirando hacia arriba
    const grp = new THREE.Group();
    grp.add(p);
    grp.rotation.z = ang; // inclinado como la chapa
    const nx = -Math.sin(ang), ny = Math.cos(ang); // normal hacia afuera
    // 4.5 = el redondeo de la chapa (3) + un poquito, asi el vidrio queda por fuera
    grp.position.set(((x0 + x1) / 2) * sx - L / 2 + nx * 4.5, (y0 + y1) / 2 + ny * 4.5, 0);
    car.add(grp);
  };
  slopePlane(95, 63, 117, 45); // parabrisas
  slopePlane(32, 42, 46, 61); // luneta
  // paragolpes y zocalo oscuros
  const trim = lam('carTrim', { color: 0x202326 });
  for (const [x, len] of [[-L / 2 - 1, 8], [L / 2 + 1, 8]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(len, 9, Wd - 2), trim);
    b.position.set(x, 17, 0);
    car.add(b);
  }
  const sill = new THREE.Mesh(new THREE.BoxGeometry(L * 0.62, 5, Wd + 1), trim);
  sill.position.set(-L * 0.02, 15, 0);
  car.add(sill);
  // faros y luces traseras
  const head = new THREE.MeshBasicMaterial({ color: 0xfff6d6 });
  const tail = new THREE.MeshBasicMaterial({ color: 0xd61f2c });
  for (const s of [1, -1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(3, 6, 14), head);
    h.position.set(L / 2 + 0.8, 35, s * (half - 12));
    car.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(3, 6, 14), tail);
    t.position.set(-L / 2 - 0.8, 35, s * (half - 12));
    car.add(t);
    // espejos
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 6), carPaint(w.c ?? 0xc0392b));
    mirror.position.set(L / 2 - 38 * sx, 46, s * (half + 3));
    car.add(mirror);
  }
  // parrilla y patente
  const grill = new THREE.Mesh(new THREE.BoxGeometry(2, 7, Wd * 0.45), trim);
  grill.position.set(L / 2 + 1.2, 27, 0);
  car.add(grill);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(1.5, 6, 18), new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }));
  plate.position.set(-L / 2 - 1.5, 24, 0);
  car.add(plate);
  // ruedas con llanta
  const tireGeo = new THREE.CylinderGeometry(12, 12, 10, 18);
  const rimGeo = new THREE.CylinderGeometry(7, 7, 10.6, 12);
  for (const x of [-L / 2 + 30 * sx, L / 2 - 28 * sx]) {
    for (const s of [1, -1]) {
      const tire = new THREE.Mesh(tireGeo, lam('tire', { color: 0x1b1b1b }));
      tire.rotation.x = Math.PI / 2;
      tire.position.set(x, 12, s * (half - 4));
      car.add(tire);
      const rim = new THREE.Mesh(rimGeo, chromeMat());
      rim.rotation.x = Math.PI / 2;
      rim.position.set(x, 12, s * (half - 4));
      car.add(rim);
    }
  }

  car.position.set(w.x + w.w / 2, 0, w.y + w.h / 2);
  if (!horizontal) car.rotation.y = -Math.PI / 2;
  parent.add(car);
}

// ---------- Pistolas de agua ----------
// Plastico brillante de colores, tanque transparente con agua, boquilla, empuñadura y gatillo.
// Se arman a lo largo de +x (de 0 a len), con la empuñadura hacia abajo.
const BLASTERS = [
  { len: 30, r: 4.2, body: 0x3ecf6b, accent: 0xffd23f, tank: 'top', tankR: 4.6, tankL: 11, nozzles: 1 }, // Chorrito
  { len: 22, r: 3.6, body: 0xff8a3d, accent: 0xffffff, tank: 'top', tankR: 3.4, tankL: 7, nozzles: 1 }, // Pistola de agua
  { len: 40, r: 5.2, body: 0x8e5cf7, accent: 0xff5fa2, tank: 'top', tankR: 6.2, tankL: 17, nozzles: 2 }, // Regadera
  { len: 38, r: 4.4, body: 0x2f9bff, accent: 0xffd23f, tank: 'drum', tankR: 7.5, nozzles: 1 }, // Hidrometralleta
];
const plastic = (c) => paintCache['p' + c] || (paintCache['p' + c] = toon({ color: c }));
const waterMat = () => paintCache.water || (paintCache.water = new THREE.MeshPhongMaterial({
  color: 0x7fdcff, shininess: 120, specular: 0xffffff, transparent: true, opacity: 0.6,
}));

export function buildBlaster(id) {
  const b = BLASTERS[id] || BLASTERS[0];
  const g = new THREE.Group();
  const along = (mesh) => { mesh.rotation.z = Math.PI / 2; return mesh; }; // de eje Y a eje X
  const put = (mesh, x, y, z) => { mesh.position.set(x, y, z); g.add(mesh); return mesh; };
  const body = plastic(b.body), acc = plastic(b.accent);

  // cuerpo redondeado
  put(along(new THREE.Mesh(new THREE.CapsuleGeometry(b.r, b.len - 2 * b.r, 6, 14), body)), b.len / 2, 0, 0);
  // franja decorativa
  put(along(new THREE.Mesh(new THREE.CylinderGeometry(b.r + 0.4, b.r + 0.4, 2.2, 14), acc)), b.len * 0.7, 0, 0);
  // boquilla(s) con punta de color
  const zs = b.nozzles === 2 ? [-b.r * 0.55, b.r * 0.55] : [0];
  for (const z of zs) {
    put(along(new THREE.Mesh(new THREE.CylinderGeometry(b.r * 0.42, b.r * 0.55, 8, 10), body)), b.len + 3, 0, z);
    put(along(new THREE.Mesh(new THREE.CylinderGeometry(b.r * 0.5, b.r * 0.5, 1.8, 10), acc)), b.len + 7, 0, z);
  }
  // tanque de agua
  if (b.tank === 'top') {
    put(along(new THREE.Mesh(new THREE.CapsuleGeometry(b.tankR, b.tankL, 6, 14), waterMat())), b.len * 0.42, b.r + b.tankR * 0.75, 0);
    put(new THREE.Mesh(new THREE.CylinderGeometry(b.tankR * 0.45, b.tankR * 0.45, 2.5, 10), acc), b.len * 0.42, b.r + b.tankR * 1.75, 0);
  } else {
    const drum = put(new THREE.Mesh(new THREE.CylinderGeometry(b.tankR, b.tankR, 7, 18), waterMat()), b.len * 0.55, -b.r - b.tankR * 0.55, 0);
    drum.rotation.x = Math.PI / 2;
    const cap = put(new THREE.Mesh(new THREE.CylinderGeometry(b.tankR * 0.5, b.tankR * 0.5, 7.6, 12), acc), b.len * 0.55, -b.r - b.tankR * 0.55, 0);
    cap.rotation.x = Math.PI / 2;
  }
  // empuñadura y gatillo
  const grip = put(new THREE.Mesh(new THREE.CapsuleGeometry(b.r * 0.72, 7, 4, 10), acc), b.len * 0.2, -b.r - 5, 0);
  grip.rotation.z = -0.28;
  put(new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.7, 6, 12, Math.PI), acc), b.len * 0.34, -b.r - 0.4, 0).rotation.z = Math.PI;
  // bomba de presion (la regadera)
  if (b.nozzles === 2) put(along(new THREE.Mesh(new THREE.CylinderGeometry(b.r * 0.6, b.r * 0.6, b.len * 0.35, 12), acc)), b.len * 0.68, -b.r - 1.5, 0);
  return { group: g, len: b.len + 8 };
}

// ---------- Baranda: pasamanos, barra del medio y parantes (se ve a traves) ----------
function railingModel(parent, w) {
  const mat = lam('railing', { color: 0xf2c94c });
  const zb = w.zb || 0, H = w.z - zb;
  const along = w.w >= w.h; // la baranda corre a lo largo de x o de y
  const len = along ? w.w : w.h;
  const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
  for (const [hy, th] of [[H - 2, 4], [H * 0.5, 3]]) {
    const bar = new THREE.Mesh(along ? new THREE.BoxGeometry(len, th, 4) : new THREE.BoxGeometry(4, th, len), mat);
    bar.position.set(cx, zb + hy, cy);
    parent.add(bar);
  }
  const n = Math.max(1, Math.round(len / 60));
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * len;
    const post = new THREE.Mesh(new THREE.BoxGeometry(4, H, 4), mat);
    post.position.set(along ? w.x + t : cx, zb + H / 2, along ? cy : w.y + t);
    parent.add(post);
  }
}

const fruitGeos = {};
const fruitGeo = (r) => fruitGeos[r] || (fruitGeos[r] = new THREE.SphereGeometry(r, 10, 8));

// ---------- Construccion del mundo ----------
export function createWorld(scene, hemi, sun, teamHex) {
  let group = null;
  let builtId = null;
  let anims = []; // cosas que se mueven solas (la fuente)

  // Fuente funcionando: chorros de agua en arco que suben y caen, y el agua que ondula
  function addFountainWater(g, w) {
    const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
    const top = w.z + 60; // punta del surtidor
    const mat = new THREE.MeshPhongMaterial({ color: 0xbfeeff, transparent: true, opacity: 0.75, shininess: 120, specular: 0xffffff });
    const geo = new THREE.SphereGeometry(2.6, 6, 5);
    const drops = [];
    const N = 8, PER = 7; // 8 chorros, 7 gotas por chorro
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < PER; i++) {
        const m = new THREE.Mesh(geo, mat);
        g.add(m);
        drops.push({ m, ang: (j / N) * Math.PI * 2, phase: i / PER });
      }
    }
    // chorro central hacia arriba
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(geo, mat);
      g.add(m);
      drops.push({ m, ang: null, phase: i / 6 });
    }
    const water = g.userData.fountainWater;
    anims.push((now) => {
      const T = now / 1100;
      for (const d of drops) {
        const t = (T + d.phase) % 1;
        if (d.ang === null) {
          d.m.position.set(cx, top + 34 * Math.sin(t * Math.PI), cy);
        } else {
          const r = 8 + t * (w.w / 2 - 22);
          d.m.position.set(cx + Math.cos(d.ang) * r, top - 48 * t * t + 22 * t, cy + Math.sin(d.ang) * r);
        }
      }
      if (water) water.position.y = w.z + 1 + Math.sin(now / 300) * 0.6;
    });
  }

  function box(g, x, y, w, d, z0, h, mat, tile, r = 5) {
    const geo = roundBox(w, h, d, r, tile || 'fit');
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x + w / 2, z0 + h / 2, y + d / 2);
    g.add(m);
    return m;
  }

  function floorPlane(g, x, y, w, h, texName, tile, yOff, color) {
    const geo = new THREE.PlaneGeometry(w, h);
    if (texName) planeUV(geo, w, h, tile);
    const mat = texName
      ? lam('floor_' + texName + (color || ''), { map: TEX[texName](), color: color || 0xffffff })
      : lam('paint' + color, { color });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x + w / 2, yOff, y + h / 2);
    g.add(m);
    return m;
  }

  function addDeco(g, d, MAP, th) {
    switch (d.t) {
      case 'wheel': {
        if (d.car) break; // las ruedas de los autos las dibuja carModel
        const m = new THREE.Mesh(new THREE.CylinderGeometry(d.r, d.r, 12, 14), lam('tire', { color: 0x1b1b1b }));
        if (d.axis === 'y') m.rotation.x = Math.PI / 2; else m.rotation.z = Math.PI / 2;
        m.position.set(d.x, d.r, d.y);
        g.add(m);
        break;
      }
      case 'awning': {
        const geo = new THREE.BoxGeometry(d.w, 4, d.h);
        const m = new THREE.Mesh(geo, lam('awning' + d.c, { map: stripes(d.c[0], d.c[1]) }));
        planeUV(geo, d.w, d.h, 64);
        m.position.set(d.x + d.w / 2, d.z, d.y + d.h / 2);
        g.add(m);
        // palitos que sostienen el toldo
        for (const px of [d.x + 4, d.x + d.w - 4]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, d.z, 6), lam('pole', { color: 0x30343a }));
          post.position.set(px, d.z / 2, d.y + (d.y > 0 ? d.h - 4 : 4));
          g.add(post);
        }
        break;
      }
      case 'floor': {
        const tile = d.tex === 'tiles' ? 40 : d.tex === 'plaza' ? 90 : 70;
        // pisos apilados con algo de separacion para que no parpadeen (vereda arriba del asfalto, baldosas arriba de la vereda)
        floorPlane(g, d.x, d.y, d.w, d.h, d.tex, tile, d.tex === 'tiles' ? 1.6 : d.tex === 'sidewalk' ? 0.8 : 0.5);
        break;
      }
      case 'paint': floorPlane(g, d.x, d.y, d.w, d.h, null, 0, 0.9, d.c); break;
      case 'fruits': {
        // naranjas, manzanas, limones, peras y bananas apiladas
        const kinds = [[0xff9f1c, 4.6], [0xd62828, 4.4], [0x7cb518, 4.2], [0xffe74c, 3.8], [0xc4e05a, 4.3]];
        let k = Math.floor(d.x + d.y) % kinds.length;
        const step = 9.5;
        for (let yy = d.y + 5; yy < d.y + d.h - 3; yy += step) {
          for (let xx = d.x + 5; xx < d.x + d.w - 3; xx += step) {
            const [color, r] = kinds[k++ % kinds.length];
            const f = new THREE.Mesh(fruitGeo(r), lam('fruit' + color, { color }));
            f.position.set(xx + rnd(-1, 1), d.z + r, yy + rnd(-1, 1));
            g.add(f);
          }
        }
        // algunas bananas arriba
        for (let i = 0; i < 3; i++) {
          const b = new THREE.Mesh(new THREE.CapsuleGeometry(2, 9, 4, 8), lam('banana', { color: 0xffd93d }));
          b.rotation.z = Math.PI / 2 + rnd(-0.3, 0.3);
          b.rotation.y = rnd(0, Math.PI);
          b.position.set(d.x + d.w * (0.25 + i * 0.25), d.z + 10, d.y + d.h / 2);
          g.add(b);
        }
        break;
      }
      case 'lamp': {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3.5, 170, 8), lam('pole', { color: 0x30343a }));
        pole.position.set(d.x, 85, d.y);
        g.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(22, 6, 12), lam('pole', { color: 0x30343a }));
        head.position.set(d.x, 170, d.y);
        g.add(head);
        const bulb = new THREE.Mesh(new THREE.BoxGeometry(16, 2, 8), new THREE.MeshBasicMaterial({ color: 0xfff1b8 }));
        bulb.position.set(d.x, 166, d.y);
        g.add(bulb);
        break;
      }
      case 'cactus': {
        // cactus redondeado: tronco y brazos en forma de capsula, con florcita arriba
        const mat = lam('cactus', { color: 0x4f9a3c });
        const trunk = new THREE.Mesh(new THREE.CapsuleGeometry(9, 72, 6, 14), mat);
        trunk.position.set(d.x, 45, d.y);
        g.add(trunk);
        for (const s of [-1, 1]) {
          const h = 46 + s * 8;
          const elbow = new THREE.Mesh(new THREE.CapsuleGeometry(5.5, 12, 4, 10), mat);
          elbow.rotation.z = Math.PI / 2;
          elbow.position.set(d.x + s * 14, h, d.y);
          g.add(elbow);
          const arm = new THREE.Mesh(new THREE.CapsuleGeometry(5.5, 20, 4, 10), mat);
          arm.position.set(d.x + s * 22, h + 13, d.y);
          g.add(arm);
        }
        const flower = new THREE.Mesh(new THREE.SphereGeometry(4, 10, 8), lam('flower', { color: 0xff6fa8 }));
        flower.position.set(d.x, 92, d.y);
        g.add(flower);
        break;
      }
      case 'rock': {
        // piedra redondeada (no choca, es decoracion)
        const r = d.r || 18;
        const m = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), lam('deskRock', { color: 0xb88a5a }));
        m.scale.set(1.3, 0.7, 1);
        m.rotation.y = d.x;
        m.position.set(d.x, r * 0.35, d.y);
        g.add(m);
        break;
      }
      case 'tree': {
        // arbol: tronco y copa de esferas
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(6, 8, 90, 10), lam('trunk', { color: 0x7a5233 }));
        trunk.position.set(d.x, 45, d.y);
        g.add(trunk);
        const leaf = lam('leaves', { color: 0x4caf50 });
        const leaf2 = lam('leaves2', { color: 0x66bb4a });
        for (const [ox, oy, oz, r, m] of [[0, 120, 0, 42, leaf], [-26, 100, 10, 30, leaf2], [24, 102, -8, 32, leaf2], [6, 150, -4, 28, leaf2]]) {
          const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m);
          s.position.set(d.x + ox, oy, d.y + oz);
          g.add(s);
        }
        break;
      }
      case 'bush': {
        const m1 = lam('leaves', { color: 0x4caf50 }), m2 = lam('leaves2', { color: 0x66bb4a });
        for (const [ox, oz, r, m] of [[0, 0, 20, m1], [-16, 6, 15, m2], [16, -4, 16, m2]]) {
          const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m);
          s.scale.y = 0.8;
          s.position.set(d.x + ox, r * 0.7, d.y + oz);
          g.add(s);
        }
        break;
      }
      case 'light': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(d.w, 4, d.h), new THREE.MeshBasicMaterial({ color: 0xfff6dc }));
        m.position.set(d.x, (th.ceiling || 300) - 6, d.y);
        g.add(m);
        break;
      }
      case 'mast': {
        // mastil y horquillas del autoelevador, del lado de "face"
        const mat = lam('mast', { color: 0x2b2f36 });
        const front = d.face === 'e' ? d.x + d.w : d.x;
        const dir = d.face === 'e' ? 1 : -1;
        for (const oy of [10, d.h - 14]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(5, 120, 5), mat);
          post.position.set(front + dir * 3, 60, d.y + oy + 2);
          g.add(post);
          const fork = new THREE.Mesh(new THREE.BoxGeometry(40, 3, 6), mat);
          fork.position.set(front + dir * 22, 6, d.y + oy + 2);
          g.add(fork);
        }
        const cage = new THREE.Mesh(new THREE.BoxGeometry(d.w - 6, 4, d.h - 6), mat);
        cage.position.set(d.x + d.w / 2, 100, d.y + d.h / 2);
        g.add(cage);
        break;
      }
    }
  }

  // Cielo: una cupula grande con degradé (arriba mas azul, abajo mas claro) y nubes redondas
  function addSky(g, MAP, th) {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 256;
    const gc = c.getContext('2d');
    const gr = gc.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, th.skyTop || '#4f9de8');
    gr.addColorStop(0.55, th.skyMid || '#9fd0f5');
    gr.addColorStop(1, th.skyLow || '#e8f4fb');
    gc.fillStyle = gr; gc.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(4200, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
    );
    dome.position.set(MAP.W / 2, -60, MAP.H / 2);
    g.add(dome);
    // nubes: grupos de esferas blancas
    const cloudMat = toon({ color: 0xffffff, fog: false });
    const puff = new THREE.SphereGeometry(1, 14, 10);
    for (let i = 0; i < 9; i++) {
      const cl = new THREE.Group();
      const n = 4 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const s = new THREE.Mesh(puff, cloudMat);
        const r = 70 + Math.random() * 70;
        s.scale.set(r * 1.3, r * 0.8, r);
        s.position.set((k - n / 2) * 95 + rnd(-30, 30), rnd(-20, 25), rnd(-40, 40));
        cl.add(s);
      }
      const a = (i / 9) * Math.PI * 2 + rnd(-0.2, 0.2);
      const dist = 2200 + rnd(0, 900);
      cl.position.set(MAP.W / 2 + Math.cos(a) * dist, 900 + rnd(0, 500), MAP.H / 2 + Math.sin(a) * dist);
      cl.rotation.y = -a;
      g.add(cl);
      anims.push((now) => { cl.position.x += Math.sin(now / 9000 + i) * 0.08; }); // se mueven despacito
    }
  }

  // Escalera: escalones del ancho de la rampa
  function addStairs(g, r, mat) {
    const n = Math.max(5, Math.round(r.top / 11));
    const along = r.axis === 'x' ? r.w : r.h;
    const stepL = along / n;
    for (let i = 0; i < n; i++) {
      const h = ((i + 1) / n) * r.top;
      // i=0 es el escalon mas bajo; se ubica del lado bajo
      const fromLow = i * stepL;
      let x, y, w, d;
      if (r.axis === 'x') {
        w = stepL; d = r.h; y = r.y;
        x = r.dir > 0 ? r.x + fromLow : r.x + r.w - fromLow - stepL;
      } else {
        w = r.w; d = stepL; x = r.x;
        y = r.dir > 0 ? r.y + fromLow : r.y + r.h - fromLow - stepL;
      }
      box(g, x, y, w, d, 0, h, mat, 40);
    }
  }

  function build(MAP) {
    if (builtId === MAP.id && group) return;
    if (group) {
      scene.remove(group);
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    builtId = MAP.id;
    group = new THREE.Group();
    anims = [];
    const th = THEMES[MAP.theme] || THEMES.desert;

    // cielo, niebla y luces del ambiente
    scene.background = new THREE.Color(th.sky);
    scene.fog = new THREE.Fog(th.sky, th.fogNear, th.fogFar);
    hemi.color.setHex(th.hemi[0]); hemi.groundColor.setHex(th.hemi[1]); hemi.intensity = th.hemi[2];
    sun.color.setHex(th.sun[0]); sun.intensity = th.sun[1];

    // cielo con degradé y nubes (afuera)
    if (!th.ceiling) addSky(group, MAP, th);
    // piso
    floorPlane(group, 0, 0, MAP.W, MAP.H, th.floor, th.floorTile, 0);
    // bases de cada equipo
    for (const t of ['red', 'blue']) {
      const s = MAP.spawns[t];
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(s.w + 80, s.h + 80),
        new THREE.MeshBasicMaterial({ color: teamHex[t], transparent: true, opacity: 0.22, depthWrite: false })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(s.x + s.w / 2, 1.2, s.y + s.h / 2);
      group.add(m);
    }
    for (const d of MAP.deco) addDeco(group, d, MAP, th);

    // paredes y objetos solidos
    for (const w of MAP.walls) {
      if (w.k === 'carTop' || w.k === 'trunk') continue; // el auto y el arbol se dibujan aparte
      if (w.k === 'car') { carModel(group, w); continue; }
      if (w.k === 'railing') { railingModel(group, w); continue; }
      const [mat, tile] = materialFor(w);
      const zb = w.zb || 0; // objetos elevados (balcon, baranda del balcon)
      box(group, w.x, w.y, w.w, w.h, zb, w.z - zb, mat, tile, ROUNDNESS[w.k] ?? 5);
      // detalles extra
      if (w.k === 'planter') {
        const plants = new THREE.Mesh(new THREE.BoxGeometry(w.w - 8, 14, w.h - 8), lam('plants', { color: 0x4f8a3c }));
        plants.position.set(w.x + w.w / 2, w.z + 5, w.y + w.h / 2);
        group.add(plants);
      }
      if (w.k === 'fountain') {
        const water = new THREE.Mesh(new THREE.BoxGeometry(w.w - 20, 2, w.h - 20), new THREE.MeshPhongMaterial({ color: 0x4fa3d9, shininess: 100, specular: 0xffffff }));
        water.position.set(w.x + w.w / 2, w.z + 1, w.y + w.h / 2);
        group.add(water);
        const spout = new THREE.Mesh(new THREE.CylinderGeometry(8, 12, 60, 12), lam('fountain', { map: TEX.stone() }));
        spout.position.set(w.x + w.w / 2, w.z + 30, w.y + w.h / 2);
        group.add(spout);
        group.userData.fountainWater = water;
        addFountainWater(group, w);
      }
    }

    // escaleras
    const stairMat = MAP.theme === 'warehouse' ? lam('platform', { map: TEX.grate() }) : lam('stairs', { map: TEX.concrete(), color: 0xd8d0c2 });
    for (const r of MAP.ramps) addStairs(group, r, stairMat);

    // muros del borde
    const b = th.border, B = 40;
    const bm = lam('border_' + MAP.theme, { map: TEX[b.tex](), color: b.c });
    box(group, -B, -B, MAP.W + 2 * B, B, 0, b.h, bm, b.tile);
    box(group, -B, MAP.H, MAP.W + 2 * B, B, 0, b.h, bm, b.tile);
    box(group, -B, 0, B, MAP.H, 0, b.h, bm, b.tile);
    box(group, MAP.W, 0, B, MAP.H, 0, b.h, bm, b.tile);

    // techo del galpon con vigas
    if (th.ceiling) {
      const geo = new THREE.PlaneGeometry(MAP.W + 80, MAP.H + 80);
      planeUV(geo, MAP.W, MAP.H, 120);
      const roof = new THREE.Mesh(geo, lam('ceiling', { map: TEX.metal(), color: 0x6b727a, side: THREE.DoubleSide }));
      roof.rotation.x = Math.PI / 2;
      roof.position.set(MAP.W / 2, th.ceiling, MAP.H / 2);
      group.add(roof);
      for (let x = 200; x < MAP.W; x += 400) {
        box(group, x - 8, 0, 16, MAP.H, th.ceiling - 22, 22, lam('beam', { color: 0x3b4048 }));
      }
    }

    scene.add(group);
  }

  // se llama en cada cuadro para animar (la fuente)
  function update(now) {
    for (const f of anims) f(now);
  }

  return { build, update };
}

// Colores para el minimapa
export function minimapColor(w) {
  switch (w.k) {
    case 'building': case 'kiosk': return 'rgba(230,220,200,0.55)';
    case 'car': case 'carTop': return 'rgba(255,120,120,0.55)';
    case 'rack': case 'partition': return 'rgba(255,255,255,0.35)';
    case 'container': case 'cab': return 'rgba(140,180,230,0.5)';
    case 'platform': return 'rgba(255,220,120,0.35)';
    case 'crate': case 'pallet': case 'counter': return 'rgba(210,160,100,0.55)';
    default: return 'rgba(255,255,255,0.28)';
  }
}
