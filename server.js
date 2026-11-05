const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const MAP = require('./public/map.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ---- Reglas del juego ----
const TICK = 30;
const DT = 1 / TICK;
const P_R = MAP.P_R; // radio del jugador
const SPEED = MAP.SPEED; // px por segundo
const B_SPEED = 950;
const B_LIFE = 0.9; // segundos
const FIRE_MS = 170;
const DMG = 20;
const RESPAWN_MS = 3000;
const PROTECT_MS = 1500;
const WIN_KILLS = 25;
const ASSIST_ANGLE = 0.3; // radianes (~17 grados) de ayuda de apuntado
const ASSIST_RANGE = 750;

const players = {};
let bullets = [];
let score = { red: 0, blue: 0 };
let bulletId = 0;
let roundOverUntil = 0;
let winner = null;

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
}

function teamCounts() {
  const c = { red: 0, blue: 0 };
  for (const id in players) c[players[id].team]++;
  return c;
}

function teamName(t) {
  return t === 'red' ? 'ROJO' : 'AZUL';
}

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    if (players[socket.id]) return;
    data = data || {};
    const name = String(data.name || '').trim().slice(0, 14) || 'Jugador';
    let team = data.team;
    if (team !== 'red' && team !== 'blue') {
      const c = teamCounts();
      team = c.red <= c.blue ? 'red' : 'blue';
    }
    const p = {
      id: socket.id, name, team,
      x: 0, y: 0, a: 0, hp: 100, alive: true,
      kills: 0, deaths: 0, lastShot: 0, respawnAt: 0, protectUntil: 0,
      input: { mx: 0, my: 0, a: 0, shoot: false },
    };
    spawn(p);
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
  });
});

function kill(victim, shooter, now) {
  victim.alive = false;
  victim.deaths++;
  victim.respawnAt = now + RESPAWN_MS;
  if (shooter) shooter.kills++;
  score[victim.team === 'red' ? 'blue' : 'red']++;
  io.emit('feed', `${shooter ? shooter.name : '???'} ✖ ${victim.name}`);

  for (const t of ['red', 'blue']) {
    if (score[t] >= WIN_KILLS && !winner) {
      winner = t;
      roundOverUntil = now + 6000;
      bullets = [];
    }
  }
}

function tryShoot(p, now) {
  if (!p.input.shoot || now - p.lastShot < FIRE_MS) return;
  p.lastShot = now;
  let a = p.a;

  // Ayuda de apuntado: si hay un enemigo visible cerca de la mira, apunta a el.
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
  p.a = a;

  const bx = p.x + Math.cos(a) * (P_R + 8);
  const by = p.y + Math.sin(a) * (P_R + 8);
  if (pointInWall(bx, by)) return;
  bullets.push({
    id: ++bulletId, x: bx, y: by,
    vx: Math.cos(a) * B_SPEED, vy: Math.sin(a) * B_SPEED,
    owner: p.id, team: p.team, life: B_LIFE,
  });
}

function tick() {
  const now = Date.now();

  // Fin de ronda: reiniciar todo.
  if (winner && now >= roundOverUntil) {
    winner = null;
    score = { red: 0, blue: 0 };
    bullets = [];
    for (const id in players) {
      players[id].kills = 0;
      players[id].deaths = 0;
      spawn(players[id]);
    }
  }
  const frozen = !!winner;

  for (const id in players) {
    const p = players[id];
    if (!p.alive) {
      if (!frozen && now >= p.respawnAt) spawn(p);
      continue;
    }
    if (frozen) continue;
    p.x += p.input.mx * SPEED * DT;
    p.y += p.input.my * SPEED * DT;
    resolve(p);
    p.a = p.input.a;
    tryShoot(p, now);
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
        q.hp -= DMG;
        if (q.hp <= 0) kill(q, players[b.owner], now);
        break;
      }
    }
    b.life -= DT;
    if (!dead && b.life > 0) alive.push(b);
  }
  bullets = alive;

  const list = [];
  for (const id in players) {
    const p = players[id];
    list.push({
      id: p.id, n: p.name, t: p.team,
      x: Math.round(p.x), y: Math.round(p.y), a: +p.a.toFixed(3),
      hp: p.hp, al: p.alive, k: p.kills, d: p.deaths,
      rs: p.alive ? 0 : Math.max(0, p.respawnAt - now),
      sp: now < p.protectUntil,
      sf: now - p.lastShot < 70,
      q: p.input.q || 0,
    });
  }
  io.volatile.emit('state', {
    p: list,
    b: bullets.map((b) => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.team === 'red' ? 0 : 1]),
    s: score,
    w: winner,
    win: WIN_KILLS,
  });
}

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
