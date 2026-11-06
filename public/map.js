// Mapas y fisica compartidos entre servidor (Node) y cliente (navegador).
//
// Cada mapa tiene:
//   walls: cajas solidas {x, y, w, h, z = altura, k = tipo (para dibujarla), c = color opcional}
//   ramps: escaleras {x, y, w, h, top = altura arriba, axis 'x'|'y', dir +1|-1 (hacia donde sube)}
//   deco:  cosas que solo se dibujan (ruedas, toldos, lineas pintadas, luces...)
//   spawns: zonas de aparicion de cada equipo
// Los jugadores tienen altura (z): pueden subir escaleras, caminar sobre techos y caer.
(function (root) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- Ayudas para armar mapas ----------
  // Espeja todo lo de la mitad izquierda hacia la derecha.
  function mirror(W, list) {
    const out = [];
    for (const o of list) {
      out.push(o);
      const m = { ...o };
      if (o.w !== undefined) m.x = W - o.x - o.w; else m.x = W - o.x;
      if (o.axis === 'x') m.dir = -o.dir;
      if (o.face !== undefined) m.face = o.face === 'e' ? 'w' : o.face === 'w' ? 'e' : o.face;
      out.push(m);
    }
    return out;
  }

  // Camion: acoplado (contenedor) + cabina, con ruedas.
  function truck(x, y, horizontal, cabAtEnd, color, cabColor) {
    // las ruedas, el chasis y los detalles los dibuja world.js (trailerModel / cabModel)
    const walls = [], deco = [];
    const face = horizontal ? (cabAtEnd ? 'e' : 'w') : (cabAtEnd ? 's' : 'n');
    if (horizontal) {
      const tx = cabAtEnd ? x : x + 80;
      walls.push({ x: tx, y, w: 320, h: 80, z: 125, k: 'container', c: color, cab: cabColor, trailer: true, face });
      const cx = cabAtEnd ? x + 324 : x;
      walls.push({ x: cx, y: y + 8, w: 76, h: 64, z: 100, k: 'cab', c: cabColor, face });
    } else {
      const ty = cabAtEnd ? y : y + 80;
      walls.push({ x, y: ty, w: 80, h: 320, z: 125, k: 'container', c: color, cab: cabColor, trailer: true, face });
      const cy = cabAtEnd ? y + 324 : y;
      walls.push({ x: x + 8, y: cy, w: 64, h: 76, z: 100, k: 'cab', c: cabColor, face });
    }
    return { walls, deco };
  }

  // Auto: carroceria baja + techo con vidrios.
  function car(x, y, horizontal, color) {
    const L = 150, Wd = 68;
    const w = horizontal ? L : Wd, h = horizontal ? Wd : L;
    const walls = [
      { x, y, w, h, z: 40, k: 'car', c: color },
      horizontal
        ? { x: x + 35, y: y + 6, w: 75, h: h - 12, z: 66, k: 'carTop', c: color }
        : { x: x + 6, y: y + 35, w: w - 12, h: 75, z: 66, k: 'carTop', c: color },
    ];
    const deco = [];
    const pts = horizontal
      ? [[x + 30, y - 1, 'y'], [x + 120, y - 1, 'y'], [x + 30, y + h + 1, 'y'], [x + 120, y + h + 1, 'y']]
      : [[x - 1, y + 30, 'x'], [x - 1, y + 120, 'x'], [x + w + 1, y + 30, 'x'], [x + w + 1, y + 120, 'x']];
    for (const [px, py, axis] of pts) deco.push({ t: 'wheel', x: px, y: py, r: 12, axis, car: true });
    return { walls, deco };
  }

  // Autoelevador ("mula"): cuerpo amarillo + mastil con horquillas.
  function forklift(x, y, face) {
    const walls = [{ x, y, w: 50, h: 70, z: 62, k: 'forklift' }];
    const deco = [{ t: 'mast', x, y, w: 50, h: 70, face }];
    return { walls, deco };
  }

  // Edificio con terraza: escalera por afuera y baranda (parapeto) con hueco donde llega la escalera.
  function building(x, y, w, h, z, color, stairs) {
    const P = 6, PZ = z + 28; // baranda: alcanza para cubrirse pero se puede disparar por encima
    const walls = [{ x, y, w, h, z, k: 'building', c: color }];
    const ramps = [];
    const gap = stairs ? stairs.gap : null; // {side, from, to}
    // La baranda arranca en el techo (zb = z): asi no se superpone con la fachada
    // (si se superponen, las ventanas "parpadean" al moverse).
    const add = (x0, y0, ww, hh) => walls.push({ x: x0, y: y0, w: ww, h: hh, z: PZ, zb: z, k: 'parapet', c: color });
    const edge = (side, x0, y0, ww, hh) => {
      if (gap && gap.side === side) {
        // baranda partida en dos, dejando el hueco
        if (side === 'n' || side === 's') {
          if (gap.from > x0) add(x0, y0, gap.from - x0, hh);
          if (gap.to < x0 + ww) add(gap.to, y0, x0 + ww - gap.to, hh);
        } else {
          if (gap.from > y0) add(x0, y0, ww, gap.from - y0);
          if (gap.to < y0 + hh) add(x0, gap.to, ww, y0 + hh - gap.to);
        }
      } else add(x0, y0, ww, hh);
    };
    edge('n', x, y, w, P);
    edge('s', x, y + h - P, w, P);
    // los costados van entre la baranda de adelante y la de atras (sin pisarse en las esquinas)
    edge('w', x, y + P, P, h - 2 * P);
    edge('e', x + w - P, y + P, P, h - 2 * P);
    if (stairs) ramps.push({ ...stairs.ramp, top: z });
    return { walls, ramps };
  }

  // Almacen / tienda abierta: paredes en U, mostrador y toldo.
  function shop(x, y, w, h, open, color, awning) {
    const T = 12, Z = 114;
    const walls = [];
    // techo (se puede caminar por debajo y subirse arriba saltando desde el cajon de frutas)
    walls.push({ x: x - 6, y: y - 6, w: w + 12, h: h + 12, zb: Z, z: Z + 8, k: 'shopRoof', c: color });
    if (open !== 'n') walls.push({ x, y, w, h: T, z: Z, k: 'shopWall', c: color });
    if (open !== 's') walls.push({ x, y: y + h - T, w, h: T, z: Z, k: 'shopWall', c: color });
    // paredes de los costados entre la de adelante y la de atras (sin pisarse en las esquinas)
    const sy0 = open !== 'n' ? y + T : y, sy1 = open !== 's' ? y + h - T : y + h;
    if (open !== 'w') walls.push({ x, y: sy0, w: T, h: sy1 - sy0, z: Z, k: 'shopWall', c: color });
    if (open !== 'e') walls.push({ x: x + w - T, y: sy0, w: T, h: sy1 - sy0, z: Z, k: 'shopWall', c: color });
    // mostrador (puesto de frutas) cerca de la entrada
    const cy = open === 's' ? y + h - 56 : y + 32;
    if (open === 's' || open === 'n') walls.push({ x: x + 40, y: cy, w: w - 80, h: 24, z: 44, k: 'counter' });
    // cajon de frutas afuera, al costado: sirve de escalon para saltar al techo
    const fy = open === 's' ? y + h - 80 : y + 20;
    walls.push({ x: x + w + 4, y: fy, w: 60, h: 60, z: 62, k: 'fruitCrate' });
    const deco = [];
    deco.push({ t: 'fruits', x: x + 42, y: cy + 2, w: w - 84, h: 20, z: 44 });
    deco.push({ t: 'fruits', x: x + w + 8, y: fy + 4, w: 52, h: 52, z: 62 });
    if (open === 's') deco.push({ t: 'awning', x, y: y + h, w, h: 50, z: 100, c: awning });
    if (open === 'n') deco.push({ t: 'awning', x, y: y - 50, w, h: 50, z: 100, c: awning });
    deco.push({ t: 'floor', x, y, w, h, tex: 'tiles' });
    return { walls, deco };
  }

  function merge(target, part) {
    if (part.walls) target.walls.push(...part.walls);
    if (part.ramps) target.ramps.push(...part.ramps);
    if (part.deco) target.deco.push(...part.deco);
    return target;
  }

  // ---------- Mapa 1: Desierto ----------
  function makeDesert() {
    const W = 2400, H = 1400;
    const left = [
      { x: 420, y: 280, w: 60, h: 320 },
      { x: 420, y: 800, w: 60, h: 320 },
      { x: 720, y: 540, w: 200, h: 60 },
      { x: 720, y: 800, w: 200, h: 60 },
      { x: 820, y: 140, w: 90, h: 90 },
      { x: 820, y: 1170, w: 90, h: 90 },
      { x: 220, y: 80, w: 160, h: 50 },
      { x: 220, y: 1270, w: 160, h: 50 },
    ];
    const center = [
      { x: 1150, y: 600, w: 100, h: 200 },
      { x: 1080, y: 220, w: 240, h: 60 },
      { x: 1080, y: 1120, w: 240, h: 60 },
    ];
    const walls = [...center, ...mirror(W, left)];
    for (const w of walls) {
      const small = w.w <= 100 && w.h <= 100;
      w.z = small ? 70 : 130;
      w.k = small ? 'crate' : 'rock';
    }
    const deco = mirror(W, [
      { t: 'cactus', x: 300, y: 330 }, { t: 'cactus', x: 600, y: 1240 }, { t: 'cactus', x: 980, y: 420 },
      { t: 'cactus', x: 560, y: 120 }, { t: 'cactus', x: 1000, y: 1000 },
      { t: 'rock', x: 640, y: 380, r: 16 }, { t: 'rock', x: 330, y: 1080, r: 22 }, { t: 'rock', x: 1020, y: 160, r: 14 },
      { t: 'rock', x: 700, y: 1000, r: 12 }, { t: 'rock', x: 150, y: 300, r: 20 },
    ]);
    return {
      id: 'desert', name: 'Desierto', desc: 'Arena, rocas y cajas. Abierto y directo.',
      W, H, walls, ramps: [], deco, theme: 'desert',
      spawns: { red: { x: 60, y: 450, w: 200, h: 500 }, blue: { x: W - 260, y: 450, w: 200, h: 500 } },
    };
  }

  // ---------- Mapa 2: Galpon ----------
  function makeWarehouse() {
    const W = 2600, H = 1600;
    const m = { walls: [], ramps: [], deco: [] };
    const L = { walls: [], ramps: [], deco: [] }; // mitad izquierda (se espeja)
    // estanterias altas (forman pasillos)
    L.walls.push(
      { x: 360, y: 130, w: 50, h: 340, z: 175, k: 'rack' },
      { x: 360, y: 1130, w: 50, h: 340, z: 175, k: 'rack' },
      { x: 520, y: 150, w: 330, h: 44, z: 175, k: 'rack' },
      { x: 520, y: 320, w: 330, h: 44, z: 175, k: 'rack' },
      { x: 520, y: 1236, w: 330, h: 44, z: 175, k: 'rack' },
      { x: 520, y: 1406, w: 330, h: 44, z: 175, k: 'rack' },
    );
    // camion de carga y contenedor
    merge(L, truck(560, 600, true, true, 0xd8d8d8, 0xc0392b));
    L.walls.push({ x: 560, y: 920, w: 290, h: 74, z: 120, k: 'container', c: 0x2f6fb0, face: 'w' });
    // pallets con carga (cobertura baja) y autoelevadores
    L.walls.push(
      { x: 470, y: 470, w: 80, h: 70, z: 48, k: 'pallet' },
      { x: 470, y: 1060, w: 80, h: 70, z: 48, k: 'pallet' },
      { x: 930, y: 450, w: 90, h: 90, z: 80, k: 'crate' },
      { x: 930, y: 1060, w: 90, h: 90, z: 80, k: 'crate' },
    );
    merge(L, forklift(1000, 760, 'e'));
    // cajas pegadas a las estanterias: saltando arriba de la caja y de ahi a la estanteria
    L.walls.push(
      { x: 852, y: 140, w: 70, h: 70, z: 95, k: 'crate' },
      { x: 852, y: 1390, w: 70, h: 70, z: 95, k: 'crate' },
    );
    // tabiques que arman los pasillos del centro
    L.walls.push(
      { x: 1110, y: 130, w: 30, h: 310, z: 170, k: 'partition' },
      { x: 1110, y: 1160, w: 30, h: 310, z: 170, k: 'partition' },
    );
    // lineas pintadas en el piso
    L.deco.push(
      { t: 'paint', x: 300, y: 560, w: 760, h: 6, c: 0xf2c94c },
      { t: 'paint', x: 300, y: 1034, w: 760, h: 6, c: 0xf2c94c },
    );
    for (const o of mirror(W, L.walls)) m.walls.push(o);
    for (const o of mirror(W, L.deco)) m.deco.push(o);

    // centro: pila de cajas, pallet y dos entrepisos con escalera
    m.walls.push(
      { x: 1240, y: 560, w: 120, h: 120, z: 95, k: 'crate' },
      { x: 1240, y: 920, w: 120, h: 120, z: 95, k: 'crate' },
      { x: 1260, y: 760, w: 80, h: 80, z: 48, k: 'pallet' },
    );
    // Balcon elevado que da toda la vuelta al galpon (se puede caminar por debajo).
    // Se sube por las escaleras del medio (arriba y abajo).
    const BW = 110, BZ = 110, BZB = 100; // ancho, altura del piso del balcon y de su parte de abajo
    m.walls.push(
      { x: 0, y: 0, w: W, h: BW, z: BZ, zb: BZB, k: 'balcony' },
      { x: 0, y: H - BW, w: W, h: BW, z: BZ, zb: BZB, k: 'balcony' },
      { x: 0, y: BW, w: BW, h: H - 2 * BW, z: BZ, zb: BZB, k: 'balcony' },
      { x: W - BW, y: BW, w: BW, h: H - 2 * BW, z: BZ, zb: BZB, k: 'balcony' },
    );
    // baranda del lado de adentro, con hueco donde llegan las escaleras
    const RZ = BZ + 28, T = 5;
    const SX0 = 1250, SX1 = 1350;
    for (const ry of [BW - T, H - BW]) {
      m.walls.push(
        { x: BW, y: ry, w: SX0 - BW, h: T, z: RZ, zb: BZ, k: 'railing' },
        { x: SX1, y: ry, w: W - BW - SX1, h: T, z: RZ, zb: BZ, k: 'railing' },
      );
    }
    m.walls.push(
      { x: BW - T, y: BW, w: T, h: H - 2 * BW, z: RZ, zb: BZ, k: 'railing' },
      { x: W - BW, y: BW, w: T, h: H - 2 * BW, z: RZ, zb: BZ, k: 'railing' },
    );
    // columnas que sostienen el balcon
    for (const x of [300, 700, 1000, 1600, 1900, 2300]) {
      m.walls.push({ x: x - 10, y: BW - 22, w: 20, h: 20, z: BZB, k: 'pillar' });
      m.walls.push({ x: x - 10, y: H - BW + 2, w: 20, h: 20, z: BZB, k: 'pillar' });
    }
    for (const y of [330, 1270]) {
      m.walls.push({ x: BW - 22, y: y - 10, w: 20, h: 20, z: BZB, k: 'pillar' });
      m.walls.push({ x: W - BW + 2, y: y - 10, w: 20, h: 20, z: BZB, k: 'pillar' });
    }
    // escaleras del medio
    m.ramps.push(
      { x: SX0, y: BW, w: SX1 - SX0, h: 220, top: BZ, axis: 'y', dir: -1 },
      { x: SX0, y: H - BW - 220, w: SX1 - SX0, h: 220, top: BZ, axis: 'y', dir: 1 },
    );
    // luces del techo
    for (let x = 300; x < W; x += 500) for (let y = 250; y < H; y += 550) m.deco.push({ t: 'light', x, y, w: 260, h: 26 });
    m.deco.push({ t: 'paint', x: 1220, y: 700, w: 160, h: 6, c: 0xffffff }, { t: 'paint', x: 1220, y: 894, w: 160, h: 6, c: 0xffffff });

    return {
      id: 'warehouse', name: 'Galpón', desc: 'Depósito techado: pasillos, camiones, mulas y un balcón alrededor.',
      W, H, ...m, theme: 'warehouse',
      spawns: { red: { x: 60, y: 560, w: 200, h: 480 }, blue: { x: W - 260, y: 560, w: 200, h: 480 } },
    };
  }

  // ---------- Mapa 3: Pueblo ----------
  function makeTown() {
    const W = 2600, H = 1700;
    const m = { walls: [], ramps: [], deco: [] };
    const L = { walls: [], ramps: [], deco: [] };
    // Edificios con terraza (escalera por afuera)
    merge(L, building(340, 120, 380, 320, 130, 0xe4d2b0, {
      ramp: { x: 420, y: 440, w: 300, h: 60, axis: 'x', dir: 1 }, gap: { side: 's', from: 600, to: 720 },
    }));
    merge(L, building(340, 1260, 380, 320, 130, 0xb9d3c8, {
      ramp: { x: 420, y: 1200, w: 300, h: 60, axis: 'x', dir: 1 }, gap: { side: 'n', from: 600, to: 720 },
    }));
    // Almacenes abiertos a la calle
    merge(L, shop(820, 430, 220, 170, 's', 0xc8a27a, [0xd63a3a, 0xffffff]));
    merge(L, shop(820, 1100, 220, 170, 'n', 0xa9b8c9, [0x2e7d32, 0xffffff]));
    // Autos estacionados y en la calle
    merge(L, car(470, 690, true, 0xc0392b));
    merge(L, car(760, 930, true, 0x2e86de));
    merge(L, car(1060, 690, false, 0xf1c40f));
    // contenedores de basura pegados a los edificios: saltando arriba y de ahi a la terraza
    L.walls.push(
      { x: 722, y: 170, w: 60, h: 90, z: 75, k: 'dumpster' },
      { x: 722, y: 1340, w: 60, h: 90, z: 75, k: 'dumpster' },
    );
    // canteros (cobertura baja)
    L.walls.push(
      { x: 300, y: 600, w: 90, h: 30, z: 45, k: 'planter' },
      { x: 300, y: 1070, w: 90, h: 30, z: 45, k: 'planter' },
    );
    // veredas
    L.deco.push(
      { t: 'floor', x: 300, y: 80, w: 800, h: 560, tex: 'sidewalk' },
      { t: 'floor', x: 300, y: 1060, w: 800, h: 560, tex: 'sidewalk' },
      { t: 'lamp', x: 300, y: 650 }, { t: 'lamp', x: 300, y: 1050 }, { t: 'lamp', x: 760, y: 650 }, { t: 'lamp', x: 760, y: 1050 },
      // arboles en las veredas y arbustos
      { t: 'tree', x: 1100, y: 110 }, { t: 'tree', x: 1100, y: 1590 }, { t: 'tree', x: 590, y: 610 }, { t: 'tree', x: 590, y: 1090 },
      { t: 'bush', x: 312, y: 80 + 20 }, { t: 'bush', x: 312, y: 1600 }, { t: 'bush', x: 1120, y: 300 }, { t: 'bush', x: 1120, y: 1400 },
    );
    // troncos de los arboles (solidos)
    for (const [tx, ty] of [[1100, 110], [1100, 1590], [590, 610], [590, 1090]]) {
      L.walls.push({ x: tx - 8, y: ty - 8, w: 16, h: 16, z: 90, k: 'trunk' });
    }
    for (const o of mirror(W, L.walls)) m.walls.push(o);
    for (const o of mirror(W, L.ramps)) m.ramps.push(o);
    for (const o of mirror(W, L.deco)) m.deco.push(o);

    // Plaza central: fuente y quioscos
    m.walls.push(
      { x: 1220, y: 770, w: 160, h: 160, z: 45, k: 'fountain' },
      { x: 1250, y: 280, w: 100, h: 110, z: 100, k: 'kiosk', c: 0x8e5a3b },
      { x: 1250, y: 1310, w: 100, h: 110, z: 100, k: 'kiosk', c: 0x8e5a3b },
      { x: 1180, y: 600, w: 90, h: 28, z: 45, k: 'planter' },
      { x: 1330, y: 1072, w: 90, h: 28, z: 45, k: 'planter' },
    );
    m.deco.push({ t: 'floor', x: 1150, y: 80, w: 300, h: 1540, tex: 'plaza' });
    // lineas de la calle
    for (let x = 60; x < W - 60; x += 120) m.deco.push({ t: 'paint', x, y: 847, w: 60, h: 6, c: 0xf5f5f5 });
    // senda peatonal
    for (let i = 0; i < 7; i++) m.deco.push({ t: 'paint', x: 1130, y: 670 + i * 52, w: 14, h: 34, c: 0xf5f5f5 }, { t: 'paint', x: 1456, y: 670 + i * 52, w: 14, h: 34, c: 0xf5f5f5 });

    return {
      id: 'town', name: 'Pueblo', desc: 'Calles, autos, almacenes y terrazas para disparar desde arriba.',
      W, H, ...m, theme: 'town',
      spawns: { red: { x: 60, y: 640, w: 200, h: 420 }, blue: { x: W - 260, y: 640, w: 200, h: 420 } },
    };
  }

  // ---------- Mapa 4: Laberinto (de plantas, con torres) ----------
  // Cercos verdes altos (no se ve ni se salta por encima) y 4 torres con escalera:
  // desde arriba se ve todo el laberinto. Se arma con un sorteo fijo (igual en servidor y cliente).
  function tower(x, y, s, z, stair) {
    // base de piedra, piso de madera arriba y almena con hueco donde llega la escalera
    const walls = [{ x, y, w: s, h: s, z, k: 'tower' }];
    const P = 7, PZ = z + 26;
    const add = (x0, y0, ww, hh) => walls.push({ x: x0, y: y0, w: ww, h: hh, z: PZ, zb: z, k: 'battlement' });
    const g = stair.gap; // {from, to} sobre el lado de la escalera
    add(x, y, s, P);
    add(x, y + s - P, s, P);
    for (const side of ['w', 'e']) {
      const x0 = side === 'w' ? x : x + s - P;
      if (stair.side === side) {
        if (g.from > y + P) add(x0, y + P, P, g.from - (y + P));
        if (g.to < y + s - P) add(x0, g.to, P, y + s - P - g.to);
      } else add(x0, y + P, P, s - 2 * P);
    }
    return { walls, ramps: [{ ...stair.ramp, top: z }] };
  }

  function makeGarden() {
    const W = 2400, H = 1600;
    const T = 34, HZ = 150; // grosor y alto del cerco
    const X0 = 300, X1 = 1200, COLS = 6, ROWS = 10;
    const cw = (X1 - X0) / COLS, ch = H / ROWS;
    // sorteo con semilla: siempre sale el mismo laberinto
    let seed = 20261106;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // v[c][r]: cerco vertical a la izquierda de la celda c; h[c][r]: cerco horizontal arriba de la fila r
    const v = [], h = [];
    for (let c = 0; c <= COLS; c++) { v[c] = []; h[c] = []; for (let r = 0; r <= ROWS; r++) { v[c][r] = true; h[c][r] = true; } }
    // laberinto perfecto (recorrido en profundidad)
    const seen = new Set(['0,4']);
    const stack = [[0, 4]];
    while (stack.length) {
      const [c, r] = stack[stack.length - 1];
      const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => [c + dc, r + dr, dc, dr])
        .filter(([nc, nr]) => nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && !seen.has(nc + ',' + nr));
      if (!opts.length) { stack.pop(); continue; }
      const [nc, nr, dc, dr] = opts[(rand() * opts.length) | 0];
      if (dc === 1) v[c + 1][r] = false; else if (dc === -1) v[c][r] = false;
      else if (dr === 1) h[c][r + 1] = false; else h[c][r] = false;
      seen.add(nc + ',' + nr);
      stack.push([nc, nr]);
    }
    // se abren mas pasos para que haya vueltas (en un shooter no conviene un solo camino)
    for (let c = 1; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (v[c][r] && rand() < 0.18) v[c][r] = false;
    for (let c = 0; c < COLS; c++) for (let r = 1; r < ROWS; r++) if (h[c][r] && rand() < 0.15) h[c][r] = false;
    // claros para las torres (2 celdas de ancho, con cerco arriba y abajo y salidas a los costados)
    // claro de 3 x 2 celdas: sin cercos adentro, con cerco alrededor y dos entradas
    const clearing = (r0, inA, inB) => {
      for (let c = 1; c <= 3; c++) { h[c][r0] = true; h[c][r0 + 2] = true; h[c][r0 + 1] = false; }
      for (let r = r0; r <= r0 + 1; r++) { v[2][r] = false; v[3][r] = false; v[1][r] = true; v[4][r] = true; }
      v[1][inA] = false; v[4][inB] = false;
    };
    clearing(1, 1, 2);
    clearing(7, 8, 7);
    // claro del centro (con la fuente)
    h[5][5] = false;
    // salidas desde la base y hacia el centro
    const open = [1, 4, 5, 8];
    for (let r = 0; r < ROWS; r++) { v[0][r] = !open.includes(r); v[COLS][r] = !open.includes(r); }

    const L = { walls: [], ramps: [], deco: [] }, C = { walls: [], ramps: [], deco: [] };
    const hedge = (x, y, w, hh, list) => list.push({ x, y, w, h: hh, z: HZ, k: 'hedge' });
    const xs = (c) => X0 + c * cw;
    const ys = (r) => r * ch;
    // los tramos no se pisan entre si: en cada cruce va un "poste" (si no, los techos parpadean)
    const post = new Set();
    for (let c = 0; c <= COLS; c++) for (let r = 0; r < ROWS; r++) {
      if (!v[c][r]) continue;
      const list = c === COLS ? C.walls : L.walls; // la linea del medio no se espeja (quedaria doble)
      const y0 = r === 0 ? 0 : ys(r) + T / 2, y1 = r === ROWS - 1 ? H : ys(r + 1) - T / 2;
      hedge(xs(c) - T / 2, y0, T, y1 - y0, list);
      if (r > 0) post.add(c + ',' + r);
      if (r < ROWS - 1) post.add(c + ',' + (r + 1));
    }
    for (let c = 0; c < COLS; c++) for (let r = 1; r < ROWS; r++) {
      if (!h[c][r]) continue;
      hedge(xs(c) + T / 2, ys(r) - T / 2, cw - T, T, L.walls);
      post.add(c + ',' + r); post.add((c + 1) + ',' + r);
    }
    for (const k of post) {
      const [c, r] = k.split(',').map(Number);
      hedge(xs(c) - T / 2, ys(r) - T / 2, T, T, c === COLS ? C.walls : L.walls);
    }
    // torres: una en el claro de arriba (contra el cerco de arriba) y otra en el de abajo
    const S = 96, TZ = 140, RL = 300, RW = 50;
    const tx = xs(4) - T / 2 - 14 - S;
    const tTop = ys(1) + T / 2 + 4, tBot = ys(9) - T / 2 - 4 - S;
    merge(L, tower(tx, tTop, S, TZ, { side: 'w', gap: { from: tTop + 7, to: tTop + 7 + RW }, ramp: { x: tx - RL, y: tTop + 7, w: RL, h: RW, axis: 'x', dir: 1 } }));
    merge(L, tower(tx, tBot, S, TZ, { side: 'w', gap: { from: tBot + S - 7 - RW, to: tBot + S - 7 }, ramp: { x: tx - RL, y: tBot + S - 7 - RW, w: RL, h: RW, axis: 'x', dir: 1 } }));
    // base: arboles y arbustos
    const trees = [[90, 130], [90, H - 130], [210, 340], [210, H - 340]];
    for (const [x, y] of trees) {
      L.deco.push({ t: 'tree', x, y });
      L.walls.push({ x: x - 8, y: y - 8, w: 16, h: 16, z: 90, k: 'trunk' });
    }
    L.deco.push({ t: 'bush', x: 270, y: 560 }, { t: 'bush', x: 270, y: 1040 }, { t: 'bush', x: 40, y: 470 }, { t: 'bush', x: 40, y: 1130 });
    // senderos de piedritas en los claros de las torres
    L.deco.push({ t: 'floor', x: xs(1) + T / 2, y: ys(1) + T / 2, w: 3 * cw - T, h: 2 * ch - T, tex: 'gravel' });
    L.deco.push({ t: 'floor', x: xs(1) + T / 2, y: ys(7) + T / 2, w: 3 * cw - T, h: 2 * ch - T, tex: 'gravel' });
    // centro: claro con una fuente (cobertura baja)
    C.deco.push({ t: 'floor', x: X1 - cw + T / 2, y: ys(4) + T / 2, w: 2 * cw - T, h: 2 * ch - T, tex: 'gravel' });
    C.walls.push({ x: X1 - 60, y: H / 2 - 60, w: 120, h: 120, z: 45, k: 'fountain' });

    return {
      id: 'garden', name: 'Laberinto', desc: 'Pasillos de plantas altas y 4 torres para ver todo desde arriba.',
      W, H, walls: [...C.walls, ...mirror(W, L.walls)], ramps: mirror(W, L.ramps), deco: [...C.deco, ...mirror(W, L.deco)], theme: 'garden',
      spawns: { red: { x: 50, y: 600, w: 200, h: 400 }, blue: { x: W - 250, y: 600, w: 200, h: 400 } },
    };
  }

  const MAPS = { desert: makeDesert(), warehouse: makeWarehouse(), town: makeTown(), garden: makeGarden() };
  const MAP_IDS = Object.keys(MAPS);

  // ---------- Fisica con alturas ----------
  const STEP = 22; // lo maximo que se puede subir sin escalera
  const GRAVITY = 1000; // para el salto y las caidas
  const JUMP_V = 430; // velocidad del salto: llega a ~85 de alto (alcanza cajas, autos, contenedores de basura)

  // Altura de una escalera en un punto
  function rampH(r, x, y) {
    const t = r.axis === 'x' ? (x - r.x) / r.w : (y - r.y) / r.h;
    return clamp(r.dir > 0 ? t : 1 - t, 0, 1) * r.top;
  }

  // Empuja un circulo fuera de un rectangulo
  function pushOut(p, R, x0, y0, x1, y1) {
    const cx = clamp(p.x, x0, x1);
    const cy = clamp(p.y, y0, y1);
    const dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return;
    if (d2 === 0) {
      const l = p.x - x0, r = x1 - p.x, t = p.y - y0, b = y1 - p.y;
      const m = Math.min(l, r, t, b);
      if (m === l) p.x = x0 - R;
      else if (m === r) p.x = x1 + R;
      else if (m === t) p.y = y0 - R;
      else p.y = y1 + R;
    } else {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * R;
      p.y = cy + (dy / d) * R;
    }
  }

  // Un objeto puede estar elevado (zb = altura de abajo, ej. un balcon): se puede pasar por debajo.
  const BODY_H = 90; // alto del cuerpo (para saber si alguien entra debajo de algo)
  const bottom = (w) => w.zb || 0;
  // ¿la pared w le corta el paso a alguien parado a altura z?
  const blocksAt = (w, z) => w.z > z + STEP && bottom(w) < z + BODY_H;

  // Piso mas alto alcanzable debajo de (x, y) para alguien que esta a altura z
  function groundAt(x, y, z) {
    let g = 0;
    for (const w of MAP.walls) {
      if (w.z <= z + STEP && w.z > g && x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) g = w.z;
    }
    for (const r of MAP.ramps) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        const h = rampH(r, x, y);
        if (h <= z + STEP && h > g) g = h;
      }
    }
    return g;
  }

  // Mueve/acomoda al jugador: no atraviesa paredes, sube escaleras y cae de los bordes.
  function resolve(p, R, dt) {
    const z = p.z || 0;
    for (const w of MAP.walls) {
      if (blocksAt(w, z)) pushOut(p, R, w.x, w.y, w.x + w.w, w.y + w.h);
    }
    for (const r of MAP.ramps) {
      const cx = clamp(p.x, r.x, r.x + r.w), cy = clamp(p.y, r.y, r.y + r.h);
      if (rampH(r, cx, cy) > z + STEP) pushOut(p, R, r.x, r.y, r.x + r.w, r.y + r.h);
    }
    p.x = clamp(p.x, R, MAP.W - R);
    p.y = clamp(p.y, R, MAP.H - R);
    dt = dt || 1 / 30;
    const g = groundAt(p.x, p.y, z);
    let vz = p.vz || 0;
    if (vz !== 0 || z > g + 0.5) {
      // en el aire (saltando o cayendo)
      vz -= GRAVITY * dt;
      let nz = z + vz * dt;
      if (vz > 0 && headHit(p.x, p.y, nz)) { vz = 0; nz = z; } // pega la cabeza (ej. abajo del balcon)
      const g2 = groundAt(p.x, p.y, Math.max(z, nz));
      if (nz <= g2) { nz = g2; vz = 0; } // aterriza (en el piso, una caja, un techo...)
      p.z = nz;
      p.vz = vz;
    } else {
      p.z = g; // caminando: sube escalones y escaleras
      p.vz = 0;
    }
  }

  // ¿Choca la cabeza con algo si sube a altura z? (para el salto)
  function headHit(x, y, z) {
    const top = z + BODY_H;
    for (const w of MAP.walls) {
      const b = bottom(w);
      if (b > z + STEP && b <= top && x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
    }
    return false;
  }

  // Salta solo si esta parado en algo
  function jump(p) {
    const z = p.z || 0;
    if ((p.vz || 0) !== 0) return false;
    if (Math.abs(z - groundAt(p.x, p.y, z)) > 1) return false;
    p.vz = JUMP_V;
    return true;
  }

  // ¿Hay algo solido en este punto? (para balas y granadas)
  function solidAt(x, y, z) {
    for (const w of MAP.walls) {
      if (z < w.z && z >= bottom(w) && x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
    }
    for (const r of MAP.ramps) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && z < rampH(r, x, y)) return true;
    }
    return false;
  }

  // ¿Un jugador a altura z choca con algo si se para en (x, y)?
  function blocked(x, y, z, R) {
    for (const w of MAP.walls) {
      if (!blocksAt(w, z)) continue;
      const cx = clamp(x, w.x, w.x + w.w), cy = clamp(y, w.y, w.y + w.h);
      if ((x - cx) ** 2 + (y - cy) ** 2 < R * R) return true;
    }
    for (const r of MAP.ramps) {
      const cx = clamp(x, r.x, r.x + r.w), cy = clamp(y, r.y, r.y + r.h);
      if ((x - cx) ** 2 + (y - cy) ** 2 < R * R && rampH(r, cx, cy) > z + STEP) return true;
    }
    return false;
  }

  // ¿Se ve de un punto a otro? (en 3D)
  function los(x1, y1, z1, x2, y2, z2) {
    const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1, z2 - z1) / 12);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (solidAt(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, z1 + (z2 - z1) * t)) return false;
    }
    return true;
  }

  // Cambia el mapa activo (lo llama el servidor al empezar una partida y el cliente al enterarse)
  function setMap(id) {
    const m = MAPS[id] || MAPS.desert;
    MAP.id = m.id;
    MAP.name = m.name;
    MAP.W = m.W;
    MAP.H = m.H;
    MAP.walls = m.walls;
    MAP.ramps = m.ramps;
    MAP.deco = m.deco;
    MAP.theme = m.theme;
    MAP.spawns = m.spawns;
    return m;
  }

  // Armas de la tienda (las usan servidor y cliente).
  // dmg = daño por bala, rate = ms entre disparos, pellets = balas por disparo,
  // spread = dispersion (radianes), life = alcance en segundos de vuelo.
  const WEAPONS = [
    { id: 0, name: 'Chorrito', price: 0, dmg: 20, rate: 170, pellets: 1, spread: 0.02, life: 0.9, speed: 950,
      desc: 'La de siempre, equilibrada.' },
    { id: 1, name: 'Pistola de agua', price: 50, dmg: 28, rate: 200, pellets: 1, spread: 0.02, life: 0.9, speed: 1000,
      desc: 'Más daño por tiro.' },
    { id: 2, name: 'Regadera', price: 70, dmg: 15, rate: 750, pellets: 6, spread: 0.32, life: 0.42, speed: 900,
      desc: 'Mucho daño de cerca, lenta.' },
    { id: 3, name: 'Hidrometralleta', price: 90, dmg: 12, rate: 75, pellets: 1, spread: 0.09, life: 0.8, speed: 1000,
      desc: 'Muy rápida, menos daño.' },
  ];

  // Personajes: 2 estilos por equipo (solo cambia el aspecto; el cuerpo y la cabeza miden lo mismo).
  // Armadura estilo espartano: body = placas, accent = detalles, visor = color del visor.
  // (hat/gear/skin/legs quedan para el personaje simple que se usa si no cargan los modelos 3D)
  const STYLES = {
    red: [
      { name: 'Titán', desc: 'Armadura pesada, visor dorado', body: 0xd1343f, accent: 0x5e1219, visor: 0xf2b233, skin: 0xf0c9a0, legs: 0x2a1d1f, hat: 'helmet', gear: 'vest' },
      { name: 'Centella', desc: 'Armadura liviana, visor celeste', body: 0xe0564a, accent: 0x3a3f48, visor: 0x5ce6f0, skin: 0xb07850, legs: 0x1d2128, hat: 'bandana', gear: 'backpack' },
    ],
    blue: [
      { name: 'Coloso', desc: 'Armadura pesada, visor dorado', body: 0x2f72e0, accent: 0x15306e, visor: 0xf2b233, skin: 0xf0c9a0, legs: 0x1d2534, hat: 'goggles', gear: 'pads' },
      { name: 'Halcón', desc: 'Armadura liviana, visor celeste', body: 0x3d97ea, accent: 0x3a3f48, visor: 0x5ce6f0, skin: 0x8d5a3b, legs: 0x1d2128, hat: 'cap', gear: 'scarf' },
    ],
  };

  const BASE_PAD = 40; // la base pintada en el piso es la zona de aparicion + 40 de margen
  function inBase(team, x, y) {
    const s = MAP.spawns[team];
    return !!s && x >= s.x - BASE_PAD && x <= s.x + s.w + BASE_PAD && y >= s.y - BASE_PAD && y <= s.y + s.h + BASE_PAD;
  }

  const MAP = {
    MAPS,
    MAP_IDS,
    setMap,
    resolve,
    jump,
    groundAt,
    solidAt,
    blocked,
    los,
    rampH,
    STEP,
    inBase,
    BASE_PAD,
    STYLES,
    WEAPONS,
    START_COINS: 100,
    KILL_COINS: 5,
    MAX_MINUTES: 15,
    P_R: 22,
    SPEED: 286, // 10% mas rapido que antes (260)
    // Alturas del cuerpo (desde los pies, para las zonas de impacto): piernas y torso hasta 72, cabeza (casco) 72-94
    EYE_H: 62, // altura de los ojos: de aca salen las balas
    HEAD_Z: 72,
    TOP_Z: 94,
    HEAD_R: 15.75, // radio de la cabeza
    MAX_PITCH: 0.7, // cuanto se puede mirar arriba/abajo (radianes, ~40 grados)
    HEADSHOT_COINS: 10,
    // Granada: el daño baja con la distancia al centro de la explosion
    // Flashbang: cuesta lo mismo que la granada; no hace daño, deja ciego a todos los que lo ven (tambien a tu equipo y a vos)
    FLASH: {
      radius: 950, // hasta donde enceguece
      maxMs: 3600, // ceguera maxima (mirandolo de frente y de cerca)
      minMs: 350, // menos que esto no cuenta
    },
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
  };
  setMap('desert');

  if (typeof module !== 'undefined' && module.exports) module.exports = MAP;
  else root.MAP = MAP;
})(this);
