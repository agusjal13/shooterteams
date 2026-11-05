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
  // Altura de cada pared (z): las cajas chicas son bajas y se puede disparar por encima.
  for (const w of walls) w.z = w.w <= 100 && w.h <= 100 ? 70 : 130;

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
      desc: 'La de siempre, equilibrada.' },
    { id: 1, name: 'Pistola', price: 50, dmg: 28, rate: 200, pellets: 1, spread: 0.02, life: 0.9, speed: 1000,
      desc: 'Más daño por tiro.' },
    { id: 2, name: 'Escopeta', price: 70, dmg: 15, rate: 750, pellets: 6, spread: 0.32, life: 0.42, speed: 900,
      desc: 'Mucho daño de cerca, lenta.' },
    { id: 3, name: 'Metralleta', price: 90, dmg: 12, rate: 75, pellets: 1, spread: 0.09, life: 0.8, speed: 1000,
      desc: 'Muy rápida, menos daño.' },
  ];

  // Personajes: 2 estilos por equipo (solo cambia el aspecto; el cuerpo y la cabeza miden lo mismo).
  // body = color del cuerpo, accent = color del equipamiento, hat = que lleva en la cabeza, gear = accesorio.
  const STYLES = {
    red: [
      { name: 'Brasa', desc: 'Casco y chaleco táctico', body: 0xe23b4c, accent: 0x6e1420, skin: 0xf0c9a0, legs: 0x2a1d1f, hat: 'helmet', gear: 'vest' },
      { name: 'Fénix', desc: 'Bandana, cresta y mochila', body: 0xc92a3c, accent: 0xff9a2e, skin: 0xb07850, legs: 0x1d2128, hat: 'bandana', gear: 'backpack' },
    ],
    blue: [
      { name: 'Glaciar', desc: 'Casco blanco con antiparras', body: 0x2f7fe6, accent: 0xe8f2ff, skin: 0xf0c9a0, legs: 0x1d2534, hat: 'goggles', gear: 'pads' },
      { name: 'Tormenta', desc: 'Gorra, bufanda y mochila', body: 0x2259b8, accent: 0xf2c94c, skin: 0x8d5a3b, legs: 0x1d2128, hat: 'cap', gear: 'scarf' },
    ],
  };

  const spawns = {
    red: { x: 60, y: 450, w: 200, h: 500 },
    blue: { x: W - 260, y: 450, w: 200, h: 500 },
  };
  const BASE_PAD = 40; // la base pintada en el piso es la zona de aparicion + 40 de margen
  function inBase(team, x, y) {
    const s = spawns[team];
    return !!s && x >= s.x - BASE_PAD && x <= s.x + s.w + BASE_PAD && y >= s.y - BASE_PAD && y <= s.y + s.h + BASE_PAD;
  }

  const MAP = {
    W,
    H,
    walls,
    resolve,
    inBase,
    BASE_PAD,
    STYLES,
    WEAPONS,
    START_COINS: 100,
    KILL_COINS: 5,
    MAX_MINUTES: 15,
    P_R: 22,
    SPEED: 286, // 10% mas rapido que antes (260)
    // Alturas del cuerpo (para las zonas de impacto): piernas 0-22, torso/brazos 22-67, cabeza 67-94
    EYE_H: 62, // altura de los ojos: de aca salen las balas
    HEAD_Z: 66, // la zona de cabeza es un 5% mas grande que antes (67 / 15)
    TOP_Z: 94,
    HEAD_R: 15.75, // radio de la cabeza
    MAX_PITCH: 0.7, // cuanto se puede mirar arriba/abajo (radianes, ~40 grados)
    HEADSHOT_COINS: 10,
    // Granada: el daño baja con la distancia al centro de la explosion
    GRENADE: {
      price: 30,
      max: 2, // cuantas podes llevar
      fuse: 2300, // ms hasta explotar
      radius: 230, // alcance de la explosion
      maxDmg: 110, // daño en el centro (mata)
      minDmg: 10, // daño en el borde
      throwSpeed: 860, // mas fuerza: apuntando alto llega a ~900 de distancia
      gravity: 800,
      cooldown: 700, // ms entre tiros
    },
    spawns,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MAP;
  else root.MAP = MAP;
})(this);
