// Personajes 3D (Universal Base Characters de Quaternius, CC0) con armadura estilo "espartano".
// La armadura se arma sobre el mismo cuerpo: se toman las partes del cuerpo que corresponden a cada
// hueso (pecho, hombros, brazos, piernas), se "inflan" un poco hacia afuera y se pintan del color del
// equipo. Como usan el mismo esqueleto, se mueven junto con el personaje.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';
import { toon } from './world.js';

export const HERO_SCALE = 51; // el modelo viene en metros: 1.75 m → ~89 de alto (+ casco ≈ 94)
const FILES = ['/models/hero_m.glb', '/models/hero_f.glb']; // estilo 0 y estilo 1
const templates = [];
let readyPromise = null;

// Piezas de armadura de cada estilo: cajas en el espacio del modelo (metros, en pose T, x medido
// como |x| asi sirve para los dos lados). Se arman con la posicion de los huesos (B) para que
// calcen en los dos cuerpos. off = cuanto sobresale la placa; col = de que color va.
const INF = 9;
const MAX_PIECES = 10;
const ARMOR = [
  // 0: pesado. Pecho grande, hombreras anchas, placas en abdomen, muslos y canilleras.
  (B) => [
    { col: 'plate', off: 0.05, x: [B.ax - 0.07, B.ax + 0.15], y: [B.ay - 0.035, INF] }, // hombreras
    { col: 'plate', off: 0.034, x: [0, B.ax + 0.02], y: [B.s2 - 0.03, B.neck + 0.01] }, // pecho
    { col: 'trim', off: 0.022, y: [B.s1 - 0.01, B.s2 - 0.03], z: [-0.02, INF] }, // abdomen
    { col: 'boot', off: 0.016, y: [B.pel - 0.05, B.s1 - 0.01] }, // cinturon
    { col: 'trim', off: 0.022, x: [B.lx + 0.05, B.hx - 0.03] }, // antebrazos
    { col: 'plate', off: 0.02, y: [B.calf + 0.14, B.thigh - 0.1], z: [B.tz - 0.01, INF] }, // muslos
    { col: 'trim', off: 0.026, y: [B.calf - 0.04, B.calf + 0.07], z: [B.cz, INF] }, // rodilleras
    { col: 'plate', off: 0.022, y: [B.foot + 0.06, B.calf - 0.04] }, // canilleras
    { col: 'boot', off: 0.012, y: [-INF, B.foot + 0.06] }, // botas
  ],
  // 1: liviano. Pecho chico, hombreras chicas, cintura y muslos expuestos.
  (B) => [
    { col: 'plate', off: 0.03, x: [B.ax - 0.04, B.ax + 0.09], y: [B.ay - 0.02, INF] },
    { col: 'plate', off: 0.024, x: [0, B.ax], y: [B.s3 - 0.05, B.neck] },
    { col: 'trim', off: 0.014, y: [B.pel - 0.03, B.pel + 0.05] },
    { col: 'plate', off: 0.016, x: [B.lx + 0.08, B.hx - 0.03] },
    { col: 'trim', off: 0.012, x: [B.tx, INF], y: [B.calf + 0.2, B.thigh - 0.1] }, // costado del muslo
    { col: 'plate', off: 0.022, y: [B.calf - 0.03, B.calf + 0.06], z: [B.cz, INF] },
    { col: 'plate', off: 0.018, y: [B.foot + 0.08, B.calf - 0.03] },
    { col: 'boot', off: 0.01, y: [-INF, B.foot + 0.08] },
  ],
];

export function loadHeroes() {
  if (readyPromise) return readyPromise;
  const loader = new GLTFLoader();
  readyPromise = Promise.all(FILES.map((f) => loader.loadAsync(f))).then((gl) => {
    gl.forEach((g, i) => (templates[i] = prepTemplate(g, i)));
    return true;
  });
  return readyPromise;
}
export const heroesReady = () => templates.length === FILES.length;

// Calcula una sola vez por modelo: geometria de la armadura y donde va el casco
function prepTemplate(gltf, style) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  let body = null;
  scene.traverse((o) => { if (o.isSkinnedMesh) body = o; });
  const geo = body.geometry;
  const skel = body.skeleton;
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const n = pos.count;
  const boneIdx = {};
  skel.bones.forEach((b, i) => (boneIdx[b.name] = i));
  // posicion de cada hueso en el espacio de la malla (pose de reposo)
  const invBind = body.bindMatrix.clone().invert();
  const boneLocal = skel.bones.map((b, i) => new THREE.Vector3().applyMatrix4(skel.boneInverses[i].clone().invert()).applyMatrix4(invBind));
  const bp = (name) => boneLocal[boneIdx[name]];
  const B = {
    ax: Math.abs(bp('upperarm_l').x), ay: bp('upperarm_l').y, lx: Math.abs(bp('lowerarm_l').x), hx: Math.abs(bp('hand_l').x),
    pel: bp('pelvis').y, s1: bp('spine_01').y, s2: bp('spine_02').y, s3: bp('spine_03').y, neck: bp('neck_01').y,
    thigh: bp('thigh_l').y, tx: Math.abs(bp('thigh_l').x), tz: bp('thigh_l').z, calf: bp('calf_l').y, cz: bp('calf_l').z, foot: bp('foot_l').y,
  };
  const parts = ARMOR[style](B).map((p) => ({ ...p, min: [p.x ? p.x[0] : 0, p.y ? p.y[0] : -INF, p.z ? p.z[0] : -INF], max: [p.x ? p.x[1] : INF, p.y ? p.y[1] : INF, p.z ? p.z[1] : INF] }));
  const inBox = (p, x, y, z, m) => Math.abs(x) >= p.min[0] - m && Math.abs(x) <= p.max[0] + m && y >= p.min[1] - m && y <= p.max[1] + m && z >= p.min[2] - m && z <= p.max[2] + m;

  // Cada pieza: los triangulos que tocan su caja (con margen), inflados hacia afuera.
  // El borde exacto lo recorta el shader (ver armorMaterial), asi las placas quedan con cortes prolijos.
  const idx = geo.index.array;
  const byCol = {};
  const M = 0.03;
  parts.forEach((p, pi) => {
    const keep = new Uint8Array(n);
    for (let v = 0; v < n; v++) keep[v] = inBox(p, pos.getX(v), pos.getY(v), pos.getZ(v), M) ? 1 : 0;
    const acc = (byCol[p.col] = byCol[p.col] || { P: [], N: [], B: [], K: [], SI: [], SW: [], I: [] });
    const map = new Map();
    for (let f = 0; f < idx.length; f += 3) {
      if (!(keep[idx[f]] || keep[idx[f + 1]] || keep[idx[f + 2]])) continue;
      for (let k = 0; k < 3; k++) {
        const v = idx[f + k];
        let j = map.get(v);
        if (j === undefined) {
          j = acc.P.length / 3; map.set(v, j);
          const o = p.off;
          acc.P.push(pos.getX(v) + nor.getX(v) * o, pos.getY(v) + nor.getY(v) * o, pos.getZ(v) + nor.getZ(v) * o);
          acc.N.push(nor.getX(v), nor.getY(v), nor.getZ(v));
          acc.B.push(pos.getX(v), pos.getY(v), pos.getZ(v));
          acc.K.push(pi);
          for (let q = 0; q < 4; q++) { acc.SI.push(si.getComponent(v, q)); acc.SW.push(sw.getComponent(v, q)); }
        }
        acc.I.push(j);
      }
    }
  });
  const armorGeos = {};
  for (const col in byCol) {
    const a = byCol[col];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(a.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(a.N, 3));
    g.setAttribute('aBind', new THREE.Float32BufferAttribute(a.B, 3));
    g.setAttribute('aPiece', new THREE.Float32BufferAttribute(a.K, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(a.SI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(a.SW, 4));
    g.setIndex(a.I);
    armorGeos[col] = g;
  }
  const boxMin = parts.map((p) => new THREE.Vector3(...p.min));
  const boxMax = parts.map((p) => new THREE.Vector3(...p.max));
  while (boxMin.length < MAX_PIECES) { boxMin.push(new THREE.Vector3()); boxMax.push(new THREE.Vector3()); }
  const tmp = new THREE.Vector3();

  // Casco: caja de la cabeza (en el espacio de la malla) → se cuelga del hueso de la cabeza
  const head = boneIdx.Head;
  const hb = new THREE.Box3();
  for (let v = 0; v < n; v++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > bw) { bw = w; best = si.getComponent(v, k); } }
    if (best === head) hb.expandByPoint(tmp.fromBufferAttribute(pos, v));
  }
  const hc = hb.getCenter(new THREE.Vector3()), hs = hb.getSize(new THREE.Vector3());
  // matriz que lleva del espacio de la malla al del hueso: boneInverse * bindMatrix
  const toHead = skel.boneInverses[head].clone().multiply(body.bindMatrix);
  // arma: en la mano derecha
  const hand = boneIdx.hand_r;
  const toHand = skel.boneInverses[hand].clone().multiply(body.bindMatrix);
  const bonePos = {};
  skel.bones.forEach((b, i) => (bonePos[b.name] = boneLocal[i].toArray().map((x) => +x.toFixed(3))));
  const bb = new THREE.Box3().setFromBufferAttribute(pos);
  return { bonePos, bb, scene, armorGeos, boxMin, boxMax, hc, hs, toHead, toHand, handPos: boneLocal[hand].clone(), clips: gltf.animations || [] };
}

// Material de placa: igual al toon, pero recorta lo que queda fuera de la caja de su pieza
function armorMaterial(color, T) {
  const m = toon({ color });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMin = { value: T.boxMin };
    sh.uniforms.uMax = { value: T.boxMax };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aBind;
attribute float aPiece;
varying vec3 vBind;
varying float vPiece;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vBind = aBind; vPiece = aPiece;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uMin[${MAX_PIECES}];
uniform vec3 uMax[${MAX_PIECES}];
varying vec3 vBind;
varying float vPiece;`)
      .replace('void main() {', `void main() {
  int armorI = int(vPiece + 0.5);
  vec3 bp = vec3(abs(vBind.x), vBind.yz);
  if (any(lessThan(bp, uMin[armorI])) || any(greaterThan(bp, uMax[armorI]))) discard;`);
  };
  m.customProgramCacheKey = () => 'armor' + MAX_PIECES;
  return m;
}

// Casco estilo espartano: cupula, mentonera y un visor grande que envuelve la cara.
const helmetCache = {};
function helmetParts(style, hs) {
  const key = style;
  if (helmetCache[key]) return helmetCache[key];
  const r = Math.max(hs.x, hs.z) * 0.62; // un poco mas grande que la cabeza
  const parts = [];
  if (style === 0) {
    const dome = new THREE.SphereGeometry(r, 28, 20);
    dome.scale(1, 1.02, 1.1);
    parts.push({ geo: dome, col: 'plate', pos: [0, 0.01, -0.005] });
    // mentonera/boca del casco
    const jaw = new THREE.CapsuleGeometry(r * 0.55, r * 0.5, 6, 12);
    jaw.rotateZ(Math.PI / 2);
    parts.push({ geo: jaw, col: 'trim', pos: [0, -r * 0.62, r * 0.32] });
    // visor dorado: una porcion de esfera adelante
    const vis = new THREE.SphereGeometry(r * 1.02, 26, 12, Math.PI * 0.18, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.22);
    parts.push({ geo: vis, col: 'visor', pos: [0, 0.006, 0.012], scale: [1.03, 1.05, 1.12] });
    // cresta en el medio
    const crest = new THREE.BoxGeometry(r * 0.22, r * 0.18, r * 1.6);
    parts.push({ geo: crest, col: 'trim', pos: [0, r * 0.98, 0] });
  } else {
    const dome = new THREE.SphereGeometry(r * 0.95, 28, 20);
    dome.scale(0.95, 1.05, 1.08);
    parts.push({ geo: dome, col: 'plate', pos: [0, 0.012, -0.004] });
    const jaw = new THREE.CapsuleGeometry(r * 0.45, r * 0.42, 6, 12);
    jaw.rotateZ(Math.PI / 2);
    parts.push({ geo: jaw, col: 'trim', pos: [0, -r * 0.6, r * 0.28] });
    // visor angosto tipo ranura
    const vis = new THREE.SphereGeometry(r * 0.97, 26, 8, Math.PI * 0.12, Math.PI * 0.76, Math.PI * 0.42, Math.PI * 0.12);
    parts.push({ geo: vis, col: 'visor', pos: [0, 0.008, 0.012], scale: [1.03, 1.05, 1.12] });
    // antena al costado
    const ant = new THREE.CylinderGeometry(r * 0.04, r * 0.06, r * 1.2, 8);
    parts.push({ geo: ant, col: 'trim', pos: [-r * 0.85, r * 0.55, -r * 0.3], rot: [0, 0, 0.25] });
    const ear = new THREE.CylinderGeometry(r * 0.28, r * 0.28, r * 0.25, 16);
    ear.rotateZ(Math.PI / 2);
    parts.push({ geo: ear, col: 'trim', pos: [-r * 0.92, 0, 0] });
    parts.push({ geo: ear, col: 'trim', pos: [r * 0.92, 0, 0] });
  }
  return (helmetCache[key] = parts);
}

// Colores: placas del equipo, detalles, traje de abajo, botas y visor
export function heroColors(st) {
  return { plate: st.body, trim: st.accent, suit: 0x2b2f36, boot: 0x23262c, visor: st.visor ?? 0xf2b233 };
}

// Arma un personaje listo para la escena. Mira hacia +x (igual que los de antes).
export function buildHero(style, st) {
  const T = templates[style];
  const cols = heroColors(st);
  const mats = [];
  const M = (c, extra) => { const m = toon({ color: c, ...extra }); mats.push(m); return m; };
  const plate = M(cols.plate, { transparent: true });
  const trim = M(cols.trim);
  const suit = M(cols.suit);
  const boot = M(cols.boot);
  const visor = new THREE.MeshPhongMaterial({ color: cols.visor, emissive: cols.visor, emissiveIntensity: 0.25, shininess: 140, specular: 0xffffff });
  mats.push(visor);
  const byCol = { plate, trim, suit, boot, visor };

  const root = skClone(T.scene);
  let body = null;
  root.traverse((o) => { if (o.isSkinnedMesh) body = o; });
  body.material = suit;
  body.frustumCulled = false;
  const armorMats = {};
  for (const col in T.armorGeos) {
    const am = (armorMats[col] = armorMaterial(cols[col], T));
    mats.push(am);
    const m = new THREE.SkinnedMesh(T.armorGeos[col], am);
    m.frustumCulled = false;
    m.position.copy(body.position); m.quaternion.copy(body.quaternion); m.scale.copy(body.scale);
    body.parent.add(m);
    m.bind(body.skeleton, body.bindMatrix);
  }
  const bone = (name) => body.skeleton.bones.find((b) => b.name === name);
  // casco colgado del hueso de la cabeza
  const headBone = bone('Head');
  const helmet = new THREE.Group();
  helmet.matrixAutoUpdate = false;
  helmet.matrix.copy(T.toHead).multiply(new THREE.Matrix4().makeTranslation(T.hc.x, T.hc.y, T.hc.z));
  for (const p of helmetParts(style, T.hs)) {
    const o = new THREE.Mesh(p.geo, byCol[p.col]);
    o.position.set(...p.pos);
    if (p.rot) o.rotation.set(...p.rot);
    if (p.scale) o.scale.set(...p.scale);
    helmet.add(o);
  }
  headBone.add(helmet);
  // arma: soporte colgado de la mano derecha (lo llena game.js)
  const handBone = bone('hand_r');
  const gunMount = new THREE.Group();
  gunMount.matrixAutoUpdate = false;
  gunMount.matrix.copy(T.toHand).multiply(new THREE.Matrix4().makeTranslation(T.handPos.x, T.handPos.y, T.handPos.z));
  handBone.add(gunMount);

  const g = new THREE.Group();
  root.rotation.y = Math.PI / 2; // el modelo mira a +z; el juego usa +x
  root.scale.setScalar(HERO_SCALE);
  g.add(root);
  const bones = {};
  for (const b of body.skeleton.bones) bones[b.name] = b;
  const rest = {};
  for (const b of body.skeleton.bones) rest[b.name] = b.quaternion.clone();
  const restPos = {};
  for (const k in T.bonePos) restPos[k] = new THREE.Vector3(...T.bonePos[k]);
  return { g, root, body, bones, rest, restPos, plateMat: plate, flashMats: [plate, trim, suit, boot, ...Object.values(armorMats)], mats, gunMount, clips: T.clips };
}

// ---------- Pose por codigo (sin animaciones del pack) ----------
// Brazos: "IK" de dos huesos para que las manos agarren el arma (mano derecha en la empuñadura,
// izquierda adelante). Piernas: paso de caminar/correr y rodillas dobladas en el aire.
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _down = new THREE.Vector3(), _fwd = new THREE.Vector3(), _side = new THREE.Vector3();
// gira "bone" para que la direccion hacia "child" apunte a dirWorld
function aimBone(bone, child, dirWorld) {
  bone.getWorldPosition(_a);
  child.getWorldPosition(_b);
  _c.subVectors(_b, _a).normalize();
  _d.copy(dirWorld).normalize();
  _q.setFromUnitVectors(_c, _d);
  bone.getWorldQuaternion(_qb);
  bone.parent.getWorldQuaternion(_qp);
  _qb.premultiply(_q);
  bone.quaternion.copy(_qp.invert().multiply(_qb));
  bone.updateMatrixWorld(true);
}
const _S = new THREE.Vector3(), _E = new THREE.Vector3(), _T = new THREE.Vector3(), _P = new THREE.Vector3(), _dir = new THREE.Vector3();
function ikArm(h, side, target, pole) {
  const up = h.bones['upperarm_' + side], lo = h.bones['lowerarm_' + side], ha = h.bones['hand_' + side];
  up.getWorldPosition(_S);
  const L1 = h.len['ua' + side] * h.sc, L2 = h.len['la' + side] * h.sc;
  _dir.subVectors(target, _S);
  let d = _dir.length();
  d = Math.min(d, (L1 + L2) * 0.999);
  _dir.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _P.copy(pole).addScaledVector(_dir, -pole.dot(_dir)).normalize();
  _E.copy(_S).addScaledVector(_dir, a).addScaledVector(_P, hh);
  _T.copy(_S).addScaledVector(_dir, d);
  aimBone(up, lo, _c.subVectors(_E, _S).clone());
  aimBone(lo, ha, _c.subVectors(_T, _E).clone());
}
function legPose(h, side, swing, knee) {
  const th = h.bones['thigh_' + side], ca = h.bones['calf_' + side], fo = h.bones['foot_' + side];
  aimBone(th, ca, _a.copy(_down).multiplyScalar(Math.cos(swing)).addScaledVector(_fwd, Math.sin(swing)).clone());
  const s2 = swing - knee;
  aimBone(ca, fo, _a.copy(_down).multiplyScalar(Math.cos(s2)).addScaledVector(_fwd, Math.sin(s2)).clone());
}
const POSED = ['upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'thigh_r', 'calf_r', 'spine_02', 'Head'];
const _grip = new THREE.Vector3(), _sup = new THREE.Vector3();
// o: { walk (fase), moving (0..1), air (bool), pitch (rad), gun (Object3D), grip, support (Vector3 locales del arma) }
export function poseHero(h, o) {
  if (!h.len) {
    // largos de brazos (en metros del modelo) una sola vez
    const bl = (a, b) => h.restPos[a].distanceTo(h.restPos[b]);
    h.len = { ual: bl('upperarm_l', 'lowerarm_l'), lal: bl('lowerarm_l', 'hand_l'), uar: bl('upperarm_r', 'lowerarm_r'), lar: bl('lowerarm_r', 'hand_r') };
  }
  for (const n of POSED) h.bones[n].quaternion.copy(h.rest[n]);
  h.g.updateMatrixWorld(true);
  h.root.getWorldScale(_a); h.sc = _a.x;
  // ejes del personaje en el mundo
  h.g.getWorldQuaternion(_q);
  _down.set(0, -1, 0);
  _fwd.set(1, 0, 0).applyQuaternion(_q); _fwd.y = 0; _fwd.normalize();
  _side.set(0, 0, 1).applyQuaternion(_q); // derecha del personaje
  // inclinacion del torso al apuntar arriba/abajo
  const sp = h.bones.spine_02;
  sp.getWorldQuaternion(_qb); sp.parent.getWorldQuaternion(_qp);
  _q.setFromAxisAngle(_side, (o.pitch || 0) * 0.35);
  _qb.premultiply(_q);
  sp.quaternion.copy(_qp.clone().invert().multiply(_qb));
  sp.updateMatrixWorld(true);
  // piernas
  const m = o.moving || 0;
  if (o.air) {
    legPose(h, 'l', 0.55, 1.1); legPose(h, 'r', 0.2, 0.7);
  } else {
    const w = o.walk || 0;
    legPose(h, 'l', Math.sin(w) * 0.55 * m, (0.12 + 0.7 * Math.max(0, Math.cos(w))) * m);
    legPose(h, 'r', -Math.sin(w) * 0.55 * m, (0.12 + 0.7 * Math.max(0, -Math.cos(w))) * m);
  }
  // brazos al arma
  if (o.gun) {
    o.gun.updateMatrixWorld(true);
    o.gun.localToWorld(_grip.copy(o.grip));
    o.gun.localToWorld(_sup.copy(o.support));
    ikArm(h, 'r', _grip, _a.copy(_down).addScaledVector(_side, 0.8).clone());
    ikArm(h, 'l', _sup, _a.copy(_down).addScaledVector(_side, -0.9).clone());
  }
  // cabeza: sigue la mira
  const hd = h.bones.Head;
  hd.getWorldQuaternion(_qb); hd.parent.getWorldQuaternion(_qp);
  _q.setFromAxisAngle(_side, (o.pitch || 0) * 0.5);
  _qb.premultiply(_q);
  hd.quaternion.copy(_qp.clone().invert().multiply(_qb));
}
