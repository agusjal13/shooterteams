const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const MAP = require('./public/map.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
// no-cache: el navegador siempre pregunta si hay una version nueva (evita quedarse con archivos viejos)
const noCache = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use(express.static(path.join(__dirname, 'public'), noCache));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build'), noCache));

// ---- Reglas del juego ----
const TICK = 30;
const DT = 1 / TICK;
const P_R = MAP.P_R; // radio del jugador
const SPEED = MAP.SPEED; // px por segundo
const WEAPONS = MAP.WEAPONS;
const RESPAWN_MS = 3000;
const PROTECT_MS = 1500;
const ROUND_END_MS = 3500; // cartel de "gano la ronda" (modo eliminacion)
const MATCH_END_MS = 9000; // cartel de fin de partida antes de arrancar otra
const ASSIST_ANGLE = 0.3; // radianes (~17 grados) de ayuda de apuntado
const ASSIST_RANGE = 750;

const players = {};
let bullets = [];
let score = { red: 0, blue: 0 }; // bajas por equipo
let bulletId = 0;
let grenades = []; // granadas en el aire / en el piso
let grenadeId = 0;
const GR = MAP.GRENADE;

// ---- Partida ----
// mode: 'tdm' = con reaparicion, gana el equipo con mas bajas al terminar el tiempo
//       'elim' = sin reaparicion, cada ronda la gana el equipo que elimina a todos;
//                al terminar el tiempo gana el que gano mas rondas
const match = {
  creator: null, // id de quien creo la partida (recibe los avisos de bots)
  autoFill: true, // completar equipos con bots automaticamente
  mode: 'tdm',
  minutes: 5,
  endsAt: 0,
  phase: 'playing', // 'playing' | 'roundEnd' | 'matchEnd'
  phaseUntil: 0,
  rounds: { red: 0, blue: 0 },
  round: 1,
  banner: '',
  bannerTeam: null,
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Fisica con alturas (compartida con el cliente en map.js)
const solidAt = (x, y, z) => MAP.solidAt(x, y, z);
const CHEST = 48; // altura del pecho (para ver/apuntar a alguien)
// ¿p ve a q? (de ojos a pecho, teniendo en cuenta pisos y paredes)
const canSee = (p, q) => MAP.los(p.x, p.y, (p.z || 0) + MAP.EYE_H, q.x, q.y, (q.z || 0) + CHEST);

const resolve = (p) => MAP.resolve(p, P_R, DT);

function spawn(p) {
  const s = MAP.spawns[p.team];
  for (let i = 0; i < 30; i++) {
    p.x = s.x + Math.random() * s.w;
    p.y = s.y + Math.random() * s.h;
    if (!MAP.blocked(p.x, p.y, 0, P_R)) break;
  }
  p.z = 0;
  p.vz = 0;
  p.hp = 100;
  p.alive = true;
  p.a = p.team === 'red' ? 0 : Math.PI;
  p.input.a = p.a;
  p.input.p = 0;
  p.protectUntil = Date.now() + PROTECT_MS;
  if (p.isBot) botAutoBuy(p);
}

function setDead(p, respawnAt) {
  p.alive = false;
  p.hp = 0;
  p.respawnAt = respawnAt;
}

function teamCounts() {
  const c = { red: 0, blue: 0 };
  for (const id in players) c[players[id].team]++;
  return c;
}

function teamName(t) {
  return t === 'red' ? 'ROJO' : 'AZUL';
}

function newPlayer(id, name, team, isBot, style) {
  return {
    id, name, team, isBot: !!isBot,
    style: style === 1 ? 1 : 0, // personaje elegido (0 o 1 dentro de su equipo)
    x: 0, y: 0, z: 0, a: 0, hp: 100, alive: true,
    kills: 0, deaths: 0, lastShot: 0, respawnAt: 0, protectUntil: 0,
    coins: MAP.START_COINS, owned: 1, weapon: 0, // owned = armas compradas (bits)
    grenades: 0, lastThrow: 0,
    input: { mx: 0, my: 0, a: 0, p: 0, shoot: false },
  };
}

// Un jugador que entra en medio de una ronda de eliminacion espera a la proxima.
function placeNewPlayer(p) {
  if (match.mode === 'elim' && match.phase === 'playing') {
    spawn(p);
    setDead(p, Infinity);
  } else {
    spawn(p);
  }
}

// ---- Partida: inicio, rondas y final ----
function startMatch(mode, minutes, creatorId, mapId) {
  if (creatorId) match.creator = creatorId;
  if (mapId && MAP.MAPS[mapId]) MAP.setMap(mapId); // si no se elige mapa, se sigue con el actual
  const now = Date.now();
  match.mode = mode === 'elim' ? 'elim' : 'tdm';
  match.minutes = clamp(Math.round(Number(minutes) || 5), 1, MAP.MAX_MINUTES);
  match.endsAt = now + match.minutes * 60000;
  match.phase = 'playing';
  match.rounds = { red: 0, blue: 0 };
  match.round = 1;
  match.banner = '';
  match.bannerTeam = null;
  score = { red: 0, blue: 0 };
  bullets = [];
  for (const id in players) {
    const p = players[id];
    p.kills = 0;
    p.deaths = 0;
    p.coins = MAP.START_COINS;
    p.owned = 1;
    p.weapon = 0;
    p.grenades = 0;
    spawn(p);
  }
  grenades = [];
}

function startRound() {
  match.round++;
  match.phase = 'playing';
  match.banner = '';
  match.bannerTeam = null;
  bullets = [];
  grenades = [];
  for (const id in players) spawn(players[id]);
}

function endMatch(now) {
  let w = null;
  const pts = match.mode === 'elim' ? match.rounds : score;
  if (pts.red > pts.blue) w = 'red';
  else if (pts.blue > pts.red) w = 'blue';
  match.phase = 'matchEnd';
  match.phaseUntil = now + MATCH_END_MS;
  match.bannerTeam = w || 'draw';
  match.banner = w ? `¡GANA EL ${teamName(w)}!` : '¡EMPATE!';
  bullets = [];
  io.emit('feed', `Fin de la partida: ${match.banner}`);
}

function roundWin(t, now) {
  if (t) match.rounds[t]++;
  match.phase = 'roundEnd';
  match.phaseUntil = now + ROUND_END_MS;
  match.bannerTeam = t || 'draw';
  match.banner = t ? `Ronda ${match.round} para el ${teamName(t)}` : `Ronda ${match.round}: empate`;
  bullets = [];
}

// Modo eliminacion: si un equipo se quedo sin vivos, el otro gana la ronda.
function checkElimination(now) {
  if (match.mode !== 'elim' || match.phase !== 'playing') return;
  const total = { red: 0, blue: 0 };
  const alive = { red: 0, blue: 0 };
  for (const id in players) {
    const p = players[id];
    total[p.team]++;
    if (p.alive) alive[p.team]++;
  }
  if (!total.red || !total.blue) return; // hace falta gente en los dos equipos
  if (!alive.red && !alive.blue) roundWin(null, now);
  else if (!alive.red) roundWin('blue', now);
  else if (!alive.blue) roundWin('red', now);
}

// ---- Granadas ----
// Para comprar hay que estar vivo y dentro de la base del propio equipo (equipar lo ya comprado se puede en cualquier lado)
function canShop(p) {
  return p.isBot || (p.alive && MAP.inBase(p.team, p.x, p.y));
}

function buyGrenade(p) {
  if (!canShop(p)) return 'Solo podés comprar en tu base';
  if (p.grenades >= GR.max) return `Máximo ${GR.max} granadas`;
  if (p.coins < GR.price) return `Te faltan $${GR.price - p.coins}`;
  p.coins -= GR.price;
  p.grenades++;
  return null;
}

function throwGrenade(p, now) {
  if (!p.alive || p.grenades <= 0 || match.phase !== 'playing' || now - p.lastThrow < GR.cooldown) return;
  p.lastThrow = now;
  p.grenades--;
  const a = p.input.a;
  // se tira hacia donde mira, con una curva hacia arriba
  // La mira se traduce en angulo de tiro: mirando recto sale con ~20 grados,
  // y mirando bien arriba sale a 45 grados (el angulo de mayor alcance).
  const aim = clamp(p.input.p || 0, -MAP.MAX_PITCH, MAP.MAX_PITCH) / MAP.MAX_PITCH; // -1..1
  const pitch = aim >= 0 ? 0.35 + aim * (Math.PI / 4 - 0.35) : 0.35 + aim * 0.55;
  const hs = Math.cos(pitch) * GR.throwSpeed;
  const z0 = (p.z || 0) + MAP.EYE_H - 8;
  let x = p.x + Math.cos(a) * (P_R + 6);
  let y = p.y + Math.sin(a) * (P_R + 6);
  if (solidAt(x, y, z0)) { x = p.x; y = p.y; }
  grenades.push({
    id: ++grenadeId, x, y, z: z0,
    vx: Math.cos(a) * hs, vy: Math.sin(a) * hs, vz: Math.sin(pitch) * GR.throwSpeed,
    owner: p.id, team: p.team, explodeAt: now + GR.fuse,
  });
}

function updateGrenades(now) {
  const keep = [];
  for (const g of grenades) {
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
      // cae arriba de algo (caja, techo, escalera): rebota un poco y frena
      g.vz = Math.abs(g.vz) > 60 ? -g.vz * 0.35 : 0;
      g.vx *= 0.7; g.vy *= 0.7;
    } else if (g.vz > 0 && solidAt(g.x, g.y, nz)) {
      g.vz = 0; // pego contra algo por arriba (ej. techo del galpon)
    } else g.z = nz;
    if (g.z > 320) { g.z = 320; g.vz = Math.min(0, g.vz); }

    if (now >= g.explodeAt) explode(g, now);
    else keep.push(g);
  }
  grenades = keep;
}

function explode(g, now) {
  io.emit('boom', { x: Math.round(g.x), y: Math.round(g.y), z: Math.round(g.z), t: g.team });
  const thrower = players[g.owner];
  for (const id in players) {
    const q = players[id];
    if (!q.alive || q.team === g.team) continue; // no lastima a tu equipo
    const qz = (q.z || 0) + 45;
    const d = Math.hypot(q.x - g.x, q.y - g.y, (qz - g.z) * 0.7);
    if (d > GR.radius) continue;
    if (!MAP.los(g.x, g.y, g.z + 10, q.x, q.y, qz)) continue; // las paredes y los pisos cubren
    if (now < q.protectUntil) continue;
    // daño segun la distancia: maximo en el centro, minimo en el borde
    const dmg = Math.round(GR.maxDmg - (GR.maxDmg - GR.minDmg) * (d / GR.radius));
    q.hp -= dmg;
    const k = q.hp <= 0;
    if (k) kill(q, thrower, now, false, true);
    notifyHit(thrower, false, k);
  }
}

// ---- Tienda ----
function buyOrEquip(p, w) {
  const wp = WEAPONS[w];
  if (!wp) return 'Arma inválida';
  if (p.owned & (1 << w)) {
    p.weapon = w;
    return null;
  }
  if (!canShop(p)) return 'Solo podés comprar en tu base';
  if (p.coins < wp.price) return `Te faltan $${wp.price - p.coins}`;
  p.coins -= wp.price;
  p.owned |= 1 << w;
  p.weapon = w;
  return null;
}

// ---- Bots (para probar) ----
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
let botSeq = 0;

// Los bots se compran la mejor arma que les alcance.
function botAutoBuy(p) {
  for (let w = WEAPONS.length - 1; w >= 1; w--) {
    if ((p.owned & (1 << w)) || p.coins >= WEAPONS[w].price) {
      buyOrEquip(p, w);
      return;
    }
  }
}

function botCount() {
  let n = 0;
  for (const id in players) if (players[id].isBot) n++;
  return n;
}

// auto = bot agregado solo para emparejar equipos (se va si entra una persona)
function addBot(team, auto) {
  if (botCount() >= MAX_BOTS) return null;
  if (team !== 'red' && team !== 'blue') {
    const c = teamCounts();
    team = c.red <= c.blue ? 'red' : 'blue';
  }
  const id = 'bot-' + ++botSeq;
  const p = newPlayer(id, 'Bot ' + botSeq, team, true, Math.random() < 0.5 ? 0 : 1);
  p.autoBot = !!auto;
  p.bot = { reactAt: 0, strafe: 1, strafeAt: 0, lastX: 0, lastY: 0, checkAt: 0, wanderUntil: 0, wanderA: 0 };
  placeNewPlayer(p);
  players[id] = p;
  return p;
}

// ---- Creador de la partida y equipos parejos ----
// El creador es quien arranco la partida; si se va, pasa a ser el jugador que siga.
function ensureCreator() {
  const c = players[match.creator];
  if (c && !c.isBot) return;
  match.creator = null;
  for (const id in players) if (!players[id].isBot) { match.creator = id; break; }
}

function notifyCreator(msg) {
  ensureCreator();
  if (match.creator) io.to(match.creator).emit('notice', msg);
}

// Si un equipo tiene menos jugadores, se agregan bots ahi; si sobran bots automaticos, se sacan.
function balanceTeams() {
  if (!match.autoFill || humanCount() === 0) return;
  const notes = [];
  for (let guard = 0; guard < MAX_BOTS + 2; guard++) {
    const c = teamCounts();
    const diff = c.red - c.blue;
    if (diff === 0) break;
    const big = diff > 0 ? 'red' : 'blue';
    const small = diff > 0 ? 'blue' : 'red';
    // primero se saca un bot automatico del equipo que tiene de mas (mejor si esta muerto)
    const extra = Object.values(players)
      .filter((p) => p.autoBot && p.team === big)
      .sort((a, b) => (a.alive ? 1 : 0) - (b.alive ? 1 : 0))[0];
    if (extra) {
      delete players[extra.id];
      notes.push(`Se quitó ${extra.name} del ${teamName(big)}`);
      continue;
    }
    const bot = addBot(small, true);
    if (!bot) break; // se llego al maximo de bots
    notes.push(`Se agregó ${bot.name} al ${teamName(small)} para emparejar`);
  }
  if (notes.length) {
    const c = teamCounts();
    notifyCreator(`🤖 ${notes.join(' · ')} (${c.red} vs ${c.blue})`);
    checkElimination(Date.now());
  }
}

function removeAutoBots() {
  const names = [];
  for (const id in players) if (players[id].autoBot) { names.push(players[id].name); delete players[id]; }
  return names;
}

function removeBots() {
  let n = 0;
  for (const id in players) if (players[id].isBot) { delete players[id]; n++; }
  return n;
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

function botThink(p, now) {
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
  for (const id in players) {
    const q = players[id];
    if (!q.alive || q.team === p.team) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < td) { td = d; target = q; }
  }

  // con escopeta se acercan mas
  const close = p.weapon === 2 ? 140 : 220;
  const far = p.weapon === 2 ? 260 : 450;

  let goal;
  if (!target) {
    goal = Math.atan2(MAP.H / 2 - p.y, MAP.W / 2 - p.x);
  } else {
    const ang = Math.atan2(target.y - p.y, target.x - p.x);
    const visible = td < BOT.sight && canSee(p, target);
    if (visible) {
      if (!b.reactAt) {
        b.reactAt = now + BOT.reactMin + Math.random() * (BOT.reactMax - BOT.reactMin);
        b.aim = p.a;
      }
      b.aim += angleDiff(ang, b.aim) * BOT.turn;
      p.input.a = b.aim + (Math.random() - 0.5) * BOT.aimNoise;
      // apuntan al pecho con algo de error vertical (de vez en cuando le pegan a la cabeza)
      const dz = ((target.z || 0) + CHEST) - ((p.z || 0) + MAP.EYE_H); // tiene en cuenta si esta mas arriba o abajo
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

function humanCount() {
  let n = 0;
  for (const id in players) if (!players[id].isBot) n++;
  return n;
}

// ---- Conexiones ----
io.on('connection', (socket) => {
  socket.on('addBots', (data) => {
    if (!players[socket.id]) return;
    data = data || {};
    const count = clamp(Math.floor(Number(data.count) || 1), 1, 5);
    let added = 0;
    for (let i = 0; i < count; i++) if (addBot(data.team)) added++;
    if (added) io.emit('feed', `${players[socket.id].name} agregó ${added} bot${added > 1 ? 's' : ''}`);
    else socket.emit('feed', `Máximo ${MAX_BOTS} bots`);
    balanceTeams();
  });

  // Quitar todos los bots tambien apaga el autocompletado, asi no vuelven (se puede jugar 3 vs 2)
  socket.on('clearBots', () => {
    const p = players[socket.id];
    if (!p) return;
    const n = removeBots();
    const wasOn = match.autoFill;
    match.autoFill = false;
    if (n) io.emit('feed', `${p.name} quitó ${n} bot${n > 1 ? 's' : ''}`);
    if (wasOn) {
      io.emit('feed', 'Completar equipos con bots: desactivado');
      notifyCreator('🤖 Se quitaron los bots y se apagó el autocompletado: los equipos pueden quedar desparejos');
    }
    checkElimination(Date.now());
  });

  // Prender/apagar el autocompletado de equipos con bots
  socket.on('autoFill', (data) => {
    const p = players[socket.id];
    if (!p) return;
    match.autoFill = !!(data && data.on);
    if (match.autoFill) {
      io.emit('feed', `${p.name} activó completar equipos con bots`);
      balanceTeams();
    } else {
      const gone = removeAutoBots();
      io.emit('feed', `${p.name} desactivó completar equipos con bots`);
      if (gone.length) notifyCreator(`🤖 Se quitaron los bots automáticos: ${gone.join(', ')}`);
      checkElimination(Date.now());
    }
  });

  socket.on('newMatch', (data) => {
    const p = players[socket.id];
    if (!p) return;
    data = data || {};
    startMatch(data.mode, data.minutes, socket.id, data.map);
    const modo = match.mode === 'elim' ? 'Guerra' : 'DeathMatch';
    io.emit('feed', `${p.name} empezó una partida: ${modo} en ${MAP.name}, ${match.minutes} min`);
    balanceTeams();
  });

  socket.on('buyGrenade', () => {
    const p = players[socket.id];
    if (!p) return;
    const err = buyGrenade(p);
    if (err) socket.emit('feed', err);
  });

  socket.on('throw', () => {
    const p = players[socket.id];
    if (p) throwGrenade(p, Date.now());
  });

  socket.on('buy', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;
    const err = buyOrEquip(p, Math.floor(Number(data.w)));
    if (err) socket.emit('feed', err);
  });

  socket.on('join', (data) => {
    if (players[socket.id]) return;
    data = data || {};
    const name = String(data.name || '').trim().slice(0, 14) || 'Jugador';
    let team = data.team;
    if (team !== 'red' && team !== 'blue') {
      const c = teamCounts();
      team = c.red <= c.blue ? 'red' : 'blue';
    }
    // Si no hay nadie jugando, o el jugador pidio empezar una nueva, arranca con el modo que eligio.
    const startNew = humanCount() === 0 || data.start === true;
    const p = newPlayer(socket.id, name, team, false, Number(data.style));
    placeNewPlayer(p);
    players[socket.id] = p;
    socket.emit('welcome', { id: socket.id, team });
    io.emit('feed', `${name} entró al equipo ${teamName(team)}`);
    if (startNew && (data.mode === 'tdm' || data.mode === 'elim')) {
      startMatch(data.mode, data.minutes, socket.id, data.map);
      const modo = match.mode === 'elim' ? 'Guerra' : 'DeathMatch';
      io.emit('feed', `${name} empezó una partida: ${modo} en ${MAP.name}, ${match.minutes} min`);
    }
    ensureCreator();
    balanceTeams();
  });

  socket.on('input', (inp) => {
    const p = players[socket.id];
    if (!p || !inp) return;
    let mx = Number(inp.mx) || 0;
    let my = Number(inp.my) || 0;
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
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

  // Salir de la partida (al menu) o desconectarse: el jugador deja de estar en el juego
  function leave() {
    const p = players[socket.id];
    if (!p) return;
    delete players[socket.id];
    io.emit('feed', `${p.name} se fue`);
    if (humanCount() === 0) removeBots(); // sin humanos, no quedan bots jugando solos
    checkElimination(Date.now());
    if (match.creator === socket.id) {
      ensureCreator(); // el siguiente jugador pasa a ser el creador
      if (match.creator) io.to(match.creator).emit('notice', '👑 Ahora sos el creador de la partida');
    }
    balanceTeams();
  }
  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

function kill(victim, shooter, now, head, grenade) {
  setDead(victim, match.mode === 'elim' ? Infinity : now + RESPAWN_MS);
  victim.deaths++;
  if (shooter) {
    shooter.kills++;
    shooter.coins += head ? MAP.HEADSHOT_COINS : MAP.KILL_COINS;
  }
  score[victim.team === 'red' ? 'blue' : 'red']++;
  io.emit('feed', `${shooter ? shooter.name : '???'} ${grenade ? (victim.team === 'red' ? '💦' : '🔥') : head ? '🎯' : '🔫'} ${victim.name}`);
  checkElimination(now);
}

// Aviso al tirador de que pego (para la marca en la mira)
function notifyHit(shooter, head, killed) {
  if (shooter && !shooter.isBot) io.to(shooter.id).emit('hit', { h: head ? 1 : 0, k: killed ? 1 : 0 });
}

function tryShoot(p, now) {
  const wp = WEAPONS[p.weapon] || WEAPONS[0];
  if (!p.input.shoot || now - p.lastShot < wp.rate) return;
  p.lastShot = now;
  let a = p.a;

  // Ayuda de apuntado: si hay un enemigo visible cerca de la mira, apunta a el.
  if (!p.isBot) {
    let best = null;
    let bestD = Infinity;
    for (const id in players) {
      const q = players[id];
      if (!q.alive || q.team === p.team) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d > ASSIST_RANGE || d >= bestD) continue;
      const diff = Math.abs(angleDiff(Math.atan2(q.y - p.y, q.x - p.x), a));
      if (diff > ASSIST_ANGLE) continue;
      if (!canSee(p, q)) continue;
      best = q;
      bestD = d;
    }
    if (best) a = Math.atan2(best.y - p.y, best.x - p.x);
  }
  p.a = a;

  const bz = (p.z || 0) + MAP.EYE_H; // las balas salen de los ojos (a la altura donde este parado)
  const bx = p.x + Math.cos(a) * (P_R + 8);
  const by = p.y + Math.sin(a) * (P_R + 8);
  if (solidAt(bx, by, bz)) return;
  const pitch = clamp(p.input.p || 0, -MAP.MAX_PITCH, MAP.MAX_PITCH);
  for (let i = 0; i < wp.pellets; i++) {
    // la escopeta abre sus perdigones en abanico; las demas tienen un leve desvio
    const off = wp.pellets > 1
      ? (i / (wp.pellets - 1) - 0.5) * wp.spread + (Math.random() - 0.5) * 0.05
      : (Math.random() - 0.5) * wp.spread;
    const ba = a + off;
    const bp = pitch + (Math.random() - 0.5) * wp.spread * 0.5; // desvio vertical
    const hs = Math.cos(bp) * wp.speed;
    bullets.push({
      id: ++bulletId, x: bx, y: by, z: bz,
      vx: Math.cos(ba) * hs, vy: Math.sin(ba) * hs, vz: Math.sin(bp) * wp.speed,
      owner: p.id, team: p.team, life: wp.life, dmg: wp.dmg,
    });
  }
}

function updatePhase(now) {
  if (match.phase === 'playing' && now >= match.endsAt) endMatch(now);
  else if (match.phase === 'roundEnd' && now >= match.phaseUntil) {
    if (now >= match.endsAt) endMatch(now);
    else startRound();
  } else if (match.phase === 'matchEnd' && now >= match.phaseUntil) {
    startMatch(match.mode, match.minutes); // arranca otra con la misma configuracion
  }
}

function tick() {
  const now = Date.now();
  updatePhase(now);
  const frozen = match.phase !== 'playing';

  for (const id in players) {
    const p = players[id];
    if (!p.alive) {
      if (!frozen && now >= p.respawnAt) spawn(p);
      continue;
    }
    if (frozen) continue;
    if (p.isBot) botThink(p, now);
    if (p.input.jumpReq) { MAP.jump(p); p.input.jumpReq = false; }
    const sp = p.isBot ? SPEED * BOT.speed : SPEED;
    p.x += p.input.mx * sp * DT;
    p.y += p.input.my * sp * DT;
    resolve(p);
    p.a = p.input.a;
    tryShoot(p, now);
  }

  // Los jugadores no se pueden superponer: se empujan entre si.
  const vivos = Object.values(players).filter((p) => p.alive);
  for (let i = 0; i < vivos.length; i++) {
    for (let j = i + 1; j < vivos.length; j++) {
      const a = vivos[i], b = vivos[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= P_R * 2 || d === 0) continue;
      if (Math.abs((a.z || 0) - (b.z || 0)) > 60) continue; // uno arriba de un techo y otro abajo: no chocan
      const push = (P_R * 2 - d) / 2;
      a.x -= (dx / d) * push; a.y -= (dy / d) * push;
      b.x += (dx / d) * push; b.y += (dy / d) * push;
      resolve(a); resolve(b);
    }
  }

  // Balas (en sub-pasos para no atravesar nada).
  const STEPS = 3;
  const alive = [];
  for (const b of bullets) {
    let dead = false;
    for (let s = 0; s < STEPS && !dead; s++) {
      b.x += (b.vx * DT) / STEPS;
      b.y += (b.vy * DT) / STEPS;
      b.z += (b.vz * DT) / STEPS;
      if (b.x < 0 || b.y < 0 || b.x > MAP.W || b.y > MAP.H || b.z < 0 || b.z > 330 || solidAt(b.x, b.y, b.z)) {
        dead = true;
        break;
      }
      for (const id in players) {
        const q = players[id];
        if (!q.alive || q.team === b.team) continue;
        const rz = b.z - (q.z || 0); // altura de la bala respecto a los pies de q
        if (rz < 0 || rz > MAP.TOP_Z) continue; // paso por arriba o por abajo
        const d2 = (q.x - b.x) ** 2 + (q.y - b.y) ** 2;
        const head = rz >= MAP.HEAD_Z;
        // la cabeza es mas angosta que el cuerpo
        if (d2 > (head ? MAP.HEAD_R : P_R + 4) ** 2) continue;
        dead = true;
        if (now < q.protectUntil) break;
        const shooter = players[b.owner];
        if (head) {
          q.hp = 0; // disparo a la cabeza: muerte directa
          kill(q, shooter, now, true);
          notifyHit(shooter, true, true);
        } else {
          q.hp -= b.dmg; // torso, brazos y piernas: daño normal
          const k = q.hp <= 0;
          if (k) kill(q, shooter, now, false);
          notifyHit(shooter, false, k);
        }
        break;
      }
    }
    b.life -= DT;
    if (!dead && b.life > 0 && match.phase === 'playing') alive.push(b);
  }
  bullets = alive;
  if (match.phase === 'playing') updateGrenades(now);
  else grenades = [];

  const list = [];
  for (const id in players) {
    const p = players[id];
    list.push({
      id: p.id, n: p.name, t: p.team,
      x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z || 0), a: +p.a.toFixed(3), pt: +(p.input.p || 0).toFixed(2),
      hp: Math.max(0, p.hp), al: p.alive, k: p.kills, d: p.deaths,
      rs: p.alive ? 0 : (p.respawnAt === Infinity ? -1 : Math.max(0, p.respawnAt - now)),
      sp: now < p.protectUntil,
      sf: now - p.lastShot < 70,
      q: p.input.q || 0,
      bt: !!p.isBot,
      w: p.weapon, c: p.coins, o: p.owned, gr: p.grenades, sy: p.style,
    });
  }
  io.volatile.emit('state', {
    p: list,
    b: bullets.map((b) => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.team === 'red' ? 0 : 1, Math.round(b.z), Math.round(b.vz)]),
    s: score,
    g: grenades.map((g) => [g.id, Math.round(g.x), Math.round(g.y), Math.round(g.z), Math.max(0, g.explodeAt - now), g.team === 'red' ? 0 : 1]),
    m: {
      mo: match.mode,
      min: match.minutes,
      tl: Math.max(0, match.endsAt - now),
      ph: match.phase,
      r: match.rounds,
      rn: match.round,
      ban: match.banner,
      bt: match.bannerTeam,
      pl: match.phase === 'playing' ? 0 : Math.max(0, match.phaseUntil - now),
      af: match.autoFill,
      mp: MAP.id, // mapa actual
      cr: match.creator,
    },
  });
}

startMatch('tdm', 5);
setInterval(tick, 1000 / TICK);
setInterval(balanceTeams, 2000); // control extra por si algo quedo desparejo

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
