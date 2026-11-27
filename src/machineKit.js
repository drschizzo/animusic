// Pièces mécaniques des machines du réseau : pièces tournées chanfreinées, boîtes aux
// arêtes adoucies, profilés extrudés le long d'un tracé, boulonnerie, paliers et
// poulies. Tout est rendu en géométries (sans matière) ; un `Kit` les range par matière
// et les fusionne en un maillage par matière.
//
// Règle de construction : aucune arête vive (tout est chanfreiné ou arrondi, sinon une
// arête ne prend pas la lumière), et toute pièce qui tourne est portée par un palier.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Géométrie réduite à position et normale, non indexée : fusionnable avec n'importe quelle autre. */
function plain(g) {
  const out = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal') out.deleteAttribute(k);
  return out;
}

/** Pièces d'un ensemble, rangées par matière, fusionnées en un maillage par matière. */
export class Kit {
  constructor() {
    this.lists = new Map();
  }

  /** Ajoute une géométrie (posée par `matrix` si donnée) dans la matière `material`. */
  add(material, geometry, matrix) {
    if (matrix) geometry.applyMatrix4(matrix);
    if (!this.lists.has(material)) this.lists.set(material, []);
    this.lists.get(material).push(plain(geometry));
    return geometry;
  }

  /** Fusionne et accroche les maillages à `parent`. */
  build(parent, name) {
    const meshes = [];
    for (const [material, list] of this.lists) {
      if (!list.length) continue;
      const mesh = new THREE.Mesh(mergeGeometries(list), material);
      mesh.name = `${name} (${material.name || material.type})`;
      mesh.castShadow = mesh.receiveShadow = !material.transparent;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.lists.clear();
    return meshes;
  }
}

/**
 * Pièce tournée : profil [[rayon, hauteur], …] autour de l'axe y. Chaque segment du
 * profil a sa propre normale (arêtes franches, chanfreins nets) ; deux segments presque
 * alignés (moins de `smooth` degrés) sont lissés ensemble (congés, calottes).
 */
export function turn(profile, { segments, smooth = 32, start = 0, length = Math.PI * 2 } = {}) {
  segments ??= facets(Math.max(...profile.map(([r]) => r)));
  const pos = [];
  const nor = [];
  const segN = [];
  for (let j = 0; j < profile.length - 1; j++) {
    const [ra, ya] = profile[j];
    const [rb, yb] = profile[j + 1];
    const l = Math.hypot(rb - ra, yb - ya);
    segN.push(l > 1e-9 ? [(yb - ya) / l, -(rb - ra) / l] : null);
  }
  const cosLimit = Math.cos((smooth * Math.PI) / 180);
  const blend = (n, m) => (m && n[0] * m[0] + n[1] * m[1] > cosLimit ? [(n[0] + m[0]) / 2, (n[1] + m[1]) / 2] : n);
  for (let j = 0; j < profile.length - 1; j++) {
    const n = segN[j];
    if (!n) continue;
    const na = blend(n, segN[j - 1]);
    const nb = blend(n, segN[j + 1]);
    const [ra, ya] = profile[j];
    const [rb, yb] = profile[j + 1];
    for (let k = 0; k < segments; k++) {
      const t0 = start + (length * k) / segments;
      const t1 = start + (length * (k + 1)) / segments;
      const P = (r, y, t) => [r * Math.cos(t), y, r * Math.sin(t)];
      const N = (m, t) => {
        const v = [m[0] * Math.cos(t), m[1], m[0] * Math.sin(t)];
        const l = Math.hypot(...v) || 1;
        return v.map((x) => x / l);
      };
      const A0 = P(ra, ya, t0);
      const A1 = P(ra, ya, t1);
      const B0 = P(rb, yb, t0);
      const B1 = P(rb, yb, t1);
      pos.push(...A0, ...B0, ...A1, ...A1, ...B0, ...B1);
      nor.push(...N(na, t0), ...N(nb, t0), ...N(na, t1), ...N(na, t1), ...N(nb, t0), ...N(nb, t1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/**
 * Nombre de facettes d'une pièce tournée de rayon r : une facette tous les 2,5 cm de
 * pourtour environ, entre 6 et 32 (un pied de 1 cm n'a pas besoin d'être aussi rond
 * qu'un volant ; le réseau compte des milliers de petites pièces).
 */
export const facets = (r) => Math.max(6, Math.min(32, Math.round((2 * Math.PI * r) / 0.025)));

/** Cylindre plein chanfreiné, d'axe y, centré. */
export const cylinder = (r, h, c = Math.min(r, h) * 0.12, segments = facets(r)) =>
  turn([[0, -h / 2], [r - c, -h / 2], [r, -h / 2 + c], [r, h / 2 - c], [r - c, h / 2], [0, h / 2]], { segments });

/** Bague (rondelle, collier, bride) d'axe y, centrée, percée de rIn. */
export const ring = (rOut, rIn, h, c = Math.min(rOut - rIn, h) * 0.2, segments = facets(rOut)) =>
  turn([[rIn, -h / 2], [rOut - c, -h / 2], [rOut, -h / 2 + c], [rOut, h / 2 - c], [rOut - c, h / 2], [rIn, h / 2], [rIn, -h / 2]], { segments });

/** Boîte aux arêtes arrondies. */
export const rbox = (w, h, d, r = 0.006) => {
  const radius = Math.min(r, w / 2.01, h / 2.01, d / 2.01);
  // Un seul segment d'arrondi suffit sous 5 mm : c'est un chanfrein, qui prend la lumière pareil.
  return new RoundedBoxGeometry(w, h, d, radius < 0.005 ? 1 : 2, radius);
};

/** Écrou hexagonal d'axe y, posé sur y = 0 (pans plats). */
export function nut(s = 0.006, h = s * 0.8) {
  const g = new THREE.CylinderGeometry(s, s, h, 6).translate(0, h / 2, 0).toNonIndexed();
  g.computeVertexNormals();
  return plain(g);
}

/** Couronne de n écrous sur un cercle de rayon R (plan xz, têtes vers +y), à la hauteur y. */
export function boltCircle(n, R, y = 0, s = 0.006, phase = 0) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    list.push(nut(s).rotateY(-a).translate(Math.cos(a) * R, y, Math.sin(a) * R));
  }
  return mergeGeometries(list);
}

/** Axe y → axe x (pour les pièces tournées couchées le long de x). */
export const toX = (g) => g.rotateZ(-Math.PI / 2);
/** Axe y → axe z. */
export const toZ = (g) => g.rotateX(Math.PI / 2);

/** Pièce d'axe y (centrée, de longueur 1 le long de y si `unit`) posée entre deux points. */
export function between(g, a, b, { unit = false } = {}) {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  if (unit) g.scale(1, A.distanceTo(B), 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, B.clone().sub(A).normalize()));
  return g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
}

/** Tige ronde chanfreinée entre deux points. */
export const rod = (a, b, r, segments = 14) => between(cylinder(r, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), r * 0.25, segments), a, b);

/**
 * Palier à semelle (axe x, centré sur l'axe de l'arbre) : semelle boulonnée, corps,
 * chapeau, graisseur. `drop` : distance de l'axe au-dessous de la semelle.
 * @returns { iron, brass, steel } géométries par matière
 */
export function pillowBlock(shaftR, drop = shaftR * 3) {
  const R = shaftR * 2.1;
  const L = shaftR * 2.4;
  // La semelle et ses boulons s'étendent en travers de l'arbre (le long de z).
  const iron = [
    rbox(L * 1.25, shaftR * 0.9, R * 4.2, shaftR * 0.25).translate(0, -drop + shaftR * 0.45, 0), // semelle
    rbox(L, drop - shaftR * 0.9, R * 2.2, shaftR * 0.3).translate(0, -(drop + shaftR * 0.9) / 2 + shaftR * 0.45, 0), // pied
    toX(ring(R, shaftR * 1.02, L)), // corps
    rbox(L * 0.9, shaftR * 0.7, R * 2.6, shaftR * 0.25).translate(0, R * 0.95, 0), // chapeau
  ];
  const capTop = R * 0.95 + shaftR * 0.35;
  const steel = [boltCircle(2, R * 1.6, -drop + shaftR * 0.9, shaftR * 0.35, Math.PI / 2), nut(shaftR * 0.32).translate(0, capTop, R * 1.05), nut(shaftR * 0.32).translate(0, capTop, -R * 1.05)];
  // Graisseur de laiton sur le chapeau.
  const brass = [cylinder(shaftR * 0.3, shaftR * 0.7).translate(0, capTop + shaftR * 0.35, 0), cylinder(shaftR * 0.45, shaftR * 0.3).translate(0, capTop + shaftR * 0.8, 0)];
  return { iron: mergeGeometries(iron.map(plain)), steel: mergeGeometries(steel.map(plain)), brass: mergeGeometries(brass.map(plain)) };
}

/**
 * Poulie à bras (axe x, centrée) : jante bombée, moyeu, bras de section ovale.
 * @returns { rim, hub } géométries (jante et bras ; moyeu)
 */
export function spokedPulley(R, width, { spokes = 4, hubR = R * 0.28, rimT = Math.max(0.006, R * 0.12) } = {}) {
  const w = width / 2;
  const c = Math.min(rimT, w) * 0.3;
  // Jante bombée (la courroie reste au milieu), face intérieure, chanfreins.
  const rim = turn(
    [[R - rimT, -w], [R - c, -w], [R, -w + c], [R + rimT * 0.15, 0], [R, w - c], [R - c, w], [R - rimT, w], [R - rimT, -w]],
    { segments: 40, smooth: 25 },
  );
  const parts = [toX(rim)];
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    const len = R - rimT - hubR * 0.8;
    const spoke = new THREE.CylinderGeometry(rimT * 0.32, rimT * 0.5, len, 10).toNonIndexed();
    spoke.scale(1, 1, 0.6).translate(0, hubR * 0.8 + len / 2, 0).rotateX(a);
    spoke.computeVertexNormals();
    parts.push(spoke);
  }
  const hub = toX(turn([[0, -w * 1.1], [hubR - c, -w * 1.1], [hubR, -w * 1.1 + c], [hubR, w * 1.1 - c], [hubR - c, w * 1.1], [0, w * 1.1]], { segments: 24 }));
  return { rim: mergeGeometries(parts.map(plain)), hub };
}

/**
 * Profilé extrudé le long d'un tracé au sol : `profile` est une suite de points
 * [décalage latéral, hauteur] (décalage vers la gauche du sens de marche, hauteur
 * absolue), parcourue dans le sens qui laisse la matière à droite (normales vers
 * l'extérieur). Normales franches d'un segment du profil à l'autre, lisses le long du tracé.
 */
export function extrude(path, profile, { closed = false } = {}) {
  const n = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    return [dz / l, -dx / l];
  });
  const prof = closed ? [...profile, profile[0]] : profile;
  const pos = [];
  const nor = [];
  for (let j = 0; j < prof.length - 1; j++) {
    const [la, ya] = prof[j];
    const [lb, yb] = prof[j + 1];
    const l = Math.hypot(lb - la, yb - ya);
    if (l < 1e-9) continue;
    const sn = [(yb - ya) / l, -(lb - la) / l]; // [latéral, vertical]
    for (let i = 0; i < path.length - 1; i++) {
      const V = (k, lat, y) => [path[k][0] + n[k][0] * lat, y, path[k][2] + n[k][1] * lat];
      const N = (k) => [n[k][0] * sn[0], sn[1], n[k][1] * sn[0]];
      const A0 = V(i, la, ya);
      const B0 = V(i, lb, yb);
      const A1 = V(i + 1, la, ya);
      const B1 = V(i + 1, lb, yb);
      pos.push(...A0, ...B0, ...A1, ...A1, ...B0, ...B1);
      nor.push(...N(i), ...N(i), ...N(i + 1), ...N(i + 1), ...N(i), ...N(i + 1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Profil miroir (côté droit → côté gauche), parcouru dans le bon sens. */
export const mirror = (profile) => profile.map(([l, y]) => [-l, y]).reverse();

/**
 * Bande courbe (courroie enroulée sur une poulie) : arc de rayon R autour d'un axe
 * parallèle à x passant par (y, z), de l'angle a0 à a1 (angle a : point (y + R cos a,
 * z + R sin a)), de largeur w.
 */
export function arcBand(x, cy, cz, R, a0, a1, w, segments = 24) {
  const pos = [];
  const nor = [];
  const uv = [];
  for (let k = 0; k < segments; k++) {
    const t0 = a0 + ((a1 - a0) * k) / segments;
    const t1 = a0 + ((a1 - a0) * (k + 1)) / segments;
    const P = (side, t) => [x + side * w, cy + R * Math.cos(t), cz + R * Math.sin(t)];
    const N = (t) => [0, Math.cos(t), Math.sin(t)];
    pos.push(...P(-1, t0), ...P(1, t0), ...P(-1, t1), ...P(-1, t1), ...P(1, t0), ...P(1, t1));
    nor.push(...N(t0), ...N(t0), ...N(t1), ...N(t1), ...N(t0), ...N(t1));
    const u0 = (R * (t0 - a0)) / 0.5;
    const u1 = (R * (t1 - a0)) / 0.5;
    uv.push(u0, 0, u0, 1, u1, 0, u1, 0, u0, 1, u1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/**
 * Courroie ouverte entre deux poulies d'axes parallèles à x, dans le plan x : deux brins
 * tangents et les arcs d'enroulement. c1, c2 : centres [y, z].
 */
export function beltLoop(x, c1, r1, c2, r2, w) {
  const dy = c2[0] - c1[0];
  const dz = c2[1] - c1[1];
  const D = Math.hypot(dy, dz);
  const phi = Math.atan2(dz, dy);
  const alpha = Math.acos(Math.max(-1, Math.min(1, (r1 - r2) / D)));
  const parts = [arcBand(x, c1[0], c1[1], r1, phi + alpha, phi - alpha + Math.PI * 2, w), arcBand(x, c2[0], c2[1], r2, phi - alpha, phi + alpha, w, 12)];
  for (const sgn of [1, -1]) {
    const a = phi + sgn * alpha;
    const P = [c1[0] + r1 * Math.cos(a), c1[1] + r1 * Math.sin(a)];
    const Q = [c2[0] + r2 * Math.cos(a), c2[1] + r2 * Math.sin(a)];
    const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
    const nrm = [0, Math.cos(a), Math.sin(a)];
    const g = new THREE.BufferGeometry();
    const v = (side, p) => [x + side * w, p[0], p[1]];
    g.setAttribute('position', new THREE.Float32BufferAttribute([...v(-1, P), ...v(1, P), ...v(-1, Q), ...v(-1, Q), ...v(1, P), ...v(1, Q)], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([...nrm, ...nrm, ...nrm, ...nrm, ...nrm, ...nrm], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, len / 0.5, 0, len / 0.5, 0, 0, 1, len / 0.5, 1], 2));
    parts.push(g);
  }
  return mergeGeometries(parts);
}
