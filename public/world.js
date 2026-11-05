// Armado 3D de los mapas: texturas dibujadas por codigo (sin imagenes externas),
// materiales por tipo de objeto, escaleras, decoracion y luces de cada ambiente.
import * as THREE from '/vendor/three/three.module.js';

// ---------- Texturas (se dibujan en un canvas) ----------
const texCache = {};
const rnd = (a, b) => a + Math.random() * (b - a);

function canvasTex(name, size, draw) {
  if (texCache[name]) return texCache[name];
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache[name] = t;
  return t;
}

function noise(g, s, n, colors, rMin = 0.5, rMax = 1.6) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(Math.random() * colors.length) | 0];
    g.beginPath();
    g.arc(Math.random() * s, Math.random() * s, rnd(rMin, rMax), 0, Math.PI * 2);
    g.fill();
  }
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
    sky: 0xcfe1ea, fogNear: 900, fogFar: 3200, hemi: [0xfff3dc, 0x8a6f4a, 2.4], sun: [0xfff0d0, 2.2],
    floor: 'sand', floorTile: 300, border: { tex: 'sandstone', tile: 160, h: 170, c: 0xffffff },
  },
  warehouse: {
    sky: 0x1b1e23, fogNear: 1000, fogFar: 3400, hemi: [0xfff4e0, 0x50545c, 2.4], sun: [0xfff6e8, 0.7],
    floor: 'concrete', floorTile: 260, border: { tex: 'metal', tile: 120, h: 330, c: 0xa9b6c4 }, ceiling: 330,
  },
  town: {
    sky: 0x9fcbf0, fogNear: 1000, fogFar: 3600, hemi: [0xeaf4ff, 0x5c6a50, 2.4], sun: [0xfff4e0, 2.1],
    floor: 'asphalt', floorTile: 260, border: { tex: 'brick', tile: 128, h: 200, c: 0xffffff },
  },
};

// ---------- Materiales por tipo de objeto ----------
const matCache = {};
function lam(key, opts) {
  if (!matCache[key]) matCache[key] = new THREE.MeshLambertMaterial(opts);
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
    case 'building': {
      const side = lam('facade' + c, { map: TEX.facade(), color: c });
      const top = lam('roof', { map: TEX.gravel() });
      return [[side, side, top, top, side, side], 65];
    }
    case 'parapet': return [lam('parapet' + c, { color: new THREE.Color(c).multiplyScalar(0.85) }), 'fit'];
    case 'shopWall': return [lam('shopWall' + c, { map: TEX.brick(), color: c }), 80];
    case 'counter': return [lam('counter', { map: TEX.planks() }), 60];
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

// ---------- Construccion del mundo ----------
export function createWorld(scene, hemi, sun, teamHex) {
  let group = null;
  let builtId = null;

  function box(g, x, y, w, d, z0, h, mat, tile) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (tile) boxUV(geo, w, h, d, tile);
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
        floorPlane(g, d.x, d.y, d.w, d.h, d.tex, tile, d.tex === 'sidewalk' ? 0.6 : 0.4);
        break;
      }
      case 'paint': floorPlane(g, d.x, d.y, d.w, d.h, null, 0, 0.9, d.c); break;
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
        const mat = lam('cactus', { color: 0x4f8a3c });
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(8, 9, 90, 10), mat);
        trunk.position.set(d.x, 45, d.y);
        g.add(trunk);
        for (const s of [-1, 1]) {
          const arm = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 30, 8), mat);
          arm.position.set(d.x + s * 14, 50 + s * 6, d.y);
          g.add(arm);
          const elbow = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 14, 8), mat);
          elbow.rotation.z = Math.PI / 2;
          elbow.position.set(d.x + s * 8, 36 + s * 6, d.y);
          g.add(elbow);
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
    const th = THEMES[MAP.theme] || THEMES.desert;

    // cielo, niebla y luces del ambiente
    scene.background = new THREE.Color(th.sky);
    scene.fog = new THREE.Fog(th.sky, th.fogNear, th.fogFar);
    hemi.color.setHex(th.hemi[0]); hemi.groundColor.setHex(th.hemi[1]); hemi.intensity = th.hemi[2];
    sun.color.setHex(th.sun[0]); sun.intensity = th.sun[1];

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
      const [mat, tile] = materialFor(w);
      box(group, w.x, w.y, w.w, w.h, 0, w.z, mat, tile);
      // detalles extra
      if (w.k === 'planter') {
        const plants = new THREE.Mesh(new THREE.BoxGeometry(w.w - 8, 14, w.h - 8), lam('plants', { color: 0x4f8a3c }));
        plants.position.set(w.x + w.w / 2, w.z + 5, w.y + w.h / 2);
        group.add(plants);
      }
      if (w.k === 'fountain') {
        const water = new THREE.Mesh(new THREE.BoxGeometry(w.w - 20, 2, w.h - 20), new THREE.MeshLambertMaterial({ color: 0x4fa3d9 }));
        water.position.set(w.x + w.w / 2, w.z + 1, w.y + w.h / 2);
        group.add(water);
        const spout = new THREE.Mesh(new THREE.CylinderGeometry(8, 12, 60, 12), lam('fountain', { map: TEX.stone() }));
        spout.position.set(w.x + w.w / 2, w.z + 30, w.y + w.h / 2);
        group.add(spout);
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

  return { build };
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
