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
let pitch = 0; // mirar arriba (+) / abajo (-)

// Girar la vista con el dedo: horizontal = girar, vertical = subir/bajar la mira.
function turnView(dx, dy) {
  const s = lookSens();
  yaw += dx * s;
  pitch = Math.max(-MAP.MAX_PITCH, Math.min(MAP.MAX_PITCH, pitch - dy * s * 0.8));
}

// Marca de impacto en la mira y avisos de headshot / monedas
let hitMark = { at: -1e9, head: false, kill: false };
const popups = []; // textos que suben y se desvanecen

const isFrozen = (s) => !!(s && s.m && s.m.ph !== 'playing');
let lobbyAt = 0;

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
// Personaje: 2 estilos por equipo
let chosenStyle = 0;
try { chosenStyle = localStorage.getItem('rva_style') === '1' ? 1 : 0; } catch (e) {}
const charPreviews = {}; // imagenes generadas con la vista 3D (se llenan mas abajo)
function refreshChars() {
  document.querySelectorAll('.char').forEach((b) => {
    const s = +b.dataset.s;
    b.classList.toggle('sel', s === chosenStyle);
    const teams = chosenTeam === 'red' || chosenTeam === 'blue' ? [chosenTeam] : ['red', 'blue'];
    const imgs = teams.map((t) => (charPreviews[t + s] ? `<img src="${charPreviews[t + s]}" alt="">` : '')).join('');
    const names = teams.map((t) => MAP.STYLES[t][s].name).join(' / ');
    const desc = teams.length === 1 ? MAP.STYLES[teams[0]][s].desc : 'Según el equipo que te toque';
    b.innerHTML = `<div class="imgs">${imgs}</div><div><b>${names}</b><span>${desc}</span></div>`;
  });
}
document.querySelectorAll('.char').forEach((b) => {
  b.onclick = () => {
    chosenStyle = +b.dataset.s;
    try { localStorage.setItem('rva_style', chosenStyle); } catch (e) {}
    refreshChars();
  };
});
document.querySelectorAll('.teams button').forEach((b) => b.addEventListener('click', refreshChars));
refreshChars();

// Paso 2: modo de juego y minutos
let menuMode = 'tdm';
let menuMins = 5;
try {
  menuMode = localStorage.getItem('rva_mode') === 'elim' ? 'elim' : 'tdm';
  menuMins = Math.min(MAP.MAX_MINUTES, Math.max(1, +localStorage.getItem('rva_mins') || 5));
} catch (e) {}
function refreshMenuMode() {
  document.querySelectorAll('.mmode').forEach((b) => b.classList.toggle('sel', b.dataset.mode === menuMode));
  document.getElementById('mMinVal').textContent = menuMins;
}
document.querySelectorAll('.mmode').forEach((b) => {
  b.onclick = () => { menuMode = b.dataset.mode; refreshMenuMode(); refreshLobby(); };
});
document.getElementById('mMinLess').onclick = () => { menuMins = Math.max(1, menuMins - 1); refreshMenuMode(); };
document.getElementById('mMinMore').onclick = () => { menuMins = Math.min(MAP.MAX_MINUTES, menuMins + 1); refreshMenuMode(); };
refreshMenuMode();

// Muestra que se esta jugando ahora, para decidir si unirse o empezar otra
const MODE_NAME = { tdm: 'Reaparición', elim: 'Eliminación' };
function refreshLobby() {
  if (myId || !state) return;
  const humans = state.p.filter((p) => !p.bt);
  const info = document.getElementById('lobbyInfo');
  const play = document.getElementById('play');
  const playNew = document.getElementById('playNew');
  if (!humans.length) {
    info.textContent = `No hay nadie jugando: se empieza una partida de ${MODE_NAME[menuMode]} de ${menuMins} min.`;
    play.textContent = 'JUGAR';
    playNew.style.display = 'none';
  } else {
    const m = state.m;
    const names = humans.map((p) => p.n).slice(0, 4).join(', ') + (humans.length > 4 ? '…' : '');
    info.textContent = `Partida en curso: ${MODE_NAME[m.mo]} · quedan ${fmtTime(m.tl)} · ${humans.length} jugando (${names}).`;
    play.textContent = 'UNIRME A ESTA PARTIDA';
    playNew.textContent = `Empezar una nueva de ${MODE_NAME[menuMode]} (reinicia para todos)`;
    playNew.style.display = 'block';
  }
}

function enterGame(startNew) {
  const name = nameInput.value.trim() || 'Jugador';
  try {
    localStorage.setItem('rva_name', name);
    localStorage.setItem('rva_mode', menuMode);
    localStorage.setItem('rva_mins', menuMins);
  } catch (e) {}
  // si no hay nadie, el servidor arranca la partida con este modo; si hay gente, solo con startNew
  socket.emit('join', { name, team: chosenTeam, style: chosenStyle, mode: menuMode, minutes: menuMins, start: !!startNew });
  joinData = { name, team: chosenTeam, style: chosenStyle }; // para reconectar sin reiniciar la partida
  menu.style.display = 'none';
  document.body.classList.add('playing');
  const el = document.documentElement;
  if (el.requestFullscreen && isTouch) {
    el.requestFullscreen().then(() => {
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }).catch(() => {});
  }
}
document.getElementById('play').onclick = () => enterGame(false);
document.getElementById('playNew').onclick = () => enterGame(true);

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
  // Solo se compra estando vivo dentro de la base propia (equipar se puede en cualquier lado)
  const inBase = !!(me && me.al && MAP.inBase(me.t, me.x, me.y));
  const shopBtn = document.getElementById('shopBtn');
  document.getElementById('coinsBtn').textContent = '$' + coins + (inBase || !me ? '' : ' · solo en base');
  shopBtn.classList.toggle('away', !!me && !inBase);
  document.getElementById('coinsShop').textContent = '$' + coins;
  document.getElementById('shopWarn').style.display = me && !inBase ? 'block' : 'none';
  const grs = me ? me.gr : 0;
  const key = coins + '|' + owned + '|' + eq + '|' + grs + '|' + inBase;
  if (!force && (key === shopKey || !shop.classList.contains('open'))) return;
  shopKey = key;
  shopList.innerHTML = '';
  const pct = (v) => Math.round(Math.max(8, Math.min(100, v * 100))) + '%';
  for (const w of MAP.WEAPONS) {
    const has = owned & (1 << w.id);
    const card = document.createElement('div');
    card.className = 'wcard' + (eq === w.id ? ' eq' : '');
    card.innerHTML = `
      <div class="top"><span class="nm">${w.name}</span><span class="pr">${w.price ? '$' + w.price : 'Gratis'}</span></div>
      <div class="ds">${w.desc}</div>
      <div class="stat"><span>Daño</span><i style="--v:${pct((w.dmg * w.pellets) / 90)}"></i></div>
      <div class="stat"><span>Cadencia</span><i style="--v:${pct(80 / w.rate)}"></i></div>
      <div class="stat"><span>Alcance</span><i style="--v:${pct(w.life / 0.9)}"></i></div>`;
    const btn = document.createElement('button');
    if (eq === w.id) { btn.textContent = 'Equipada'; btn.disabled = true; }
    else if (has) { btn.textContent = 'Equipar'; btn.className = 'eqb'; }
    else if (!inBase) { btn.textContent = 'En tu base'; btn.className = 'buy'; btn.disabled = true; }
    else {
      btn.textContent = coins >= w.price ? `Comprar $${w.price}` : `Faltan $${w.price - coins}`;
      btn.className = 'buy';
      btn.disabled = coins < w.price;
    }
    btn.onclick = () => { btn.blur(); socket.emit('buy', { w: w.id }); };
    card.appendChild(btn);
    shopList.appendChild(card);
  }

  // Granada (se compra por unidad, maximo GR.max)
  const G = MAP.GRENADE;
  const card = document.createElement('div');
  card.className = 'wcard' + (grs ? ' eq' : '');
  card.innerHTML = `
    <div class="top"><span class="nm">💣 Granada</span><span class="pr">$${G.price}</span></div>
    <div class="ds">Más cerca del centro, más daño. Máx. ${G.max}.</div>
    <div class="stat"><span>Tenés</span><b>${grs} / ${G.max}</b></div>`;
  const btn = document.createElement('button');
  if (grs >= G.max) { btn.textContent = 'Llevás el máximo'; btn.disabled = true; }
  else if (!inBase) { btn.textContent = 'En tu base'; btn.className = 'buy'; btn.disabled = true; }
  else if (coins >= G.price) { btn.textContent = `Comprar $${G.price}`; btn.className = 'buy'; }
  else { btn.textContent = `Faltan $${G.price - coins}`; btn.className = 'buy'; btn.disabled = true; }
  btn.onclick = () => { btn.blur(); socket.emit('buyGrenade'); };
  card.appendChild(btn);
  shopList.appendChild(card);
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
  if (!myId && performance.now() - lobbyAt > 500) { lobbyAt = performance.now(); refreshLobby(); }
});
socket.on('hit', (d) => {
  const now = performance.now();
  hitMark = { at: now, head: !!d.h, kill: !!d.k };
  if (d.h) popups.push({ at: now, text: `¡HEADSHOT! +$${MAP.HEADSHOT_COINS}`, color: '#ff5a5a', big: true });
  else if (d.k) popups.push({ at: now, text: `Baja +$${MAP.KILL_COINS}`, color: '#f2c94c' });
});
socket.on('feed', (msg) => {
  feed.push({ msg, at: performance.now() });
  if (feed.length > 5) feed.shift();
});

function reconcile(mine, s) {
  if (!mine.al || !pred.ok || isFrozen(s)) {
    if (mine.al && !pred.ok) { yaw = mine.a; pitch = 0; } // al reaparecer miro hacia el enemigo
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
// Boton de granada: arriba a la izquierda del de disparo
function grenadeBtn() {
  const fb = fireBtn();
  const r = Math.max(26, fb.r * 0.5);
  return { x: fb.x - fb.r - r - 6, y: fb.y - fb.r - r + 10, r };
}
let lastThrowAt = -1e9;
function throwGrenade() {
  const now = performance.now();
  if (now - lastThrowAt < MAP.GRENADE.cooldown) return;
  lastThrowAt = now;
  socket.emit('throw');
}

hud.addEventListener('touchstart', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const fb = fireBtn();
    const gb = grenadeBtn();
    const onFire = Math.hypot(t.clientX - fb.x, t.clientY - fb.y) < fb.r * 1.4;
    if (Math.hypot(t.clientX - gb.x, t.clientY - gb.y) < gb.r * 1.25) {
      throwGrenade();
    } else if (onFire && fireId === null) {
      fireId = t.identifier;
      touchShoot = true;
      fire.x = fire.lx = fire.sx = t.clientX;
      fire.y = fire.ly = fire.sy = t.clientY;
    } else if (t.clientX <= W / 2 && joy.id === null) {
      joy.id = t.identifier;
      joy.ox = joy.x = t.clientX;
      joy.oy = joy.y = t.clientY;
      joy.jx = joy.jy = 0;
    } else if (t.clientX > W / 2 && look.id === null) {
      look.id = t.identifier;
      look.x = t.clientX;
      look.y = t.clientY;
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
      turnView(t.clientX - fire.lx, t.clientY - fire.ly);
      fire.lx = t.clientX;
      fire.ly = t.clientY;
      fire.x = t.clientX;
      fire.y = t.clientY;
    } else if (t.identifier === look.id) {
      turnView(t.clientX - look.x, t.clientY - look.y);
      look.x = t.clientX;
      look.y = t.clientY;
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
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyG' && myId && document.activeElement !== nameInput) throwGrenade();
});
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
  if (document.pointerLockElement === hud) {
    yaw += e.movementX * LOOK_SENS_MOUSE;
    pitch = Math.max(-MAP.MAX_PITCH, Math.min(MAP.MAX_PITCH, pitch - e.movementY * LOOK_SENS_MOUSE));
  }
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
  const out = { mx: mv.mx, my: mv.my, a: yaw, p: pitch, shoot: shooting(), q: ++seq };
  hist.push({ q: seq, x: pred.x, y: pred.y });
  if (hist.length > 120) hist.shift();
  socket.volatile.emit('input', out);
}, 1000 / 30);

// ---------- Escena 3D ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
} catch (e) {
  window.showErr('Este navegador no soporta gráficos 3D (WebGL 2). Probá con Chrome actualizado. Detalle: ' + e.message);
  throw e;
}
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
  addBox(w.x, w.y, w.w, w.h, w.z, small ? wallMats[2] : wallMats[i % 2 === 0 ? 0 : 1]);
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
// Manga del brazo en primera persona, con el color de tu personaje
const sleeveMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
const sleeve = new THREE.Mesh(new THREE.BoxGeometry(7, 7, 26), sleeveMat);
sleeve.position.set(1, -9, 18);
sleeve.rotation.x = 0.35;
viewGun.add(sleeve);
const hand = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), new THREE.MeshLambertMaterial({ color: 0xf0c9a0 }));
hand.position.set(0, -7, 6);
viewGun.add(hand);
let sleeveKey = '';
function setViewSleeve(team, s) {
  const key = team + s;
  if (key === sleeveKey) return;
  sleeveKey = key;
  const st = styleOf(team, s);
  sleeveMat.color.setHex(st.body);
  hand.material.color.setHex(st.skin);
}
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

// Cara: ojos blancos con pupila y una boquita (para que no den miedo)
const eyeGeo = new THREE.SphereGeometry(3.4, 10, 8);
const pupilGeo = new THREE.SphereGeometry(1.8, 8, 6);
const mouthGeo = new THREE.BoxGeometry(1.4, 1.5, 6);
const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const pupilMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
const mouthMat = new THREE.MeshLambertMaterial({ color: 0x7a3a2a });
function addFace(g) {
  for (const z of [-5, 5]) {
    const e = new THREE.Mesh(eyeGeo, eyeWhiteMat); e.position.set(11.2, 80.5, z); g.add(e);
    const p = new THREE.Mesh(pupilGeo, pupilMat); p.position.set(14.2, 80.7, z); g.add(p);
  }
  const m = new THREE.Mesh(mouthGeo, mouthMat); m.position.set(10.9, 72.8, 0); g.add(m);
}

// Arma un personaje segun equipo y estilo. Mira hacia +x. Devuelve las partes que se animan.
const styleOf = (team, s) => (MAP.STYLES[team] || MAP.STYLES.red)[s === 1 ? 1 : 0];
function buildCharacter(team, s) {
  const st = styleOf(team, s);
  const mats = []; // materiales propios (para liberarlos despues)
  const mat = (color, basic) => {
    const m = basic ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color });
    mats.push(m);
    return m;
  };
  const add = (g, geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };

  const g = new THREE.Group();
  const teamMat = new THREE.MeshLambertMaterial({ color: st.body, transparent: true });
  mats.push(teamMat);
  const accent = mat(st.accent);
  const skin = mat(st.skin);
  const legM = mat(st.legs);

  add(g, bodyGeo, teamMat, 0, 45, 0); // torso (22-68)
  const legL = add(g, legGeo, legM, 0, 11, -8);
  const legR = add(g, legGeo, legM, 0, 11, 8);
  add(g, headGeo, skin, 0, 80, 0); // cabeza (67-93)
  // brazos
  add(g, new THREE.BoxGeometry(8, 26, 8), teamMat, 4, 50, -20);
  add(g, new THREE.BoxGeometry(22, 7, 7), teamMat, 12, BULLET_H, 14);

  // Cabeza (todos con ojos y boca)
  addFace(g);
  if (st.hat === 'helmet') {
    add(g, new THREE.SphereGeometry(14.8, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), accent, 0, 85, 0);
    add(g, new THREE.CylinderGeometry(15.5, 15.5, 2.5, 16), accent, 0, 85, 0);
  } else if (st.hat === 'bandana') {
    add(g, new THREE.CylinderGeometry(13.6, 13.6, 4, 16), accent, 0, 87, 0);
    add(g, new THREE.BoxGeometry(6, 3, 3), accent, -15, 86, 3);
    add(g, new THREE.BoxGeometry(18, 9, 3), accent, -1, 95, 0); // cresta
  } else if (st.hat === 'goggles') {
    add(g, new THREE.SphereGeometry(14.8, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), accent, 0, 85, 0);
    // antiparras levantadas sobre el casco (asi se le ven los ojos)
    const gog = add(g, new THREE.BoxGeometry(4, 5, 20), mat(0x6fe0ff, true), 11, 90, 0);
    gog.rotation.z = -0.5;
  } else if (st.hat === 'cap') {
    add(g, new THREE.CylinderGeometry(13.9, 13.9, 7, 16), accent, 0, 89, 0);
    add(g, new THREE.BoxGeometry(14, 2, 20), accent, 14, 86, 0); // visera
  }

  // Equipamiento
  if (st.gear === 'vest') {
    add(g, new THREE.CylinderGeometry(18.5, 20, 30, 14), accent, 0, 50, 0);
    add(g, new THREE.BoxGeometry(5, 9, 8), mat(0x3a2a20), 19, 46, -6);
    add(g, new THREE.BoxGeometry(5, 9, 8), mat(0x3a2a20), 19, 46, 6);
  } else if (st.gear === 'backpack') {
    add(g, new THREE.BoxGeometry(11, 28, 24), mat(0x3b2f2a), -21, 50, 0);
    add(g, new THREE.BoxGeometry(4, 8, 20), accent, -27, 58, 0);
  } else if (st.gear === 'pads') {
    add(g, new THREE.SphereGeometry(8.5, 10, 8), accent, 0, 65, -17);
    add(g, new THREE.SphereGeometry(8.5, 10, 8), accent, 0, 65, 17);
    add(g, new THREE.CylinderGeometry(19.5, 19.5, 5, 14), accent, 0, 30, 0); // cinturon
  } else if (st.gear === 'scarf') {
    add(g, new THREE.CylinderGeometry(15, 17, 7, 14), accent, 0, 69, 0);
    add(g, new THREE.BoxGeometry(4, 18, 6), accent, -16, 60, 6);
    add(g, new THREE.BoxGeometry(10, 24, 20), mat(0x2b2f3a), -20, 50, 0);
  }

  const gunMatA = new THREE.MeshLambertMaterial({ color: 0x1d2128 });
  mats.push(gunMatA);
  const gun = add(g, gunGeo, gunMatA, 26, BULLET_H, 12);
  const muzzle = add(g, new THREE.SphereGeometry(5, 8, 8), mat(0xffe27a, true), 46, BULLET_H, 12);
  return { g, teamMat, legL, legR, gun, gunMatA, muzzle, mats };
}

// Fotos de los 4 personajes para el menu (se dibujan una vez con un renderizador chico)
function renderCharPreviews() {
  try {
    const PW = 110, PH = 150;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(2);
    r.setSize(PW, PH);
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x445066, 2.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.8);
    dl.position.set(1, 1.4, 0.8);
    sc.add(dl);
    const cam = new THREE.PerspectiveCamera(30, PW / PH, 1, 2000);
    cam.position.set(185, 70, 95);
    cam.lookAt(0, 52, 0);
    for (const t of ['red', 'blue']) {
      for (const s of [0, 1]) {
        const c = buildCharacter(t, s);
        c.muzzle.visible = false;
        sc.add(c.g);
        r.render(sc, cam);
        charPreviews[t + s] = r.domElement.toDataURL('image/png');
        sc.remove(c.g);
        c.mats.forEach((m) => m.dispose());
      }
    }
    r.dispose();
    r.forceContextLoss();
  } catch (e) { /* sin vista previa: el menu funciona igual */ }
  refreshChars();
}

function getAvatar(p) {
  let a = avatars[p.id];
  if (a && a.team === p.t && a.style === p.sy) return a;
  if (a) removeAvatar(p.id);
  const { g, teamMat, legL, legR, gun, gunMatA, muzzle, mats } = buildCharacter(p.t, p.sy);
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.8;
  const label = makeLabel();
  const root = new THREE.Group();
  root.add(g);
  root.add(shadow);
  root.add(label.sprite);
  scene.add(root);
  a = avatars[p.id] = { root, body: g, teamMat, muzzle, label, legL, legR, team: p.t, style: p.sy, walk: 0, lx: 0, ly: 0, gun, gunMatA, mats, w: -1 };
  return a;
}
function removeAvatar(id) {
  const a = avatars[id];
  if (!a) return;
  scene.remove(a.root);
  a.mats.forEach((m) => m.dispose());
  a.root.traverse((o) => { if (o.geometry && !o.isSprite && !SHARED_GEOS.has(o.geometry)) o.geometry.dispose(); });
  a.label.tex.dispose();
  a.label.sprite.material.dispose();
  delete avatars[id];
}
const SHARED_GEOS = new Set([bodyGeo, headGeo, visorGeo, gunGeo, legGeo, shadowGeo, eyeGeo, pupilGeo, mouthGeo]);
renderCharPreviews();

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

// Granadas y explosiones
const grenadeGeo = new THREE.SphereGeometry(6, 10, 8);
const grenadeMat = new THREE.MeshLambertMaterial({ color: 0x3f5a2e });
const grenadeLightMat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
const grenadePool = [];
function getGrenade(i) {
  if (!grenadePool[i]) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(grenadeGeo, grenadeMat));
    const led = new THREE.Mesh(new THREE.SphereGeometry(2.2, 6, 6), grenadeLightMat);
    led.position.y = 6;
    g.add(led);
    g.userData.led = led;
    scene.add(g);
    grenadePool[i] = g;
  }
  return grenadePool[i];
}
const blasts = []; // explosiones visibles
const blastGeo = new THREE.SphereGeometry(1, 20, 14);
let shakeUntil = 0, shakeAmt = 0;
socket.on('boom', (b) => {
  const now = performance.now();
  const fire = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.9, depthWrite: false }));
  fire.position.set(b.x, Math.max(10, b.z), b.y);
  scene.add(fire);
  // anillo en el piso que muestra el alcance
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1, 40),
    new THREE.MeshBasicMaterial({ color: 0xff7020, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(b.x, 1.5, b.y);
  scene.add(ring);
  blasts.push({ fire, ring, at: now });
  // sacudon de camara si estoy cerca
  const d = Math.hypot(pred.x - b.x, pred.y - b.y);
  const R = MAP.GRENADE.radius;
  if (d < R * 2) { shakeUntil = now + 450; shakeAmt = 7 * (1 - d / (R * 2)); }
});
function updateBlasts(now) {
  const R = MAP.GRENADE.radius;
  for (let i = blasts.length - 1; i >= 0; i--) {
    const b = blasts[i];
    const t = (now - b.at) / 550;
    if (t >= 1) {
      scene.remove(b.fire); scene.remove(b.ring);
      b.fire.material.dispose(); b.ring.material.dispose(); b.ring.geometry.dispose();
      blasts.splice(i, 1);
      continue;
    }
    b.fire.scale.setScalar(20 + R * 0.55 * Math.sqrt(t));
    b.fire.material.opacity = 0.9 * (1 - t);
    b.fire.material.color.setHex(t < 0.25 ? 0xfff0a0 : 0xff7a20);
    b.ring.scale.setScalar(R * Math.min(1, t * 2.2));
    b.ring.material.opacity = 0.6 * (1 - t);
  }
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
  camera.rotation.x = deadCam ? 0 : pitch;
  camera.rotation.z = deadCam ? 0.35 : 0;

  // Arma: retroceso y fogonazo
  const firing = meP && meP.al && shooting() && !isFrozen(state);
  const kick = firing ? Math.max(0, Math.sin(now / 28)) : 0;
  viewGun.position.set(GUN_POS.x, GUN_POS.y + (moving ? Math.sin(now / 90) * 0.6 : 0), GUN_POS.z + kick * 2.5);
  flash.visible = firing && kick > 0.6;
  viewGun.visible = !!meP && meP.al;
  if (meP) { setViewWeapon(meP.w); setViewSleeve(meP.t, meP.sy); }

  // Otros jugadores
  for (const p of state.p) {
    if (p.id === myId) continue;
    const a = getAvatar(p);
    const d = disp[p.id];
    a.root.visible = p.al;
    if (!p.al) continue;
    a.root.position.set(d.x, 0, d.y);
    a.body.rotation.y = -d.a;
    a.gun.rotation.z = p.pt || 0; // el arma sube/baja segun hacia donde apunta
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
  for (const [, x, y, vx, vy, team, z, vz] of state.b) {
    const g = getBullet(i++);
    g.visible = true;
    g.position.set(x + vx * bdt, (z ?? BULLET_H) + (vz || 0) * bdt, y + vy * bdt);
    g.rotation.order = 'YZX';
    g.rotation.y = -Math.atan2(vy, vx);
    g.rotation.z = Math.atan2(vz || 0, Math.hypot(vx, vy));
    g.userData.s.material = bulletMats[team];
    g.userData.t.material = tracerMats[team];
  }
  for (; i < bulletPool.length; i++) bulletPool[i].visible = false;

  // Granadas: la luz titila mas rapido cuando esta por explotar
  let gi = 0;
  for (const [, x, y, z, left] of state.g || []) {
    const g = getGrenade(gi++);
    g.visible = true;
    g.position.set(x, z, y);
    g.userData.led.visible = Math.floor(now / Math.max(60, left / 6)) % 2 === 0;
  }
  for (; gi < grenadePool.length; gi++) grenadePool[gi].visible = false;
  updateBlasts(now);

  // Sacudon de camara por explosion cercana
  if (now < shakeUntil) {
    const k = (shakeUntil - now) / 450;
    camera.position.x += (Math.random() - 0.5) * shakeAmt * k;
    camera.position.y += (Math.random() - 0.5) * shakeAmt * k;
  }
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

  // Marca de impacto: X blanca al pegar, roja y mas grande en la cabeza
  const now = performance.now();
  const since = now - hitMark.at;
  if (since < 220) {
    const s = hitMark.head ? 15 : hitMark.kill ? 12 : 10;
    ctx.globalAlpha = 1 - since / 220;
    ctx.strokeStyle = hitMark.head ? '#ff4040' : '#fff';
    ctx.lineWidth = hitMark.head ? 3.5 : 2.5;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(cx + sx * (s - 6), cy + sy * (s - 6));
      ctx.lineTo(cx + sx * s, cy + sy * s);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawPopups(now) {
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    const t = (now - p.at) / 1200;
    if (t >= 1) { popups.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - t * t;
    ctx.textAlign = 'center';
    ctx.font = `bold ${p.big ? 26 : 18}px system-ui, sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    const y = H / 2 - 50 - t * 40;
    ctx.strokeText(p.text, W / 2, y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, W / 2, y);
    ctx.globalAlpha = 1;
  }
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
      ctx.fillText((MAP.WEAPONS[meP.w] || MAP.WEAPONS[0]).name + (meP.gr ? `  ·  💣 x${meP.gr}${isTouch ? '' : ' (G)'}` : ''), bx, by - 8);
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

  // Boton de granada (con la cantidad que tenes)
  const meP = state && state.p.find((p) => p.id === myId);
  const grs = meP ? meP.gr : 0;
  const gb = grenadeBtn();
  ctx.globalAlpha = grs ? 0.9 : 0.35;
  ctx.fillStyle = 'rgba(60,90,50,0.75)';
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(gb.x, gb.y, gb.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.font = `${Math.round(gb.r * 0.9)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('💣', gb.x, gb.y + 1);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillText('x' + grs, gb.x + gb.r * 0.75, gb.y + gb.r + 4);
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
  drawPopups(now);
  drawMinimap(meP);
  drawHUD(now, meP);
  drawControls();
}
requestAnimationFrame(frame);
window.__gameReady = true;
