import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lineBalls, gateOpening, lastPainted } from './trunks.js';
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
  }

  update(t) {
    const tr = this.trunks;
    // La bande défile : la texture glisse à la vitesse des tapis.
    this.beltTex.offset.x = -(((tr.options.speed * t) / BELT_PERIOD) % 1);
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
