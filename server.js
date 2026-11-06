const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const MAP = require('./public/map.js');

const app = express();
const server = http.createServer(app);
// Se revisa seguido si cada conexion sigue viva: si un celular se corta, su jugador se va en ~20 s (antes ~45 s)
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000 });
// no-cache: el navegador siempre pregunta si hay una version nueva (evita quedarse con archivos viejos)
const noCache = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use(express.static(path.join(__dirname, 'public'), noCache));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build'), noCache));
// piezas extra de three.js (ej. cajas con bordes redondeados)
app.use('/vendor/three-addons', express.static(path.join(__dirname, 'node_modules', 'three', 'examples', 'jsm'), noCache));

// Version que esta corriendo (el commit de GitHub): el boton "Actualizar" la usa para saber si hay una nueva
const VERSION = (() => {
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    return (process.env.RENDER_GIT_COMMIT || 'dev').slice(0, 7);
  }
})();
app.get('/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ v: VERSION });
});

// ---- Reglas del juego ----
const TICK = 30;
const DT = 1 / TICK;
const P_R = MAP.P_R; // radio del jugador
const SPEED = MAP.SPEED; // px por segundo
const WEAPONS = MAP.WEAPONS;
const RESPAWN_MS = 3000;
const PROTECT_MS = 1500; // Guerra: proteccion corta al aparecer
const PROTECT_TDM_MS = 5000; // DeathMatch: 5 s invencible para poder comprar (se corta si dispara)
const FREEZE_MS = 4000; // Guerra: al arrancar cada ronda nadie se mueve ni dispara, se puede comprar
const ROUND_END_MS = 3500; // cartel de "gano la ronda" (modo Guerra)
const MATCH_END_MS = 9000; // cartel de fin de partida antes de arrancar otra
const ASSIST_ANGLE = 0.3; // radianes (~17 grados) de ayuda de apuntado
const ASSIST_RANGE = 750;
const GR = MAP.GRENADE;
const CHEST = 48; // altura del pecho (para ver/apuntar a alguien)

// ---- Compensacion de lag ----
// Cada jugador ve a los demas un poco "en el pasado" (su demora de red + 100 ms de interpolacion).
// Para que lo que ves sea lo que le pegas, los impactos se calculan contra donde estaban
// los demas en ese momento ("rebobinando" un poco el tiempo).
const INTERP_MS = 100; // lo mismo que usa el cliente para dibujar a los demas
const MAX_REWIND = 300; // nunca se rebobina mas que esto (para que nadie con mucha demora tenga ventaja)
const HIST_LEN = 24; // ~0.8 s de historial de posiciones (a 30 por segundo)

function recordHistory(p, now) {
  (p.hist || (p.hist = [])).push({ t: now, x: p.x, y: p.y, z: p.z || 0 });
  if (p.hist.length > HIST_LEN) p.hist.shift();
}

// Donde estaba q en el momento t (interpolando entre dos registros)
function posAt(q, t) {
  const h = q.hist;
  if (!h || !h.length || t >= h[h.length - 1].t) return q;
  if (t <= h[0].t) return h[0];
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i];
    if (t >= a.t) {
      const k = (t - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
    }
  }
  return q;
}

// Cuanto rebobinar para los disparos de p
const rewindFor = (p) => (p.isBot ? 0 : clamp((p.rtt || 0) / 2 + INTERP_MS + 1000 / TICK / 2, 0, MAX_REWIND));

// ---- Limites contra abusos ----
const MAX_ROOMS = 300;
const MAX_HUMANS_PER_ROOM = 12;
const CREATE_LIMIT = { n: 3, ms: 60000 }; // salas que puede crear alguien por minuto
const JOIN_LIMIT = { n: 15, ms: 60000 }; // intentos de entrar a una sala por minuto
const EVENT_RATE = 150; // mensajes por segundo que acepta el servidor de cada conexion

// ¿Supero el limite? (cuenta las veces dentro de la ventana de tiempo)
function overLimit(list, lim, now) {
  while (list.length && now - list[0] > lim.ms) list.shift();
  if (list.length >= lim.n) return true;
  list.push(now);
  return false;
}

// ---- Filtro de nombres ----
// Se compara una version "normalizada" del nombre (sin tildes, sin numeros disfrazados de letras,
// sin letras repetidas) contra una lista de palabras no permitidas.
const BAD_WORDS = [
  // castellano
  'puto', 'puta', 'putit', 'pelotud', 'boludo', 'boluda', 'concha', 'conchud', 'forro', 'mierd', 'verga', 'pija', 'poronga',
  'chot', 'trolo', 'trola', 'hdp', 'hijodeput', 'maricon', 'culia', 'culo', 'ort', 'cagon', 'pajer', 'garch', 'coger', 'cojer',
  'sorete', 'mogolic', 'retrasad', 'idiota', 'imbecil', 'tarad', 'estupid', 'negr', 'prostitut', 'zorra', 'perra', 'pete',
  'chupa', 'teta', 'sexo', 'porno', 'nazi', 'hitler', 'droga', 'cocain', 'faso', 'matar', 'violad', 'suicid',
  // ingles
  'fuck', 'fuk', 'shit', 'bitch', 'dick', 'cock', 'pussy', 'nigg', 'cunt', 'whore', 'slut', 'fag', 'porn', 'sex', 'rape',
  'kill', 'penis', 'vagin',
];
// palabras que solo se bloquean si son la palabra entera (para no bloquear "Cortes", "Esperanza" o "Recoger")
const BAD_EXACT_LIST = ['ort', 'culo', 'pete', 'chot', 'negr', 'kill', 'teta', 'faso', 'sex', 'fag', 'puto', 'puta', 'pija',
  'perra', 'zorra', 'forro', 'coger', 'cojer', 'matar', 'chupa', 'droga', 'dick', 'rape'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' };

function normalizeName(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin tildes
    .replace(/[01345780@$!|]/g, (c) => LEET[c] || c)
    .replace(/(.)\1+/g, '$1'); // "puuuuto" -> "puto"
}

// la lista se normaliza igual que los nombres (asi "pussy" queda "pusy", igual que el nombre)
const BAD_EXACT = new Set(BAD_EXACT_LIST.map(normalizeName));
const BAD_SUB = [...new Set(BAD_WORDS.map(normalizeName))].filter((w) => !BAD_EXACT.has(w));

function isBadName(name) {
  // se revisan dos versiones: con los numeros como letras ("Put0") y sin numeros ("PUTO123")
  const versions = [normalizeName(name), normalizeName(String(name).replace(/[0-9]+/g, ' '))];
  for (const n of versions) {
    const tokens = n.split(/[^a-zñ]+/).filter(Boolean);
    const joined = tokens.join(''); // "p u t o" -> "puto"
    for (const w of BAD_EXACT) if (tokens.includes(w) || joined === w) return true;
    for (const w of BAD_SUB) if (joined.includes(w)) return true;
  }
  return false;
}

// Nombre limpio: si tiene algo no permitido, se reemplaza por uno generico
function cleanName(raw) {
  let name = String(raw || '').replace(/[<>]/g, '').trim().slice(0, 14);
  if (!name) return { name: 'Jugador', changed: false };
  if (isBadName(name)) return { name: 'Jugador ' + Math.floor(100 + Math.random() * 900), changed: true };
  return { name, changed: false };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const teamName = (t) => (t === 'red' ? 'ROJO' : 'AZUL');
const modeName = (m) => (m === 'elim' ? 'Guerra' : 'DeathMatch');

// =====================================================================
// SALAS: cada sala es una partida independiente (su mapa, jugadores, bots y creador).
// Publica = aparece en la lista; privada = solo se entra con el codigo.
// =====================================================================
const rooms = {};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin letras que se confunden (O/0, I/1)

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms[c]) return c;
  }
}

function createRoom(opts) {
  const R = {
    id: newCode(),
    name: String(opts.name || 'Sala').slice(0, 24),
    isPublic: !!opts.isPublic,
    map: MAP.MAPS[opts.map] ? opts.map : 'desert',
    players: {},
    bullets: [],
    grenades: [],
    score: { red: 0, blue: 0 }, // bajas por equipo
    bulletId: 0,
    grenadeId: 0,
    botSeq: 0,
    match: {
      creator: null, // id de quien creo la sala (el "admin")
      autoFill: true, // completar equipos con bots automaticamente
      mode: 'tdm', // 'tdm' = DeathMatch (reaparicion), 'elim' = Guerra (rondas)
      minutes: 5,
      endsAt: 0,
      phase: 'playing', // 'playing' | 'roundEnd' | 'matchEnd'
      phaseUntil: 0,
      rounds: { red: 0, blue: 0 },
      round: 1,
      banner: '',
      bannerTeam: null,
    },
  };
  rooms[R.id] = R;
  return R;
}

// Antes de hacer fisica en una sala, se activa su mapa (las funciones de map.js usan el mapa activo)
const useMap = (R) => { if (MAP.id !== R.map) MAP.setMap(R.map); };
const emit = (R, ev, data) => io.to(R.id).emit(ev, data);
const solidAt = (x, y, z) => MAP.solidAt(x, y, z);
// ¿p ve a q? (de ojos a pecho, teniendo en cuenta pisos y paredes)
const canSee = (p, q) => MAP.los(p.x, p.y, (p.z || 0) + MAP.EYE_H, q.x, q.y, (q.z || 0) + CHEST);
const resolve = (p) => MAP.resolve(p, P_R, DT);
// Donde pego una bala: punto justo antes de la superficie y hacia donde mira esa cara.
// Devuelve [x, y, z, eje (0 x, 1 y, 2 altura), sentido de la cara (+1/-1), equipo (0 rojo, 1 azul)]
const blockedAt = (x, y, z) => x < 0 || y < 0 || x > MAP.W || y > MAP.H || z < 0 || solidAt(x, y, z);
function splatAt(px, py, pz, b) {
  if (b.z > 330) return null; // se fue por arriba (cielo o techo): no mancha
  let lx = px, ly = py, lz = pz, hx = b.x, hy = b.y, hz = b.z;
  for (let i = 0; i < 7; i++) { // se acerca a la superficie partiendo el tramo al medio
    const mx = (lx + hx) / 2, my = (ly + hy) / 2, mz = (lz + hz) / 2;
    if (blockedAt(mx, my, mz)) { hx = mx; hy = my; hz = mz; } else { lx = mx; ly = my; lz = mz; }
  }
  const sx = Math.sign(b.vx) || 1, sy = Math.sign(b.vy) || 1, sz = Math.sign(b.vz) || -1;
  let axis, dir;
  if (blockedAt(lx + sx * 2, ly, lz)) { axis = 0; dir = -sx; }
  else if (blockedAt(lx, ly + sy * 2, lz)) { axis = 1; dir = -sy; }
  else { axis = 2; dir = -sz; }
  return [Math.round(lx), Math.round(ly), Math.round(Math.max(0, lz)), axis, dir, b.team === 'red' ? 0 : 1];
}

function humanCount(R) {
  let n = 0;
  for (const id in R.players) if (!R.players[id].isBot) n++;
  return n;
}
function teamCounts(R) {
  const c = { red: 0, blue: 0 };
  for (const id in R.players) c[R.players[id].team]++;
  return c;
}

// ---- Jugadores ----
function newPlayer(id, name, team, isBot, style) {
  return {
    id, name, team, isBot: !!isBot,
    style: style === 1 ? 1 : 0, // personaje elegido (0 o 1 dentro de su equipo)
    x: 0, y: 0, z: 0, vz: 0, a: 0, hp: 100, alive: true,
    kills: 0, deaths: 0, lastShot: 0, respawnAt: 0, protectUntil: 0,
    coins: MAP.START_COINS, owned: 1, weapon: 0, // owned = armas compradas (bits)
    grenades: 0, flashes: 0, lastThrow: 0, blindUntil: 0,
    input: { mx: 0, my: 0, a: 0, p: 0, shoot: false },
  };
}

function spawn(R, p) {
  useMap(R);
  const s = MAP.spawns[p.team];
  for (let i = 0; i < 30; i++) {
    p.x = s.x + Math.random() * s.w;
    p.y = s.y + Math.random() * s.h;
    if (!MAP.blocked(p.x, p.y, 0, P_R)) break;
  }
  p.z = 0;
  p.vz = 0;
  p.hist = []; // aparece en otro lugar: el historial empieza de nuevo
  p.hp = 100;
  p.alive = true;
  p.a = p.team === 'red' ? 0 : Math.PI;
  p.input.a = p.a;
  p.input.p = 0;
  p.protectUntil = Date.now() + (R.match.mode === 'tdm' ? PROTECT_TDM_MS : PROTECT_MS);
  if (p.isBot) botAutoBuy(p);
}

function setDead(p, respawnAt) {
  p.alive = false;
  p.hp = 0;
  p.respawnAt = respawnAt;
}

// Un jugador que entra en medio de una ronda de Guerra espera a la proxima.
function placeNewPlayer(R, p) {
  spawn(R, p);
  p.hist = [];
  if (R.match.mode === 'elim' && R.match.phase === 'playing') setDead(p, Infinity);
}

// ---- Partida: inicio, rondas y final ----
function startMatch(R, mode, minutes, mapId) {
  const m = R.match;
  if (mapId && MAP.MAPS[mapId]) R.map = mapId;
  const now = Date.now();
  m.mode = mode === 'elim' ? 'elim' : 'tdm';
  m.minutes = clamp(Math.round(Number(minutes) || 5), 1, MAP.MAX_MINUTES);
  m.endsAt = now + m.minutes * 60000;
  setStartPhase(m, now);
  m.rounds = { red: 0, blue: 0 };
  m.round = 1;
  m.banner = '';
  m.bannerTeam = null;
  R.score = { red: 0, blue: 0 };
  R.bullets = [];
  R.grenades = [];
  for (const id in R.players) {
    const p = R.players[id];
    p.kills = 0;
    p.deaths = 0;
    p.coins = MAP.START_COINS;
    p.owned = 1;
    p.weapon = 0;
    p.grenades = 0;
    p.flashes = 0;
    spawn(R, p);
  }
}

// Cambiar de mapa sin reiniciar puntos ni tiempo: todos reaparecen en su base del mapa nuevo
function changeMap(R, mapId) {
  if (!MAP.MAPS[mapId]) return false;
  R.map = mapId;
  R.bullets = [];
  R.grenades = [];
  for (const id in R.players) {
    const p = R.players[id];
    const wasWaiting = !p.alive && p.respawnAt === Infinity;
    spawn(R, p);
    if (wasWaiting) setDead(p, Infinity);
  }
  return true;
}

// En Guerra cada ronda arranca con unos segundos congelados para comprar
function setStartPhase(m, now) {
  if (m.mode === 'elim') { m.phase = 'freeze'; m.phaseUntil = now + FREEZE_MS; }
  else m.phase = 'playing';
}

function startRound(R) {
  const m = R.match;
  m.round++;
  setStartPhase(m, Date.now());
  m.banner = '';
  m.bannerTeam = null;
  R.bullets = [];
  R.grenades = [];
  for (const id in R.players) spawn(R, R.players[id]);
}

function endMatch(R, now) {
  const m = R.match;
  let w = null;
  const pts = m.mode === 'elim' ? m.rounds : R.score;
  if (pts.red > pts.blue) w = 'red';
  else if (pts.blue > pts.red) w = 'blue';
  m.phase = 'matchEnd';
  m.phaseUntil = now + MATCH_END_MS;
  m.bannerTeam = w || 'draw';
  m.banner = w ? `¡GANA EL ${teamName(w)}!` : '¡EMPATE!';
  R.bullets = [];
  emit(R, 'feed', `Fin de la partida: ${m.banner}`);
}

function roundWin(R, t, now) {
  const m = R.match;
  if (t) m.rounds[t]++;
  m.phase = 'roundEnd';
  m.phaseUntil = now + ROUND_END_MS;
  m.bannerTeam = t || 'draw';
  m.banner = t ? `Ronda ${m.round} para el ${teamName(t)}` : `Ronda ${m.round}: empate`;
  R.bullets = [];
}

// Guerra: si un equipo se quedo sin vivos, el otro gana la ronda.
function checkElimination(R, now) {
  const m = R.match;
  if (m.mode !== 'elim' || m.phase !== 'playing') return;
  const total = { red: 0, blue: 0 };
  const alive = { red: 0, blue: 0 };
  for (const id in R.players) {
    const p = R.players[id];
    total[p.team]++;
    if (p.alive) alive[p.team]++;
  }
  if (!total.red || !total.blue) return; // hace falta gente en los dos equipos
  if (!alive.red && !alive.blue) roundWin(R, null, now);
  else if (!alive.red) roundWin(R, 'blue', now);
  else if (!alive.blue) roundWin(R, 'red', now);
}

// ---- Tienda y granadas ----
// Para comprar hay que estar vivo y dentro de la base del propio equipo (equipar lo ya comprado se puede en cualquier lado)
function canShop(R, p) {
  useMap(R);
  return p.isBot || (p.alive && MAP.inBase(p.team, p.x, p.y));
}

function buyOrEquip(R, p, w) {
  const wp = WEAPONS[w];
  if (!wp) return 'Arma inválida';
  if (p.owned & (1 << w)) {
    p.weapon = w;
    return null;
  }
  if (!canShop(R, p)) return 'Solo podés comprar en tu base';
  if (p.coins < wp.price) return `Te faltan $${wp.price - p.coins}`;
  p.coins -= wp.price;
  p.owned |= 1 << w;
  p.weapon = w;
  return null;
}

function buyGrenade(R, p, flash) {
  if (!canShop(R, p)) return 'Solo podés comprar en tu base';
  const has = flash ? p.flashes : p.grenades;
  if (has >= GR.max) return `Máximo ${GR.max} ${flash ? 'flashes' : 'granadas'}`;
  if (p.coins < GR.price) return `Te faltan $${GR.price - p.coins}`;
  p.coins -= GR.price;
  if (flash) p.flashes++; else p.grenades++;
  return null;
}

function throwGrenade(R, p, now, flash) {
  if (!p.alive || (flash ? p.flashes : p.grenades) <= 0 || R.match.phase !== 'playing' || now - p.lastThrow < GR.cooldown) return;
  useMap(R);
  p.lastThrow = now;
  if (flash) p.flashes--; else p.grenades--;
  const a = p.input.a;
  // La mira se traduce en angulo de tiro: mirando recto sale con ~20 grados,
  // y mirando bien arriba sale a 45 grados (el angulo de mayor alcance).
  const aim = clamp(p.input.p || 0, -MAP.MAX_PITCH, MAP.MAX_PITCH) / MAP.MAX_PITCH; // -1..1
  const pitch = aim >= 0 ? 0.35 + aim * (Math.PI / 4 - 0.35) : 0.35 + aim * 0.55;
  const hs = Math.cos(pitch) * GR.throwSpeed;
  const z0 = (p.z || 0) + MAP.EYE_H - 8;
  let x = p.x + Math.cos(a) * (P_R + 6);
  let y = p.y + Math.sin(a) * (P_R + 6);
  if (solidAt(x, y, z0)) { x = p.x; y = p.y; }
  R.grenades.push({
    id: ++R.grenadeId, x, y, z: z0,
    vx: Math.cos(a) * hs, vy: Math.sin(a) * hs, vz: Math.sin(pitch) * GR.throwSpeed,
    owner: p.id, team: p.team, explodeAt: now + (flash ? GR.fuse * 0.7 : GR.fuse), f: !!flash,
  });
  emit(R, 'thr', [Math.round(x), Math.round(y)]); // sonido de tirar la granada
}

function updateGrenades(R, now) {
  const keep = [];
  for (const g of R.grenades) {
    // movimiento con gravedad y rebotes contra paredes y piso
    g.vz -= GR.gravity * DT;
    const nx = g.x + g.vx * DT;
    if (nx < 0 || nx > MAP.W || solidAt(nx, g.y, g.z)) g.vx *= -0.45; else g.x = nx;
    const ny = g.y + g.vy * DT;
    if (ny < 0 || ny > MAP.H || solidAt(g.x, ny, g.z)) g.vy *= -0.45; else g.y = ny;
    const nz = g.z + g.vz * DT;
    if (nz <= 4) {
      g.z = 4;
      g.vz = Math.abs(g.vz) > 60 ? -g.vz * 0.35 : 0;
      g.vx *= 0.7; g.vy *= 0.7; // friccion con el piso
    } else if (g.vz < 0 && solidAt(g.x, g.y, nz)) {
      g.vz = Math.abs(g.vz) > 60 ? -g.vz * 0.35 : 0; // cae arriba de algo
      g.vx *= 0.7; g.vy *= 0.7;
    } else if (g.vz > 0 && solidAt(g.x, g.y, nz)) {
      g.vz = 0; // pego contra algo por arriba
    } else g.z = nz;
    if (g.z > 320) { g.z = 320; g.vz = Math.min(0, g.vz); }
    if (now >= g.explodeAt) explode(R, g, now);
    else keep.push(g);
  }
  R.grenades = keep;
}

// Flashbang: enceguece a todos los que lo pueden ver, de los dos equipos y al que lo tiro
// (mas si lo miran de frente y estan cerca)
function flashBang(R, g, now) {
  const F = MAP.FLASH;
  emit(R, 'flash', { x: Math.round(g.x), y: Math.round(g.y), z: Math.round(g.z) });
  for (const id in R.players) {
    const q = R.players[id];
    if (!q.alive) continue;
    const qz = (q.z || 0) + MAP.EYE_H;
    const d = Math.hypot(q.x - g.x, q.y - g.y, qz - g.z);
    if (d > F.radius) continue;
    if (!MAP.los(g.x, g.y, g.z + 6, q.x, q.y, qz)) continue; // detras de una pared no te ciega
    const look = Math.cos(angleDiff(Math.atan2(g.y - q.y, g.x - q.x), q.a));
    const facing = look > 0.5 ? 1 : look > -0.1 ? 0.6 : 0.3; // de espaldas casi no te afecta
    const ms = Math.round(F.maxMs * facing * (1 - 0.65 * (d / F.radius)));
    if (ms < F.minMs) continue;
    q.blindUntil = Math.max(q.blindUntil || 0, now + ms);
    if (!q.isBot) io.to(q.id).emit('flashed', ms);
  }
}

function explode(R, g, now) {
  if (g.f) return flashBang(R, g, now);
  emit(R, 'boom', { x: Math.round(g.x), y: Math.round(g.y), z: Math.round(g.z), t: g.team });
  const thrower = R.players[g.owner];
  for (const id in R.players) {
    const q = R.players[id];
    if (!q.alive || q.team === g.team) continue; // no lastima a tu equipo
    const qz = (q.z || 0) + 45;
    const d = Math.hypot(q.x - g.x, q.y - g.y, (qz - g.z) * 0.7);
    if (d > GR.radius) continue;
    if (!MAP.los(g.x, g.y, g.z + 10, q.x, q.y, qz)) continue; // las paredes y los pisos cubren
    if (now < q.protectUntil) continue;
    // daño segun la distancia: maximo en el centro, minimo en el borde
    q.hp -= Math.round(GR.maxDmg - (GR.maxDmg - GR.minDmg) * (d / GR.radius));
    const k = q.hp <= 0;
    if (k) kill(R, q, thrower, now, false, true);
    notifyHit(thrower, false, k);
  }
}

// ---- Bots ----
const MAX_BOTS = 12;
// Dificultad de los bots (nivel intermedio). Subir/bajar estos numeros para ajustar.
const BOT = {
  speed: 0.85, // velocidad respecto a un jugador (1 = igual)
  sight: 650, // distancia a la que "ven" al enemigo
  reactMin: 600, // ms minimos antes de empezar a disparar al verte
  reactMax: 1100, // ms maximos
  aimNoise: 0.45, // error de punteria (radianes)
  turn: 0.12, // que tan rapido giran la mira hacia vos (0-1)
  burst: 700, // ms disparando seguido
  pause: 600, // ms de pausa entre rafagas
};

// Los bots se compran la mejor arma que les alcance.
function botAutoBuy(p) {
  for (let w = WEAPONS.length - 1; w >= 1; w--) {
    if ((p.owned & (1 << w)) || p.coins >= WEAPONS[w].price) {
      if (!(p.owned & (1 << w))) { p.coins -= WEAPONS[w].price; p.owned |= 1 << w; }
      p.weapon = w;
      return;
    }
  }
}

function botCount(R) {
  let n = 0;
  for (const id in R.players) if (R.players[id].isBot) n++;
  return n;
}

// auto = bot agregado solo para emparejar equipos (se va si entra una persona)
function addBot(R, team, auto) {
  if (botCount(R) >= MAX_BOTS) return null;
  if (team !== 'red' && team !== 'blue') {
    const c = teamCounts(R);
    team = c.red <= c.blue ? 'red' : 'blue';
  }
  const id = R.id + '-bot-' + ++R.botSeq;
  const p = newPlayer(id, 'Bot ' + R.botSeq, team, true, Math.random() < 0.5 ? 0 : 1);
  p.autoBot = !!auto;
  p.bot = { reactAt: 0, strafe: 1, strafeAt: 0, lastX: 0, lastY: 0, checkAt: 0, wanderUntil: 0, wanderA: 0 };
  placeNewPlayer(R, p);
  R.players[id] = p;
  return p;
}

function removeBots(R) {
  let n = 0;
  for (const id in R.players) if (R.players[id].isBot) { delete R.players[id]; n++; }
  return n;
}

function removeAutoBots(R) {
  const names = [];
  for (const id in R.players) if (R.players[id].autoBot) { names.push(R.players[id].name); delete R.players[id]; }
  return names;
}

// ---- Creador (admin) y equipos parejos ----
// El creador es quien hizo la sala; si se va, pasa a ser el jugador que siga.
function ensureCreator(R) {
  const c = R.players[R.match.creator];
  if (c && !c.isBot) return;
  R.match.creator = null;
  for (const id in R.players) if (!R.players[id].isBot) { R.match.creator = id; break; }
}

function notifyCreator(R, msg) {
  ensureCreator(R);
  if (R.match.creator) io.to(R.match.creator).emit('notice', msg);
}

// Si un equipo tiene menos jugadores, se agregan bots ahi; si sobran bots automaticos, se sacan.
function balanceTeams(R) {
  if (!R.match.autoFill || humanCount(R) === 0) return;
  const notes = [];
  for (let guard = 0; guard < MAX_BOTS + 2; guard++) {
    const c = teamCounts(R);
    const diff = c.red - c.blue;
    if (diff === 0) break;
    const big = diff > 0 ? 'red' : 'blue';
    const small = diff > 0 ? 'blue' : 'red';
    // primero se saca un bot automatico del equipo que tiene de mas (mejor si esta muerto)
    const extra = Object.values(R.players)
      .filter((p) => p.autoBot && p.team === big)
      .sort((a, b) => (a.alive ? 1 : 0) - (b.alive ? 1 : 0))[0];
    if (extra) {
      delete R.players[extra.id];
      notes.push(`Se quitó ${extra.name} del ${teamName(big)}`);
      continue;
    }
    const bot = addBot(R, small, true);
    if (!bot) break; // se llego al maximo de bots
    notes.push(`Se agregó ${bot.name} al ${teamName(small)} para emparejar`);
  }
  if (notes.length) {
    const c = teamCounts(R);
    notifyCreator(R, `🤖 ${notes.join(' · ')} (${c.red} vs ${c.blue})`);
    checkElimination(R, Date.now());
  }
}

// Busca una direccion libre de paredes cercana a la deseada.
function freeDirection(p, goal) {
  const offs = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2, Math.PI];
  for (const o of offs) {
    const a = goal + o * (p.bot.strafe || 1);
    const x = p.x + Math.cos(a) * 45;
    const y = p.y + Math.sin(a) * 45;
    if (x < P_R || y < P_R || x > MAP.W - P_R || y > MAP.H - P_R) continue;
    if (!MAP.blocked(x, y, p.z || 0, P_R)) return a;
  }
  return goal + Math.PI;
}

function botThink(R, p, now) {
  const b = p.bot;
  p.input.shoot = false;

  if (now >= b.strafeAt) {
    b.strafe = Math.random() < 0.5 ? 1 : -1;
    b.strafeAt = now + 800 + Math.random() * 1400;
  }
  if (now >= b.checkAt) {
    if (Math.hypot(p.x - b.lastX, p.y - b.lastY) < 25 && now >= b.wanderUntil) {
      b.wanderUntil = now + 900;
      b.wanderA = Math.random() * Math.PI * 2;
    }
    b.lastX = p.x; b.lastY = p.y;
    b.checkAt = now + 1000;
  }

  let target = null, td = Infinity;
  for (const id in R.players) {
    const q = R.players[id];
    if (!q.alive || q.team === p.team) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < td) { td = d; target = q; }
  }

  // con la regadera se acercan mas
  const close = p.weapon === 2 ? 140 : 220;
  const far = p.weapon === 2 ? 260 : 450;

  let goal;
  if (!target) {
    goal = Math.atan2(MAP.H / 2 - p.y, MAP.W / 2 - p.x);
  } else {
    const ang = Math.atan2(target.y - p.y, target.x - p.x);
    const visible = now >= (p.blindUntil || 0) && td < BOT.sight && canSee(p, target); // encegecido no ve
    if (visible) {
      if (!b.reactAt) {
        b.reactAt = now + BOT.reactMin + Math.random() * (BOT.reactMax - BOT.reactMin);
        b.aim = p.a;
      }
      b.aim += angleDiff(ang, b.aim) * BOT.turn;
      p.input.a = b.aim + (Math.random() - 0.5) * BOT.aimNoise;
      // apuntan al pecho con algo de error vertical (de vez en cuando le pegan a la cabeza)
      const dz = ((target.z || 0) + CHEST) - ((p.z || 0) + MAP.EYE_H);
      p.input.p = clamp(Math.atan2(dz, td) + (Math.random() - 0.5) * BOT.aimNoise * 0.35, -MAP.MAX_PITCH, MAP.MAX_PITCH);
      const cycle = (now - b.reactAt) % (BOT.burst + BOT.pause);
      p.input.shoot = now >= b.reactAt && cycle < BOT.burst;
      if (td > far) goal = ang + b.strafe * 0.5;
      else if (td < close) goal = ang + Math.PI - b.strafe * 0.5;
      else goal = ang + b.strafe * Math.PI / 2;
    } else {
      b.reactAt = 0;
      goal = ang;
      p.input.a = ang;
    }
  }

  if (now < b.wanderUntil) goal = b.wanderA;
  const dir = freeDirection(p, goal);
  p.input.mx = Math.cos(dir);
  p.input.my = Math.sin(dir);
  if (!p.input.shoot && (!target || now < b.wanderUntil)) p.input.a = dir;
}

// ---- Disparos, bajas ----
function kill(R, victim, shooter, now, head, grenade) {
  setDead(victim, R.match.mode === 'elim' ? Infinity : now + RESPAWN_MS);
  victim.deaths++;
  if (shooter) {
    shooter.kills++;
    shooter.coins += head ? MAP.HEADSHOT_COINS : MAP.KILL_COINS;
  }
  R.score[victim.team === 'red' ? 'blue' : 'red']++;
  const icon = grenade ? (victim.team === 'red' ? '💦' : '🔥') : head ? '🎯' : '🔫';
  emit(R, 'feed', `${shooter ? shooter.name : '???'} ${icon} ${victim.name}`);
  checkElimination(R, now);
}

// Aviso al tirador de que pego (para la marca en la mira)
function notifyHit(shooter, head, killed) {
  if (shooter && !shooter.isBot) io.to(shooter.id).emit('hit', { h: head ? 1 : 0, k: killed ? 1 : 0 });
}

function tryShoot(R, p, now) {
  const wp = WEAPONS[p.weapon] || WEAPONS[0];
  if (!p.input.shoot || now - p.lastShot < wp.rate) return;
  p.lastShot = now;
  p.protectUntil = 0; // si dispara pierde la proteccion de recien aparecido
  let a = p.a;

  // Ayuda de apuntado: si hay un enemigo visible cerca de la mira, apunta a el.
  if (!p.isBot) {
    // apunta a donde el tirador VE al enemigo (posicion rebobinada), igual que el calculo del impacto
    const back = now - rewindFor(p);
    let best = null;
    let bestD = Infinity;
    for (const id in R.players) {
      const q = R.players[id];
      if (!q.alive || q.team === p.team) continue;
      const qp = posAt(q, back);
      const d = Math.hypot(qp.x - p.x, qp.y - p.y);
      if (d > ASSIST_RANGE || d >= bestD) continue;
      if (Math.abs(angleDiff(Math.atan2(qp.y - p.y, qp.x - p.x), a)) > ASSIST_ANGLE) continue;
      if (!canSee(p, { x: qp.x, y: qp.y, z: qp.z })) continue;
      best = qp;
      bestD = d;
    }
    if (best) a = Math.atan2(best.y - p.y, best.x - p.x);
  }
  p.a = a;

  const bz = (p.z || 0) + MAP.EYE_H; // los disparos salen de los ojos
  const bx = p.x + Math.cos(a) * (P_R + 8);
  const by = p.y + Math.sin(a) * (P_R + 8);
  if (solidAt(bx, by, bz)) return;
  const pitch = clamp(p.input.p || 0, -MAP.MAX_PITCH, MAP.MAX_PITCH);
  for (let i = 0; i < wp.pellets; i++) {
    // la regadera abre sus chorros en abanico; las demas tienen un leve desvio
    const off = wp.pellets > 1
      ? (i / (wp.pellets - 1) - 0.5) * wp.spread + (Math.random() - 0.5) * 0.05
      : (Math.random() - 0.5) * wp.spread;
    const ba = a + off;
    const bp = pitch + (Math.random() - 0.5) * wp.spread * 0.5; // desvio vertical
    const hs = Math.cos(bp) * wp.speed;
    R.bullets.push({
      id: ++R.bulletId, x: bx, y: by, z: bz,
      vx: Math.cos(ba) * hs, vy: Math.sin(ba) * hs, vz: Math.sin(bp) * wp.speed,
      owner: p.id, team: p.team, life: wp.life, dmg: wp.dmg,
      rewind: rewindFor(p), // cuanto "en el pasado" estaba viendo el tirador a los demas
    });
  }
  // aviso para el sonido del disparo: [x, y, arma, quien]
  emit(R, 'shot', [Math.round(p.x), Math.round(p.y), wp.id, p.id]);
}

function updatePhase(R, now) {
  const m = R.match;
  if (m.phase === 'freeze' && now >= m.phaseUntil) m.phase = 'playing';
  if (m.phase === 'playing' && now >= m.endsAt) endMatch(R, now);
  else if (m.phase === 'roundEnd' && now >= m.phaseUntil) {
    if (now >= m.endsAt) endMatch(R, now);
    else startRound(R);
  } else if (m.phase === 'matchEnd' && now >= m.phaseUntil) {
    startMatch(R, m.mode, m.minutes); // arranca otra con la misma configuracion
  }
}

// ---- Un paso de simulacion de una sala ----
function tickRoom(R, now) {
  useMap(R);
  updatePhase(R, now);
  const m = R.match;
  const frozen = m.phase !== 'playing';
  const P = R.players;

  for (const id in P) {
    const p = P[id];
    if (!p.alive) {
      if (!frozen && now >= p.respawnAt) spawn(R, p);
      continue;
    }
    if (frozen) continue;
    if (p.isBot) botThink(R, p, now);
    if (p.input.jumpReq) { MAP.jump(p); p.input.jumpReq = false; }
    const sp = p.isBot ? SPEED * BOT.speed : SPEED;
    p.x += p.input.mx * sp * DT;
    p.y += p.input.my * sp * DT;
    resolve(p);
    p.a = p.input.a;
    tryShoot(R, p, now);
  }

  // Los jugadores no se pueden superponer: se empujan entre si.
  const vivos = Object.values(P).filter((p) => p.alive);
  for (let i = 0; i < vivos.length; i++) {
    for (let j = i + 1; j < vivos.length; j++) {
      const a = vivos[i], b = vivos[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= P_R * 2 || d === 0) continue;
      if (Math.abs((a.z || 0) - (b.z || 0)) > 60) continue; // uno arriba y otro abajo: no chocan
      const push = (P_R * 2 - d) / 2;
      a.x -= (dx / d) * push; a.y -= (dy / d) * push;
      b.x += (dx / d) * push; b.y += (dy / d) * push;
      resolve(a); resolve(b);
    }
  }
  // historial de posiciones (para la compensacion de lag)
  for (const p of vivos) recordHistory(p, now);

  // Disparos (en sub-pasos para no atravesar nada).
  const STEPS = 3;
  const keep = [];
  const splats = []; // manchas de pintura donde las balas pegan en paredes, objetos o el piso
  for (const b of R.bullets) {
    let dead = false;
    for (let s = 0; s < STEPS && !dead; s++) {
      const px = b.x, py = b.y, pz = b.z;
      b.x += (b.vx * DT) / STEPS;
      b.y += (b.vy * DT) / STEPS;
      b.z += (b.vz * DT) / STEPS;
      if (b.x < 0 || b.y < 0 || b.x > MAP.W || b.y > MAP.H || b.z < 0 || b.z > 330 || solidAt(b.x, b.y, b.z)) {
        dead = true;
        const sp = splatAt(px, py, pz, b);
        if (sp) splats.push(sp);
        break;
      }
      for (const id in P) {
        const q = P[id];
        if (!q.alive || q.team === b.team) continue;
        // compensacion de lag: q se toma donde estaba cuando el tirador lo veia en su pantalla
        const qp = b.rewind ? posAt(q, now - b.rewind) : q;
        const rz = b.z - (qp.z || 0); // altura del disparo respecto a los pies de q
        if (rz < 0 || rz > MAP.TOP_Z) continue;
        const d2 = (qp.x - b.x) ** 2 + (qp.y - b.y) ** 2;
        const head = rz >= MAP.HEAD_Z;
        if (d2 > (head ? MAP.HEAD_R : P_R + 4) ** 2) continue; // la cabeza es mas angosta
        dead = true;
        if (now < q.protectUntil) break;
        const shooter = P[b.owner];
        if (head) {
          q.hp = 0; // a la cabeza: muerte directa
          kill(R, q, shooter, now, true);
          notifyHit(shooter, true, true);
        } else {
          q.hp -= b.dmg; // torso, brazos y piernas: daño normal
          const k = q.hp <= 0;
          if (k) kill(R, q, shooter, now, false);
          notifyHit(shooter, false, k);
        }
        break;
      }
    }
    b.life -= DT;
    if (!dead && b.life > 0 && m.phase === 'playing') keep.push(b);
  }
  R.bullets = keep;
  if (splats.length) emit(R, 'splat', splats);
  if (m.phase === 'playing') updateGrenades(R, now);
  else R.grenades = [];

  // Estado para los jugadores de esta sala
  const list = [];
  for (const id in P) {
    const p = P[id];
    list.push({
      id: p.id, n: p.name, t: p.team,
      x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z || 0), a: +p.a.toFixed(3), pt: +(p.input.p || 0).toFixed(2),
      hp: Math.max(0, p.hp), al: p.alive, k: p.kills, d: p.deaths,
      rs: p.alive ? 0 : (p.respawnAt === Infinity ? -1 : Math.max(0, p.respawnAt - now)),
      sp: now < p.protectUntil,
      sf: now - p.lastShot < 70,
      q: p.input.q || 0,
      bt: !!p.isBot,
      w: p.weapon, c: p.coins, o: p.owned, gr: p.grenades, fb: p.flashes, sy: p.style,
      pg: Math.round(p.rtt || 0), // demora (ping) en ms
    });
  }
  io.to(R.id).volatile.emit('state', {
    p: list,
    b: R.bullets.map((b) => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.team === 'red' ? 0 : 1, Math.round(b.z), Math.round(b.vz)]),
    s: R.score,
    g: R.grenades.map((g) => [g.id, Math.round(g.x), Math.round(g.y), Math.round(g.z), Math.max(0, g.explodeAt - now), g.team === 'red' ? 0 : 1, g.f ? 1 : 0]),
    m: {
      mo: m.mode,
      min: m.minutes,
      tl: Math.max(0, m.endsAt - now),
      ph: m.phase,
      r: m.rounds,
      rn: m.round,
      ban: m.banner,
      bt: m.bannerTeam,
      pl: m.phase === 'playing' ? 0 : Math.max(0, m.phaseUntil - now),
      af: m.autoFill,
      mp: R.map, // mapa actual
      cr: m.creator,
      room: { c: R.id, pub: R.isPublic, name: R.name },
    },
  });
}

// Lista de salas publicas (para el menu)
function publicRooms() {
  const now = Date.now();
  return Object.values(rooms)
    .filter((R) => R.isPublic && humanCount(R) > 0)
    .map((R) => ({
      c: R.id, name: R.name, map: R.map, mode: R.match.mode,
      humans: humanCount(R), bots: botCount(R), tl: Math.max(0, R.match.endsAt - now),
    }));
}

// =====================================================================
// Conexiones
// =====================================================================
io.on('connection', (socket) => {
  const here = () => {
    const R = rooms[socket.data.room];
    return { R, p: R && R.players[socket.id] };
  };
  // Acciones que solo puede hacer el creador de la sala
  const asCreator = () => {
    const { R, p } = here();
    if (!R || !p) return {};
    ensureCreator(R);
    if (R.match.creator !== socket.id) {
      socket.emit('feed', '👑 Solo el creador de la sala puede hacer eso');
      return {};
    }
    return { R, p };
  };

  // Limite de mensajes por segundo (si alguien manda de mas, se ignoran los sobrantes)
  let tokens = EVENT_RATE, lastRefill = Date.now();
  socket.use((packet, next) => {
    const now = Date.now();
    tokens = Math.min(EVENT_RATE * 2, tokens + ((now - lastRefill) / 1000) * EVENT_RATE);
    lastRefill = now;
    if (tokens < 1) return; // se descarta
    tokens--;
    next();
  });
  socket.data.creates = [];
  socket.data.joins = [];

  // Medicion de la demora (ida y vuelta) de este jugador, para la compensacion de lag
  socket.on('sp2', (t) => {
    const { p } = here();
    const rtt = Date.now() - Number(t);
    if (p && rtt >= 0 && rtt < 3000) p.rtt = p.rtt ? p.rtt * 0.7 + rtt * 0.3 : rtt;
  });

  socket.emit('rooms', publicRooms());
  socket.on('listRooms', () => socket.emit('rooms', publicRooms()));

  // Cada pestaña del navegador manda su identificacion (cid). Si esa pestaña ya tenia un jugador
  // (por ejemplo se corto la conexion o se recargo la pagina), se recupera en vez de crear uno duplicado.
  function takeOver(R, cid, data) {
    if (!cid) return false;
    for (const rid in rooms) {
      const Q = rooms[rid];
      for (const id in Q.players) {
        const old = Q.players[id];
        if (old.isBot || old.cid !== cid || id === socket.id) continue;
        const oldSock = io.sockets.sockets.get(id);
        if (Q !== R) {
          // estaba en otra sala: se lo saca de ahi
          if (oldSock) oldSock.disconnect(true);
          else { delete Q.players[id]; if (humanCount(Q) === 0) delete rooms[rid]; }
          continue;
        }
        // misma sala: el jugador viejo pasa a esta conexion (conserva puntos, plata y armas)
        if (oldSock) { oldSock.data.room = null; oldSock.leave(R.id); oldSock.disconnect(true); }
        delete R.players[id];
        old.id = socket.id;
        old.input = { mx: 0, my: 0, a: old.input.a, p: 0, shoot: false, q: 0 };
        old.lastJc = 0;
        old.rtt = 0;
        old.hist = [];
        const nm = cleanName(data.name);
        if (data.name && !nm.changed) old.name = nm.name;
        R.players[socket.id] = old;
        if (R.match.creator === id) R.match.creator = socket.id;
        socket.data.room = R.id;
        socket.join(R.id);
        socket.emit('welcome', { id: socket.id, team: old.team, room: { c: R.id, pub: R.isPublic, name: R.name } });
        emit(R, 'feed', `${old.name} volvió a conectarse`);
        return true;
      }
    }
    return false;
  }

  function enterRoom(R, data, creating) {
    data = data || {};
    const cid = typeof data.cid === 'string' ? data.cid.replace(/[^a-z0-9]/gi, '').slice(0, 32) : '';
    if (takeOver(R, cid, data)) return;
    const clean = cleanName(data.name);
    const name = clean.name;
    if (clean.changed) socket.emit('notice', `🚫 Ese nombre no está permitido. Te pusimos "${name}".`);
    let team = data.team;
    if (team !== 'red' && team !== 'blue') {
      const c = teamCounts(R);
      team = c.red <= c.blue ? 'red' : 'blue';
    }
    socket.data.room = R.id;
    socket.join(R.id);
    const p = newPlayer(socket.id, name, team, false, Number(data.style));
    p.cid = cid;
    R.players[socket.id] = p;
    placeNewPlayer(R, p);
    if (creating) R.match.creator = socket.id;
    ensureCreator(R);
    socket.emit('welcome', { id: socket.id, team, room: { c: R.id, pub: R.isPublic, name: R.name } });
    emit(R, 'feed', `${name} entró al equipo ${teamName(team)}`);
    balanceTeams(R);
  }

  // Crear una sala nueva (publica o privada) y entrar como creador
  socket.on('createRoom', (data) => {
    if (here().R) return;
    data = data || {};
    if (Object.keys(rooms).length >= MAX_ROOMS) { socket.emit('joinError', 'Hay demasiadas salas abiertas. Probá unirte a una o esperá un rato.'); return; }
    if (overLimit(socket.data.creates, CREATE_LIMIT, Date.now())) { socket.emit('joinError', 'Creaste muchas salas seguidas. Esperá un minuto.'); return; }
    const name = cleanName(data.name).name;
    const R = createRoom({ name: `Sala de ${name}`, isPublic: data.public !== false, map: data.map });
    startMatch(R, data.mode, data.minutes, data.map);
    enterRoom(R, data, true);
    emit(R, 'feed', `${name} creó la sala: ${modeName(R.match.mode)} en ${MAP.MAPS[R.map].name}, ${R.match.minutes} min`);
  });

  // Entrar a una sala existente (de la lista o con el codigo)
  socket.on('joinRoom', (data) => {
    if (here().R) return;
    data = data || {};
    if (overLimit(socket.data.joins, JOIN_LIMIT, Date.now())) { socket.emit('joinError', 'Demasiados intentos. Esperá un minuto.'); return; }
    const code = String(data.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const R = rooms[code];
    if (!R) { socket.emit('joinError', `No existe ninguna sala con el código ${code || '(vacío)'}`); return; }
    if (humanCount(R) >= MAX_HUMANS_PER_ROOM) { socket.emit('joinError', `La sala ${code} está llena (máximo ${MAX_HUMANS_PER_ROOM} personas).`); return; }
    enterRoom(R, data, false);
  });

  socket.on('addBots', (data) => {
    const { R, p } = asCreator();
    if (!R) return;
    data = data || {};
    const count = clamp(Math.floor(Number(data.count) || 1), 1, 5);
    let added = 0;
    for (let i = 0; i < count; i++) if (addBot(R, data.team)) added++;
    if (added) emit(R, 'feed', `${p.name} agregó ${added} bot${added > 1 ? 's' : ''}`);
    else socket.emit('feed', `Máximo ${MAX_BOTS} bots`);
    balanceTeams(R);
  });

  // Quitar todos los bots tambien apaga el autocompletado, asi no vuelven (se puede jugar 3 vs 2)
  socket.on('clearBots', () => {
    const { R, p } = asCreator();
    if (!R) return;
    const n = removeBots(R);
    const wasOn = R.match.autoFill;
    R.match.autoFill = false;
    if (n) emit(R, 'feed', `${p.name} quitó ${n} bot${n > 1 ? 's' : ''}`);
    if (wasOn) emit(R, 'feed', 'Completar equipos con bots: desactivado');
    checkElimination(R, Date.now());
  });

  // Prender/apagar el autocompletado de equipos con bots
  socket.on('autoFill', (data) => {
    const { R, p } = asCreator();
    if (!R) return;
    R.match.autoFill = !!(data && data.on);
    if (R.match.autoFill) {
      emit(R, 'feed', `${p.name} activó completar equipos con bots`);
      balanceTeams(R);
    } else {
      const gone = removeAutoBots(R);
      emit(R, 'feed', `${p.name} desactivó completar equipos con bots`);
      if (gone.length) notifyCreator(R, `🤖 Se quitaron los bots automáticos: ${gone.join(', ')}`);
      checkElimination(R, Date.now());
    }
  });

  socket.on('newMatch', (data) => {
    const { R, p } = asCreator();
    if (!R) return;
    data = data || {};
    startMatch(R, data.mode, data.minutes, data.map);
    emit(R, 'feed', `${p.name} empezó una partida: ${modeName(R.match.mode)} en ${MAP.MAPS[R.map].name}, ${R.match.minutes} min`);
    balanceTeams(R);
  });

  // El creador cambia de mapa al instante (sin reiniciar puntos ni tiempo)
  socket.on('changeMap', (data) => {
    const { R, p } = asCreator();
    if (!R || !data) return;
    if (data.map === R.map) return;
    if (changeMap(R, data.map)) emit(R, 'feed', `${p.name} cambió el mapa a ${MAP.MAPS[R.map].name}`);
  });

  // Cambiarse de equipo (cualquiera)
  socket.on('switchTeam', () => {
    const { R, p } = here();
    if (!p) return;
    p.team = p.team === 'red' ? 'blue' : 'red';
    p.lastShot = 0;
    if (R.match.mode === 'elim' && R.match.phase === 'playing') { spawn(R, p); setDead(p, Infinity); }
    else spawn(R, p);
    socket.emit('teamChanged', { team: p.team });
    emit(R, 'feed', `${p.name} se cambió al equipo ${teamName(p.team)}`);
    balanceTeams(R);
    checkElimination(R, Date.now());
  });

  socket.on('buyGrenade', (data) => {
    const { R, p } = here();
    if (!p) return;
    const err = buyGrenade(R, p, !!(data && data.f));
    if (err) socket.emit('feed', err);
  });

  socket.on('throw', (data) => {
    const { R, p } = here();
    if (p) throwGrenade(R, p, Date.now(), !!(data && data.f));
  });

  socket.on('buy', (data) => {
    const { R, p } = here();
    if (!p || !data) return;
    const err = buyOrEquip(R, p, Math.floor(Number(data.w)));
    if (err) socket.emit('feed', err);
  });

  socket.on('input', (inp) => {
    const { p } = here();
    if (!p || !inp) return;
    let mx = Number(inp.mx) || 0;
    let my = Number(inp.my) || 0;
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }
    p.input.mx = mx;
    p.input.my = my;
    if (Number.isFinite(inp.a)) p.input.a = inp.a;
    if (Number.isFinite(inp.p)) p.input.p = clamp(inp.p, -MAP.MAX_PITCH, MAP.MAX_PITCH);
    p.input.shoot = !!inp.shoot;
    if (Number.isFinite(inp.q)) p.input.q = inp.q;
    // salto: el cliente manda un contador; cada vez que sube es un salto nuevo
    if (Number.isFinite(inp.jc) && inp.jc > (p.lastJc || 0)) {
      p.lastJc = inp.jc;
      p.input.jumpReq = true;
    }
  });

  // Salir de la sala (al menu) o desconectarse
  function leave() {
    const { R, p } = here();
    if (!R) return;
    socket.leave(R.id);
    socket.data.room = null;
    if (!p) return;
    delete R.players[socket.id];
    emit(R, 'feed', `${p.name} se fue`);
    if (humanCount(R) === 0) {
      delete rooms[R.id]; // sala vacia: se cierra
      return;
    }
    checkElimination(R, Date.now());
    if (R.match.creator === socket.id) {
      ensureCreator(R); // el siguiente jugador pasa a ser el creador
      if (R.match.creator) io.to(R.match.creator).emit('notice', '👑 Ahora sos el creador de la sala');
    }
    balanceTeams(R);
  }
  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

setInterval(() => {
  const now = Date.now();
  for (const id in rooms) tickRoom(rooms[id], now);
}, 1000 / TICK);

setInterval(() => {
  const now = Date.now();
  for (const id in rooms) {
    const R = rooms[id];
    useMap(R);
    balanceTeams(R); // control extra por si algo quedo desparejo
    // "ping" a cada persona para medir su demora (el celular lo devuelve enseguida)
    for (const pid in R.players) if (!R.players[pid].isBot) io.to(pid).emit('sp', now);
  }
  io.emit('rooms', publicRooms()); // la lista de salas publicas, para el menu
}, 2000);

const PORT = process.env.PORT || 3030;
server.listen(PORT, () => {
  console.log(`\n  Shooter Equipos corriendo en el puerto ${PORT}\n`);
  console.log(`  En esta PC:        http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        console.log(`  Desde el celular:  http://${ni.address}:${PORT}   (misma red Wi-Fi)`);
      }
    }
  }
  console.log('');
});
