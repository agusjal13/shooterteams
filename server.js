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

// ---- Partida ----
// mode: 'tdm' = con reaparicion, gana el equipo con mas bajas al terminar el tiempo
//       'elim' = sin reaparicion, cada ronda la gana el equipo que elimina a todos;
//                al terminar el tiempo gana el que gano mas rondas
const match = {
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

function pointInWall(x, y) {
  for (const w of MAP.walls) {
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
  }
  return false;
}

function hitsWall(x, y, r) {
  for (const w of MAP.walls) {
    const cx = clamp(x, w.x, w.x + w.w);
    const cy = clamp(y, w.y, w.y + w.h);
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
  }
  return false;
}

function lineOfSight(x1, y1, x2, y2) {
  const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 12);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (pointInWall(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
  }
  return true;
}

const resolve = (p) => MAP.resolve(p, P_R);

function spawn(p) {
  const s = MAP.spawns[p.team];
  for (let i = 0; i < 30; i++) {
    p.x = s.x + Math.random() * s.w;
    p.y = s.y + Math.random() * s.h;
    if (!hitsWall(p.x, p.y, P_R)) break;
  }
  p.hp = 100;
  p.alive = true;
  p.a = p.team === 'red' ? 0 : Math.PI;
  p.input.a = p.a;
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

function newPlayer(id, name, team, isBot) {
  return {
    id, name, team, isBot: !!isBot,
    x: 0, y: 0, a: 0, hp: 100, alive: true,
    kills: 0, deaths: 0, lastShot: 0, respawnAt: 0, protectUntil: 0,
    coins: MAP.START_COINS, owned: 1, weapon: 0, // owned = armas compradas (bits)
    input: { mx: 0, my: 0, a: 0, shoot: false },
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
function startMatch(mode, minutes) {
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
    spawn(p);
  }
}

function startRound() {
  match.round++;
  match.phase = 'playing';
  match.banner = '';
  match.bannerTeam = null;
  bullets = [];
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

// ---- Tienda ----
function buyOrEquip(p, w) {
  const wp = WEAPONS[w];
  if (!wp) return 'Arma inválida';
  if (p.owned & (1 << w)) {
    p.weapon = w;
    return null;
  }
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

function addBot(team) {
  if (botCount() >= MAX_BOTS) return false;
  if (team !== 'red' && team !== 'blue') {
    const c = teamCounts();
    team = c.red <= c.blue ? 'red' : 'blue';
  }
  const id = 'bot-' + ++botSeq;
  const p = newPlayer(id, 'Bot ' + botSeq, team, true);
  p.bot = { reactAt: 0, strafe: 1, strafeAt: 0, lastX: 0, lastY: 0, checkAt: 0, wanderUntil: 0, wanderA: 0 };
  placeNewPlayer(p);
  players[id] = p;
  return true;
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
    if (!hitsWall(x, y, P_R)) return a;
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
    const visible = td < BOT.sight && lineOfSight(p.x, p.y, target.x, target.y);
    if (visible) {
      if (!b.reactAt) {
        b.reactAt = now + BOT.reactMin + Math.random() * (BOT.reactMax - BOT.reactMin);
        b.aim = p.a;
      }
      b.aim += angleDiff(ang, b.aim) * BOT.turn;
      p.input.a = b.aim + (Math.random() - 0.5) * BOT.aimNoise;
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
  });

  socket.on('clearBots', () => {
    if (!players[socket.id]) return;
    const n = removeBots();
    if (n) io.emit('feed', `Se quitaron ${n} bots`);
    checkElimination(Date.now());
  });

  socket.on('newMatch', (data) => {
    const p = players[socket.id];
    if (!p) return;
    data = data || {};
    startMatch(data.mode, data.minutes);
    const modo = match.mode === 'elim' ? 'Eliminación' : 'Con reaparición';
    io.emit('feed', `${p.name} empezó una partida: ${modo}, ${match.minutes} min`);
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
    const p = newPlayer(socket.id, name, team, false);
    placeNewPlayer(p);
    players[socket.id] = p;
    socket.emit('welcome', { id: socket.id, team });
    io.emit('feed', `${name} entró al equipo ${teamName(team)}`);
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
    p.input.shoot = !!inp.shoot;
    if (Number.isFinite(inp.q)) p.input.q = inp.q;
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (!p) return;
    delete players[socket.id];
    io.emit('feed', `${p.name} se fue`);
    if (humanCount() === 0) removeBots(); // sin humanos, no quedan bots jugando solos
    checkElimination(Date.now());
  });
});

function kill(victim, shooter, now) {
  setDead(victim, match.mode === 'elim' ? Infinity : now + RESPAWN_MS);
  victim.deaths++;
  if (shooter) {
    shooter.kills++;
    shooter.coins += MAP.KILL_COINS;
  }
  score[victim.team === 'red' ? 'blue' : 'red']++;
  io.emit('feed', `${shooter ? shooter.name : '???'} ✖ ${victim.name}`);
  checkElimination(now);
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
      if (!lineOfSight(p.x, p.y, q.x, q.y)) continue;
      best = q;
      bestD = d;
    }
    if (best) a = Math.atan2(best.y - p.y, best.x - p.x);
  }
  p.a = a;

  const bx = p.x + Math.cos(a) * (P_R + 8);
  const by = p.y + Math.sin(a) * (P_R + 8);
  if (pointInWall(bx, by)) return;
  for (let i = 0; i < wp.pellets; i++) {
    // la escopeta abre sus perdigones en abanico; las demas tienen un leve desvio
    const off = wp.pellets > 1
      ? (i / (wp.pellets - 1) - 0.5) * wp.spread + (Math.random() - 0.5) * 0.05
      : (Math.random() - 0.5) * wp.spread;
    const ba = a + off;
    bullets.push({
      id: ++bulletId, x: bx, y: by,
      vx: Math.cos(ba) * wp.speed, vy: Math.sin(ba) * wp.speed,
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
      if (b.x < 0 || b.y < 0 || b.x > MAP.W || b.y > MAP.H || pointInWall(b.x, b.y)) {
        dead = true;
        break;
      }
      for (const id in players) {
        const q = players[id];
        if (!q.alive || q.team === b.team) continue;
        if ((q.x - b.x) ** 2 + (q.y - b.y) ** 2 > (P_R + 4) ** 2) continue;
        dead = true;
        if (now < q.protectUntil) break;
        q.hp -= b.dmg;
        if (q.hp <= 0) kill(q, players[b.owner], now);
        break;
      }
    }
    b.life -= DT;
    if (!dead && b.life > 0 && match.phase === 'playing') alive.push(b);
  }
  bullets = alive;

  const list = [];
  for (const id in players) {
    const p = players[id];
    list.push({
      id: p.id, n: p.name, t: p.team,
      x: Math.round(p.x), y: Math.round(p.y), a: +p.a.toFixed(3),
      hp: Math.max(0, p.hp), al: p.alive, k: p.kills, d: p.deaths,
      rs: p.alive ? 0 : (p.respawnAt === Infinity ? -1 : Math.max(0, p.respawnAt - now)),
      sp: now < p.protectUntil,
      sf: now - p.lastShot < 70,
      q: p.input.q || 0,
      bt: !!p.isBot,
      w: p.weapon, c: p.coins, o: p.owned,
    });
  }
  io.volatile.emit('state', {
    p: list,
    b: bullets.map((b) => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.team === 'red' ? 0 : 1]),
    s: score,
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
    },
  });
}

startMatch('tdm', 5);
setInterval(tick, 1000 / TICK);

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
