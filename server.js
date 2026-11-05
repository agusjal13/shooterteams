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
// piezas extra de three.js (ej. cajas con bordes redondeados)
app.use('/vendor/three-addons', express.static(path.join(__dirname, 'node_modules', 'three', 'examples', 'jsm'), noCache));

// ---- Reglas del juego ----
const TICK = 30;
const DT = 1 / TICK;
const P_R = MAP.P_R; // radio del jugador
const SPEED = MAP.SPEED; // px por segundo
const WEAPONS = MAP.WEAPONS;
const RESPAWN_MS = 3000;
const PROTECT_MS = 1500;
const ROUND_END_MS = 3500; // cartel de "gano la ronda" (modo Guerra)
const MATCH_END_MS = 9000; // cartel de fin de partida antes de arrancar otra
const ASSIST_ANGLE = 0.3; // radianes (~17 grados) de ayuda de apuntado
const ASSIST_RANGE = 750;
const GR = MAP.GRENADE;
const CHEST = 48; // altura del pecho (para ver/apuntar a alguien)

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
    grenades: 0, lastThrow: 0,
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

// Un jugador que entra en medio de una ronda de Guerra espera a la proxima.
function placeNewPlayer(R, p) {
  spawn(R, p);
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
  m.phase = 'playing';
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

function startRound(R) {
  const m = R.match;
  m.round++;
  m.phase = 'playing';
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

function buyGrenade(R, p) {
  if (!canShop(R, p)) return 'Solo podés comprar en tu base';
  if (p.grenades >= GR.max) return `Máximo ${GR.max} granadas`;
  if (p.coins < GR.price) return `Te faltan $${GR.price - p.coins}`;
  p.coins -= GR.price;
  p.grenades++;
  return null;
}

function throwGrenade(R, p, now) {
  if (!p.alive || p.grenades <= 0 || R.match.phase !== 'playing' || now - p.lastThrow < GR.cooldown) return;
  useMap(R);
  p.lastThrow = now;
  p.grenades--;
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
    owner: p.id, team: p.team, explodeAt: now + GR.fuse,
  });
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

function explode(R, g, now) {
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
    const visible = td < BOT.sight && canSee(p, target);
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
  let a = p.a;

  // Ayuda de apuntado: si hay un enemigo visible cerca de la mira, apunta a el.
  if (!p.isBot) {
    let best = null;
    let bestD = Infinity;
    for (const id in R.players) {
      const q = R.players[id];
      if (!q.alive || q.team === p.team) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d > ASSIST_RANGE || d >= bestD) continue;
      if (Math.abs(angleDiff(Math.atan2(q.y - p.y, q.x - p.x), a)) > ASSIST_ANGLE) continue;
      if (!canSee(p, q)) continue;
      best = q;
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
    });
  }
}

function updatePhase(R, now) {
  const m = R.match;
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

  // Disparos (en sub-pasos para no atravesar nada).
  const STEPS = 3;
  const keep = [];
  for (const b of R.bullets) {
    let dead = false;
    for (let s = 0; s < STEPS && !dead; s++) {
      b.x += (b.vx * DT) / STEPS;
      b.y += (b.vy * DT) / STEPS;
      b.z += (b.vz * DT) / STEPS;
      if (b.x < 0 || b.y < 0 || b.x > MAP.W || b.y > MAP.H || b.z < 0 || b.z > 330 || solidAt(b.x, b.y, b.z)) {
        dead = true;
        break;
      }
      for (const id in P) {
        const q = P[id];
        if (!q.alive || q.team === b.team) continue;
        const rz = b.z - (q.z || 0); // altura del disparo respecto a los pies de q
        if (rz < 0 || rz > MAP.TOP_Z) continue;
        const d2 = (q.x - b.x) ** 2 + (q.y - b.y) ** 2;
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
      w: p.weapon, c: p.coins, o: p.owned, gr: p.grenades, sy: p.style,
    });
  }
  io.to(R.id).volatile.emit('state', {
    p: list,
    b: R.bullets.map((b) => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.team === 'red' ? 0 : 1, Math.round(b.z), Math.round(b.vz)]),
    s: R.score,
    g: R.grenades.map((g) => [g.id, Math.round(g.x), Math.round(g.y), Math.round(g.z), Math.max(0, g.explodeAt - now), g.team === 'red' ? 0 : 1]),
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

  socket.emit('rooms', publicRooms());
  socket.on('listRooms', () => socket.emit('rooms', publicRooms()));

  function enterRoom(R, data, creating) {
    data = data || {};
    const name = String(data.name || '').trim().slice(0, 14) || 'Jugador';
    let team = data.team;
    if (team !== 'red' && team !== 'blue') {
      const c = teamCounts(R);
      team = c.red <= c.blue ? 'red' : 'blue';
    }
    socket.data.room = R.id;
    socket.join(R.id);
    const p = newPlayer(socket.id, name, team, false, Number(data.style));
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
    const name = String(data.name || '').trim().slice(0, 14) || 'Jugador';
    const R = createRoom({ name: `Sala de ${name}`, isPublic: data.public !== false, map: data.map });
    startMatch(R, data.mode, data.minutes, data.map);
    enterRoom(R, data, true);
    emit(R, 'feed', `${name} creó la sala: ${modeName(R.match.mode)} en ${MAP.MAPS[R.map].name}, ${R.match.minutes} min`);
  });

  // Entrar a una sala existente (de la lista o con el codigo)
  socket.on('joinRoom', (data) => {
    if (here().R) return;
    data = data || {};
    const code = String(data.code || '').trim().toUpperCase();
    const R = rooms[code];
    if (!R) { socket.emit('joinError', `No existe ninguna sala con el código ${code || '(vacío)'}`); return; }
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

  socket.on('buyGrenade', () => {
    const { R, p } = here();
    if (!p) return;
    const err = buyGrenade(R, p);
    if (err) socket.emit('feed', err);
  });

  socket.on('throw', () => {
    const { R, p } = here();
    if (p) throwGrenade(R, p, Date.now());
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
  for (const id in rooms) { useMap(rooms[id]); balanceTeams(rooms[id]); } // control extra por si algo quedo desparejo
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
