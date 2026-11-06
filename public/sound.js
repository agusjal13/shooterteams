// Sonidos del juego generados por codigo (Web Audio): no usa archivos de audio.
// - Efectos: chorros de las pistolas de agua, tirar granada, bombucha y bomba de fuego.
// - Musica de lobby: bossa tranquila tipo "musica de ascensor" mientras se espera en el menu.

let ctx = null, master = null, sfxBus = null, musicBus = null;
let muted = false;
try { muted = localStorage.getItem('rva_mute') === '1'; } catch (e) {}

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    // limitador: si suenan muchas cosas juntas (o una explosion cerca) no satura el parlante
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.8;
    sfxBus.connect(master);
    // la musica pasa por un filtro que le saca brillo (suena mas calida y de fondo)
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 2800;
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.5;
    musicBus.connect(warm);
    warm.connect(master);
    // con la app en segundo plano no suena nada
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend().catch(() => {});
      else ctx.resume().catch(() => {});
    });
  }
  if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
  return ctx;
}

// Los navegadores solo dejan sonar despues de que la persona toca la pantalla o una tecla
export function unlock() { ensure(); }

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem('rva_mute', muted ? '1' : '0'); } catch (e) {}
  if (ctx) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
}

// ---------- piezas basicas ----------
let noiseBuf = null;
function noiseBuffer() {
  if (!noiseBuf) {
    const n = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// salida de un efecto con su volumen y de que lado suena (izquierda -1 ... derecha 1)
function out(vol, pan, bus = sfxBus) {
  const g = ctx.createGain();
  g.gain.value = vol;
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(bus);
  } else g.connect(bus);
  return g;
}

// soplido/chorro: ruido filtrado que se apaga
function noiseBurst(dest, t, dur, type, f0, f1, q, peak, attack = 0.006) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, Math.random() * 0.9);
  src.stop(t + dur + 0.05);
}

// nota con un tono que puede subir o bajar
function tone(dest, t, dur, type, f0, f1, peak, attack = 0.005) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// cuanto mas lejos, mas bajito (0 = no se escucha)
const fall = (d, range) => {
  const k = Math.max(0, 1 - d / range);
  return k * k;
};

// ---------- efectos ----------
// Gota/burbuja: un tono corto que SUBE rapido (asi suenan de verdad las burbujas y las gotas)
function bubble(dest, t, f, vol, dur = 0.05) {
  tone(dest, t, dur, 'sine', f, f * (1.8 + Math.random() * 0.8), vol, 0.003);
}

// Chorro de agua: "shhh" suave que chisporrotea (el volumen salta al azar, como el agua saliendo
// a borbotones) + burbujitas/gotas desparramadas
function squirt(dest, t, dur, f0, f1, q, peak) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const soft = ctx.createBiquadFilter(); // le saca el "siseo" agudo
  soft.type = 'lowpass';
  soft.frequency.value = 3200;
  const g = ctx.createGain();
  const n = 32;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const env = k < 0.08 ? k / 0.08 : Math.pow(1 - (k - 0.08) / 0.92, 1.6);
    curve[i] = peak * env * (0.45 + Math.random() * 0.55);
  }
  curve[n - 1] = 0;
  g.gain.setValueCurveAtTime(curve, t, dur);
  src.connect(f);
  f.connect(soft);
  soft.connect(g);
  g.connect(dest);
  src.start(t, Math.random() * 0.9);
  src.stop(t + dur + 0.05);
}

// Una forma de sonar por arma (mismo orden que MAP.WEAPONS)
// dur: largo del chorro, f0/f1: tono del chorro (de mas agudo a mas grave), bub: cantidad de gotas
const GUNS = [
  { dur: 0.11, f0: 1600, f1: 1000, q: 0.9, vol: 0.4, bub: 2, bf: 1100 }, // Chorrito
  { dur: 0.16, f0: 1300, f1: 750, q: 0.8, vol: 0.5, bub: 3, bf: 800 }, // Pistola de agua
  { dur: 0.28, f0: 1500, f1: 600, q: 0.5, vol: 0.55, bub: 6, bf: 700 }, // Regadera (abanico)
  { dur: 0.08, f0: 1500, f1: 1000, q: 0.9, vol: 0.34, bub: 1, bf: 950 }, // Hidrometralleta
];

export function shot(weapon, dist = 0, pan = 0) {
  if (!ctx || muted || ctx.state !== 'running') return;
  const v = fall(dist, 1700);
  if (v < 0.02) return;
  const G = GUNS[weapon] || GUNS[0];
  const t = ctx.currentTime;
  const r = 0.9 + Math.random() * 0.2; // cada tiro suena un poquito distinto
  const dest = out(G.vol * v, pan);
  squirt(dest, t, G.dur, G.f0 * r, G.f1 * r, G.q, 1);
  for (let i = 0; i < G.bub; i++) {
    bubble(dest, t + 0.01 + Math.random() * G.dur, G.bf * (0.7 + Math.random() * 0.7), 0.16, 0.035 + Math.random() * 0.03);
  }
}

// tirar una granada: un "fuuu" corto
export function toss(dist = 0, pan = 0) {
  if (!ctx || muted || ctx.state !== 'running') return;
  const v = fall(dist, 1300);
  if (v < 0.02) return;
  const t = ctx.currentTime;
  const dest = out(0.35 * v, pan);
  noiseBurst(dest, t, 0.32, 'bandpass', 450, 2300, 2.2, 0.8, 0.06);
}

// explosion: bombucha (salpicon + burbujas) o bomba de fuego (golpe grave + chisporroteo)
export function boom(water, dist = 0, pan = 0) {
  if (!ctx || muted || ctx.state !== 'running') return;
  const v = Math.max(fall(dist, 3200), dist < 4000 ? 0.04 : 0);
  if (v < 0.02) return;
  const t = ctx.currentTime;
  const dest = out(0.95 * v, pan);
  if (water) {
    noiseBurst(dest, t, 0.75, 'lowpass', 5000, 260, 0.7, 1, 0.01);
    tone(dest, t, 0.25, 'sine', 200, 70, 0.55);
    for (let i = 0; i < 8; i++) {
      const f = 380 + Math.random() * 520;
      tone(dest, t + 0.06 + Math.random() * 0.45, 0.07 + Math.random() * 0.05, 'sine', f, f * (2 + Math.random()), 0.22);
    }
  } else {
    tone(dest, t, 0.65, 'sine', 115, 36, 1, 0.004);
    noiseBurst(dest, t, 1.0, 'lowpass', 2600, 140, 0.8, 0.95, 0.004);
    for (let i = 0; i < 12; i++) {
      noiseBurst(dest, t + 0.08 + Math.random() * 0.75, 0.025 + Math.random() * 0.03, 'highpass', 2600, 2600, 0.6, 0.35, 0.002);
    }
  }
}

// ---------- musica de lobby ----------
const BPM = 92;
const BEAT = 60 / BPM;
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// 8 compases: acordes (notas MIDI), bajo (fundamental) y melodia [tiempo, nota, duracion]
const SONG = [
  { ch: [55, 59, 60, 64], b: 36, mel: [[0, 76, 1], [1, 79, 0.5], [1.5, 83, 1.5], [3, 81, 1]] }, // Cmaj7
  { ch: [55, 57, 60, 64], b: 33, mel: [[0, 79, 1.5], [1.5, 76, 0.5], [2, 72, 2]] }, // Am7
  { ch: [57, 60, 62, 65], b: 38, mel: [[0, 77, 1], [1, 81, 0.5], [1.5, 84, 1.5], [3, 83, 1]] }, // Dm7
  { ch: [55, 59, 62, 65], b: 31, mel: [[0, 81, 1.5], [1.5, 79, 0.5], [2, 77, 1], [3, 74, 1]] }, // G7
  { ch: [55, 59, 62, 64], b: 40, mel: [[0, 79, 1], [1, 83, 0.5], [1.5, 86, 1.5], [3, 83, 1]] }, // Em7
  { ch: [55, 57, 61, 64], b: 33, mel: [[0, 85, 1.5], [1.5, 81, 0.5], [2, 79, 2]] }, // A7
  { ch: [57, 60, 62, 65], b: 38, mel: [[0, 77, 1], [1, 76, 0.5], [1.5, 74, 1.5], [3, 72, 1]] }, // Dm7
  { ch: [55, 59, 62, 65], b: 31, mel: [[0, 74, 2], [2, 71, 1], [3, 67, 1]] }, // G7
];

// piano electrico suave (tipo Rhodes): fundamental + un "tintineo" agudo que se apaga rapido
function epiano(dest, t, m, dur, vol) {
  const f = hz(m);
  tone(dest, t, dur, 'sine', f, f, vol, 0.012);
  tone(dest, t, Math.min(dur, 0.35), 'sine', f * 4, f * 4, vol * 0.12, 0.004);
}
// vibrafono para la melodia: tono redondo con un leve vaiven de volumen
function vibes(dest, t, m, dur, vol) {
  const f = hz(m);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = f;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.6);
  const trem = ctx.createGain();
  trem.gain.value = 0.75;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.2;
  const depth = ctx.createGain();
  depth.gain.value = 0.25;
  lfo.connect(depth);
  depth.connect(trem.gain);
  o.connect(g);
  g.connect(trem);
  trem.connect(dest);
  o.start(t);
  lfo.start(t);
  o.stop(t + dur + 0.7);
  lfo.stop(t + dur + 0.7);
  tone(dest, t, 0.25, 'sine', f * 3, f * 3, vol * 0.08, 0.003);
}
function bass(dest, t, m, dur, vol) {
  const f = hz(m);
  tone(dest, t, dur, 'triangle', f, f, vol, 0.01);
}
function shaker(dest, t, vol) {
  noiseBurst(dest, t, 0.05, 'highpass', 7000, 7000, 0.7, vol, 0.004);
}

let playing = false, timer = null, nextBar = 0, bar = 0, session = null;

function playBar(B, t0, loop) {
  const dest = session;
  // acompañamiento de bossa: golpes de acorde en 1, 2½ y 4
  for (const [beat, len] of [[0, 1.3], [1.5, 1.2], [3, 0.9]]) {
    for (const m of B.ch) epiano(dest, t0 + beat * BEAT, m, len * BEAT, 0.045);
  }
  // bajo: fundamental y quinta
  for (const [beat, iv, len] of [[0, 0, 1.4], [1.5, 7, 0.45], [2, 0, 1.4], [3.5, 7, 0.45]]) {
    bass(dest, t0 + beat * BEAT, B.b + iv, len * BEAT, 0.16);
  }
  // melodia: una vuelta en vibrafono, la otra una octava mas grave y mas suave
  const low = loop % 2 === 1;
  for (const [beat, m, len] of B.mel) {
    vibes(dest, t0 + beat * BEAT, low ? m - 12 : m, len * BEAT, low ? 0.07 : 0.085);
  }
  // shaker en corcheas, acentuado a contratiempo
  for (let i = 0; i < 8; i++) shaker(dest, t0 + i * 0.5 * BEAT, i % 2 ? 0.05 : 0.025);
}

function schedule() {
  if (!playing || !ctx) return;
  while (nextBar < ctx.currentTime + 0.6) {
    if (nextBar < ctx.currentTime) nextBar = ctx.currentTime + 0.05; // si se atraso (app en pausa), retoma sin amontonar
    playBar(SONG[bar % SONG.length], nextBar, Math.floor(bar / SONG.length));
    nextBar += 4 * BEAT;
    bar++;
  }
}

export function musicStart() {
  if (playing || !ensure()) return;
  playing = true;
  // cada vez que arranca usa su propio volumen, asi al cortarla se apaga todo lo que ya estaba programado
  session = ctx.createGain();
  session.gain.setValueAtTime(0.0001, ctx.currentTime);
  session.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.5);
  session.connect(musicBus);
  nextBar = ctx.currentTime + 0.15;
  bar = 0;
  schedule();
  timer = setInterval(schedule, 150);
}

export function musicStop() {
  if (!playing) return;
  playing = false;
  clearInterval(timer);
  const s = session;
  session = null;
  s.gain.cancelScheduledValues(ctx.currentTime);
  s.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.3);
  setTimeout(() => s.disconnect(), 3500);
}
