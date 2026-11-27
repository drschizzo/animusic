import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lineBalls, gateOpening, lastPainted, engineLoad } from './trunks.js';
import { BallPool } from './ballPool.js';
import { mat } from './materials.js';
import { lowerBound, upperBound } from './util.js';

/** Tuyau balayé le long d'une polyligne (repères transportés de proche en proche, sans vrille). */
export function sweepGeometry(points, radius, sides = 12) {
  const pos = [];
  const idx = [];
  const P = points.map((p) => new THREE.Vector3(...p));
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const q = new THREE.Quaternion();
  P.forEach((p, i) => {
    T.subVectors(P[Math.min(P.length - 1, i + 1)], P[Math.max(0, i - 1)]).normalize();
    if (i === 0) N.set(Math.abs(T.y) > 0.9 ? 1 : 0, Math.abs(T.y) > 0.9 ? 0 : 1, 0).addScaledVector(T, -N.dot(T)).normalize();
    else N.applyQuaternion(q.setFromUnitVectors(prev, T)).addScaledVector(T, -N.dot(T)).normalize();
    prev.copy(T);
    B.crossVectors(T, N);
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const c = Math.cos(a) * radius;
      const s = Math.sin(a) * radius;
      pos.push(p.x + N.x * c + B.x * s, p.y + N.y * c + B.y * s, p.z + N.z * c + B.z * s);
      if (i > 0 && k > 0) {
        const r0 = (i - 1) * (sides + 1);
        const r1 = i * (sides + 1);
        idx.push(r0 + k - 1, r0 + k, r1 + k - 1, r0 + k, r1 + k, r1 + k - 1);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Normale horizontale (à gauche du sens de marche) en chaque point d'une polyligne au sol. */
function sideNormals(points) {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    return [dz / l, -dx / l];
  });
}

/**
 * Bande horizontale de demi-largeur w le long d'une polyligne (abscisse curviligne en u,
 * en périodes de la texture), ou paroi verticale décalée de `offset`, de y0 à y1.
 */
function strip(points, { w = 0, offset = 0, y0 = 0, y1 = 0, period = 1, vertical = false }) {
  const n = sideNormals(points);
  const pos = [];
  const uv = [];
  const idx = [];
  let s = 0;
  points.forEach((p, i) => {
    if (i) s += Math.hypot(p[0] - points[i - 1][0], p[2] - points[i - 1][2]);
    const [nx, nz] = n[i];
    if (vertical) {
      const x = p[0] + nx * offset;
      const z = p[2] + nz * offset;
      pos.push(x, y0, z, x, y1, z);
    } else pos.push(p[0] + nx * w, p[1], p[2] + nz * w, p[0] - nx * w, p[1], p[2] - nz * w);
    uv.push(s / period, 0, s / period, 1);
    if (i) {
      const a = 2 * (i - 1);
      const b = 2 * i;
      // Faces tournées vers le haut (bande) ou vers l'extérieur (paroi).
      if (!vertical || offset > 0) idx.push(a, a + 1, b, a + 1, b + 1, b);
      else idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Texture de bande transporteuse : caoutchouc noir, nervures en chevrons. */
function beltTexture() {
  const W = 64;
  const H = 32;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // Chevron : la nervure avance au milieu de la bande.
      const u = (x + Math.abs(y - H / 2) * 0.9) % (W / 2);
      const rib = u < 4 ? 1 : 0;
      const edge = y < 2 || y >= H - 2;
      const v = edge ? 46 : rib ? 58 : 20 + ((x * 7 + y * 13) % 5);
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = v;
      data[i + 2] = v + 3;
      data[i + 3] = 255;
    }
  const t = new THREE.DataTexture(data, W, H);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const BELT_PERIOD = 0.12; // longueur de bande couverte par la texture (deux chevrons)
const RAW = new THREE.Color(0.3, 0.31, 0.34); // bille brute, pas encore peinte

/** Pièce posée à l'abscisse s d'une ligne : repère (x = travers, y = haut, z = sens de marche). */
function frameAt(path, s, y = 0) {
  const p = path.pointAt(s);
  const d = path.tangentAt(s);
  const m = new THREE.Matrix4();
  const z = new THREE.Vector3(d[0], 0, d[2]).normalize();
  const x = new THREE.Vector3(z.z, 0, -z.x);
  m.makeBasis(x, new THREE.Vector3(0, 1, 0), z).setPosition(p[0], y, p[2]);
  return m;
}

/**
 * Rendu du réseau (voir trunks.js) : les tapis roulants posés au sol, leurs capots
 * (distributeur, retour, chute), les cabines de peinture, les portes d'échappement, et
 * les billes qui y roulent ou montent dans les colonnes des instruments (les colonnes
 * elles-mêmes sont dessinées par chaque rangée).
 */
export class TrunksView {
  constructor(trunks, trackColors, content) {
    this.trunks = trunks;
    this.trackColors = trackColors;
    const o = trunks.options;
    const g = (this.group = new THREE.Group());
    g.name = 'réseau';
    content.add(g);
    // Pièces fixes de toutes les lignes, regroupées par matériau puis fusionnées.
    const parts = { dark: [], chrome: [], steel: [], belt: [] };
    const put = (bucket, geometry, matrix) => {
      if (matrix) geometry.applyMatrix4(matrix);
      parts[bucket].push(geometry);
    };
    const W = o.radius; // demi-largeur du bâti
    const top = o.beltY;
    const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const hoodLen = 0.14;
    const hoodH = 0.12;
    /** Capot en tunnel au-dessus de la bande, ouvert dans le sens de marche. */
    const hood = (path, s, { feeder = false } = {}) => {
      const m = frameAt(path, s);
      const wall = 0.012;
      put('dark', box(wall, hoodH, hoodLen, W + 0.002, top + hoodH / 2 - 0.02, 0), m);
      put('dark', box(wall, hoodH, hoodLen, -W - 0.002, top + hoodH / 2 - 0.02, 0), m);
      put('dark', box(2 * W + 0.016, 0.014, hoodLen + 0.01, 0, top + hoodH - 0.02, 0), m);
      put('chrome', box(2 * W + 0.02, 0.006, 0.01, 0, top + hoodH - 0.012, hoodLen / 2 + 0.005), m);
      put('chrome', box(2 * W + 0.02, 0.006, 0.01, 0, top + hoodH - 0.012, -hoodLen / 2 - 0.005), m);
      if (feeder) {
        // Colonne d'arrivée des billes brutes, coiffée d'un entonnoir.
        put('steel', new THREE.CylinderGeometry(0.028, 0.028, 0.34, 14).translate(0, top + hoodH + 0.16, 0), m);
        put('chrome', new THREE.CylinderGeometry(0.07, 0.03, 0.08, 18, 1, true).translate(0, top + hoodH + 0.37, 0), m);
      }
    };
    this.lines = trunks.lines.map((line) => {
      const path = line.maze;
      const pts = path.points;
      // Bande et bâti : parois latérales, lèvres chromées, pieds.
      put('belt', strip(pts, { w: o.beltWidth / 2, period: BELT_PERIOD }));
      for (const side of [1, -1]) {
        put('dark', strip(pts, { offset: side * W, y0: 0.035, y1: top + 0.012, vertical: true }));
        const n = sideNormals(pts);
        put('chrome', sweepGeometry(pts.map((p, i) => [p[0] + n[i][0] * side * (W - 0.007), top + 0.014, p[2] + n[i][1] * side * (W - 0.007)]), 0.0075, 8));
      }
      for (let s = 0.3; s < path.length - 0.2; s += 0.9) put('dark', box(2 * W + 0.03, 0.035, 0.05, 0, 0.0175, 0), frameAt(path, s));
      // Rouleaux d'extrémité.
      for (const s of [0, path.length]) put('steel', new THREE.CylinderGeometry(0.022, 0.022, 2 * W - 0.004, 16).rotateZ(Math.PI / 2).translate(0, top - 0.022, 0), frameAt(path, s));
      const view = { line, path };
      if (line.kind === 'feed') {
        hood(path, 0, { feeder: true });
        hood(path, path.length + 0.02);
        // Cabine de peinture : parois à hublot lumineux, toit portant les pots des couleurs de la ligne.
        const m = frameAt(path, line.paintAt);
        const L = o.paintLength;
        const H = 0.22;
        for (const side of [1, -1]) put('dark', box(0.014, H, L, side * (W + 0.006), top + H / 2 - 0.03, 0), m);
        put('dark', box(2 * W + 0.04, 0.02, L + 0.02, 0, top + H - 0.02, 0), m);
        put('chrome', box(2 * W + 0.044, 0.008, 0.012, 0, top + H - 0.03, L / 2), m);
        put('chrome', box(2 * W + 0.044, 0.008, 0.012, 0, top + H - 0.03, -L / 2), m);
        put('steel', new THREE.CylinderGeometry(0.012, 0.012, 0.06, 10).translate(0, top + H - 0.06, 0), m);
        const tracks = [...new Set(line.balls.map((b) => b.track))].slice(0, 3);
        tracks.forEach((track, k) => {
          const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.06, 16), mat.glow(this.trackColors[track], 0.6));
          pot.applyMatrix4(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, top + H + 0.03, (k - (tracks.length - 1) / 2) * 0.07)));
          pot.castShadow = true;
          g.add(pot);
          put('chrome', new THREE.CylinderGeometry(0.029, 0.029, 0.008, 16).translate(0, top + H + 0.064, (k - (tracks.length - 1) / 2) * 0.07), m);
        });
        // Hublots : ils prennent la couleur de la bille qu'on peint et s'éteignent doucement.
        const lamp = mat.glow(0xffffff, 0);
        for (const side of [1, -1]) {
          const win = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.6, H * 0.45), lamp);
          win.applyMatrix4(m.clone().multiply(new THREE.Matrix4().makeRotationY((side * Math.PI) / 2).setPosition(side * (W + 0.0135), top + 0.07, 0)));
          g.add(win);
        }
        view.lamp = lamp;
        // Porte d'échappement : un cliquet suspendu à une potence, en travers de la bande.
        const G = line.gateAt + line.ballRadius + 0.006;
        const gm = frameAt(path, G);
        put('dark', box(0.02, 0.11, 0.02, W + 0.012, top + 0.055, 0), gm);
        put('dark', box(2 * W + 0.04, 0.016, 0.02, 0, top + 0.11, 0), gm);
        const hinge = new THREE.Group();
        const [hx, , hz] = path.pointAt(G);
        const hd = path.tangentAt(G);
        hinge.position.set(hx, top + 0.1, hz);
        hinge.rotation.set(0, Math.atan2(hd[0], hd[2]), 0, 'YXZ');
        const flap = new THREE.Mesh(new THREE.BoxGeometry(o.beltWidth * 0.9, 0.08, 0.01), mat.brass());
        flap.position.y = -0.045;
        flap.castShadow = true;
        hinge.add(flap);
        g.add(hinge);
        view.hinge = hinge;
      } else {
        hood(path, 0);
        hood(path, path.length + 0.02);
      }
      // Réservoir : le plus grand nombre de billes en vie à la fois sur la ligne.
      const life = line.before + line.after;
      let most = 0;
      for (let i = 0, j = 0; i < line.balls.length; i++) {
        while (line.balls[i].time - line.balls[j].time > life) j++;
        most = Math.max(most, i - j + 1);
      }
      view.pool = new BallPool(g, line.ballRadius, most + 2);
      view.pool.trails.visible = false; // pas de traînée sur un tapis
      return view;
    });
    const merged = (list, material, name) => {
      if (!list.length) return null;
      const geos = list.map((x) => {
        const y = x.index ? x.toNonIndexed() : x;
        if (material !== this.beltMat) y.deleteAttribute('uv');
        return y;
      });
      const mesh = new THREE.Mesh(mergeGeometries(geos), material);
      mesh.name = name;
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    this.beltTex = beltTexture();
    this.beltMat = new THREE.MeshStandardMaterial({ map: this.beltTex, roughness: 0.8, metalness: 0 });
    merged(parts.belt, this.beltMat, 'bandes');
    merged(parts.dark, mat.gunmetal(), 'bâtis');
    merged(parts.chrome, mat.chrome(), 'garnitures');
    merged(parts.steel, mat.steel(), 'rouleaux');
    this.pools = this.lines.map((l) => l.pool);
    if (trunks.engine) this.buildEngine(trunks.engine);
  }

  /**
   * Salle des machines (voir placeEngine, trunks.js) : arbre de transmission sur deux
   * chevalets, une poulie et une courroie par tapis, et au bout la machine à vapeur :
   * volant, manivelle, bielle, crosse sur ses glissières, cylindre et régulateur à boules.
   */
  buildEngine(e) {
    const g = new THREE.Group();
    g.name = 'machine';
    this.group.add(g);
    const dark = mat.gunmetal();
    const steel = mat.steel();
    const chrome = mat.chrome();
    const brass = mat.brass();
    const fixed = { dark: [], steel: [], chrome: [], brass: [] };
    const turning = { dark: [], steel: [], brass: [] };
    const cyl = (r, len, segs = 18) => new THREE.CylinderGeometry(r, r, len, segs);
    const alongX = (geo) => geo.rotateZ(Math.PI / 2);
    const alongZ = (geo) => geo.rotateX(Math.PI / 2);
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const bar = (a, b, r, bucket, list = fixed) => {
      const A = new THREE.Vector3(...a);
      const B = new THREE.Vector3(...b);
      const geo = cyl(r, A.distanceTo(B), 10).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
      list[bucket].push(geo.translate(...A.clone().add(B).multiplyScalar(0.5).toArray()));
    };
    const { y, z, side, dir } = e;
    const u = (k) => e.xe + side * k; // abscisse à la distance k du bout de l'arbre, côté machine
    const steam = e.kind === 'steam';
    const x0 = Math.min(e.xa - 0.05, steam ? u(0.5) : Infinity);
    const x1 = Math.max(e.xb + 0.05, steam ? u(0.5) : -Infinity);
    // Arbre et chevalets.
    fixed.chrome.push(alongX(cyl(0.018, x1 - x0, 14)).translate((x0 + x1) / 2, y, z));
    for (const x of e.supports) {
      for (const s of [-1, 1]) bar([x, 0.02, z + s * 0.16], [x, y - 0.03, z], 0.016, 'dark');
      fixed.dark.push(box(0.07, 0.07, 0.09).translate(x, y, z), box(0.05, 0.02, 0.4).translate(x, 0.01, z));
    }
    // Rotor : tout ce qui tourne avec l'arbre, fusionné, tourné d'un bloc autour de l'axe x.
    const rotor = new THREE.Group();
    rotor.position.set(0, y, z);
    // Poulies et courroies vers la tête de chaque tapis.
    const leather = new THREE.MeshStandardMaterial({ map: this.beltTex, roughness: 0.7, side: THREE.DoubleSide, color: 0x9a6a48 });
    const belts = [];
    const r1 = 0.09;
    const r2 = 0.03;
    const top = this.trunks.options.beltY;
    for (const { line, path } of this.lines) {
      const hub = line.kind === 'feed' ? path.pointAt(0) : path.pointAt(path.length);
      if (Math.abs(hub[2] - e.z0) > 0.05) continue;
      const x = hub[0] + this.trunks.options.radius + 0.025;
      turning.steel.push(alongX(cyl(r1, 0.024, 28)).translate(x, 0, 0));
      turning.dark.push(box(0.028, 2 * r1 - 0.02, 0.022).translate(x, 0, 0), box(0.028, 0.022, 2 * r1 - 0.02).translate(x, 0, 0));
      const c2 = [top - 0.022, hub[2]]; // axe du rouleau de tête (y, z)
      fixed.steel.push(alongX(cyl(r2, 0.016, 18)).translate(x, c2[0], c2[1]));
      // Brins de la courroie : tangentes extérieures aux deux poulies.
      const dy = c2[0] - y;
      const dz = c2[1] - z;
      const D = Math.hypot(dy, dz);
      const phi = Math.atan2(dz, dy);
      const alpha = Math.acos((r1 - r2) / D);
      for (const sgn of [1, -1]) {
        const a = phi + sgn * alpha;
        const P = [y + r1 * Math.cos(a), z + r1 * Math.sin(a)];
        const Q = [c2[0] + r2 * Math.cos(a), c2[1] + r2 * Math.sin(a)];
        const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
        const geo = new THREE.BufferGeometry();
        const w = 0.009;
        geo.setAttribute('position', new THREE.Float32BufferAttribute([x - w, P[0], P[1], x + w, P[0], P[1], x - w, Q[0], Q[1], x + w, Q[0], Q[1]], 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, len / BELT_PERIOD, 0, len / BELT_PERIOD, 1], 2));
        geo.setIndex([0, 2, 1, 1, 2, 3]);
        geo.computeVertexNormals();
        belts.push(geo);
      }
    }
    if (belts.length) {
      const m = new THREE.Mesh(mergeGeometries(belts), leather);
      m.name = 'courroies';
      g.add(m);
    }
    const rc = 0.1; // rayon de manivelle
    const zz = (k) => z + dir * k; // le long du cylindre
    const govBase = y + 0.165;
    const govTop = govBase + 0.32;
    if (steam) {
      // Volant : jante, moyeu, six bras.
      const R = 0.3;
      turning.dark.push(new THREE.TorusGeometry(R, 0.035, 10, 48).rotateY(Math.PI / 2).translate(u(0.16), 0, 0));
      turning.steel.push(alongX(cyl(0.05, 0.08, 18)).translate(u(0.16), 0, 0));
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        turning.dark.push(box(0.025, R - 0.04, 0.03).translate(0, (R - 0.04) / 2 + 0.03, 0).rotateX(a).translate(u(0.16), 0, 0));
      }
      // Manivelle : plateau et maneton.
      turning.brass.push(alongX(cyl(0.13, 0.03, 24)).translate(u(0.32), 0, 0));
      turning.steel.push(alongX(cyl(0.016, 0.06, 10)).translate(u(0.36), rc, 0));
      // Palier extérieur.
      fixed.dark.push(box(0.06, y, 0.1).translate(u(0.46), y / 2, z), box(0.12, 0.02, 0.22).translate(u(0.46), 0.01, z));
      // Glissières, cylindre, socle.
      for (const s of [-1, 1]) bar([u(0.36), y + s * 0.05, zz(0.26)], [u(0.36), y + s * 0.05, zz(0.64)], 0.01, 'chrome');
      for (const k of [0.27, 0.63]) fixed.dark.push(box(0.05, y - 0.04, 0.03).translate(u(0.36), (y - 0.04) / 2, zz(k)));
      fixed.brass.push(alongZ(cyl(0.1, 0.36, 28)).translate(u(0.36), y, zz(0.84)));
      for (const k of [0.66, 1.02]) fixed.chrome.push(alongZ(cyl(0.112, 0.02, 28)).translate(u(0.36), y, zz(k)));
      fixed.dark.push(box(0.16, y - 0.1, 0.42).translate(u(0.36), (y - 0.1) / 2, zz(0.84)));
      fixed.dark.push(box(0.08, 0.07, 0.2).translate(u(0.36), y + 0.13, zz(0.84))); // boîte à vapeur
      // Régulateur à boules, sur la boîte à vapeur.
      bar([u(0.36), govBase, zz(0.84)], [u(0.36), govTop, zz(0.84)], 0.008, 'chrome');
    } else {
      // Moteur électrique posé au sol devant l'arbre : carter à ailettes, poulie, courroie montante.
      const [mx, mz] = e.motor;
      const my = 0.13;
      fixed.dark.push(alongX(cyl(0.075, 0.2, 24)).translate(mx, my, mz), box(0.16, 0.06, 0.14).translate(mx, 0.03, mz));
      for (let k = 0; k < 10; k++) fixed.dark.push(box(0.18, 0.012, 0.02).translate(0, 0.08, 0).rotateX((k / 10) * Math.PI * 2).translate(mx, my, mz));
      fixed.chrome.push(alongX(cyl(0.05, 0.21, 24)).translate(mx, my, mz));
      const px = mx + 0.12;
      fixed.steel.push(alongX(cyl(0.012, 0.05, 10)).translate(px - 0.015, my, mz));
      const motorPulley = new THREE.Group();
      motorPulley.position.set(px, my, mz);
      const mp = new THREE.Mesh(alongX(cyl(0.04, 0.02, 20)), steel);
      const mark = new THREE.Mesh(box(0.024, 0.07, 0.014), dark);
      motorPulley.add(mp, mark);
      g.add(motorPulley);
      this._motorPulley = motorPulley;
      turning.steel.push(alongX(cyl(0.08, 0.02, 24)).translate(px, 0, 0));
      turning.dark.push(box(0.024, 0.15, 0.014).translate(px, 0, 0));
      const w = 0.008;
      for (const s of [-1, 1]) {
        const P = [y, z + s * 0.08];
        const Q = [my, mz + s * 0.04];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([px - w, P[0], P[1], px + w, P[0], P[1], px - w, Q[0], Q[1], px + w, Q[0], Q[1]], 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 2, 0, 2, 1], 2));
        geo.setIndex([0, 2, 1, 1, 2, 3]);
        geo.computeVertexNormals();
        const strap = new THREE.Mesh(geo, leather);
        g.add(strap);
      }
    }
    const merge = (list, material, parent, name) => {
      if (!list.length) return;
      const mesh = new THREE.Mesh(mergeGeometries(list.map((x) => (x.index ? x.toNonIndexed() : x)).map((x) => (x.deleteAttribute('uv'), x))), material);
      mesh.name = name;
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
    };
    merge(fixed.dark, dark, g, 'machine');
    merge(fixed.steel, steel, g, 'poulies de tête');
    merge(fixed.chrome, chrome, g, 'arbre');
    merge(fixed.brass, brass, g, 'cylindre');
    // Le rotor est centré sur l'axe : ses pièces ont été posées en (x, 0, 0) relatif.
    merge(turning.dark, dark, rotor, 'volant');
    merge(turning.steel, steel, rotor, 'poulies');
    merge(turning.brass, brass, rotor, 'manivelle');
    g.add(rotor);
    if (!steam) {
      this.engine = { e, rotor, motorPulley: this._motorPulley };
      return;
    }
    // Bielle et crosse (avec sa tige de piston), posées à chaque image.
    const rod = new THREE.Mesh(cyl(0.018, 1, 10), steel);
    rod.castShadow = true;
    const slider = new THREE.Group();
    const head = new THREE.Mesh(box(0.06, 0.08, 0.07), chrome);
    const stem = new THREE.Mesh(alongZ(cyl(0.012, 0.4, 10)).translate(0, 0, dir * 0.2), chrome);
    slider.add(head, stem);
    g.add(rod, slider);
    // Régulateur : deux bras pesants qui tournent, plus ou moins écartés.
    const spinner = new THREE.Group();
    spinner.position.set(u(0.36), govTop, zz(0.84));
    const arms = [1, -1].map((s) => {
      const pivot = new THREE.Group();
      const arm = new THREE.Mesh(cyl(0.006, 0.16, 8).translate(0, -0.08, 0), chrome);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.032, 18, 12), brass);
      ball.position.y = -0.16;
      ball.castShadow = true;
      pivot.add(arm, ball);
      pivot.userData.side = s;
      spinner.add(pivot);
      return pivot;
    });
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), brass);
    spinner.add(cap);
    g.add(spinner);
    this.engine = { e, rotor, rod, slider, spinner, arms, rc, L: 0.42, x: u(0.36) };
    this.updateEngine(0); // pose de repos
  }

  updateEngine(t) {
    const en = this.engine;
    const { e } = en;
    const o = this.trunks.options;
    const theta = (2 * Math.PI * o.shaftSpin * t) % (2 * Math.PI);
    en.rotor.rotation.x = theta;
    if (en.motorPulley) en.motorPulley.rotation.x = 2 * theta;
    if (!en.rod) return;
    // Maneton après rotation de θ autour de x : (0, rc cos θ, rc sin θ) autour de l'axe.
    const py = e.y + en.rc * Math.cos(theta);
    const pz = e.z + en.rc * Math.sin(theta);
    const cz = pz + e.dir * Math.sqrt(en.L * en.L - (py - e.y) ** 2);
    en.slider.position.set(en.x, e.y, cz);
    const a = new THREE.Vector3(en.x, py, pz);
    const b = new THREE.Vector3(en.x, e.y, cz);
    en.rod.position.copy(a).add(b).multiplyScalar(0.5);
    en.rod.scale.set(1, a.distanceTo(b), 1);
    en.rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    // Régulateur : il tourne, ses boules s'affaissent quand la machine peine.
    en.spinner.rotation.y = (2 * Math.PI * 1.5 * t) % (2 * Math.PI);
    const phi = 0.95 - 0.4 * Math.tanh(engineLoad(this.trunks, t) / 4);
    for (const arm of en.arms) arm.rotation.z = arm.userData.side * phi;
  }

  update(t) {
    const tr = this.trunks;
    // La bande défile : la texture glisse à la vitesse des tapis.
    this.beltTex.offset.x = -(((tr.options.speed * t) / BELT_PERIOD) % 1);
    if (this.engine) this.updateEngine(t);
    for (const view of this.lines) {
      const { line, pool } = view;
      pool.begin();
      if (line.balls.length) {
        const first = lowerBound(line.balls, t - line.after, (b) => b.time);
        if (first < line.balls.length && upperBound(line.balls, t + line.before, (b) => b.time) > first)
          lineBalls(tr, line, t, (ball, p, v, painted) => pool.add(p, v, painted ? this.trackColors[ball.track] : RAW));
      }
      pool.end();
      if (view.hinge) view.hinge.rotation.x = -1.25 * gateOpening(line, t);
      if (view.lamp) {
        const last = lastPainted(tr, line, t);
        if (last && last.since < 0.5) {
          view.lamp.emissive.copy(this.trackColors[last.ball.track]);
          view.lamp.emissiveIntensity = 3 * Math.exp(-last.since * 8);
        } else view.lamp.emissiveIntensity = 0;
      }
    }
  }
}
