// Mapa compartido entre servidor (Node) y cliente (navegador).
(function (root) {
  const W = 2400;
  const H = 1400;

  // Paredes de la mitad izquierda; se espejan automaticamente para la derecha.
  const leftHalf = [
    { x: 420, y: 280, w: 60, h: 320 },
    { x: 420, y: 800, w: 60, h: 320 },
    { x: 720, y: 540, w: 200, h: 60 },
    { x: 720, y: 800, w: 200, h: 60 },
    { x: 820, y: 140, w: 90, h: 90 },
    { x: 820, y: 1170, w: 90, h: 90 },
    { x: 220, y: 80, w: 160, h: 50 },
    { x: 220, y: 1270, w: 160, h: 50 },
  ];

  // Piezas centrales (ya son simetricas).
  const center = [
    { x: 1150, y: 600, w: 100, h: 200 },
    { x: 1080, y: 220, w: 240, h: 60 },
    { x: 1080, y: 1120, w: 240, h: 60 },
  ];

  const walls = [...center];
  for (const w of leftHalf) {
    walls.push(w);
    walls.push({ x: W - w.x - w.w, y: w.y, w: w.w, h: w.h });
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Empuja un circulo (jugador) fuera de las paredes. Lo usan servidor y cliente.
  function resolve(p, R) {
    for (const w of walls) {
      const cx = clamp(p.x, w.x, w.x + w.w);
      const cy = clamp(p.y, w.y, w.y + w.h);
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) continue;
      if (d2 === 0) {
        const l = p.x - w.x, r = w.x + w.w - p.x, t = p.y - w.y, b = w.y + w.h - p.y;
        const m = Math.min(l, r, t, b);
        if (m === l) p.x = w.x - R;
        else if (m === r) p.x = w.x + w.w + R;
        else if (m === t) p.y = w.y - R;
        else p.y = w.y + w.h + R;
      } else {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * R;
        p.y = cy + (dy / d) * R;
      }
    }
    p.x = clamp(p.x, R, W - R);
    p.y = clamp(p.y, R, H - R);
  }

  // Armas de la tienda (las usan servidor y cliente).
  // dmg = daño por bala, rate = ms entre disparos, pellets = balas por disparo,
  // spread = dispersion (radianes), life = alcance en segundos de vuelo.
  const WEAPONS = [
    { id: 0, name: 'Básica', price: 0, dmg: 20, rate: 170, pellets: 1, spread: 0.02, life: 0.9, speed: 950,
      desc: 'La de siempre. Equilibrada.' },
    { id: 1, name: 'Pistola', price: 50, dmg: 28, rate: 200, pellets: 1, spread: 0.02, life: 0.9, speed: 1000,
      desc: 'Un poco más de daño por tiro.' },
    { id: 2, name: 'Escopeta', price: 70, dmg: 15, rate: 750, pellets: 6, spread: 0.32, life: 0.42, speed: 900,
      desc: 'Mucho daño de cerca, lenta y de corto alcance.' },
    { id: 3, name: 'Metralleta', price: 90, dmg: 12, rate: 75, pellets: 1, spread: 0.09, life: 0.8, speed: 1000,
      desc: 'Dispara muy rápido, menos daño por bala.' },
  ];

  const MAP = {
    W,
    H,
    walls,
    resolve,
    WEAPONS,
    START_COINS: 100,
    KILL_COINS: 5,
    MAX_MINUTES: 15,
    P_R: 22,
    SPEED: 260,
    spawns: {
      red: { x: 60, y: 450, w: 200, h: 500 },
      blue: { x: W - 260, y: 450, w: 200, h: 500 },
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MAP;
  else root.MAP = MAP;
})(this);
