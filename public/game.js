import * as THREE from '/vendor/three/three.module.js';
import { createWorld, minimapColor, buildBlaster, toon, roundBox } from './world.js';

const socket = io();
const hud = document.getElementById('hud');
const ctx = hud.getContext('2d');
const menu = document.getElementById('menu');
const nameInput = document.getElementById('name');

const COLORS = { red: '#ff4d5e', blue: '#4d9dff' };
const BOT_GREEN = '#39ff14'; // verde fluor para los nombres de bots
let notices = []; // avisos para el creador de la partida
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
// Identificacion de esta pestaña (sobrevive a recargar la pagina): si se corta la conexion,
// el servidor nos devuelve nuestro jugador en vez de dejar uno viejo congelado
const clientId = (() => {
  const nuevo = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    let c = sessionStorage.getItem('rva_cid');
    if (!c) { c = nuevo(); sessionStorage.setItem('rva_cid', c); }
    return c;
  } catch (e) { return nuevo(); }
})();
let state = null;
let stateAt = 0;
const disp = {}; // posiciones suavizadas por jugador
let feed = [];
let myHitAt = 0;
let W = 0, H = 0, dpr = 1;

// Prediccion local
const pred = { x: 0, y: 0, z: 0, ok: false };
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
// ---------- Salas ----------
// Paso 0: elegir sala (unirse a una publica, crear una publica/privada o entrar con codigo).
// Si se crea: nombre/equipo → personaje → mapa → modo. Si se entra a una existente: nombre/equipo → personaje.
let roomAction = null; // { type: 'create', pub } | { type: 'join', code, name }
let roomsList = [];
const roomErr = document.getElementById('roomErr');
const codeInput = document.getElementById('codeInput');
const MODE_NAME = { tdm: 'DeathMatch', elim: 'Guerra' };

function renderRooms() {
  const box = document.getElementById('roomList');
  if (!roomsList.length) {
    box.innerHTML = '<div class="empty">No hay salas públicas ahora. ¡Creá una!</div>';
    return;
  }
  box.innerHTML = '';
  for (const r of roomsList) {
    const row = document.createElement('div');
    row.className = 'roomRow';
    const map = (MAP.MAPS[r.map] || {}).name || '';
    row.innerHTML = `<div class="ri"><b>${escapeHtml(r.name)}</b>${map} · ${MODE_NAME[r.mode]} · ${r.humans} jugando${r.bots ? ` + ${r.bots} bots` : ''} · quedan ${fmtTime(r.tl)}</div>`;
    const b = document.createElement('button');
    b.textContent = 'Unirme';
    b.onclick = () => { roomAction = { type: 'join', code: r.c, name: r.name }; showStep(1); };
    row.appendChild(b);
    box.appendChild(row);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
socket.on('rooms', (list) => {
  roomsList = list || [];
  if (!myId && wizStep === 0) renderRooms();
});
document.getElementById('createPub').onclick = () => { roomAction = { type: 'create', pub: true }; showStep(1); };
document.getElementById('createPriv').onclick = () => { roomAction = { type: 'create', pub: false }; showStep(1); };
document.getElementById('codeJoin').onclick = () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 5) { roomErr.textContent = 'El código tiene 5 letras/números.'; return; }
  roomErr.textContent = '';
  roomAction = { type: 'join', code };
  showStep(1);
};
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('codeJoin').click(); });

// Menu paso a paso
let wizStep = 0;
const stepsFor = () => (roomAction && roomAction.type === 'join' ? [1, 2] : [1, 2, 3, 4]);
function showStep(n) {
  wizStep = n;
  document.querySelectorAll('.wstep').forEach((s) => { s.hidden = +s.dataset.step !== wizStep; });
  const seq = stepsFor();
  const idx = seq.indexOf(n);
  const dots = document.querySelector('.dots');
  dots.style.visibility = n === 0 ? 'hidden' : 'visible';
  dots.innerHTML = seq.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('');
  document.querySelectorAll('.wstep .step[data-title]').forEach((el) => {
    const s = +el.closest('.wstep').dataset.step;
    el.textContent = `Paso ${seq.indexOf(s) + 1} de ${seq.length} · ${el.dataset.title}`;
  });
  // en el paso 2, si se entra a una sala existente, ese es el ultimo paso
  const joining = roomAction && roomAction.type === 'join';
  document.querySelector('[data-step="2"] .next').textContent = joining ? 'ENTRAR A LA SALA' : 'Siguiente ›';
  document.getElementById('roomInfo').textContent = !roomAction ? ''
    : joining ? `Vas a entrar a ${roomAction.name ? roomAction.name : 'la sala'} (código ${roomAction.code}).`
      : `Vas a crear una sala ${roomAction.pub ? 'pública (cualquiera puede entrar)' : 'privada (solo con el código)'}.`;
  if (n === 0) { renderRooms(); socket.emit('listRooms'); }
  if (n === 2) refreshChars();
  if (n === 3) refreshMaps();
  if (n === 4) refreshLobby();
}
document.querySelectorAll('.wstep .next').forEach((b) => {
  b.onclick = () => {
    const seq = stepsFor();
    const i = seq.indexOf(wizStep);
    if (i === seq.length - 1) enterGame(); else showStep(seq[i + 1]);
  };
});
document.querySelectorAll('.wstep .back').forEach((b) => {
  b.onclick = () => {
    const seq = stepsFor();
    const i = seq.indexOf(wizStep);
    if (i <= 0) { roomAction = null; showStep(0); } else showStep(seq[i - 1]);
  };
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { nameInput.blur(); showStep(2); }
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

// Resumen de la sala que se va a crear (ultimo paso)
function refreshLobby() {
  if (myId || !roomAction || roomAction.type !== 'create') return;
  const info = document.getElementById('lobbyInfo');
  info.textContent = `Sala ${roomAction.pub ? 'pública' : 'privada'}: ${MODE_NAME[menuMode]} en ${MAP.MAPS[menuMap].name}, ${menuMins} min.`
    + (roomAction.pub ? '' : ' Te damos un código para pasarle a tus amigos.');
  document.getElementById('play').textContent = 'CREAR SALA';
  document.getElementById('playNew').style.display = 'none';
}

// ---------- Mapas: tarjetas con un dibujo del plano visto desde arriba ----------
let menuMap = 'desert';
try { if (MAP.MAPS[localStorage.getItem('rva_map')]) menuMap = localStorage.getItem('rva_map'); } catch (e) {}
const MAP_BG = { desert: '#d8b47c', warehouse: '#7d8288', town: '#4a4d52' };
function mapThumb(id, wpx) {
  const m = MAP.MAPS[id];
  const c = document.createElement('canvas');
  const hpx = Math.round((wpx * m.H) / m.W);
  c.width = wpx * 2; c.height = hpx * 2;
  const g = c.getContext('2d');
  const k = (wpx * 2) / m.W;
  g.fillStyle = MAP_BG[id] || '#555'; g.fillRect(0, 0, c.width, c.height);
  for (const d of m.deco) if (d.t === 'floor') { g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(d.x * k, d.y * k, d.w * k, d.h * k); }
  g.fillStyle = 'rgba(214,58,58,0.55)'; const r = m.spawns.red; g.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
  g.fillStyle = 'rgba(46,111,209,0.55)'; const b = m.spawns.blue; g.fillRect(b.x * k, b.y * k, b.w * k, b.h * k);
  for (const w of m.walls) {
    g.fillStyle = w.c !== undefined && w.k !== 'container' ? '#' + w.c.toString(16).padStart(6, '0') : w.k === 'container' ? '#5f8fc4' : w.k === 'rack' ? '#2b2f36' : w.k === 'crate' || w.k === 'pallet' ? '#9b6a3a' : '#5a4630';
    g.fillRect(w.x * k, w.y * k, Math.max(1, w.w * k), Math.max(1, w.h * k));
  }
  g.fillStyle = '#39ff14';
  for (const rr of m.ramps) g.fillRect(rr.x * k, rr.y * k, rr.w * k, rr.h * k);
  return c;
}
function refreshMaps() {
  const box = document.getElementById('maps');
  if (!box.children.length) {
    for (const id of MAP.MAP_IDS) {
      const m = MAP.MAPS[id];
      const b = document.createElement('button');
      b.className = 'mapc';
      b.dataset.map = id;
      b.appendChild(mapThumb(id, 140));
      b.insertAdjacentHTML('beforeend', `<b>${m.name}</b><span>${m.desc}</span>`);
      b.onclick = () => {
        menuMap = id;
        try { localStorage.setItem('rva_map', id); } catch (e) {}
        refreshMaps();
      };
      box.appendChild(b);
    }
  }
  box.querySelectorAll('.mapc').forEach((b) => b.classList.toggle('sel', b.dataset.map === menuMap));
}

function enterGame() {
  if (!roomAction) { showStep(0); return; }
  const name = nameInput.value.trim() || 'Jugador';
  try {
    localStorage.setItem('rva_name', name);
    localStorage.setItem('rva_mode', menuMode);
    localStorage.setItem('rva_mins', menuMins);
  } catch (e) {}
  const base = { name, team: chosenTeam, style: chosenStyle, cid: clientId };
  if (roomAction.type === 'create') {
    socket.emit('createRoom', { ...base, public: roomAction.pub, mode: menuMode, minutes: menuMins, map: menuMap });
  } else {
    socket.emit('joinRoom', { ...base, code: roomAction.code });
  }
  joinData = { ...base, code: roomAction.type === 'join' ? roomAction.code : null }; // para reconectar
  menu.style.display = 'none';
  document.body.classList.add('playing');
  const el = document.documentElement;
  if (el.requestFullscreen && isTouch) {
    el.requestFullscreen().then(() => {
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }).catch(() => {});
  }
}
document.getElementById('play').onclick = () => enterGame();

// Volver al menu (al salir o si no se pudo entrar a la sala)
function backToMenu(step) {
  myId = null;
  pred.ok = false;
  touchShoot = mouseShoot = false;
  fireId = null; joy.id = null; look.id = null;
  document.querySelectorAll('.modal').forEach((m) => m.classList.remove('open'));
  if (document.pointerLockElement) document.exitPointerLock();
  document.body.classList.remove('playing');
  menu.style.display = '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  roomAction = null;
  showStep(step || 0);
}
socket.on('joinError', (msg) => {
  joinData = null;
  backToMenu(0);
  roomErr.textContent = msg;
});
// Link de invitacion: ?sala=CODIGO entra directo a esa sala
{
  const code = new URLSearchParams(location.search).get('sala');
  if (code) {
    codeInput.value = code.toUpperCase();
    roomAction = { type: 'join', code: code.toUpperCase() };
  }
}

// ---------- Ventanas: partida/bots y tienda ----------
const botsPanel = document.getElementById('botsPanel');
const shop = document.getElementById('shop');
function openModal(el) {
  if (document.pointerLockElement) document.exitPointerLock();
  el.classList.add('open');
  if (el === shop) renderShop(true);
}
document.getElementById('botsBtn').onclick = () => {
  // el formulario arranca con el mapa que se esta jugando
  if (state && state.m && state.m.mp) { newMap = state.m.mp; refreshMatchForm(); }
  syncMatchPanel();
  openModal(botsPanel);
};

// Salir al menu principal
const exitAsk = document.getElementById('exitAsk');
document.getElementById('exitBtn').onclick = () => openModal(exitAsk);
document.getElementById('exitYes').onclick = () => {
  exitAsk.classList.remove('open');
  socket.emit('leave');
  joinData = null; // que no vuelva a entrar solo al reconectar
  backToMenu(0);
};
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
// Completar equipos con bots (lo puede prender/apagar cualquiera; los avisos le llegan al creador)
const autoFillBox = document.getElementById('autoFill');
autoFillBox.onchange = () => socket.emit('autoFill', { on: autoFillBox.checked });
function syncMatchPanel() {
  if (!state || !state.m) return;
  if (document.activeElement !== autoFillBox) autoFillBox.checked = !!state.m.af;
  const cr = state.p.find((p) => p.id === state.m.cr);
  const iAmCreator = state.m.cr === myId;
  document.getElementById('creatorInfo').textContent =
    iAmCreator ? '👑 Sos el creador de la sala: podés cambiar el mapa, la partida y los bots.'
      : cr ? `👑 El creador de la sala es ${cr.n}: solo él o ella puede cambiar el mapa, la partida y los bots.` : '';
  // lo que es solo del creador se ve apagado para los demas
  botsPanel.querySelectorAll('.adminOnly').forEach((el) => el.classList.toggle('locked', !iAmCreator));
  // datos de la sala para invitar
  const room = state.m.room || myRoom;
  if (room) {
    document.getElementById('roomName').textContent = room.name;
    document.getElementById('roomCode').textContent = room.c;
    document.getElementById('roomPriv').textContent = room.pub ? 'pública' : '🔒 privada';
  }
}
// Compartir el link de la sala (en el celular abre el menu de compartir; si no, lo copia)
document.getElementById('shareRoom').onclick = async () => {
  const room = (state && state.m && state.m.room) || myRoom;
  if (!room) return;
  const url = `${location.origin}${location.pathname}?sala=${room.c}`;
  const text = `¡Vení a jugar Rojo vs Azul conmigo! Sala ${room.c}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Rojo vs Azul', text, url }); return; }
  } catch (e) { /* cancelado */ }
  try {
    await navigator.clipboard.writeText(url);
    feed.push({ msg: '🔗 Link copiado: ' + url, at: performance.now() });
  } catch (e) {
    feed.push({ msg: 'Pasales este link: ' + url, at: performance.now() });
  }
};
document.getElementById('switchTeam').onclick = () => {
  socket.emit('switchTeam');
  botsPanel.classList.remove('open');
};
document.getElementById('changeMapNow').onclick = () => {
  socket.emit('changeMap', { map: newMap });
  botsPanel.classList.remove('open');
};

// Nueva partida
const MODE_INFO = {
  tdm: 'Reaparecés a los 3 segundos. Al terminar el tiempo gana el equipo con más bajas.',
  elim: 'Sin reaparición: la ronda la gana el equipo que elimina a todos los del otro. Al terminar el tiempo gana el que ganó más rondas.',
};
let newMode = 'tdm';
let newMins = 5;
let newMap = 'desert';
const minVal = document.getElementById('minVal');
const pmaps = document.getElementById('pmaps');
for (const id of MAP.MAP_IDS) {
  const b = document.createElement('button');
  b.dataset.map = id;
  b.textContent = MAP.MAPS[id].name;
  b.onclick = () => { b.blur(); newMap = id; refreshMatchForm(); };
  pmaps.appendChild(b);
}
function refreshMatchForm() {
  botsPanel.querySelectorAll('.mode').forEach((b) => b.classList.toggle('sel', b.dataset.mode === newMode));
  pmaps.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.map === newMap));
  document.getElementById('modeInfo').textContent = MODE_INFO[newMode];
  minVal.textContent = newMins;
}
botsPanel.querySelectorAll('.mode').forEach((b) => {
  b.onclick = () => { newMode = b.dataset.mode; refreshMatchForm(); };
});
document.getElementById('minLess').onclick = () => { newMins = Math.max(1, newMins - 1); refreshMatchForm(); };
document.getElementById('minMore').onclick = () => { newMins = Math.min(MAP.MAX_MINUTES, newMins + 1); refreshMatchForm(); };
document.getElementById('startMatch').onclick = () => {
  socket.emit('newMatch', { mode: newMode, minutes: newMins, map: newMap });
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
  shopBtn.classList.toggle('away', !!me && !inBase); // fuera de la base se ve apagado
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
    <div class="top"><span class="nm">${me && me.t === 'blue' ? '💦 Bombucha' : '🔥 Bomba de fuego'}</span><span class="pr">$${G.price}</span></div>
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
// Si se corta la conexion, al volver se reintenta entrar a la misma sala
socket.on('connect', () => {
  if (joinData && joinData.code) socket.emit('joinRoom', joinData);
});
let myRoom = null; // { c: codigo, pub, name }
socket.on('welcome', (d) => {
  myId = d.id;
  pred.ok = false;
  myRoom = d.room || null;
  if (joinData) {
    joinData.team = d.team;
    if (myRoom) joinData.code = myRoom.c;
  }
  // la direccion queda con el codigo: recargar vuelve a la misma sala y sirve para compartir
  if (myRoom) try { history.replaceState(null, '', `${location.pathname}?sala=${myRoom.c}`); } catch (e) {}
  if (myRoom && !myRoom.pub) {
    notices.push({ msg: `🔒 Sala privada · código ${myRoom.c} · pasáselo a tus amigos`, at: performance.now() });
  }
});
// el servidor mide nuestra demora: le devolvemos el "ping" al instante
socket.on('sp', (t) => socket.emit('sp2', t));
socket.on('teamChanged', (d) => {
  pred.ok = false; // reaparece en la otra base
  if (joinData) joinData.team = d.team;
});
socket.on('state', (s) => {
  // Cambio de mapa: se arma el escenario nuevo
  if (s.m && s.m.mp && s.m.mp !== MAP.id) {
    MAP.setMap(s.m.mp);
    world.build(MAP);
    pred.ok = false;
    for (const id in disp) disp[id].buf = [];
  }
  state = s;
  stateAt = performance.now();
  for (const p of s.p) {
    let d = disp[p.id];
    if (!d) d = disp[p.id] = { x: p.x, y: p.y, z: p.z || 0, a: p.a, hp: p.hp, hitAt: 0, al: p.al };
    if (p.hp < d.hp && p.al) {
      d.hitAt = performance.now();
      if (p.id === myId) myHitAt = d.hitAt;
    }
    if (!p.al && d.al && p.id === myId) myHitAt = performance.now();
    if (p.al && !d.al) { d.x = p.x; d.y = p.y; d.z = p.z || 0; d.a = p.a; d.buf = []; }
    // historial de posiciones para interpolar suave entre actualizaciones
    (d.buf || (d.buf = [])).push({ t: stateAt, x: p.x, y: p.y, z: p.z || 0, a: p.a });
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
  showPing(mine && mine.pg);
  renderShop(false);
  if (botsPanel.classList.contains('open')) syncMatchPanel();
  if (!myId && performance.now() - lobbyAt > 500) { lobbyAt = performance.now(); refreshLobby(); }
});
socket.on('hit', (d) => {
  const now = performance.now();
  hitMark = { at: now, head: !!d.h, kill: !!d.k };
  if (d.h) popups.push({ at: now, text: `¡HEADSHOT! +$${MAP.HEADSHOT_COINS}`, color: '#ff5a5a', big: true });
  else if (d.k) popups.push({ at: now, text: `Baja +$${MAP.KILL_COINS}`, color: '#f2c94c' });
});
socket.on('notice', (msg) => {
  notices.push({ msg, at: performance.now() });
  if (notices.length > 3) notices.shift();
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
    pred.z = mine.z || 0;
    pred.vz = 0;
    pred.ok = mine.al && !isFrozen(s);
    hist.length = 0;
    return;
  }
  if (Math.abs((mine.z || 0) - (pred.z || 0)) > 45) pred.z = mine.z || 0; // altura muy distinta: corregir
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
  // separado del borde para no rozar el marco del celular al arrastrarlo
  return { x: W - r - 78, y: H - r - 40, r };
}
// Boton de granada: arriba a la izquierda del de disparo
function grenadeBtn() {
  const fb = fireBtn();
  const r = Math.max(26, fb.r * 0.5);
  return { x: fb.x - fb.r - r - 6, y: fb.y - fb.r - r + 10, r };
}
// Boton de saltar: a la izquierda del de disparo, abajo
function jumpBtn() {
  const fb = fireBtn();
  const r = Math.max(28, fb.r * 0.58);
  return { x: fb.x - fb.r - r - 18, y: fb.y + fb.r * 0.25, r };
}
// Salto: se predice al instante y se le avisa al servidor con un contador
let jumpCount = 0;
function doJump() {
  const meP = state && state.p.find((p) => p.id === myId);
  if (!meP || !meP.al || !pred.ok || isFrozen(state)) return;
  if (MAP.jump(pred)) jumpCount++;
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
    const jb = jumpBtn();
    const onFire = Math.hypot(t.clientX - fb.x, t.clientY - fb.y) < fb.r * 1.4;
    if (Math.hypot(t.clientX - gb.x, t.clientY - gb.y) < gb.r * 1.25) {
      throwGrenade();
    } else if (Math.hypot(t.clientX - jb.x, t.clientY - jb.y) < jb.r * 1.2) {
      doJump();
      jumpPressedAt = performance.now();
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
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat && myId && document.activeElement !== nameInput) doJump(); // espacio = saltar
  }
  keys[e.code] = true;
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

const shooting = () => touchShoot || mouseShoot || !!keys.KeyF; // en PC: click o F (espacio es saltar)
let jumpPressedAt = -1e9;

setInterval(() => {
  if (!myId) return;
  const mv = currentMove();
  const out = { mx: mv.mx, my: mv.my, a: yaw, p: pitch, shoot: shooting(), q: ++seq, jc: jumpCount };
  hist.push({ q: seq, x: pred.x, y: pred.y });
  if (hist.length > 120) hist.shift();
  socket.volatile.emit('input', out);
}, 1000 / 30);

// ---------- Escena 3D ----------
let renderer;
try {
  // bordes suavizados tambien en el celular (sin esto se ven serruchados / pixelados)
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  window.showErr('Este navegador no soporta gráficos 3D (WebGL 2). Probá con Chrome actualizado. Detalle: ' + e.message);
  throw e;
}
document.getElementById('gl').appendChild(renderer.domElement);
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(70, 1, 1, 5000);
camera.rotation.order = 'YXZ';
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xdde8ff, 0x4a4f5a, 2.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
sun.position.set(0.6, 1, 0.35);
scene.add(sun);

// El mapa (piso, paredes, objetos, escaleras) lo arma world.js segun el mapa activo
const world = createWorld(scene, hemi, sun, TEAM_HEX);
world.build(MAP);

// Arma en primera persona
const viewGun = new THREE.Group();
// salpicadura de agua en la punta al disparar
const flash = new THREE.Mesh(
  new THREE.SphereGeometry(3.5, 10, 8),
  new THREE.MeshBasicMaterial({ color: 0xc8f2ff, transparent: true, opacity: 0.85 })
);
flash.position.set(0, 0, -20);
viewGun.add(flash);
// La pistola de agua que tenes en la mano (cambia segun el arma equipada)
let viewWeapon = -1;
let viewBlaster = null;
function disposeTree(o) { o.traverse((c) => { if (c.geometry) c.geometry.dispose(); }); }
function setViewWeapon(w) {
  if (w === viewWeapon) return;
  viewWeapon = w;
  if (viewBlaster) { viewGun.remove(viewBlaster); disposeTree(viewBlaster); }
  const { group, len } = buildBlaster(w);
  const k = 0.62; // mas chica en la mano para que no tape la vista
  group.scale.setScalar(k);
  group.rotation.y = Math.PI / 2; // de +x (como se arma) a -z (hacia adelante de la camara)
  group.position.set(0, -3, len * 0.3 * k);
  viewGun.add(group);
  viewBlaster = group;
  flash.position.set(0, -3, (len * 0.3 - len - 2) * k);
  flash.scale.setScalar(w === 2 ? 1.8 : 1);
}
setViewWeapon(0);
// Manga del brazo en primera persona, con el color de tu personaje
// brazo y mano redondeados (estilo dibujo animado)
const sleeveMat = toon({ color: 0x888888 });
const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(3.8, 22, 4, 12), sleeveMat);
sleeve.rotation.x = Math.PI / 2 + 0.35;
sleeve.position.set(1, -9, 18);
viewGun.add(sleeve);
const hand = new THREE.Mesh(new THREE.SphereGeometry(3.6, 14, 10), toon({ color: 0xf0c9a0 }));
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
const headGeo = new THREE.SphereGeometry(13, 26, 18);
const visorGeo = new THREE.BoxGeometry(6, 6, 18);
const gunGeo = new THREE.BoxGeometry(32, 6, 6);
const legGeo = new THREE.BoxGeometry(10, 22, 10);
const shadowGeo = new THREE.CircleGeometry(22, 16);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });
const skinMat = toon({ color: 0xf0c9a0 });
const darkMat = toon({ color: 0x1d2128 });

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
function drawLabel(l, name, hp, team, isBot) {
  const key = name + '|' + hp + '|' + isBot;
  if (l.key === key) return;
  l.key = key;
  const g = l.c.getContext('2d');
  g.clearRect(0, 0, 256, 72);
  // los bots llevan el nombre mas grande y en verde fluor, para reconocerlos al toque
  g.font = isBot ? 'bold 40px system-ui, sans-serif' : 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.lineWidth = isBot ? 7 : 6;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.strokeText(name, 128, 34);
  g.fillStyle = isBot ? BOT_GREEN : COLORS[team];
  g.fillText(name, 128, 34);
  g.fillStyle = 'rgba(0,0,0,0.7)';
  g.fillRect(48, 46, 160, 16);
  g.fillStyle = hp > 50 ? '#5ee07a' : hp > 25 ? '#f2c94c' : '#ff5a5a';
  g.fillRect(50, 48, 156 * Math.max(0, hp) / 100, 12);
  l.tex.needsUpdate = true;
}

// Cara de dibujo animado: ojos grandes con brillito, cejas y sonrisa.
// Se arma dentro del grupo "cabeza" (el centro de la cabeza esta 12 arriba del cuello).
const eyeGeo = new THREE.SphereGeometry(3.9, 14, 10);
const pupilGeo = new THREE.SphereGeometry(2.1, 10, 8);
const shineGeo = new THREE.SphereGeometry(0.8, 6, 5);
const browGeo = new THREE.CapsuleGeometry(0.7, 4.5, 3, 6);
const mouthGeo = new THREE.TorusGeometry(3, 0.65, 6, 14, Math.PI);
const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const pupilMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
const mouthMat = toon({ color: 0x7a3a2a });
function addFace(head) {
  const hy = 12; // centro de la cabeza dentro del grupo
  for (const z of [-5, 5]) {
    const e = new THREE.Mesh(eyeGeo, eyeWhiteMat); e.position.set(10.6, hy + 1, z); e.scale.set(0.8, 1.1, 1); head.add(e);
    const p = new THREE.Mesh(pupilGeo, pupilMat); p.position.set(13.6, hy + 1, z); head.add(p);
    const s = new THREE.Mesh(shineGeo, eyeWhiteMat); s.position.set(15.3, hy + 2, z + 0.8); head.add(s);
    const b = new THREE.Mesh(browGeo, pupilMat); b.position.set(11.6, hy + 6.2, z); b.rotation.x = Math.PI / 2; b.rotation.y = z > 0 ? 0.25 : -0.25; head.add(b);
  }
  const m = new THREE.Mesh(mouthGeo, mouthMat); // sonrisa
  m.position.set(11.6, hy - 6, 0); m.rotation.set(0, Math.PI / 2, Math.PI); head.add(m);
}

// Arma un personaje segun equipo y estilo. Mira hacia +x. Devuelve las partes que se animan.
const styleOf = (team, s) => (MAP.STYLES[team] || MAP.STYLES.red)[s === 1 ? 1 : 0];
function buildCharacter(team, s) {
  const st = styleOf(team, s);
  const mats = []; // materiales propios (para liberarlos despues)
  const mat = (color, basic) => {
    const m = basic ? new THREE.MeshBasicMaterial({ color }) : toon({ color });
    mats.push(m);
    return m;
  };
  const add = (g, geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };

  const g = new THREE.Group();
  const teamMat = toon({ color: st.body, transparent: true });
  mats.push(teamMat);
  const accent = mat(st.accent);
  const skin = mat(st.skin);
  const legM = mat(st.legs);

  // Capsula que une dos puntos (brazos redondeados)
  const limb = (from, to, r, m) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const o = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.1, len - r), 4, 10), m);
    o.position.copy(a).add(b).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    g.add(o);
    return o;
  };
  const shoeM = mat(0x2a2a2e);
  const soleM = mat(0xf2f2f2);

  // Piernas redondeadas (con pivote en la cadera para animar el paso) y zapatillas con suela
  const leg = (z) => {
    const pivot = new THREE.Group();
    pivot.position.set(0, 34, z);
    const l = new THREE.Mesh(new THREE.CapsuleGeometry(5.3, 19, 4, 12), legM);
    l.position.y = -14;
    pivot.add(l);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(6, 14, 10), shoeM);
    foot.scale.set(1.6, 0.72, 1.05);
    foot.position.set(3, -29.5, 0);
    pivot.add(foot);
    const sole = new THREE.Mesh(new THREE.CylinderGeometry(6.3, 6.3, 1.6, 14), soleM);
    sole.scale.set(1.6, 1, 1.05);
    sole.position.set(3, -32.5, 0);
    pivot.add(sole);
    g.add(pivot);
    return pivot;
  };
  const legL = leg(-6.2);
  const legR = leg(6.2);
  const hips = add(g, new THREE.CapsuleGeometry(7, 9, 4, 12), legM, 0, 37, 0); // cadera
  hips.rotation.x = Math.PI / 2;
  hips.scale.set(0.95, 1, 1);

  // Torso con forma de "poroto": se arma girando un perfil curvo
  const prof = [[0, 0], [9.5, 0.5], [11, 5], [11.3, 12], [12.6, 20], [12.2, 25], [8, 28.5], [0, 29.2]].map(([r, y]) => new THREE.Vector2(r, y));
  const torso = add(g, new THREE.LatheGeometry(prof, 24), teamMat, 0, 39, 0);
  torso.scale.x = 0.7;
  add(g, new THREE.SphereGeometry(5.8, 14, 10), teamMat, 0, 63, -11.5); // hombros
  add(g, new THREE.SphereGeometry(5.8, 14, 10), teamMat, 0, 63, 11.5);
  add(g, new THREE.CapsuleGeometry(4.2, 3, 4, 10), skin, 0, 67.5, 0); // cuello

  // Cabeza en su propio grupo (asi se inclina segun hacia donde apunta). Centro en y=80 (headshot 66-94).
  const head = new THREE.Group();
  head.position.set(0, 68, 0);
  g.add(head);
  add(head, headGeo, skin, 0, 12, 0);
  const ear = new THREE.SphereGeometry(3, 10, 8);
  add(head, ear, skin, 0, 12, -12.8).scale.set(0.7, 1, 0.5);
  add(head, ear, skin, 0, 12, 12.8).scale.set(0.7, 1, 0.5);

  // Brazos sosteniendo el arma (mano derecha en la empuñadura, izquierda adelante)
  limb([0, 63, 11.5], [5, 51, 16], 4, teamMat);
  limb([5, 51, 16], [15, 47, 12.5], 3.6, teamMat);
  add(g, new THREE.SphereGeometry(3.9, 12, 10), skin, 16, 47, 12);
  limb([0, 63, -11.5], [11, 53, -9], 4, teamMat);
  limb([11, 53, -9], [29, 49, 8], 3.6, teamMat);
  add(g, new THREE.SphereGeometry(3.9, 12, 10), skin, 30, 49, 9);

  // Cara y lo que lleva en la cabeza
  addFace(head);
  const dome = (r) => new THREE.SphereGeometry(r, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  if (st.hat === 'helmet') {
    add(head, dome(14.9), accent, 0, 16, 0);
    add(head, new THREE.TorusGeometry(15, 1.6, 8, 28), accent, 0, 16.3, 0).rotation.x = Math.PI / 2;
  } else if (st.hat === 'bandana') {
    add(head, new THREE.TorusGeometry(13.4, 2.4, 8, 28), accent, 0, 18, 0).rotation.x = Math.PI / 2;
    add(head, new THREE.SphereGeometry(2.6, 10, 8), accent, -14.5, 18, 3); // nudo
    add(head, new THREE.CapsuleGeometry(1.6, 5, 4, 8), accent, -16, 15, 5).rotation.z = 0.8;
    // cresta: puntas redondeadas
    for (let i = 0; i < 4; i++) {
      const c = add(head, new THREE.ConeGeometry(3.4, 9 - i, 12), accent, 6 - i * 5, 27.5 - i * 0.6, 0);
      c.rotation.z = 0.25 + i * 0.12;
    }
  } else if (st.hat === 'goggles') {
    add(head, dome(14.9), accent, 0, 16, 0);
    add(head, new THREE.TorusGeometry(15, 1.3, 8, 28), mat(0x2b3440), 0, 20, 0).rotation.x = Math.PI / 2.4;
    // antiparras levantadas sobre el casco (asi se le ven los ojos)
    for (const z of [-5, 5]) {
      const lens = add(head, new THREE.CylinderGeometry(4, 4, 3, 16), mat(0x6fe0ff, true), 9.5, 24, z);
      lens.rotation.z = Math.PI / 2 - 0.6;
    }
  } else if (st.hat === 'cap') {
    const cap = add(head, dome(14), accent, 0, 16, 0);
    cap.scale.y = 0.85;
    const brim = add(head, new THREE.CylinderGeometry(10, 10, 1.6, 22, 1, false, 0, Math.PI), accent, 11, 16.5, 0);
    brim.rotation.y = Math.PI / 2;
    add(head, new THREE.SphereGeometry(1.8, 8, 6), accent, 0, 28, 0); // botoncito
  }

  // Equipamiento (todo con bordes redondeados)
  if (st.gear === 'vest') {
    add(g, roundBox(18, 21, 25, 6), accent, 0, 53, 0);
    add(g, roundBox(4, 7, 7, 1.6), mat(0x3a2a20), 10.5, 49, -5);
    add(g, roundBox(4, 7, 7, 1.6), mat(0x3a2a20), 10.5, 49, 5);
  } else if (st.gear === 'backpack') {
    add(g, roundBox(9, 24, 18, 4), mat(0x3b2f2a), -12, 54, 0);
    add(g, new THREE.CapsuleGeometry(4, 12, 4, 10), accent, -12, 68, 0).rotation.x = Math.PI / 2;
  } else if (st.gear === 'pads') {
    add(g, new THREE.SphereGeometry(7.2, 14, 10), accent, 0, 65, -12.5).scale.y = 0.75;
    add(g, new THREE.SphereGeometry(7.2, 14, 10), accent, 0, 65, 12.5).scale.y = 0.75;
    const belt = add(g, new THREE.TorusGeometry(10.2, 2, 8, 24), accent, 0, 41, 0); // cinturon
    belt.rotation.x = Math.PI / 2; belt.scale.x = 0.75;
  } else if (st.gear === 'scarf') {
    add(g, new THREE.TorusGeometry(6.8, 2.8, 8, 20), accent, 0, 66, 0).rotation.x = Math.PI / 2;
    add(g, new THREE.CapsuleGeometry(2, 10, 4, 8), accent, -8.5, 58, 5);
    add(g, roundBox(9, 22, 17, 4), mat(0x2b2f3a), -12, 54, 0);
  }

  // la pistola de agua va en un "soporte" que se inclina segun hacia donde apunta
  const gun = new THREE.Group();
  gun.position.set(10, BULLET_H, 12);
  g.add(gun);
  gun.add(buildBlaster(0).group);
  const muzzle = add(g, new THREE.SphereGeometry(5, 8, 8), mat(0xc8f2ff, true), 48, BULLET_H, 12);
  return { g, teamMat, legL, legR, gun, muzzle, mats, head, torso };
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
  const { g, teamMat, legL, legR, gun, muzzle, mats, head, torso } = buildCharacter(p.t, p.sy);
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.8;
  const label = makeLabel();
  const root = new THREE.Group();
  root.add(g);
  root.add(shadow);
  root.add(label.sprite);
  scene.add(root);
  a = avatars[p.id] = { root, body: g, teamMat, muzzle, label, legL, legR, team: p.t, style: p.sy, walk: 0, lx: 0, ly: 0, gun, mats, w: 0, head, torso, phase: Math.random() * 6 };
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
const SHARED_GEOS = new Set([bodyGeo, headGeo, visorGeo, gunGeo, legGeo, shadowGeo, eyeGeo, pupilGeo, mouthGeo, shineGeo, browGeo]);
renderCharPreviews();

// Balas
// Disparos de agua: una gota con un chorrito detras (rosada para el rojo, celeste para el azul)
const bulletGeo = new THREE.SphereGeometry(3.6, 10, 8);
const bulletMats = [
  new THREE.MeshPhongMaterial({ color: 0xffc2d6, shininess: 120, specular: 0xffffff, transparent: true, opacity: 0.85 }),
  new THREE.MeshPhongMaterial({ color: 0xbfeeff, shininess: 120, specular: 0xffffff, transparent: true, opacity: 0.85 }),
];
const tracerGeo = new THREE.CylinderGeometry(0.9, 1.9, 1, 8);
tracerGeo.rotateZ(Math.PI / 2); // a lo largo de x
const tracerMats = [
  new THREE.MeshBasicMaterial({ color: 0xff9ec0, transparent: true, opacity: 0.45 }),
  new THREE.MeshBasicMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.45 }),
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

// Granadas: el azul tira bombuchas (globos de agua) y el rojo bombas de fuego
const grenadePools = [[], []]; // [0] fuego (rojo), [1] bombucha (azul)
const balloonMat = new THREE.MeshPhongMaterial({ color: 0x3fa9ff, shininess: 140, specular: 0xffffff, transparent: true, opacity: 0.8 });
const fireBombMat = new THREE.MeshPhongMaterial({ color: 0xb3261e, shininess: 60, specular: 0x553333 });
const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb020 });
function makeGrenadeModel(kind) {
  const g = new THREE.Group();
  if (kind === 1) {
    // bombucha: globo un poco alargado con el nudito arriba
    const ball = new THREE.Mesh(new THREE.SphereGeometry(7, 14, 12), balloonMat);
    ball.scale.set(1, 1.15, 1);
    g.add(ball);
    const knot = new THREE.Mesh(new THREE.ConeGeometry(2, 3.5, 8), balloonMat);
    knot.position.y = 9;
    knot.rotation.x = Math.PI;
    g.add(knot);
    g.userData.led = null;
  } else {
    // bomba de fuego: bola roja con mecha y llamita que titila
    g.add(new THREE.Mesh(new THREE.SphereGeometry(6.5, 14, 12), fireBombMat));
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 5, 6), new THREE.MeshLambertMaterial({ color: 0x3a2a20 }));
    fuse.position.y = 8;
    g.add(fuse);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(2.4, 6, 8), flameMat);
    flame.position.y = 13;
    g.add(flame);
    g.userData.led = flame;
  }
  scene.add(g);
  return g;
}
function getGrenade(kind, i) {
  const pool = grenadePools[kind];
  if (!pool[i]) pool[i] = makeGrenadeModel(kind);
  return pool[i];
}

const blasts = []; // explosiones visibles
const drops = []; // gotitas / chispas que salen volando
const blastGeo = new THREE.SphereGeometry(1, 20, 14);
const dropGeo = new THREE.SphereGeometry(2.6, 6, 5);
let shakeUntil = 0, shakeAmt = 0;
socket.on('boom', (b) => {
  const now = performance.now();
  const water = b.t === 'blue';
  // bola central: salpicadura celeste o fuego naranja
  const fire = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({
    color: water ? 0x9fe3ff : 0xffa030, transparent: true, opacity: water ? 0.7 : 0.9, depthWrite: false,
  }));
  fire.position.set(b.x, Math.max(10, b.z), b.y);
  scene.add(fire);
  // anillo en el piso que muestra el alcance (charco de agua o quemadura)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1, 40),
    new THREE.MeshBasicMaterial({ color: water ? 0x4fc3ff : 0xff7020, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(b.x, 1.5, b.y);
  scene.add(ring);
  blasts.push({ fire, ring, at: now, water });
  // gotas de agua o chispas que salen volando
  const dmat = new THREE.MeshBasicMaterial({ color: water ? 0xbfeeff : 0xffc040, transparent: true, opacity: 0.9 });
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(dropGeo, dmat);
    m.position.set(b.x, Math.max(10, b.z) + 5, b.y);
    const a = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 260;
    scene.add(m);
    drops.push({ m, vx: Math.cos(a) * sp, vy: 150 + Math.random() * 280, vz: Math.sin(a) * sp, at: now, mat: dmat });
  }
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
    b.fire.material.opacity = (b.water ? 0.7 : 0.9) * (1 - t);
    if (!b.water) b.fire.material.color.setHex(t < 0.25 ? 0xfff0a0 : 0xff7a20);
    b.ring.scale.setScalar(R * Math.min(1, t * 2.2));
    b.ring.material.opacity = 0.6 * (1 - t);
  }
  // gotas/chispas con gravedad
  const dt = 1 / 60;
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    const age = (now - d.at) / 900;
    if (age >= 1 || d.m.position.y < 0) {
      scene.remove(d.m);
      drops.splice(i, 1);
      if (!drops.some((o) => o.mat === d.mat)) d.mat.dispose();
      continue;
    }
    d.vy -= 900 * dt;
    d.m.position.x += d.vx * dt;
    d.m.position.y += d.vy * dt;
    d.m.position.z += d.vz * dt;
    d.m.material.opacity = 0.9 * (1 - age);
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
  const cam = meP ? (meP.al ? pred : disp[myId]) : { x: MAP.W / 2, y: MAP.H / 2, z: 0 };
  const deadCam = meP && !meP.al;
  camera.position.set(cam.x, (cam.z || 0) + (deadCam ? 18 : EYE_H), cam.y);
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
    a.root.position.set(d.x, d.z || 0, d.y);
    a.body.rotation.y = -d.a;
    a.gun.rotation.z = p.pt || 0; // el arma sube/baja segun hacia donde apunta
    // caminar
    const sp = Math.hypot(d.x - a.lx, d.y - a.ly);
    a.lx = d.x; a.ly = d.y;
    if (sp > 0.5) a.walk += dt * 12;
    const walking = sp > 0.5;
    const sw = walking ? Math.sin(a.walk) * 6 : 0;
    a.legL.rotation.z = sw * 0.075; // las piernas giran desde la cadera al caminar
    a.legR.rotation.z = -sw * 0.075;
    // Animaciones de dibujo animado:
    // rebote al caminar, respiracion quieto, cabeza que sigue la mira y "aplastada" al recibir un golpe
    const t = now / 1000 + a.phase;
    a.body.position.y = walking ? Math.abs(Math.sin(a.walk)) * 2.4 : Math.sin(t * 2.2) * 0.5;
    a.torso.scale.set(0.7 * (1 + Math.sin(t * 2.2) * 0.02), 1 + Math.sin(t * 2.2) * 0.025, 1);
    a.head.rotation.z = (p.pt || 0) * 0.55 + (walking ? Math.sin(a.walk * 2) * 0.04 : 0);
    a.body.rotation.x = walking ? Math.sin(a.walk) * 0.05 : 0; // balanceo
    const squash = Math.max(0, 1 - (now - d.hitAt) / 180);
    a.body.scale.set(1 + squash * 0.1, 1 - squash * 0.12, 1 + squash * 0.1);
    if (a.w !== p.w) {
      // arma en la mano segun lo que compro
      a.w = p.w;
      for (const c of [...a.gun.children]) { a.gun.remove(c); disposeTree(c); }
      const { group, len } = buildBlaster(p.w);
      a.gun.add(group);
      a.muzzle.position.x = 10 + len;
    }
    a.muzzle.visible = p.sf;
    const hit = now - d.hitAt < 110;
    a.teamMat.emissive.setHex(hit ? 0xffffff : 0x000000);
    a.teamMat.opacity = p.sp ? 0.45 + 0.25 * Math.sin(now / 80) : 1;
    drawLabel(a.label, p.n, p.hp, p.t, p.bt);
    a.label.sprite.scale.set(p.bt ? 76 : 64, p.bt ? 21 : 18, 1);
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

  // Granadas: bombuchas que se bambolean y bombas de fuego con la llamita titilando
  const used = [0, 0];
  for (const [, x, y, z, left, kind] of state.g || []) {
    const k = kind === 1 ? 1 : 0;
    const g = getGrenade(k, used[k]++);
    g.visible = true;
    g.position.set(x, z, y);
    if (k === 1) g.rotation.z = Math.sin(now / 90) * 0.25;
    else g.userData.led.scale.setScalar(0.7 + 0.5 * (Math.floor(now / Math.max(50, left / 6)) % 2));
  }
  for (const k of [0, 1]) for (let j = used[k]; j < grenadePools[k].length; j++) grenadePools[k][j].visible = false;
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
  for (const w of MAP.walls) {
    ctx.fillStyle = minimapColor(w);
    ctx.fillRect(x0 + w.x * k, y0 + w.y * k, Math.max(1, w.w * k), Math.max(1, w.h * k));
  }
  ctx.fillStyle = 'rgba(120,255,140,0.45)'; // escaleras
  for (const r of MAP.ramps) ctx.fillRect(x0 + r.x * k, y0 + r.y * k, Math.max(1, r.w * k), Math.max(1, r.h * k));
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

// Ping: etiqueta arriba de los botones (verde: bueno, amarillo: aceptable, rojo: alto)
const pingTag = document.getElementById('pingTag');
let pingShown = -1;
function showPing(pg) {
  pg = pg || 0;
  if (pg === pingShown) return;
  pingShown = pg;
  pingTag.textContent = `📶 Ping ${pg ? pg + ' ms' : '…'}`;
  pingTag.style.color = !pg ? '#9aa4b2' : pg < 60 ? '#5ee07a' : pg < 120 ? '#f2c94c' : '#ff6b6b';
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

// Texto con los nombres de bots ("Bot 12") resaltados: mas grandes y en verde fluor
const BOT_NAME_RE = /(Bot \d+)/;
function richParts(text) {
  return String(text).split(BOT_NAME_RE).filter(Boolean).map((s) => ({ s, bot: BOT_NAME_RE.test(s) && /^Bot \d+$/.test(s) }));
}
function richWidth(text, size, botSize) {
  let w = 0;
  for (const p of richParts(text)) {
    ctx.font = p.bot ? `900 ${botSize}px system-ui, sans-serif` : `${size}px system-ui, sans-serif`;
    w += ctx.measureText(p.s).width;
  }
  return w;
}
function drawRich(text, x, y, size, botSize) {
  ctx.textAlign = 'left';
  for (const p of richParts(text)) {
    ctx.font = p.bot ? `900 ${botSize}px system-ui, sans-serif` : `${size}px system-ui, sans-serif`;
    if (p.bot) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(p.s, x, y);
    }
    ctx.fillStyle = p.bot ? BOT_GREEN : '#fff';
    ctx.fillText(p.s, x, y);
    x += ctx.measureText(p.s).width;
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
  ctx.fillText(elim ? `Guerra · Ronda ${m.rn}` : 'DeathMatch · bajas', cx, 49);
  if (elim) {
    const vivos = { red: 0, blue: 0 };
    for (const p of state.p) if (p.al) vivos[p.t]++;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`${vivos.red} vivos`, cx - 75, 49);
    ctx.fillText(`${vivos.blue} vivos`, cx + 75, 49);
  }

  // Feed (los nombres de bots en verde fluor)
  let fy = 26;
  feed = feed.filter((f) => now - f.at < 5000);
  for (const f of feed) {
    const tw = richWidth(f.msg, 14, 15);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(W - tw - 22, fy - 15, tw + 12, 21);
    drawRich(f.msg, W - 16 - tw, fy, 14, 15);
    fy += 24;
  }

  // Avisos para el creador de la partida (bots agregados/quitados)
  notices = notices.filter((n) => now - n.at < 6000);
  let ny = 96;
  for (const n of notices) {
    const t = (now - n.at) / 6000;
    ctx.globalAlpha = t > 0.85 ? (1 - t) / 0.15 : 1;
    const size = 15, botSize = 21;
    const tw = Math.min(richWidth(n.msg, size, botSize), W - 40);
    ctx.fillStyle = 'rgba(10,14,20,0.85)';
    ctx.strokeStyle = BOT_GREEN;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(W / 2 - tw / 2 - 12, ny - 22, tw + 24, 32, 10);
    else ctx.rect(W / 2 - tw / 2 - 12, ny - 22, tw + 24, 32);
    ctx.fill();
    ctx.stroke();
    drawRich(n.msg, W / 2 - tw / 2, ny, size, botSize);
    ctx.globalAlpha = 1;
    ny += 40;
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
      ctx.fillText((MAP.WEAPONS[meP.w] || MAP.WEAPONS[0]).name + (meP.gr ? `  ·  ${meP.t === 'blue' ? '💦' : '🔥'} x${meP.gr}${isTouch ? '' : ' (G)'}` : ''), bx, by - 8);
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
    ctx.fillText('Click: capturar mouse y disparar  ·  Espacio: saltar  ·  G: granada  ·  B: tienda  ·  Esc: soltar', W / 2, H - 70);
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
  const water = meP && meP.t === 'blue';
  ctx.fillStyle = water ? 'rgba(40,120,200,0.75)' : 'rgba(200,80,30,0.75)';
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(gb.x, gb.y, gb.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.font = `${Math.round(gb.r * 0.9)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(water ? '💦' : '🔥', gb.x, gb.y + 1); // bombucha (azul) o bomba de fuego (rojo)
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillText('x' + grs, gb.x + gb.r * 0.75, gb.y + gb.r + 4);
  ctx.globalAlpha = 1;

  // Boton de saltar
  const jb = jumpBtn();
  const pressed = performance.now() - jumpPressedAt < 150;
  ctx.fillStyle = pressed ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)';
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(jb.x, jb.y, jb.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); // flecha hacia arriba
  ctx.moveTo(jb.x, jb.y - jb.r * 0.5);
  ctx.lineTo(jb.x + jb.r * 0.42, jb.y + jb.r * 0.05);
  ctx.lineTo(jb.x + jb.r * 0.16, jb.y + jb.r * 0.05);
  ctx.lineTo(jb.x + jb.r * 0.16, jb.y + jb.r * 0.45);
  ctx.lineTo(jb.x - jb.r * 0.16, jb.y + jb.r * 0.45);
  ctx.lineTo(jb.x - jb.r * 0.16, jb.y + jb.r * 0.05);
  ctx.lineTo(jb.x - jb.r * 0.42, jb.y + jb.r * 0.05);
  ctx.closePath();
  ctx.fill();

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
      d.x = b1.x; d.y = b1.y; d.z = b1.z; d.a = b1.a;
    } else {
      const k = Math.max(0, Math.min(1, (renderT - b0.t) / (b1.t - b0.t)));
      d.x = b0.x + (b1.x - b0.x) * k;
      d.y = b0.y + (b1.y - b0.y) * k;
      d.z = b0.z + (b1.z - b0.z) * k;
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
    MAP.resolve(pred, P_R, dt); // choca con paredes, sube escaleras y cae de los bordes
  }
  if (meP && disp[myId] && !meP.al) {
    disp[myId].x = meP.x;
    disp[myId].y = meP.y;
    disp[myId].z = meP.z || 0;
  }

  update3D(now, meP, dt);
  world.update(now); // la fuente del pueblo
  renderer.render(scene, camera);

  drawCrosshair(meP);
  drawPopups(now);
  drawMinimap(meP);
  drawHUD(now, meP);
  drawControls();
}
requestAnimationFrame(frame);
showStep(roomAction ? 1 : 0); // menu: paso de salas (o directo al nombre si vino con link de invitacion)
window.__gameReady = true;
