import * as THREE from '/vendor/three/three.module.js';

const socket = io();
const hud = document.getElementById('hud');
const ctx = hud.getContext('2d');
const menu = document.getElementById('menu');
const nameInput = document.getElementById('name');

const COLORS = { red: '#ff4d5e', blue: '#4d9dff' };
const TEAM_HEX = { red: 0xe23b4c, blue: 0x2f7fe6 };
const P_R = MAP.P_R;
const SPEED = MAP.SPEED;
const WALL_H = 130;
const EYE_H = 62;
const BULLET_H = 48;
const TURN_SPEED = 2.6; // rad/s con el analogico a fondo
const LOOK_SENS_TOUCH = 0.006;
const LOOK_SENS_MOUSE = 0.0025;
const INTERP_MS = 100;
const isTouch = matchMedia('(pointer: coarse)').matches;

let myId = null;
let joinData = null;
let state = null;
let stateAt = 0;
const disp = {}; // posiciones suavizadas por jugador
let feed = [];
let myHitAt = 0;
let W = 0, H = 0, dpr = 1;

// Prediccion local
const pred = { x: 0, y: 0, ok: false };
let seq = 0;
const hist = [];
let lastFrame = performance.now();
let yaw = 0; // hacia donde miro (radianes, 0 = derecha del mapa)

const isFrozen = (s) => !!(s && s.m && s.m.ph !== 'playing');

// ---------- Menu ----------
let chosenTeam = 'auto';
try { nameInput.value = localStorage.getItem('rva_name') || ''; } catch (e) {}
document.querySelectorAll('.teams button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.teams button').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
    chosenTeam = b.dataset.team;
  };
});
document.getElementById('play').onclick = () => {
  const name = nameInput.value.trim() || 'Jugador';
  try { localStorage.setItem('rva_name', name); } catch (e) {}
  joinData = { name, team: chosenTeam };
  socket.emit('join', joinData);
  menu.style.display = 'none';
  document.body.classList.add('playing');
  const el = document.documentElement;
  if (el.requestFullscreen && isTouch) {
    el.requestFullscreen().then(() => {
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }).catch(() => {});
  }
};

// ---------- Ventanas: partida/bots y tienda ----------
const botsPanel = document.getElementById('botsPanel');
const shop = document.getElementById('shop');
function openModal(el) {
  if (document.pointerLockElement) document.exitPointerLock();
  el.classList.add('open');
  if (el === shop) renderShop(true);
}
document.getElementById('botsBtn').onclick = () => openModal(botsPanel);
document.getElementById('shopBtn').onclick = () => openModal(shop);
document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => b.closest('.modal').classList.remove('open');
});
// tocar afuera de la ventana la cierra
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
});
addEventListener('keydown', (e) => {
  if (e.code === 'KeyB' && myId && document.activeElement !== nameInput) {
    shop.classList.contains('open') ? shop.classList.remove('open') : openModal(shop);
  }
});

// Bots
let botTeam = 'auto';
botsPanel.querySelectorAll('.bt').forEach((b) => {
  b.onclick = () => {
    botsPanel.querySelectorAll('.bt').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
    botTeam = b.dataset.team;
  };
});
botsPanel.querySelectorAll('.add').forEach((b) => {
  b.onclick = () => socket.emit('addBots', { count: +b.dataset.n, team: botTeam });
});
document.getElementById('botClear').onclick = () => socket.emit('clearBots');

// Nueva partida
const MODE_INFO = {
  tdm: 'Reaparecés a los 3 segundos. Al terminar el tiempo gana el equipo con más bajas.',
  elim: 'Sin reaparición: la ronda la gana el equipo que elimina a todos los del otro. Al terminar el tiempo gana el que ganó más rondas.',
};
let newMode = 'tdm';
let newMins = 5;
const minVal = document.getElementById('minVal');
function refreshMatchForm() {
  botsPanel.querySelectorAll('.mode').forEach((b) => b.classList.toggle('sel', b.dataset.mode === newMode));
  document.getElementById('modeInfo').textContent = MODE_INFO[newMode];
  minVal.textContent = newMins;
}
botsPanel.querySelectorAll('.mode').forEach((b) => {
  b.onclick = () => { newMode = b.dataset.mode; refreshMatchForm(); };
});
document.getElementById('minLess').onclick = () => { newMins = Math.max(1, newMins - 1); refreshMatchForm(); };
document.getElementById('minMore').onclick = () => { newMins = Math.min(MAP.MAX_MINUTES, newMins + 1); refreshMatchForm(); };
document.getElementById('startMatch').onclick = () => {
  socket.emit('newMatch', { mode: newMode, minutes: newMins });
  botsPanel.classList.remove('open');
};
refreshMatchForm();

// Tienda
const shopList = document.getElementById('shopList');
let shopKey = '';
const maxDps = Math.max(...MAP.WEAPONS.map((w) => (w.dmg * w.pellets * 1000) / w.rate));
function renderShop(force) {
  const me = state && state.p.find((p) => p.id === myId);
  const coins = me ? me.c : MAP.START_COINS;
  const owned = me ? me.o : 1;
  const eq = me ? me.w : 0;
  document.getElementById('coinsBtn').textContent = '$' + coins;
  document.getElementById('coinsShop').textContent = '$' + coins;
  const key = coins + '|' + owned + '|' + eq;
  if (!force && (key === shopKey || !shop.classList.contains('open'))) return;
  shopKey = key;
  shopList.innerHTML = '';
  for (const w of MAP.WEAPONS) {
    const has = owned & (1 << w.id);
    const card = document.createElement('div');
    card.className = 'wcard' + (eq === w.id ? ' eq' : '');
    const pct = (v) => Math.round(Math.max(8, Math.min(100, v * 100))) + '%';
    card.innerHTML = `
      <div class="nm">${w.name}</div>
      <div class="pr">${w.price ? '$' + w.price : 'Gratis'}</div>
      <div class="ds">${w.desc}</div>
      <div class="stat"><span>Daño</span><i style="--v:${pct((w.dmg * w.pellets) / 90)}"></i></div>
      <div class="stat"><span>Cadencia</span><i style="--v:${pct(80 / w.rate)}"></i></div>
      <div class="stat"><span>Alcance</span><i style="--v:${pct(w.life / 0.9)}"></i></div>
      <div class="stat"><span>Daño/seg</span><i style="--v:${pct((w.dmg * w.pellets * 1000) / w.rate / maxDps)}"></i></div>`;
    const btn = document.createElement('button');
    if (eq === w.id) { btn.textContent = 'Equipada'; btn.disabled = true; }
    else if (has) { btn.textContent = 'Equipar'; btn.className = 'eqb'; }
    else {
      btn.textContent = coins >= w.price ? `Comprar $${w.price}` : `Faltan $${w.price - coins}`;
      btn.className = 'buy';
      btn.disabled = coins < w.price;
    }
    btn.onclick = () => { btn.blur(); socket.emit('buy', { w: w.id }); };
    card.appendChild(btn);
    shopList.appendChild(card);
  }
}

// que la barra espaciadora (disparo en PC) no vuelva a apretar botones
document.querySelectorAll('#tools button, .sheet button').forEach((b) => b.addEventListener('click', () => b.blur()));

// ---------- Red ----------
socket.on('connect', () => {
  if (joinData) socket.emit('join', joinData);
});
socket.on('welcome', (d) => {
  myId = d.id;
  pred.ok = false;
  if (joinData) joinData.team = d.team;
});
socket.on('state', (s) => {
  state = s;
  stateAt = performance.now();
  for (const p of s.p) {
    let d = disp[p.id];
    if (!d) d = disp[p.id] = { x: p.x, y: p.y, a: p.a, hp: p.hp, hitAt: 0, al: p.al };
    if (p.hp < d.hp && p.al) {
      d.hitAt = performance.now();
      if (p.id === myId) myHitAt = d.hitAt;
    }
    if (!p.al && d.al && p.id === myId) myHitAt = performance.now();
    if (p.al && !d.al) { d.x = p.x; d.y = p.y; d.a = p.a; d.buf = []; }
    // historial de posiciones para interpolar suave entre actualizaciones
    (d.buf || (d.buf = [])).push({ t: stateAt, x: p.x, y: p.y, a: p.a });
    if (d.buf.length > 12) d.buf.shift();
    d.hp = p.hp;
    d.al = p.al;
  }
  for (const id in disp) {
    if (!s.p.some((p) => p.id === id)) {
      delete disp[id];
      removeAvatar(id);
    }
  }
  const mine = s.p.find((p) => p.id === myId);
  if (mine) reconcile(mine, s);
  renderShop(false);
});
socket.on('feed', (msg) => {
  feed.push({ msg, at: performance.now() });
  if (feed.length > 5) feed.shift();
});

function reconcile(mine, s) {
  if (!mine.al || !pred.ok || isFrozen(s)) {
    if (mine.al && !pred.ok) yaw = mine.a; // al reaparecer miro hacia el enemigo
    pred.x = mine.x;
    pred.y = mine.y;
    pred.ok = mine.al && !isFrozen(s);
    hist.length = 0;
    return;
  }
  while (hist.length && hist[0].q < mine.q) hist.shift();
  const h = hist.length && hist[0].q === mine.q ? hist[0] : null;
  if (!h) {
    if (Math.hypot(mine.x - pred.x, mine.y - pred.y) > 250) { pred.x = mine.x; pred.y = mine.y; }
    return;
  }
  const ex = mine.x - h.x;
  const ey = mine.y - h.y;
  const err = Math.hypot(ex, ey);
  if (err > 150) {
    pred.x = mine.x; pred.y = mine.y; hist.length = 0;
  } else if (err > 4) {
    const k = 0.25;
    pred.x += ex * k; pred.y += ey * k;
    for (const e of hist) { e.x += ex * k; e.y += ey * k; }
  }
}

// ---------- Controles ----------
const JOY_R = 60;
const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0, jx: 0, jy: 0 };
const look = { id: null, x: 0 };
let fireId = null;
const fire = { x: 0, y: 0, lx: 0, sx: 0, sy: 0 }; // dedo sobre el boton de disparo
let touchShoot = false;
// Sensibilidad del giro tactil: proporcional a cuanto movés el dedo (sin aceleracion),
// asi un movimiento chico gira poco y uno grande gira mas, siempre parejo.
let sensLevel = 5;
try { sensLevel = +localStorage.getItem('rva_sens') || 5; } catch (e) {}
const lookSens = () => 0.004 + sensLevel * 0.0016; // nivel 5 ≈ 0,7 grados por pixel
const sensInputs = document.querySelectorAll('.sens');
const sensLabels = document.querySelectorAll('.sensVal');
function setSens(v) {
  sensLevel = Math.max(1, Math.min(10, +v || 5));
  sensInputs.forEach((i) => { i.value = sensLevel; });
  sensLabels.forEach((l) => { l.textContent = sensLevel; });
  try { localStorage.setItem('rva_sens', sensLevel); } catch (e) {}
}
sensInputs.forEach((i) => i.addEventListener('input', () => setSens(i.value)));
setSens(sensLevel);
const keys = {};
let mouseShoot = false;

function fireBtn() {
  const r = Math.max(48, Math.min(70, H * 0.13));
  return { x: W - r - 34, y: H - r - 34, r };
}

hud.addEventListener('touchstart', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const fb = fireBtn();
    const onFire = Math.hypot(t.clientX - fb.x, t.clientY - fb.y) < fb.r * 1.4;
    if (onFire && fireId === null) {
      fireId = t.identifier;
      touchShoot = true;
      fire.x = fire.lx = fire.sx = t.clientX;
      fire.y = fire.sy = t.clientY;
    } else if (t.clientX <= W / 2 && joy.id === null) {
      joy.id = t.identifier;
      joy.ox = joy.x = t.clientX;
      joy.oy = joy.y = t.clientY;
      joy.jx = joy.jy = 0;
    } else if (t.clientX > W / 2 && look.id === null) {
      look.id = t.identifier;
      look.x = t.clientX;
    }
  }
}, { passive: false });

hud.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) {
      let dx = t.clientX - joy.ox;
      let dy = t.clientY - joy.oy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_R) {
        joy.ox += (dx / len) * (len - JOY_R);
        joy.oy += (dy / len) * (len - JOY_R);
        dx = t.clientX - joy.ox;
        dy = t.clientY - joy.oy;
      }
      joy.x = t.clientX;
      joy.y = t.clientY;
      joy.jx = dx / JOY_R;
      joy.jy = dy / JOY_R;
    } else if (t.identifier === fireId) {
      // arrastrar el boton de disparo apunta mientras disparas
      yaw += (t.clientX - fire.lx) * lookSens();
      fire.lx = t.clientX;
      fire.x = t.clientX;
      fire.y = t.clientY;
    } else if (t.identifier === look.id) {
      yaw += (t.clientX - look.x) * lookSens();
      look.x = t.clientX;
    }
  }
}, { passive: false });

function touchEnd(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.id = null; joy.jx = joy.jy = 0; }
    if (t.identifier === fireId) { fireId = null; touchShoot = false; }
    if (t.identifier === look.id) look.id = null;
  }
}
hud.addEventListener('touchend', touchEnd, { passive: false });
hud.addEventListener('touchcancel', touchEnd, { passive: false });

// Teclado + mouse (PC)
addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'Space') e.preventDefault(); });
addEventListener('keyup', (e) => { keys[e.code] = false; });
hud.addEventListener('mousedown', () => {
  if (isTouch) return;
  if (document.pointerLockElement !== hud && hud.requestPointerLock) {
    try { const r = hud.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) {}
  }
  mouseShoot = true;
});
addEventListener('mouseup', () => { mouseShoot = false; });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === hud) yaw += e.movementX * LOOK_SENS_MOUSE;
});

const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);

// Movimiento en el mundo a partir de los controles y hacia donde miro.
function currentMove() {
  let fwd = 0, side = 0;
  if (joy.id !== null) {
    // el analogico mueve en todas las direcciones (adelante/atras y de costado)
    fwd = -dead(joy.jy);
    side = dead(joy.jx);
  } else {
    if (keys.KeyW || keys.ArrowUp) fwd += 1;
    if (keys.KeyS || keys.ArrowDown) fwd -= 1;
    if (keys.KeyD) side += 1;
    if (keys.KeyA) side -= 1;
  }
  let mx = Math.cos(yaw) * fwd + Math.cos(yaw + Math.PI / 2) * side;
  let my = Math.sin(yaw) * fwd + Math.sin(yaw + Math.PI / 2) * side;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  return { mx, my };
}

function updateTurn(dt) {
  if (keys.ArrowLeft) yaw -= TURN_SPEED * dt;
  if (keys.ArrowRight) yaw += TURN_SPEED * dt;
}

const shooting = () => touchShoot || mouseShoot || !!keys.Space;

setInterval(() => {
  if (!myId) return;
  const mv = currentMove();
  const out = { mx: mv.mx, my: mv.my, a: yaw, shoot: shooting(), q: ++seq };
  hist.push({ q: seq, x: pred.x, y: pred.y });
  if (hist.length > 120) hist.shift();
  socket.volatile.emit('input', out);
}, 1000 / 30);

// ---------- Escena 3D ----------
const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
document.getElementById('gl').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const SKY = 0x5f7fa8;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 700, 2300);

const camera = new THREE.PerspectiveCamera(70, 1, 1, 4000);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xdde8ff, 0x4a4f5a, 2.6));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
sun.position.set(0.6, 1, 0.35);
scene.add(sun);

// Suelo con grilla
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3a4250';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#353c49';
  g.fillRect(0, 0, 128, 128);
  g.fillRect(128, 128, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(MAP.W / 200, MAP.H / 200);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(MAP.W, MAP.H),
  new THREE.MeshLambertMaterial({ map: gridTexture() })
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(MAP.W / 2, 0, MAP.H / 2);
scene.add(floor);

// Bases de cada equipo
for (const t of ['red', 'blue']) {
  const s = MAP.spawns[t];
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(s.w + 80, s.h + 80),
    new THREE.MeshBasicMaterial({ color: TEAM_HEX[t], transparent: true, opacity: 0.22, depthWrite: false })
  );
  base.rotation.x = -Math.PI / 2;
  base.position.set(s.x + s.w / 2, 0.5, s.y + s.h / 2);
  scene.add(base);
}

// Paredes
const wallMats = [0xb8a58a, 0x9fb0c4, 0xc49a6c, 0x8fa89a].map((c) => new THREE.MeshLambertMaterial({ color: c }));
const edgeMat = new THREE.LineBasicMaterial({ color: 0x20252e });
function addBox(x, y, w, h, height, mat) {
  const geo = new THREE.BoxGeometry(w, height, h);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x + w / 2, height / 2, y + h / 2);
  scene.add(m);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
  e.position.copy(m.position);
  scene.add(e);
}
MAP.walls.forEach((w, i) => {
  // cajas chicas mas bajas y color madera; el resto alterna colores
  const small = w.w <= 100 && w.h <= 100;
  addBox(w.x, w.y, w.w, w.h, small ? 70 : WALL_H, small ? wallMats[2] : wallMats[i % 2 === 0 ? 0 : 1]);
});
// Muros del borde
const borderMat = new THREE.MeshLambertMaterial({ color: 0x5b6475 });
const B = 40, BH = 170;
addBox(-B, -B, MAP.W + 2 * B, B, BH, borderMat);
addBox(-B, MAP.H, MAP.W + 2 * B, B, BH, borderMat);
addBox(-B, 0, B, MAP.H, BH, borderMat);
addBox(MAP.W, 0, B, MAP.H, BH, borderMat);

// Arma en primera persona
const viewGun = new THREE.Group();
const gunMat = new THREE.MeshLambertMaterial({ color: 0x2b2f36 });
const gunBody = new THREE.Mesh(new THREE.BoxGeometry(5, 6, 34), gunMat);
viewGun.add(gunBody);
const gunGrip = new THREE.Mesh(new THREE.BoxGeometry(4, 10, 5), gunMat);
gunGrip.position.set(0, -6, 8);
viewGun.add(gunGrip);
const flash = new THREE.Mesh(
  new THREE.SphereGeometry(3.5, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0xffe27a })
);
flash.position.set(0, 0, -20);
viewGun.add(flash);
// Aspecto de cada arma: largo, grosor y color.
const GUN_STYLE = [
  { len: 34, w: 5, h: 6, color: 0x2b2f36 }, // basica
  { len: 18, w: 4.5, h: 7, color: 0x6a7280 }, // pistola
  { len: 46, w: 8, h: 7, color: 0x6b4a2b }, // escopeta
  { len: 30, w: 5, h: 5, color: 0x15181d, mag: true }, // metralleta
];
const gunMag = new THREE.Mesh(new THREE.BoxGeometry(3.5, 12, 5), gunMat);
gunMag.position.set(0, -8, -4);
viewGun.add(gunMag);
let viewWeapon = -1;
function setViewWeapon(w) {
  if (w === viewWeapon) return;
  viewWeapon = w;
  const st = GUN_STYLE[w] || GUN_STYLE[0];
  gunBody.scale.set(st.w / 5, st.h / 6, st.len / 34);
  gunBody.material = new THREE.MeshLambertMaterial({ color: st.color });
  flash.position.z = -st.len / 2 - 3;
  flash.scale.setScalar(w === 2 ? 1.8 : 1);
  gunMag.visible = !!st.mag;
}
setViewWeapon(0);
const GUN_POS = new THREE.Vector3(11, -10, -28);
viewGun.scale.setScalar(0.6);
viewGun.position.copy(GUN_POS);
camera.add(viewGun);

// Avatares de otros jugadores
const avatars = {};
const bodyGeo = new THREE.CylinderGeometry(16, 19, 46, 14);
const headGeo = new THREE.SphereGeometry(13, 14, 12);
const visorGeo = new THREE.BoxGeometry(6, 6, 18);
const gunGeo = new THREE.BoxGeometry(32, 6, 6);
const legGeo = new THREE.BoxGeometry(10, 22, 10);
const shadowGeo = new THREE.CircleGeometry(22, 16);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });
const skinMat = new THREE.MeshLambertMaterial({ color: 0xf0c9a0 });
const darkMat = new THREE.MeshLambertMaterial({ color: 0x1d2128 });

function makeLabel() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 72;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  sprite.scale.set(64, 18, 1);
  sprite.position.y = 104;
  return { c, tex, sprite, key: '' };
}
function drawLabel(l, name, hp, team) {
  const key = name + '|' + hp;
  if (l.key === key) return;
  l.key = key;
  const g = l.c.getContext('2d');
  g.clearRect(0, 0, 256, 72);
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.strokeText(name, 128, 32);
  g.fillStyle = COLORS[team];
  g.fillText(name, 128, 32);
  g.fillStyle = 'rgba(0,0,0,0.7)';
  g.fillRect(48, 46, 160, 16);
  g.fillStyle = hp > 50 ? '#5ee07a' : hp > 25 ? '#f2c94c' : '#ff5a5a';
  g.fillRect(50, 48, 156 * Math.max(0, hp) / 100, 12);
  l.tex.needsUpdate = true;
}

function getAvatar(p) {
  let a = avatars[p.id];
  if (a && a.team === p.t) return a;
  if (a) removeAvatar(p.id);
  const g = new THREE.Group();
  const teamMat = new THREE.MeshLambertMaterial({ color: TEAM_HEX[p.t], transparent: true });
  const body = new THREE.Mesh(bodyGeo, teamMat);
  body.position.y = 45;
  g.add(body);
  const legL = new THREE.Mesh(legGeo, darkMat); legL.position.set(0, 11, -8); g.add(legL);
  const legR = new THREE.Mesh(legGeo, darkMat); legR.position.set(0, 11, 8); g.add(legR);
  const head = new THREE.Mesh(headGeo, skinMat);
  head.position.y = 80;
  g.add(head);
  const visor = new THREE.Mesh(visorGeo, darkMat);
  visor.position.set(11, 82, 0);
  g.add(visor);
  const gunMatA = new THREE.MeshLambertMaterial({ color: 0x1d2128 });
  const gun = new THREE.Mesh(gunGeo, gunMatA);
  gun.position.set(26, BULLET_H, 12);
  g.add(gun);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffe27a }));
  muzzle.position.set(46, BULLET_H, 12);
  g.add(muzzle);
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.8;
  const label = makeLabel();
  const root = new THREE.Group();
  root.add(g);
  root.add(shadow);
  root.add(label.sprite);
  scene.add(root);
  a = avatars[p.id] = { root, body: g, teamMat, muzzle, label, legL, legR, team: p.t, walk: 0, lx: 0, ly: 0, gun, gunMatA, w: -1 };
  return a;
}
function removeAvatar(id) {
  const a = avatars[id];
  if (!a) return;
  scene.remove(a.root);
  a.teamMat.dispose();
  a.gunMatA.dispose();
  a.label.tex.dispose();
  a.label.sprite.material.dispose();
  delete avatars[id];
}

// Balas
const bulletGeo = new THREE.SphereGeometry(3.5, 8, 6);
const bulletMats = [
  new THREE.MeshBasicMaterial({ color: 0xffb0b8 }),
  new THREE.MeshBasicMaterial({ color: 0xb0d4ff }),
];
const tracerGeo = new THREE.BoxGeometry(1, 1.6, 1.6);
const tracerMats = [
  new THREE.MeshBasicMaterial({ color: 0xff5a6a, transparent: true, opacity: 0.55 }),
  new THREE.MeshBasicMaterial({ color: 0x5aa0ff, transparent: true, opacity: 0.55 }),
];
const bulletPool = [];
function getBullet(i) {
  if (!bulletPool[i]) {
    const g = new THREE.Group();
    const s = new THREE.Mesh(bulletGeo, bulletMats[0]);
    const t = new THREE.Mesh(tracerGeo, tracerMats[0]);
    t.scale.x = 34;
    t.position.x = -17;
    g.add(s); g.add(t);
    g.userData = { s, t };
    scene.add(g);
    bulletPool[i] = g;
  }
  return bulletPool[i];
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth;
  H = innerHeight;
  hud.width = W * dpr;
  hud.height = H * dpr;
  hud.style.width = W + 'px';
  hud.style.height = H + 'px';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 2));
  renderer.setSize(W, H);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

function update3D(now, meP, dt) {
  // Camara
  const cam = meP ? (meP.al ? pred : disp[myId]) : { x: MAP.W / 2, y: MAP.H / 2 };
  const deadCam = meP && !meP.al;
  camera.position.set(cam.x, deadCam ? 18 : EYE_H, cam.y);
  camera.rotation.y = -yaw - Math.PI / 2;
  camera.rotation.z = deadCam ? 0.35 : 0;

  // Arma: retroceso y fogonazo
  const firing = meP && meP.al && shooting() && !isFrozen(state);
  const kick = firing ? Math.max(0, Math.sin(now / 28)) : 0;
  viewGun.position.set(GUN_POS.x, GUN_POS.y + (moving ? Math.sin(now / 90) * 0.6 : 0), GUN_POS.z + kick * 2.5);
  flash.visible = firing && kick > 0.6;
  viewGun.visible = !!meP && meP.al;
  if (meP) setViewWeapon(meP.w);

  // Otros jugadores
  for (const p of state.p) {
    if (p.id === myId) continue;
    const a = getAvatar(p);
    const d = disp[p.id];
    a.root.visible = p.al;
    if (!p.al) continue;
    a.root.position.set(d.x, 0, d.y);
    a.body.rotation.y = -d.a;
    // caminar
    const sp = Math.hypot(d.x - a.lx, d.y - a.ly);
    a.lx = d.x; a.ly = d.y;
    if (sp > 0.5) a.walk += dt * 12;
    const sw = sp > 0.5 ? Math.sin(a.walk) * 6 : 0;
    a.legL.position.x = sw;
    a.legR.position.x = -sw;
    if (a.w !== p.w) {
      // arma en la mano segun lo que compro
      a.w = p.w;
      const st = GUN_STYLE[p.w] || GUN_STYLE[0];
      a.gun.scale.set(st.len / 32, st.h / 6, st.w / 6);
      a.gun.position.x = 10 + st.len / 2;
      a.gunMatA.color.setHex(st.color);
      a.muzzle.position.x = 14 + st.len;
    }
    a.muzzle.visible = p.sf;
    const hit = now - d.hitAt < 110;
    a.teamMat.emissive.setHex(hit ? 0xffffff : 0x000000);
    a.teamMat.opacity = p.sp ? 0.45 + 0.25 * Math.sin(now / 80) : 1;
    drawLabel(a.label, p.n, p.hp, p.t);
  }

  // Balas (extrapoladas)
  const bdt = Math.min((now - stateAt) / 1000, 0.1);
  let i = 0;
  for (const [, x, y, vx, vy, team] of state.b) {
    const g = getBullet(i++);
    g.visible = true;
    g.position.set(x + vx * bdt, BULLET_H, y + vy * bdt);
    g.rotation.y = -Math.atan2(vy, vx);
    g.userData.s.material = bulletMats[team];
    g.userData.t.material = tracerMats[team];
  }
  for (; i < bulletPool.length; i++) bulletPool[i].visible = false;
}

// ---------- HUD 2D ----------
function drawMinimap(meP) {
  const mw = Math.min(170, W * 0.22);
  const mh = mw * (MAP.H / MAP.W);
  const x0 = 12, y0 = 12;
  const k = mw / MAP.W;
  ctx.fillStyle = 'rgba(10,14,20,0.7)';
  ctx.fillRect(x0, y0, mw, mh);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  for (const w of MAP.walls) ctx.fillRect(x0 + w.x * k, y0 + w.y * k, Math.max(1, w.w * k), Math.max(1, w.h * k));
  for (const p of state.p) {
    if (!p.al || p.id === myId) continue;
    if (meP && p.t !== meP.t) continue; // solo compañeros
    const d = disp[p.id];
    ctx.fillStyle = COLORS[p.t];
    ctx.beginPath(); ctx.arc(x0 + d.x * k, y0 + d.y * k, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  if (meP && meP.al) {
    // yo: flecha hacia donde miro
    const mx = x0 + pred.x * k, my = y0 + pred.y * k;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(yaw);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-2, 0); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, mw, mh);
}

function drawCrosshair(meP) {
  if (!meP || !meP.al) return;
  const cx = W / 2, cy = H / 2;
  const gap = shooting() ? 9 : 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - gap - 9, cy); ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + 9, cy);
  ctx.moveTo(cx, cy - gap - 9); ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + 9);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(cx - 1, cy - 1, 2, 2);
}

function fmtTime(ms) {
  const t = Math.ceil(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function drawHUD(now, meP) {
  const m = state.m;
  const elim = m.mo === 'elim';
  // En eliminacion el marcador muestra rondas ganadas; en reaparicion, bajas.
  const s = elim ? m.r : state.s;
  ctx.textAlign = 'center';
  const cx = W / 2;
  ctx.fillStyle = 'rgba(10,14,20,0.7)';
  ctx.fillRect(cx - 120, 6, 240, 50);
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillStyle = COLORS.red;
  ctx.fillText(s.red, cx - 75, 36);
  ctx.fillStyle = COLORS.blue;
  ctx.fillText(s.blue, cx + 75, 36);
  // reloj
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillStyle = m.tl < 30000 && m.ph === 'playing' ? '#ff6b6b' : '#fff';
  ctx.fillText(fmtTime(m.tl), cx, 32);
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText(elim ? `Eliminación · Ronda ${m.rn}` : 'Reaparición · bajas', cx, 49);
  if (elim) {
    const vivos = { red: 0, blue: 0 };
    for (const p of state.p) if (p.al) vivos[p.t]++;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`${vivos.red} vivos`, cx - 75, 49);
    ctx.fillText(`${vivos.blue} vivos`, cx + 75, 49);
  }

  // Feed
  ctx.textAlign = 'right';
  ctx.font = '14px system-ui, sans-serif';
  let fy = 26;
  feed = feed.filter((f) => now - f.at < 5000);
  for (const f of feed) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const tw = ctx.measureText(f.msg).width;
    ctx.fillRect(W - tw - 22, fy - 15, tw + 12, 21);
    ctx.fillStyle = '#fff';
    ctx.fillText(f.msg, W - 16, fy);
    fy += 24;
  }

  if (meP) {
    ctx.textAlign = 'center';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`Bajas ${meP.k}  ·  Muertes ${meP.d}`, cx, 72);

    // Mi vida (abajo al centro)
    if (meP.al) {
      const bw = Math.min(220, W * 0.3), bx = cx - bw / 2, by = H - 30;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - 3, by - 3, bw + 6, 18);
      ctx.fillStyle = meP.hp > 50 ? '#5ee07a' : meP.hp > 25 ? '#f2c94c' : '#ff5a5a';
      ctx.fillRect(bx, by, bw * Math.max(0, meP.hp) / 100, 12);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(Math.max(0, meP.hp), cx, by + 10);
      // arma actual y monedas
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.textAlign = 'left';
      ctx.fillText((MAP.WEAPONS[meP.w] || MAP.WEAPONS[0]).name, bx, by - 8);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#f2c94c';
      ctx.fillText('$' + meP.c, bx + bw, by - 8);
      ctx.textAlign = 'center';
    }

    const since = now - myHitAt;
    if (since < 300) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(255,0,0,${0.45 * (1 - since / 300)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    if (!meP.al && m.ph === 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = 'bold 34px system-ui, sans-serif';
      if (meP.rs < 0) {
        // eliminacion: esperar a que termine la ronda
        const mios = state.p.filter((p) => p.t === meP.t && p.al).length;
        ctx.fillText(meP.d ? 'Te eliminaron' : 'Esperando la próxima ronda', W / 2, H / 2 - 10);
        ctx.font = '20px system-ui, sans-serif';
        ctx.fillText(mios ? `Quedan ${mios} de tu equipo en pie` : 'Tu equipo no tiene más jugadores', W / 2, H / 2 + 24);
      } else {
        ctx.fillText('Te eliminaron', W / 2, H / 2 - 10);
        ctx.font = '20px system-ui, sans-serif';
        ctx.fillText(`Reaparecés en ${Math.ceil(meP.rs / 1000)}…`, W / 2, H / 2 + 24);
      }
    }
  }

  // Carteles de fin de ronda / fin de partida
  if (m.ph !== 'playing') {
    const end = m.ph === 'matchEnd';
    ctx.fillStyle = end ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = `bold ${end ? 46 : 34}px system-ui, sans-serif`;
    ctx.fillStyle = m.bt === 'red' || m.bt === 'blue' ? COLORS[m.bt] : '#fff';
    ctx.fillText(m.ban, W / 2, H / 2 - (end ? 30 : 0));
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    if (end) {
      const pts = elim ? m.r : state.s;
      ctx.fillText(`${elim ? 'Rondas' : 'Bajas'}: Rojo ${pts.red} – ${pts.blue} Azul`, W / 2, H / 2 + 8);
      const mvp = [...state.p].sort((a, b) => b.k - a.k)[0];
      if (mvp && mvp.k) ctx.fillText(`Mejor jugador: ${mvp.n} (${mvp.k} bajas)`, W / 2, H / 2 + 34);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(`Nueva partida en ${Math.ceil(m.pl / 1000)}…`, W / 2, H / 2 + 64);
    } else {
      ctx.fillText(`Siguiente ronda en ${Math.ceil(m.pl / 1000)}…`, W / 2, H / 2 + 34);
    }
  }

  if (!isTouch && meP && document.pointerLockElement !== hud) {
    ctx.textAlign = 'center';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('Hacé click para usar el mouse  ·  Esc para soltarlo  ·  B abre la tienda', W / 2, H - 70);
  }
}

function drawControls() {
  if (!isTouch) return;
  const baseX = joy.id !== null ? joy.ox : 110;
  const baseY = joy.id !== null ? joy.oy : H - 110;
  const knobX = joy.id !== null ? joy.x : baseX;
  const knobY = joy.id !== null ? joy.y : baseY;
  ctx.globalAlpha = joy.id !== null ? 0.9 : 0.4;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(baseX, baseY, JOY_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath(); ctx.arc(knobX, knobY, 26, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  const base = fireBtn();
  ctx.fillStyle = fireId !== null ? 'rgba(255,90,90,0.35)' : 'rgba(255,90,90,0.4)';
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(base.x, base.y, base.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // Al arrastrarlo, la mira del boton sigue al dedo (como un analogico)
  const fb = { ...base };
  if (fireId !== null) {
    let ox = fire.x - fire.sx, oy = fire.y - fire.sy;
    const len = Math.hypot(ox, oy), max = base.r * 0.6;
    if (len > max) { ox *= max / len; oy *= max / len; }
    fb.x += ox; fb.y += oy; fb.r = base.r * 0.75;
    ctx.fillStyle = 'rgba(255,90,90,0.85)';
    ctx.beginPath(); ctx.arc(fb.x, fb.y, fb.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.arc(fb.x, fb.y, fb.r * 0.35, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(fb.x - fb.r * 0.6, fb.y); ctx.lineTo(fb.x - fb.r * 0.2, fb.y);
  ctx.moveTo(fb.x + fb.r * 0.2, fb.y); ctx.lineTo(fb.x + fb.r * 0.6, fb.y);
  ctx.moveTo(fb.x, fb.y - fb.r * 0.6); ctx.lineTo(fb.x, fb.y - fb.r * 0.2);
  ctx.moveTo(fb.x, fb.y + fb.r * 0.2); ctx.lineTo(fb.x, fb.y + fb.r * 0.6);
  ctx.stroke();
}

// ---------- Bucle principal ----------
let moving = false;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!state || !myId) {
    renderer.render(scene, camera);
    return;
  }

  // Otros jugadores: se dibujan ~100 ms "en el pasado", interpolando entre
  // dos actualizaciones del servidor, asi se mueven fluido y sin saltos.
  const renderT = now - INTERP_MS;
  for (const p of state.p) {
    const d = disp[p.id];
    if (!d || p.id === myId || !d.buf || !d.buf.length) continue;
    const buf = d.buf;
    let i = buf.length - 1;
    while (i > 0 && buf[i - 1].t > renderT) i--;
    const b1 = buf[i];
    const b0 = i > 0 ? buf[i - 1] : b1;
    if (renderT >= b1.t || b0 === b1) {
      d.x = b1.x; d.y = b1.y; d.a = b1.a;
    } else {
      const k = Math.max(0, Math.min(1, (renderT - b0.t) / (b1.t - b0.t)));
      d.x = b0.x + (b1.x - b0.x) * k;
      d.y = b0.y + (b1.y - b0.y) * k;
      d.a = lerpAngle(b0.a, b1.a, k);
    }
  }

  const meP = state.p.find((p) => p.id === myId);
  moving = false;
  if (meP && pred.ok && meP.al && !isFrozen(state)) {
    updateTurn(dt);
    const mv = currentMove();
    moving = mv.mx !== 0 || mv.my !== 0;
    pred.x += mv.mx * SPEED * dt;
    pred.y += mv.my * SPEED * dt;
    MAP.resolve(pred, P_R);
  }
  if (meP && disp[myId] && !meP.al) {
    disp[myId].x = meP.x;
    disp[myId].y = meP.y;
  }

  update3D(now, meP, dt);
  renderer.render(scene, camera);

  drawCrosshair(meP);
  drawMinimap(meP);
  drawHUD(now, meP);
  drawControls();
}
requestAnimationFrame(frame);
