// Sonidos del juego generados por codigo (Web Audio): no usa archivos de audio.
// - Efectos: chorros de las pistolas de agua, tirar granada, bombucha y bomba de fuego.
// - Musica de lobby: bossa tranquila tipo "musica de ascensor" mientras se espera en el menu.

let ctx = null, master = null, sfxBus = null, musicBus = null, reverbIn = null;
let muted = false;
try { muted = localStorage.getItem('rva_mute') === '1'; } catch (e) {}

let visHooked = false;
function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    noiseBuf = null;
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
    // reverberacion (eco de ambiente) para que los disparos no suenen secos
    const verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    verb.buffer = ir;
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.6;
    reverbIn.connect(verb);
    verb.connect(sfxBus);
    // la musica pasa por un filtro que le saca brillo (suena mas calida y de fondo)
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 2800;
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.5;
    musicBus.connect(warm);
    warm.connect(master);
    // con la app en segundo plano no suena nada
    if (!visHooked) {
      visHooked = true;
      document.addEventListener('visibilitychange', () => {
        if (!ctx) return;
        if (document.hidden) ctx.suspend().catch(() => {});
        else ctx.resume().catch(() => {});
      });
    }
  }
  if (ctx.state !== 'running' && ctx.state !== 'closed' && !document.hidden) ctx.resume().catch(() => {});
  return ctx;
}

// Rearma todo el audio desde cero (el iPhone a veces deja el audio "colgado" despues de
// bloquear la pantalla, una llamada o cambiar de app: dice que anda pero no suena)
function rebuild() {
  const wasPlaying = playing;
  if (wasPlaying) { playing = false; clearInterval(timer); session = null; }
  const old = ctx;
  ctx = null;
  try { old && old.close().catch(() => {}); } catch (e) {}
  ensure();
  if (wasPlaying) musicStart();
}

// Los navegadores solo dejan sonar despues de que la persona toca la pantalla o una tecla.
// Se llama en cada toque: si el audio quedo pausado lo reanuda, y si quedo trabado lo rearma.
let checking = false, failed = 0;
export function unlock() {
  if (!ensure() || document.hidden) return;
  // un sonido mudo de 1 muestra "despierta" el audio en el iPhone
  try {
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
  } catch (e) {}
  if (ctx.state === 'interrupted') { rebuild(); return; }
  if (checking) return;
  checking = true;
  const t0 = ctx.currentTime;
  setTimeout(() => {
    checking = false;
    if (!ctx || document.hidden) return;
    // si el reloj del audio no avanzo, esta trabado: a la segunda vez seguida se rearma
    if (ctx.state !== 'running' || ctx.currentTime <= t0) {
      if (++failed >= 2) { failed = 0; rebuild(); }
    } else failed = 0;
  }, 350);
}

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
function out(vol, pan, rev = 0, bus = sfxBus) {
  const g = ctx.createGain();
  g.gain.value = vol;
  if (rev > 0 && reverbIn) {
    const s = ctx.createGain();
    s.gain.value = rev;
    g.connect(s);
    s.connect(reverbIn);
  }
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

// Caño: el sonido entra y rebota adentro de un tubo hueco (eco muy corto que se repite),
// eso le da el timbre metalico/hueco de cañeria. f = nota del caño (mas grave = caño mas largo).
// (en un circuito con rebote el navegador no deja ecos mas cortos que ~2.7 ms, por eso f <= 370)
function pipe(dest, f, fb, life) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = 1 / Math.min(370, f);
  const loop = ctx.createGain();
  // el rebote se va apagando si o si (asi nunca se "acopla" y queda sonando)
  const t = ctx.currentTime;
  loop.gain.setValueAtTime(fb, t);
  loop.gain.setTargetAtTime(0, t + life * 0.5, life * 0.15);
  const damp = ctx.createBiquadFilter(); // cada rebote pierde un poco de agudos (suena a agua adentro)
  damp.type = 'lowpass';
  damp.frequency.value = 2600;
  damp.Q.value = 0.5; // sin pico de resonancia
  input.connect(dest);
  input.connect(delay);
  delay.connect(damp);
  damp.connect(loop);
  loop.connect(delay);
  damp.connect(dest);
  setTimeout(() => { input.disconnect(); loop.disconnect(); }, (life + 1) * 1000);
  return input;
}

// Una forma de sonar por arma (mismo orden que MAP.WEAPONS)
// dur: largo del chorro, f0/f1: tono del chorro, caño: nota del tubo y cuanto resuena,
// thump: golpe de presion al salir, rev: cuanto eco de ambiente
const GUNS = [
  { dur: 0.13, f0: 1500, f1: 800, cano: 360, fb: 0.72, vol: 0.5, thump: 160, rev: 0.12 }, // Chorrito
  { dur: 0.18, f0: 1300, f1: 600, cano: 290, fb: 0.78, vol: 0.6, thump: 125, rev: 0.16 }, // Pistola de agua
  null, // Regadera: tiene su propio sonido de escopeta (shotgun)
  { dur: 0.09, f0: 1400, f1: 800, cano: 330, fb: 0.7, vol: 0.42, thump: 145, rev: 0.1 }, // Hidrometralleta
];

// ---------- Estilos de sonido de las armas (se elige uno en Partida → Sonido de armas) ----------
export const GUN_STYLES = ['Cañería', 'Chorro a presión', 'Juguete', 'Arcade', 'Potente'];
let gunStyle = 0;
try { gunStyle = Math.max(0, Math.min(GUN_STYLES.length - 1, Number(localStorage.getItem('rva_gun')) || 0)); } catch (e) {}
export function getGunStyle() { return gunStyle; }
export function setGunStyle(i) {
  gunStyle = Math.max(0, Math.min(GUN_STYLES.length - 1, i | 0));
  try { localStorage.setItem('rva_gun', String(gunStyle)); } catch (e) {}
}
// tamaño de cada arma (mismo orden que MAP.WEAPONS): largo del sonido, tono y volumen
const SIZE = [
  { len: 1, pitch: 1.1, vol: 0.5 }, // Chorrito
  { len: 1.3, pitch: 0.9, vol: 0.6 }, // Pistola de agua
  { len: 2.4, pitch: 0.62, vol: 0.8 }, // Regadera (escopeta)
  { len: 0.7, pitch: 1, vol: 0.42 }, // Hidrometralleta
];
// distorsion suave (para el estilo "Potente")
let shaper = null;
function drive(dest) {
  if (!shaper || shaper.context !== ctx) {
    shaper = ctx.createWaveShaper();
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 3.2) / Math.tanh(3.2); }
    shaper.curve = c;
  }
  const g = ctx.createGain();
  g.gain.value = 1;
  const s = ctx.createWaveShaper();
  s.curve = shaper.curve;
  g.connect(s);
  s.connect(dest);
  return g;
}
// Capa de explosion: golpe sub-grave, estallido saturado y retumbe que se va apagando.
// size 1 = escopeta, ~2 = granada
function blastLayer(v, pan, t, size = 1, rev = 0.45) {
  const dest = out(0.9 * v, pan, rev);
  const dd = drive(dest);
  tone(dest, t, 0.45 * size, 'sine', 75, 28, 1, 0.002); // golpe que se siente en el pecho
  tone(dest, t, 0.08, 'triangle', 180, 70, 0.5, 0.001);
  noiseBurst(dd, t, 0.12 + 0.05 * size, 'highpass', 900, 400, 0.6, 0.9, 0.001); // estallido seco
  noiseBurst(dd, t + 0.01, 0.7 * size, 'lowpass', 1800, 70, 0.7, 0.85, 0.004); // retumbe
}
// "chk-chk" de recargar la escopeta (solo la mia)
function pump(t) {
  const p = out(0.32, 0, 0.08);
  for (const [dt, f] of [[0.42, 1700], [0.56, 1300]]) {
    noiseBurst(p, t + dt, 0.05, 'bandpass', f, f * 0.8, 3, 1, 0.002);
    tone(p, t + dt, 0.03, 'square', f / 4, f / 5, 0.12, 0.001);
  }
}
const STYLE_FN = [
  null, // 0 Cañería: el sonido original (abajo)
  // 1 Chorro a presión: siseo fuerte del chorro + salpicón donde pega + gotitas
  (S, big, v, pan, t, r) => {
    const dest = out(S.vol * v * 1.1, pan, (big ? 0.3 : 0.12) + (1 - v) * 0.25);
    const d = 0.12 * S.len;
    noiseBurst(dest, t, d, 'bandpass', 3200 * S.pitch * r, 1400 * S.pitch, 1.3, 0.9, 0.003);
    noiseBurst(dest, t, d * 0.7, 'highpass', 5000, 3000, 0.7, 0.25, 0.002);
    noiseBurst(dest, t + d * 0.6, d * 1.4, 'lowpass', 1400 * S.pitch, 300, 0.8, big ? 0.9 : 0.5, 0.01);
    if (big) tone(dest, t, 0.25, 'sine', 95 * r, 40, 0.8, 0.002);
    const n = big ? 8 : 2;
    for (let i = 0; i < n; i++) bubble(dest, t + d * (0.8 + Math.random() * (big ? 3 : 1)), 600 + Math.random() * 700, 0.1, 0.045);
  },
  // 2 Juguete: clic de gatillo de plastico + soplido de aire + "plip"
  (S, big, v, pan, t, r) => {
    const dest = out(S.vol * v, pan, 0.08 + (1 - v) * 0.2);
    tone(dest, t, 0.012, 'square', 2600 * r, 2200, 0.25, 0.001);
    if (big) tone(dest, t + 0.03, 0.012, 'square', 2100 * r, 1800, 0.2, 0.001);
    noiseBurst(dest, t + 0.008, 0.07 * S.len, 'bandpass', 900 * S.pitch * r, 500 * S.pitch, 0.9, big ? 1 : 0.75, 0.004);
    noiseBurst(dest, t + 0.05 * S.len, 0.06 * S.len, 'lowpass', 1800, 500, 0.7, 0.35, 0.004);
    bubble(dest, t + 0.07 * S.len, (big ? 520 : 880) * r, 0.22, big ? 0.09 : 0.06);
    if (big) for (let i = 0; i < 4; i++) bubble(dest, t + 0.12 + Math.random() * 0.25, 500 + Math.random() * 600, 0.12, 0.05);
  },
  // 3 Arcade: "piu" de videojuego con burbuja de agua al final
  (S, big, v, pan, t, r) => {
    const dest = out(S.vol * v * 0.9, pan, 0.15 + (1 - v) * 0.25);
    const d = 0.13 * Math.min(S.len, 1.6);
    const hi = 1500 * S.pitch * r;
    tone(dest, t, d, 'triangle', hi, hi * 0.2, 0.6, 0.002);
    tone(dest, t, d, 'sine', hi * 0.5, hi * 0.12, 0.45, 0.002);
    if (big) {
      tone(dest, t + 0.012, d * 1.2, 'triangle', hi * 0.75, hi * 0.15, 0.5, 0.002);
      tone(dest, t, 0.3, 'sine', 110, 40, 0.8, 0.002);
      noiseBurst(dest, t, 0.25, 'lowpass', 3000, 300, 0.7, 0.45, 0.002);
    }
    bubble(dest, t + d * 0.9, 500 * r, 0.2, 0.07);
  },
  // 4 Potente: golpe grave + chorro saturado con mucho cuerpo y eco (mas parecido a un arma real)
  (S, big, v, pan, t, r) => {
    const dest = out(S.vol * v * 0.85, pan, (big ? 0.5 : 0.28) + (1 - v) * 0.3);
    const dd = drive(dest);
    tone(dest, t, big ? 0.45 : 0.16, 'sine', (big ? 85 : 120) * r, 38, 1, 0.002);
    noiseBurst(dd, t, (big ? 0.5 : 0.14) * Math.min(S.len, 1.3), 'lowpass', 4200 * S.pitch, 350, 0.8, big ? 0.9 : 0.6, 0.002);
    squirt(dest, t + 0.01, 0.1 * S.len, 1500 * S.pitch * r, 600, 0.7, 0.5);
    if (big) for (let i = 0; i < 6; i++) bubble(dest, t + 0.12 + Math.random() * 0.5, 450 + Math.random() * 800, 0.1, 0.045);
  },
];

export function shot(weapon, dist = 0, pan = 0) {
  if (!ctx || muted || ctx.state !== 'running') return;
  const v = fall(dist, 1700);
  if (v < 0.02) return;
  const fn = STYLE_FN[gunStyle];
  if (fn) {
    const t = ctx.currentTime;
    fn(SIZE[weapon] || SIZE[0], weapon === 2, v, pan, t, 0.94 + Math.random() * 0.12);
    if (weapon === 2) {
      blastLayer(v * 0.8, pan, t, 1);
      if (dist === 0) pump(t);
    }
    return;
  }
  if (weapon === 2) { shotgun(v, pan, dist === 0); return; }
  const G = GUNS[weapon] || GUNS[0];
  const t = ctx.currentTime;
  const r = 0.92 + Math.random() * 0.16; // cada tiro suena un poquito distinto
  const dest = out(G.vol * v, pan, G.rev + (1 - v) * 0.25); // de lejos, mas eco
  // golpe de presion ("thunk") + chorro que pasa por el caño + una gota al final
  tone(dest, t, 0.09, 'sine', G.thump * r, G.thump * 0.5, 0.6, 0.002);
  const cano = pipe(dest, G.cano * r, G.fb, G.dur + 0.4);
  squirt(cano, t, G.dur, G.f0 * r, G.f1 * r, 0.7, 0.8);
  bubble(dest, t + G.dur * (0.5 + Math.random() * 0.5), 700 + Math.random() * 500, 0.12);
}

// Regadera = escopeta de agua: estallido grave con cuerpo, chorro grueso por un caño ancho,
// eco de ambiente, lluvia de gotas y (si es mia) el "chk-chk" de recargar
function shotgun(v, pan, mine) {
  const t = ctx.currentTime;
  const r = 0.94 + Math.random() * 0.12;
  const dest = out(0.75 * v, pan, 0.4 + (1 - v) * 0.3);
  tone(dest, t, 0.38, 'sine', 105 * r, 38, 1, 0.002); // golpe grave
  tone(dest, t, 0.12, 'triangle', 220 * r, 90, 0.35, 0.002);
  noiseBurst(dest, t, 0.5, 'lowpass', 5200, 280, 0.7, 0.85, 0.002); // estallido
  const cano = pipe(dest, 210 * r, 0.7, 0.9);
  squirt(cano, t + 0.01, 0.42, 1100 * r, 380, 0.5, 0.9); // chorro grueso
  for (let i = 0; i < 7; i++) {
    bubble(dest, t + 0.1 + Math.random() * 0.55, 500 + Math.random() * 900, 0.1, 0.04 + Math.random() * 0.04);
  }
  blastLayer(v * 0.8, pan, t, 1);
  if (mine) pump(t);
}

// Muestra de un estilo: pistola, tres tiros de metralleta y la escopeta
export function demo(style) {
  unlock();
  if (!ctx || muted) return;
  const prev = gunStyle;
  gunStyle = style;
  const seq = [[120, 1], [500, 3], [590, 3], [680, 3], [1020, 2]];
  for (const [ms, w] of seq) setTimeout(() => { const keep = gunStyle; gunStyle = style; shot(w); gunStyle = keep; }, ms);
  gunStyle = prev;
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
  const dest = out(0.95 * v, pan, 0.25);
  // explosion de verdad debajo de todo (mas grande en la bomba de fuego)
  blastLayer(v, pan, t, water ? 1.7 : 2.3, 0.6);
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

// Flashbang: estallido seco y agudo (sin bola de fuego)
export function flash(dist = 0, pan = 0) {
  if (!ctx || muted || ctx.state !== 'running') return;
  const v = Math.max(fall(dist, 3200), dist < 4000 ? 0.05 : 0);
  if (v < 0.02) return;
  const t = ctx.currentTime;
  const dest = out(0.9 * v, pan, 0.35);
  noiseBurst(dest, t, 0.35, 'highpass', 1800, 600, 0.7, 1, 0.002);
  tone(dest, t, 0.18, 'square', 2400, 700, 0.35, 0.002);
  tone(dest, t, 0.4, 'sine', 160, 50, 0.7, 0.003);
}
// Aturdido: pitido agudo y todo lo demas se escucha bajito hasta que se pasa
export function stun(ms) {
  if (!ctx || muted || ctx.state !== 'running') return;
  const t = ctx.currentTime, dur = ms / 1000;
  const dest = out(0.22, 0);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(3600, t);
  o.frequency.linearRampToValueAtTime(3300, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(1, t + 0.05);
  g.gain.setValueAtTime(1, t + dur * 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.05);
  sfxBus.gain.cancelScheduledValues(t);
  sfxBus.gain.setValueAtTime(0.12, t + 0.02);
  sfxBus.gain.setValueAtTime(0.12, t + dur * 0.45);
  sfxBus.gain.linearRampToValueAtTime(0.8, t + dur);
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
