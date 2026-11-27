import * as THREE from 'three';
import { lineBalls, gateOpening, lastPainted, engineLoad, stackBalls, airPressure } from './trunks.js';
import { BallPool } from './ballPool.js';
import { mat } from './materials.js';
import { lowerBound, upperBound, drain } from './util.js';
import { Kit, turn, cylinder, ring, rbox, nut, boltCircle, toX, toZ, between, rod, pillowBlock, spokedPulley, extrude, mirror, beltLoop } from './machineKit.js';

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

/** Polyligne à coude adouci (quelques points intermédiaires de part et d'autre du coude). */
function fillet3([a, b, c], k0 = 0.05) {
  const lerp = (p, q, f) => p.map((v, i) => v + (q[i] - v) * f);
  const ab = Math.hypot(...b.map((v, i) => v - a[i]));
  const bc = Math.hypot(...c.map((v, i) => v - b[i]));
  const k = Math.min(k0, ab / 3, bc / 3);
  const p0 = lerp(b, a, k / ab);
  const p2 = lerp(b, c, k / bc);
  const out = [a];
  for (let i = 0; i <= 6; i++) {
    const f = i / 6;
    out.push(lerp(lerp(p0, b, f), lerp(b, p2, f), f));
  }
  out.push(c);
  return out;
}

/** Bande horizontale de demi-largeur w le long d'une polyligne (abscisse curviligne en u, en périodes de texture). */
function strip(points, w, period) {
  const pos = [];
  const uv = [];
  const idx = [];
  let s = 0;
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    const [nx, nz] = [(b[2] - a[2]) / l, -(b[0] - a[0]) / l];
    if (i) s += Math.hypot(p[0] - points[i - 1][0], p[2] - points[i - 1][2]);
    pos.push(p[0] + nx * w, p[1], p[2] + nz * w, p[0] - nx * w, p[1], p[2] - nz * w);
    uv.push(s / period, 0, s / period, 1);
    if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Texture répétée le long de u, calculée pixel par pixel : f(x, y) → [r, g, b]. */
function dataTexture(W, H, f) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      [data[i], data[i + 1], data[i + 2]] = f(x, y);
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

/** Bande transporteuse : caoutchouc noir, nervures en chevrons, bords lisses. */
const beltTexture = () =>
  dataTexture(64, 32, (x, y) => {
    const u = (x + Math.abs(y - 16) * 0.9) % 32;
    const rib = u < 4 ? 1 : 0;
    const edge = y < 3 || y >= 29;
    const v = edge ? 30 : rib ? 52 : 17 + ((x * 7 + y * 13) % 4);
    return [v, v, v + 2];
  });

/** Courroie de cuir : fauve, bords plus sombres, une agrafe de jonction par tour. */
const leatherTexture = () =>
  dataTexture(64, 8, (x, y) => {
    const edge = y === 0 || y === 7;
    const lace = x < 3 && y > 1 && y < 6;
    const k = lace ? 0.55 : edge ? 0.7 : 1 - ((x * 13 + y * 7) % 5) * 0.02;
    return [Math.round(122 * k), Math.round(78 * k), Math.round(46 * k)];
  });

const SPARKS = 14; // étincelles par passage sous une meule
const SPARK_COLOR = new THREE.Color(4, 1.6, 0.35);

/** Pseudo-aléatoire déterministe (0..1). */
const hash = (a, b) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const BELT_PERIOD = 0.12; // longueur de bande couverte par la texture (deux chevrons)
const RAW = new THREE.Color(0.3, 0.31, 0.34); // bille brute, pas encore peinte
const ZERO = [0, 0, 0];
const Y = new THREE.Vector3(0, 1, 0);

/** Repère posé à l'abscisse s d'une ligne : x = travers (à gauche du sens de marche), y = haut, z = sens de marche. */
function frameAt(path, s, y = 0) {
  const p = path.pointAt(s);
  const d = path.tangentAt(s);
  const m = new THREE.Matrix4();
  const z = new THREE.Vector3(d[0], 0, d[2]).normalize();
  const x = new THREE.Vector3(z.z, 0, -z.x);
  m.makeBasis(x, new THREE.Vector3(0, 1, 0), z).setPosition(p[0], y, p[2]);
  return m;
}

/** Pose un maillage cylindrique (axe y, longueur 1) entre deux points. */
function placeRod(mesh, a, b) {
  const d = new THREE.Vector3().subVectors(b, a);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.scale.set(1, Math.max(1e-4, d.length()), 1);
  mesh.quaternion.setFromUnitVectors(Y, d.normalize());
}

/** Coupe d'un capot en tunnel : parois droites, voûte en plein cintre, tôle d'épaisseur t. */
function archProfile(w, yb, yc, t = 0.004) {
  const out = [[w, yb], [w, yc]];
  for (let k = 1; k < 12; k++) out.push([w * Math.cos((k / 12) * Math.PI), yc + w * Math.sin((k / 12) * Math.PI)]);
  out.push([-w, yc], [-w, yb], [-w + t, yb], [-w + t, yc]);
  for (let k = 11; k > 0; k--) out.push([(w - t) * Math.cos((k / 12) * Math.PI), yc + (w - t) * Math.sin((k / 12) * Math.PI)]);
  out.push([w - t, yc], [w - t, yb]);
  return out;
}

/** Fond plein d'un capot (plaque en arc), dans le plan z = 0. */
function archPlate(w, yb, yc) {
  const shape = new THREE.Shape();
  shape.moveTo(-w, yb);
  shape.lineTo(w, yb);
  shape.lineTo(w, yc);
  shape.absarc(0, yc, w, 0, Math.PI, false);
  shape.lineTo(-w, yb);
  return new THREE.ExtrudeGeometry(shape, { depth: 0.005, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1, curveSegments: 16 }).translate(0, 0, -0.0025);
}

/**
 * Rendu du réseau (voir trunks.js) : les tapis roulants et leurs capots, les calibreuses,
 * les cabines de peinture, les portes d'échappement, les bacs de décapage, l'arbre de
 * transmission et la salle des machines, et les billes qui y circulent.
 */
export class TrunksView {
  constructor(trunks, trackColors, content) {
    drain(this.assemble(trunks, trackColors, content));
  }

  /** La même vue, construite par étapes (voir `sliced` dans util.js) : une ligne à la fois. */
  static *steps(trunks, trackColors, content) {
    const view = Object.create(TrunksView.prototype);
    yield* view.assemble(trunks, trackColors, content);
    return view;
  }

  *assemble(trunks, trackColors, content) {
    this.trunks = trunks;
    this.trackColors = trackColors;
    const o = trunks.options;
    const g = (this.group = new THREE.Group());
    g.name = 'réseau';
    content.add(g);
    this.beltTex = beltTexture();
    this.leatherTex = leatherTexture();
    const named = (m, name) => Object.assign(m, { name });
    const M = (this.M = {
      paint: named(mat.enamel(0x1f3a32), 'émail'),
      iron: named(mat.castIron(), 'fonte'),
      steel: named(mat.machined(), 'acier'),
      chrome: named(mat.chrome(), 'chrome'),
      brass: named(mat.brass(), 'laiton'),
      wood: named(mat.wood(0x7a4524), 'bois'),
      stone: named(new THREE.MeshStandardMaterial({ color: 0x8d877b, roughness: 0.95 }), 'meule'),
      belt: named(new THREE.MeshStandardMaterial({ map: this.beltTex, roughness: 0.78, metalness: 0 }), 'bande'),
      leather: named(new THREE.MeshStandardMaterial({ map: this.leatherTex, roughness: 0.62, side: THREE.DoubleSide }), 'cuir'),
      glass: named(mat.glass(), 'verre'),
    });
    const kit = (this.kit = new Kit());
    const W = o.radius; // demi-largeur du bâti
    const top = o.beltY;
    this.screws = [];
    this.grinders = [];
    this.recyclers = [];
    this.spinners = []; // poulies et rouleaux qui tournent : { group, speed } (rad/s autour de x local)
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();

    // Coupe d'un longeron (côté gauche) : caisson à lèvre qui recouvre le bord de la bande.
    const CH = [[W - 0.012, 0.045], [W, 0.045], [W, top + 0.012], [W - 0.003, top + 0.018], [W - 0.018, top + 0.018], [W - 0.018, top + 0.006], [W - 0.012, top + 0.006], [W - 0.012, 0.045]];
    const hoodBase = top + 0.018;
    const hoodSpring = top + 0.07;
    /** Capot en tunnel sur la bande (tôle émaillée, bords roulés, boulons), fermé du côté `closed` (−1 amont, 1 aval, 0 ouvert). */
    const hood = (m, len = 0.14, closed = 0) => {
      const ends = [[0, 0, -len / 2], [0, 0, len / 2]];
      kit.add(M.paint, extrude(ends, archProfile(W, hoodBase, hoodSpring), { closed: true }), m);
      for (const s of [-1, 1]) {
        // Bord roulé à chaque bout.
        kit.add(M.paint, extrude([[0, 0, s * len / 2 - 0.006], [0, 0, s * len / 2 + 0.002]], archProfile(W + 0.003, hoodBase, hoodSpring, 0.007), { closed: true }), m);
        for (const z of [-len / 2 + 0.025, len / 2 - 0.025]) kit.add(M.steel, nut(0.0045).rotateZ((-s * Math.PI) / 2).translate(s * (W + 0.001), hoodBase + 0.01, z), m);
      }
      if (closed) kit.add(M.paint, archPlate(W, hoodBase, hoodSpring).translate(0, 0, closed * len / 2), m);
      return hoodSpring + W; // dessus de la voûte
    };

    const self = this;
    // Une ligne, par étapes : chaque machine du tapis est un morceau de travail.
    const buildLine = function* (line) {
      const path = line.maze;
      const pts = path.points;
      const view = { line, path };
      const L = path.length;
      // Bande, longerons, garde-billes chromés.
      kit.add(M.belt, strip(pts, o.beltWidth / 2, BELT_PERIOD));
      kit.add(M.paint, extrude(pts, CH));
      kit.add(M.paint, extrude(pts, mirror(CH)));
      for (const side of [1, -1]) {
        const rail = pts.map((p, i) => {
          const a = pts[Math.max(0, i - 1)];
          const b = pts[Math.min(pts.length - 1, i + 1)];
          const l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
          return [p[0] + ((b[2] - a[2]) / l) * side * (W - 0.011), top + 0.025, p[2] - ((b[0] - a[0]) / l) * side * (W - 0.011)];
        });
        kit.add(M.chrome, sweepGeometry(rail, 0.0045, 8));
      }
      yield;
      // Pieds : traverse, deux montants, patins réglables, sur les parties droites.
      for (let s = 0.45; s < L - 0.3; s += 1.1) {
        const a = path.tangentAt(s - 0.08);
        const b = path.tangentAt(s + 0.08);
        if (a[0] * b[0] + a[2] * b[2] < 0.999) continue;
        const m = frameAt(path, s);
        kit.add(M.iron, rbox(2 * W + 0.006, 0.012, 0.032, 0.004).translate(0, 0.039, 0), m);
        for (const side of [1, -1]) {
          kit.add(M.iron, rbox(0.014, 0.03, 0.024, 0.003).translate(side * (W - 0.006), 0.02, 0), m);
          kit.add(M.steel, cylinder(0.013, 0.006).translate(side * (W - 0.006), 0.003, 0), m);
        }
      }
      yield;
      // Bouts : flasques, rouleau, paliers de part et d'autre.
      for (const [s, dz] of [[0, -0.005], [L, 0.005]]) {
        const m = frameAt(path, s);
        for (const side of [1, -1]) {
          kit.add(M.paint, rbox(0.018, top - 0.03, 0.01, 0.003).translate(side * (W - 0.009), (top + 0.06) / 2, dz), m);
          kit.add(M.iron, toX(ring(0.016, 0.006, 0.012)).translate(side * (W + 0.006), top - 0.022, 0), m);
        }
        kit.add(M.steel, toX(cylinder(0.022, 2 * W - 0.026, 0.004, 24)).translate(0, top - 0.022, 0), m);
        kit.add(M.steel, toX(cylinder(0.006, 2 * W + 0.03)).translate(0, top - 0.022, 0), m);
      }
      yield;
      if (line.kind === 'feed') {
        // Distributeur : capot fermé à l'amont, collier, puis colonne de réserve (verre) ou trémie.
        const m0 = frameAt(path, 0);
        const roof = hood(m0, 0.14, -1);
        kit.add(M.iron, ring(0.045, 0.02, 0.016).translate(0, roof + 0.004, 0), m0);
        if (line.stock) {
          const R = line.ballRadius * o.rawScale + 0.012;
          const y0 = roof + 0.012;
          const y1 = o.stackTop + 0.03;
          const col = new THREE.Mesh(sweepGeometry([[0, y0, 0], [0, y1, 0]], R, 20), M.glass);
          col.applyMatrix4(m0);
          col.renderOrder = 2;
          col.name = 'colonne de réserve';
          g.add(col);
          kit.add(M.brass, ring(R + 0.01, R - 0.002, 0.014).translate(0, y0 + 0.007, 0), m0);
          kit.add(M.brass, ring(R + 0.01, R - 0.002, 0.014).translate(0, y1 - 0.004, 0), m0);
          kit.add(M.steel, boltCircle(4, R + 0.006, y0 + 0.014, 0.0035, Math.PI / 4), m0);
          // Tirants entre les deux brides : la colonne de verre est serrée, pas posée.
          for (let k = 0; k < 3; k++) {
            const a = (k / 3) * Math.PI * 2 + 0.5;
            kit.add(M.steel, rod([Math.cos(a) * (R + 0.007), y0 + 0.01, Math.sin(a) * (R + 0.007)], [Math.cos(a) * (R + 0.007), y1, Math.sin(a) * (R + 0.007)], 0.0022, 6), m0);
          }
        } else {
          // Trémie d'arrivée sur un fût d'acier.
          kit.add(M.paint, turn([[0.026, roof], [0.026, roof + 0.3], [0.07, roof + 0.37], [0.074, roof + 0.375], [0.074, roof + 0.385], [0.066, roof + 0.385], [0.062, roof + 0.375], [0.02, roof + 0.31]], { segments: 28 }), m0);
          kit.add(M.brass, ring(0.034, 0.026, 0.012).translate(0, roof + 0.02, 0), m0);
        }
        // Chute en bout de ligne.
        hood(frameAt(path, L + 0.02), 0.14, 1);
        yield;
        self.buildGrinder(line, path);
        yield;
        view.lamp = self.buildPaintBooth(line, path);
        yield;
        Object.assign(view, self.buildGate(line, path));
      } else {
        hood(frameAt(path, 0), 0.14, -1);
        if (line.recycle) self.buildRecycler(line);
        else hood(frameAt(path, L + 0.02), 0.14, 1);
      }
      yield;
      // Réservoir : le plus grand nombre de billes en vie à la fois sur la ligne.
      const life = line.before + line.after;
      let most = 0;
      for (let i = 0, j = 0; i < line.balls.length; i++) {
        while (line.balls[i].time - line.balls[j].time > life) j++;
        most = Math.max(most, i - j + 1);
      }
      view.pool = new BallPool(g, line.ballRadius, most + 2 + (line.stock?.slots ?? 0));
      view.pool.trails.visible = false; // pas de traînée sur un tapis
      return view;
    };
    this.lines = [];
    for (const line of trunks.lines) {
      this.lines.push(yield* buildLine(line));
      yield;
    }
    if (trunks.engine) this.buildEngine(trunks.engine);
    yield;
    kit.build(g, 'réseau');
    this.batchSpinners();
    yield;
    this.pools = this.lines.map((l) => l.pool);
    // Étincelles des calibreuses : de petits traits lumineux lancés en arrière, à chaque bille.
    if (this.grinders.length) {
      const sparks = (this.sparks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.005, 0.005, 1), mat.light(0xffffff), this.grinders.length * SPARKS));
      sparks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.grinders.length * SPARKS * 3), 3);
      sparks.frustumCulled = false;
      sparks.userData.fx = true;
      sparks.count = 0;
      g.add(sparks);
    }
    this.update(0); // pose de repos
  }

  /**
   * Poulies, rouleaux et meules identiques : un maillage instancié par forme et par
   * matière au lieu d'un maillage par pièce (un appel de rendu pour toutes). Chaque groupe
   * tournant ne garde que sa pose, recopiée dans son instance à chaque image.
   */
  batchSpinners() {
    const shape = (mesh) => {
      const p = mesh.geometry.attributes.position.array;
      let h = p.length;
      for (let i = 0; i < p.length; i += 13) h = (Math.imul(h, 31) + Math.round(p[i] * 1e4)) | 0;
      return `${mesh.material.uuid}|${p.length}|${h}`;
    };
    const kinds = new Map();
    for (const { group } of this.spinners)
      for (const mesh of group.children) {
        if (!mesh.isMesh) continue;
        const key = shape(mesh);
        if (!kinds.has(key)) kinds.set(key, []);
        kinds.get(key).push({ group, mesh });
      }
    this.spinBatches = [];
    for (const list of kinds.values()) {
      if (list.length < 2) continue;
      const { mesh } = list[0];
      const batch = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
      batch.name = mesh.name;
      batch.castShadow = mesh.castShadow;
      batch.receiveShadow = mesh.receiveShadow;
      batch.frustumCulled = false; // instances réparties sur tout le réseau
      batch.userData.unfold = true; // pièces solides : export glTF et collisions les déplient
      this.group.add(batch);
      for (const item of list) {
        item.mesh.removeFromParent();
        if (item.mesh !== mesh) item.mesh.geometry.dispose();
      }
      this.spinBatches.push({ batch, groups: list.map((item) => item.group) });
    }
  }

  /** Groupe tournant autour de son axe x local, posé par `matrix`, construit par `fill(kit)`. */
  spinner(matrix, speed, fill, name) {
    const grp = new THREE.Group();
    grp.name = name;
    matrix.decompose(grp.position, grp.quaternion, grp.scale);
    grp.userData.base = grp.quaternion.clone();
    const k = new Kit();
    fill(k);
    k.build(grp, name);
    this.group.add(grp);
    this.spinners.push({ group: grp, speed });
    return grp;
  }

  /**
   * Calibreuse : meule à axe transversal au-dessus de la bande, portée par deux flasques
   * boulonnées sur les longerons ; carter enveloppant ouvert en dessous ; moteur posé sur
   * le pont du carter, qui entraîne la meule par une courroie trapézoïdale.
   */
  buildGrinder(line, path) {
    const { kit, M } = this;
    const o = this.trunks.options;
    const W = o.radius;
    const top = o.beltY;
    const r = line.ballRadius;
    const m = frameAt(path, line.grindAt);
    const axis = top + 2 * r + 0.052;
    const plateTop = axis + 0.08;
    const motorY = plateTop + 0.016 + 0.028;
    for (const side of [1, -1]) {
      kit.add(M.paint, rbox(0.008, plateTop - (top - 0.03), 0.05, 0.003).translate(side * (W + 0.004), (plateTop + top - 0.03) / 2, 0), m);
      kit.add(M.iron, toX(ring(0.014, 0.004, 0.012)).translate(side * (W + 0.014), axis, 0), m);
      for (const y of [top - 0.015, top + 0.005]) kit.add(M.steel, nut(0.004).rotateZ((-side * Math.PI) / 2).translate(side * (W + 0.008), y, 0.014), m);
    }
    // Carter : coque cylindrique ouverte vers le bas, deux joues, pont qui porte le moteur.
    const a0 = -0.2 * Math.PI;
    const a1 = 1.2 * Math.PI;
    // Coque : point d'angle a en (y = sin a, z = cos a) autour de l'axe ; ouverte vers le bas.
    const guard = new THREE.CylinderGeometry(0.064, 0.064, 0.064, 28, 1, true, a0, a1 - a0);
    kit.add(M.paint, guard.rotateZ(Math.PI / 2).translate(0, axis, 0), m);
    for (const s of [-1, 1]) {
      const cheek = new THREE.CircleGeometry(0.066, 28, Math.PI / 2 - a1 + Math.PI / 2, a1 - a0).rotateY(Math.PI / 2);
      kit.add(M.paint, cheek.translate(s * 0.032, axis, 0), m);
    }
    kit.add(M.paint, rbox(2 * W + 0.018, 0.01, 0.05, 0.003).translate(0, plateTop + 0.005, 0), m);
    // Moteur : carcasse à ailettes, flasques, boîte à bornes.
    kit.add(M.paint, toX(cylinder(0.028, 0.07, 0.006)).translate(0, motorY, 0), m);
    for (let k = -2; k <= 2; k++) kit.add(M.paint, toX(ring(0.031, 0.027, 0.004, 0.001)).translate(k * 0.012, motorY, 0), m);
    for (const s of [-1, 1]) kit.add(M.iron, toX(cylinder(0.022, 0.008, 0.002)).translate(s * 0.039, motorY, 0), m);
    kit.add(M.iron, rbox(0.03, 0.016, 0.024, 0.003).translate(0, motorY + 0.034, 0), m);
    kit.add(M.iron, rbox(0.05, 0.006, 0.04, 0.002).translate(0, plateTop + 0.013, 0), m);
    // Courroie, dans le plan des poulies (dehors, côté gauche).
    const px = W + 0.026;
    kit.add(M.leather, beltLoop(px, [motorY, 0], 0.016, [axis, 0], 0.024, 0.004), m);
    // Meule (tournante) : grès, flasques, arbre, poulie ; poulie du moteur.
    const wheel = this.spinner(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, axis, 0)), -60, (k) => {
      k.add(M.stone, toX(cylinder(0.05, 0.04, 0.004, 36)));
      for (const s of [-1, 1]) k.add(M.steel, toX(cylinder(0.024, 0.006, 0.0015)).translate(s * 0.023, 0, 0));
      k.add(M.steel, toX(cylinder(0.005, 2 * W + 0.05)).translate(0.008, 0, 0));
      const p = spokedPulley(0.022, 0.01, { spokes: 3 });
      k.add(M.iron, p.rim.translate(px, 0, 0));
      k.add(M.steel, p.hub.translate(px, 0, 0));
      k.add(M.steel, nut(0.005).rotateZ(-Math.PI / 2).translate(px + 0.006, 0, 0));
    }, 'meule');
    this.spinner(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, motorY, 0)), -90, (k) => {
      k.add(M.steel, toX(cylinder(0.004, 0.03)).translate(px - 0.01, 0, 0));
      k.add(M.iron, toX(cylinder(0.016, 0.01, 0.002)).translate(px, 0, 0));
      k.add(M.steel, rbox(0.012, 0.004, 0.02, 0.001).translate(px + 0.006, 0, 0));
    }, 'poulie de la meule');
    this.grinders.push({ line, wheel, frame: m, contact: [0, top + 2 * r, 0] });
  }

  /**
   * Cabine de peinture : caisson émaillé à montants, toit portant les pots de couleur de la
   * ligne reliés par des tubes à vannes à une rampe, descente de la rampe vers la buse,
   * cheminée d'extraction ; hublots cerclés de laiton, éclairés à chaque bille peinte.
   */
  buildPaintBooth(line, path) {
    const { kit, M, group: g } = this;
    const o = this.trunks.options;
    const W = o.radius;
    const top = o.beltY;
    const m = frameAt(path, line.paintAt);
    const L = o.paintLength;
    const H = 0.24;
    const side0 = W + 0.012;
    for (const s of [1, -1]) {
      kit.add(M.paint, rbox(0.02, top + H - 0.03, L - 0.03, 0.006).translate(s * side0, (top + H + 0.03) / 2, 0), m);
      // Montants d'angle, plinthe, rivets.
      for (const z of [-L / 2 + 0.012, L / 2 - 0.012]) kit.add(M.iron, rbox(0.026, top + H - 0.02, 0.022, 0.005).translate(s * (side0 + 0.002), (top + H) / 2 + 0.005, z), m);
      kit.add(M.iron, rbox(0.026, 0.02, L, 0.004).translate(s * (side0 + 0.002), 0.035, 0), m);
      for (let k = 0; k < 6; k++) kit.add(M.steel, nut(0.0028, 0.002).rotateZ((-s * Math.PI) / 2).translate(s * (side0 + 0.0105), top + H - 0.03, -L / 2 + 0.045 + (k * (L - 0.09)) / 5), m);
      // Hublot : cadre de laiton, poignée de porte.
      const ww = L * 0.46;
      const wh = H * 0.36;
      const wy = top + 0.075;
      for (const [w, h, y, z] of [[ww + 0.014, 0.007, wy + wh / 2 + 0.0035, 0], [ww + 0.014, 0.007, wy - wh / 2 - 0.0035, 0], [0.007, wh, wy, ww / 2 + 0.0035], [0.007, wh, wy, -ww / 2 - 0.0035]])
        kit.add(M.brass, rbox(0.006, h, w === 0.007 ? 0.007 : w, 0.002).translate(s * (side0 + 0.011), y, z), m);
      kit.add(M.brass, rod([s * (side0 + 0.012), wy + 0.04, L / 2 - 0.05], [s * (side0 + 0.012), wy - 0.02, L / 2 - 0.05], 0.003, 8), m);
      kit.add(M.brass, rod([s * (side0 + 0.01), wy + 0.04, L / 2 - 0.05], [s * (side0 + 0.016), wy + 0.04, L / 2 - 0.05], 0.0025, 6), m);
      kit.add(M.brass, rod([s * (side0 + 0.01), wy - 0.02, L / 2 - 0.05], [s * (side0 + 0.016), wy - 0.02, L / 2 - 0.05], 0.0025, 6), m);
    }
    const roofY = top + H;
    kit.add(M.paint, rbox(2 * side0 + 0.03, 0.022, L + 0.016, 0.008).translate(0, roofY + 0.006, 0), m);
    // Linteaux des deux passages.
    for (const z of [-L / 2, L / 2]) kit.add(M.iron, rbox(2 * W + 0.004, 0.028, 0.02, 0.005).translate(0, roofY - 0.02, z), m);
    // Hublots lumineux (allumés à chaque bille peinte).
    const lamp = mat.glow(0xffffff, 0);
    for (const s of [1, -1]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.46, H * 0.36), lamp);
      win.applyMatrix4(m.clone().multiply(new THREE.Matrix4().makeRotationY((s * Math.PI) / 2).setPosition(s * (side0 + 0.0102), top + 0.075, 0)));
      g.add(win);
    }
    // Toit : pots (un par piste), rampe, vannes, descente vers la buse, cheminée.
    const roof = roofY + 0.017;
    const tracks = [...new Set(line.balls.map((b) => b.track))].slice(0, 3);
    const zs = tracks.map((_, k) => (k - (tracks.length - 1) / 2) * 0.065);
    tracks.forEach((track, k) => {
      const z = zs[k];
      kit.add(M.steel, turn([[0, roof], [0.022, roof], [0.024, roof + 0.003], [0.024, roof + 0.05], [0.021, roof + 0.054], [0.021, roof + 0.058], [0, roof + 0.058]], { segments: 24 }).translate(-0.03, 0, z), m);
      const label = new THREE.Mesh(ring(0.0245, 0.023, 0.026, 0.001, 24), mat.glow(this.trackColors[track], 0.7));
      label.applyMatrix4(m.clone().multiply(new THREE.Matrix4().makeTranslation(-0.03, roof + 0.027, z)));
      g.add(label);
      kit.add(M.steel, ring(0.0255, 0.02, 0.003, 0.001).translate(-0.03, roof + 0.008, z), m);
      kit.add(M.steel, ring(0.0255, 0.02, 0.003, 0.001).translate(-0.03, roof + 0.046, z), m);
      kit.add(M.steel, rod([-0.006, roof + 0.012, z], [0.0, roof + 0.012, z], 0.004, 8), m);
      kit.add(M.brass, cylinder(0.006, 0.012).translate(-0.003, roof + 0.02, z), m); // vanne
      kit.add(M.brass, rbox(0.003, 0.003, 0.018, 0.001).translate(-0.003, roof + 0.027, z), m);
    });
    const z0 = Math.min(...zs, 0) - 0.03;
    const z1 = Math.max(...zs, 0) + 0.03;
    kit.add(M.steel, toZ(cylinder(0.006, z1 - z0, 0.002, 12)).translate(0.004, roof + 0.012, (z0 + z1) / 2), m);
    kit.add(M.steel, rod([0.004, roof + 0.012, 0], [0.004, roof - 0.03, 0], 0.005, 10), m);
    // Cheminée d'extraction, au fond de la cabine.
    const cz = -L / 2 + 0.028;
    kit.add(M.paint, turn([[0, roof], [0.024, roof], [0.024, roof + 0.008], [0.016, roof + 0.012], [0.016, roof + 0.085], [0.0, roof + 0.085]], { segments: 20 }).translate(0.04, 0, cz), m);
    kit.add(M.paint, turn([[0.0, roof + 0.095], [0.028, roof + 0.095], [0.03, roof + 0.098], [0.0, roof + 0.115]], { segments: 20 }).translate(0.04, 0, cz), m);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      kit.add(M.steel, rod([0.04 + Math.cos(a) * 0.014, roof + 0.082, cz + Math.sin(a) * 0.014], [0.04 + Math.cos(a) * 0.02, roof + 0.097, cz + Math.sin(a) * 0.02], 0.0018, 5), m);
    }
    return lamp;
  }

  /**
   * Porte d'échappement : deux joues boulonnées sur les longerons portent l'axe du volet
   * de laiton ; un électro-aimant, sur une console, tire le levier de l'axe par une tige.
   */
  buildGate(line, path) {
    const { kit, M, group: g } = this;
    const o = this.trunks.options;
    const W = o.radius;
    const top = o.beltY;
    const G = line.gateAt + line.ballRadius + 0.006;
    const m = frameAt(path, G);
    const py = top + 0.1;
    for (const s of [1, -1]) {
      kit.add(M.paint, rbox(0.008, 0.15, 0.05, 0.003).translate(s * (W + 0.004), top + 0.045, 0), m);
      kit.add(M.iron, toX(ring(0.011, 0.004, 0.01)).translate(s * (W + 0.011), py, 0), m);
      for (const z of [-0.015, 0.015]) kit.add(M.steel, nut(0.0035).rotateZ((-s * Math.PI) / 2).translate(s * (W + 0.008), top - 0.012, z), m);
    }
    // Électro-aimant sur sa console, en amont.
    const sx = W + 0.016;
    kit.add(M.iron, rbox(0.012, 0.03, 0.05, 0.003).translate(W + 0.01, py + 0.03, -0.052), m);
    kit.add(M.brass, toZ(cylinder(0.012, 0.042, 0.003)).translate(sx, py + 0.04, -0.064), m);
    kit.add(M.iron, toZ(ring(0.013, 0.004, 0.006)).translate(sx, py + 0.04, -0.042), m);
    // Volet, axe et levier : ils pivotent ensemble.
    const hinge = new THREE.Group();
    const [hx, , hz] = path.pointAt(G);
    const hd = path.tangentAt(G);
    hinge.position.set(hx, py, hz);
    hinge.rotation.set(0, Math.atan2(hd[0], hd[2]), 0, 'YXZ');
    const k = new Kit();
    k.add(M.brass, rbox(o.beltWidth * 0.84, 0.075, 0.008, 0.003).translate(0, -0.047, 0));
    k.add(M.brass, toX(cylinder(0.006, o.beltWidth * 0.84)).translate(0, -0.008, 0));
    k.add(M.steel, toX(cylinder(0.0035, 2 * W + 0.04)).translate(0.004, 0, 0));
    k.add(M.steel, rbox(0.006, 0.046, 0.01, 0.002).translate(sx, 0.02, 0));
    k.build(hinge, 'volet');
    g.add(hinge);
    const plunger = new THREE.Mesh(cylinder(0.0035, 1, 0.0005, 8), M.steel);
    g.add(plunger);
    const local = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m);
    return { hinge, plunger, plungerFrom: local(sx, py + 0.04, -0.04), leverTip: new THREE.Vector3(sx, 0.04, 0) };
  }

  /**
   * Bout d'un tapis de retour (voir recycle, trunks.js) : bac de décapage en verre dans son
   * cadre de cornières, vis d'extraction coiffée de son motoréducteur, goulotte de verre
   * à brides jusqu'à la colonne de réserve du distributeur.
   */
  buildRecycler(line) {
    const { kit, M, group: g } = this;
    const o = this.trunks.options;
    const keys = line.recycle.map((k) => k.p);
    const [xr, , z0] = keys[0];
    // Le bac commence juste devant le rouleau de bout du tapis ; son bord est assez bas pour que la bille le franchisse.
    const zt = z0 + o.tankAhead + 0.045;
    const r = line.ballRadius;
    const [hw, hh, hd] = [0.065, 0.1, 0.09];
    const tank = new THREE.Mesh(new THREE.BoxGeometry(2 * hw - 0.008, hh - 0.012, 2 * hd - 0.008), M.glass);
    tank.position.set(xr, 0.012 + (hh - 0.012) / 2, zt);
    tank.renderOrder = 2;
    tank.name = 'bac de décapage';
    g.add(tank);
    const bath = new THREE.Mesh(new THREE.BoxGeometry(2 * hw - 0.012, 0.07, 2 * hd - 0.012), new THREE.MeshStandardMaterial({ color: 0x3fae7c, transparent: true, opacity: 0.4, roughness: 0.12, depthWrite: false }));
    bath.position.set(xr, 0.014 + 0.035, zt);
    bath.renderOrder = 1;
    g.add(bath);
    // Cadre : cornières d'angle, ceintures haute et basse, socle, vanne de vidange.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.add(M.paint, rbox(0.012, hh, 0.012, 0.002).translate(xr + sx * hw, hh / 2 + 0.006, zt + sz * hd), undefined);
    for (const y of [0.012, hh + 0.004]) {
      for (const sz of [-1, 1]) kit.add(M.paint, rbox(2 * hw + 0.012, 0.01, 0.01, 0.002).translate(xr, y, zt + sz * hd));
      for (const sx of [-1, 1]) kit.add(M.paint, rbox(0.01, 0.01, 2 * hd + 0.012, 0.002).translate(xr + sx * hw, y, zt));
    }
    kit.add(M.iron, rbox(2 * hw + 0.03, 0.008, 2 * hd + 0.03, 0.003).translate(xr, 0.004, zt));
    kit.add(M.brass, toZ(cylinder(0.007, 0.02)).translate(xr + 0.03, 0.02, zt + hd + 0.01));
    kit.add(M.brass, rbox(0.024, 0.004, 0.004, 0.001).translate(xr + 0.03, 0.03, zt + hd + 0.02));
    // Bulles du bain (posées à chaque image).
    const bubbles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.005, 6, 4), mat.light(0x9fffd0), 6);
    bubbles.userData.fx = true;
    bubbles.frustumCulled = false;
    g.add(bubbles);
    // Colonne de la vis, bridée en haut et en bas, tenue au cadre par un collier.
    const [lx, , lz] = keys[3];
    const R = r + 0.012;
    const yTop = o.liftTop + 0.02;
    const lift = new THREE.Mesh(sweepGeometry([[lx, 0.014, lz], [lx, yTop, lz]], R, 18), M.glass);
    lift.renderOrder = 2;
    lift.name = 'colonne de la vis';
    g.add(lift);
    kit.add(M.brass, ring(R + 0.008, R - 0.002, 0.012).translate(lx, hh + 0.016, lz));
    kit.add(M.brass, ring(R + 0.008, R - 0.002, 0.012).translate(lx, yTop - 0.006, lz));
    kit.add(M.paint, rbox(0.012, 0.01, Math.abs(zt + hd - lz) + 0.01, 0.002).translate(lx + R + 0.002, hh + 0.004, (zt + hd + lz) / 2));
    const pitch = 0.1;
    const helix = [];
    for (let a = 0; (a / (Math.PI * 2)) * pitch < yTop - 0.05; a += Math.PI / 10) helix.push([Math.cos(a) * (R - 0.008), 0.02 + (a / (Math.PI * 2)) * pitch, Math.sin(a) * (R - 0.008)]);
    const screw = new THREE.Mesh(sweepGeometry(helix, 0.004, 6), M.chrome);
    screw.position.set(lx, 0, lz);
    g.add(screw);
    this.screws.push({ screw, pitch });
    // Motoréducteur : carter, moteur couché du côté opposé à la goulotte, ailettes, flasque.
    const ms = keys[5][0] > lx ? -1 : 1;
    kit.add(M.paint, rbox(0.07, 0.05, 0.07, 0.008).translate(lx, yTop + 0.03, lz));
    kit.add(M.paint, toX(cylinder(0.022, 0.06, 0.004)).translate(lx + ms * 0.06, yTop + 0.035, lz));
    for (let k = 0; k < 4; k++) kit.add(M.paint, toX(ring(0.025, 0.021, 0.004, 0.001)).translate(lx + ms * (0.042 + k * 0.012), yTop + 0.035, lz));
    kit.add(M.iron, toX(cylinder(0.018, 0.008, 0.002)).translate(lx + ms * 0.093, yTop + 0.035, lz));
    kit.add(M.steel, boltCircle(4, 0.04, yTop + 0.055, 0.0035, Math.PI / 4).translate(lx, 0, lz));
    // Goulotte de verre, brides de laiton à chaque bout.
    const route = fillet3([[lx, yTop + 0.01, lz], keys[5], [keys[6][0], keys[6][1] + 0.02, keys[6][2]]]);
    const tube = new THREE.Mesh(sweepGeometry(route, R, 14), M.glass);
    tube.renderOrder = 2;
    tube.name = 'goulotte';
    g.add(tube);
    // Bride centrée sur p, dans l'axe du tube (vers q).
    const flange = (p, q) => {
      const d = q.map((v, i) => v - p[i]);
      const l = Math.hypot(...d);
      const e = d.map((v) => (v / l) * 0.005);
      kit.add(M.brass, between(ring(R + 0.007, R - 0.002, 0.01), p.map((v, i) => v - e[i]), p.map((v, i) => v + e[i])));
    };
    flange(route[0].map((v, i) => v + (route[1][i] - v) * 0.3), route[1]);
    flange(route[route.length - 1], route[route.length - 2]);
    this.recyclers.push({ line, bubbles, x: xr, z: zt });
  }

  /**
   * Salle des machines (voir placeEngine, trunks.js). Arbre de transmission sur chevalets
   * à paliers, une poulie à bras et une courroie de cuir par tapis. Au bout, la machine à
   * vapeur : volant, palier principal, manivelle en porte-à-faux, bielle, crosse entre ses
   * glissières, cylindre calorifugé (douelles de bois cerclées de laiton) et sa boîte à
   * vapeur, régulateur à boules entraîné par le palier principal, réservoir d'air et son
   * compresseur entraîné par l'arbre. Sans place, un moteur électrique entraîne l'arbre.
   */
  buildEngine(e) {
    const { kit, M, group: g } = this;
    const o = this.trunks.options;
    const top = o.beltY;
    const { y, z, side, dir } = e;
    const steam = e.kind === 'steam';
    const u = (k) => e.xe + side * k; // le long de l'arbre, à partir de son bout côté machine
    const zz = (k) => z + dir * k; // le long du cylindre
    const shaftR = 0.018;
    const omega = 2 * Math.PI * o.shaftSpin;
    // Arbre : de l'autre bout jusqu'au plateau de manivelle (ou au moteur).
    const xEnd = steam ? u(0.33) : e.xb + 0.04;
    const xStart = side > 0 ? e.xa - 0.04 : e.xb + 0.04;
    const [x0, x1] = [Math.min(xStart, xEnd), Math.max(xStart, xEnd)];
    const rotor = this.spinner(new THREE.Matrix4().makeTranslation(0, y, z), omega, (k) => {
      k.add(M.steel, toX(cylinder(shaftR, x1 - x0, 0.004, 20)).translate((x0 + x1) / 2, 0, 0));
      // Poulies (une par tapis), colliers de part et d'autre.
      for (const { line, path } of this.lines) {
        const hub = line.kind === 'feed' ? path.pointAt(0) : path.pointAt(path.length);
        if (Math.abs(hub[2] - e.z0) > 0.05) continue;
        const x = hub[0] + o.radius + 0.025;
        const p = spokedPulley(0.09, 0.03, { spokes: 4, hubR: 0.03 });
        k.add(M.paint, p.rim.translate(x, 0, 0));
        k.add(M.iron, p.hub.translate(x, 0, 0));
        for (const s of [-1, 1]) k.add(M.steel, toX(ring(0.026, shaftR, 0.008, 0.002)).translate(x + s * 0.024, 0, 0));
      }
      if (steam) {
        // Volant : jante, six bras ovales, moyeu claveté.
        const R = 0.31;
        k.add(M.paint, toX(turn([[R - 0.04, -0.03], [R - 0.004, -0.03], [R, -0.026], [R, 0.026], [R - 0.004, 0.03], [R - 0.04, 0.03], [R - 0.046, 0.024], [R - 0.046, -0.024], [R - 0.04, -0.03]], { segments: 64 })).translate(u(0.16), 0, 0));
        for (let n = 0; n < 6; n++) {
          const spoke = new THREE.CylinderGeometry(0.011, 0.018, R - 0.1, 12).toNonIndexed();
          spoke.scale(1, 1, 0.6).translate(0, 0.055 + (R - 0.1) / 2, 0).rotateX((n / 6) * Math.PI * 2);
          spoke.computeVertexNormals();
          k.add(M.paint, spoke.translate(u(0.16), 0, 0));
        }
        k.add(M.iron, toX(cylinder(0.06, 0.09, 0.008)).translate(u(0.16), 0, 0));
        k.add(M.steel, rbox(0.1, 0.008, 0.012, 0.002).translate(u(0.16), shaftR + 0.003, 0));
        // Plateau de manivelle avec contrepoids, maneton et son écrou.
        k.add(M.iron, toX(cylinder(0.13, 0.03, 0.005, 48)).translate(u(0.33), 0, 0));
        k.add(M.iron, rbox(0.03, 0.06, 0.16, 0.01).translate(u(0.33), -0.08, 0));
        k.add(M.steel, toX(cylinder(0.016, 0.06, 0.003)).translate(u(0.375), 0.1, 0));
        k.add(M.steel, nut(0.012).rotateZ((-side * Math.PI) / 2).translate(u(0.405), 0.1, 0));
        // Poulie du compresseur.
        const cp = spokedPulley(0.06, 0.02, { spokes: 4, hubR: 0.024 });
        k.add(M.paint, cp.rim.translate(u(0.045), 0, 0));
        k.add(M.iron, cp.hub.translate(u(0.045), 0, 0));
      } else {
        const p = spokedPulley(0.08, 0.026, { spokes: 4, hubR: 0.028 });
        k.add(M.paint, p.rim.translate(e.motor[0] + 0.12, 0, 0));
        k.add(M.iron, p.hub.translate(e.motor[0] + 0.12, 0, 0));
      }
      // Accouplement à plateaux au milieu de l'arbre.
      const hubs = this.lines.map(({ line: l, path: p }) => (l.kind === 'feed' ? p.pointAt(0) : p.pointAt(p.length))).filter((h) => Math.abs(h[2] - e.z0) < 0.05).map((h) => h[0]).sort((a, b) => a - b);
      const xm = (hubs[Math.floor(hubs.length / 2) - 1] ?? hubs[0] ?? 0) + 0.243; // entre deux poulies
      for (const s of [-1, 1]) k.add(M.iron, toX(cylinder(0.04, 0.016, 0.003)).translate(xm + s * 0.009, 0, 0));
      k.add(M.steel, toX(boltCircle(6, 0.03, 0, 0.004)).translate(xm + 0.017, 0, 0));
    }, 'arbre');

    // Chevalets : deux jambes, entretoise, platine, palier ; semelles boulonnées au sol.
    const pb = pillowBlock(shaftR, 0.05);
    for (const x of e.supports) {
      for (const s of [-1, 1]) {
        kit.add(M.paint, between(rbox(0.026, Math.hypot(y - 0.077, 0.15), 0.026, 0.005), [x, 0.012, z + s * 0.17], [x, y - 0.065, z + s * 0.02]));
        kit.add(M.iron, rbox(0.06, 0.012, 0.06, 0.004).translate(x, 0.006, z + s * 0.17));
        kit.add(M.steel, boltCircle(2, 0.021, 0.012, 0.004).translate(x, 0, z + s * 0.17));
      }
      kit.add(M.paint, rbox(0.03, 0.02, 0.24, 0.005).translate(x, 0.16, z));
      kit.add(M.iron, rbox(0.07, 0.012, 0.12, 0.004).translate(x, y - 0.056, z));
      kit.add(M.iron, pb.iron.clone().translate(x, y, z));
      kit.add(M.steel, pb.steel.clone().translate(x, y, z));
      kit.add(M.brass, pb.brass.clone().translate(x, y, z));
    }

    // Courroies de cuir et poulies de tête des tapis (elles tournent avec les rouleaux).
    for (const { line, path } of this.lines) {
      const hub = line.kind === 'feed' ? path.pointAt(0) : path.pointAt(path.length);
      if (Math.abs(hub[2] - e.z0) > 0.05) continue;
      const x = hub[0] + o.radius + 0.025;
      kit.add(M.leather, beltLoop(x, [y, z], 0.0925, [top - 0.022, hub[2]], 0.0325, 0.009));
      this.spinner(new THREE.Matrix4().makeTranslation(x, top - 0.022, hub[2]), omega * 3, (k) => {
        k.add(M.iron, toX(turn([[0.012, -0.011], [0.028, -0.011], [0.03, -0.008], [0.031, 0], [0.03, 0.008], [0.028, 0.011], [0.012, 0.011], [0.012, -0.011]], { segments: 28 })));
        k.add(M.steel, toX(cylinder(0.013, 0.026, 0.002)));
        k.add(M.steel, nut(0.006).rotateZ(-Math.PI / 2).translate(0.013, 0, 0));
        k.add(M.iron, rbox(0.022, 0.006, 0.006, 0.002).translate(0, 0.02, 0));
      }, 'poulie de tête');
    }

    if (!steam) {
      // Moteur électrique : carcasse à ailettes sur pattes, boîte à bornes, poulie, courroie.
      const [mx, mz] = e.motor;
      const my = 0.13;
      kit.add(M.paint, toX(cylinder(0.07, 0.19, 0.012)).translate(mx, my, mz));
      for (let n = 0; n < 12; n++) kit.add(M.paint, rbox(0.17, 0.014, 0.008, 0.002).translate(0, 0.072, 0).rotateX((n / 12) * Math.PI * 2).translate(mx, my, mz));
      for (const s of [-1, 1]) {
        kit.add(M.iron, toX(cylinder(0.06, 0.02, 0.006)).translate(mx + s * 0.1, my, mz));
        kit.add(M.iron, rbox(0.03, 0.06, 0.14, 0.006).translate(mx + s * 0.07, 0.03, mz));
      }
      kit.add(M.iron, rbox(0.05, 0.03, 0.05, 0.006).translate(mx, my + 0.085, mz));
      const px = mx + 0.12;
      kit.add(M.leather, beltLoop(px, [y, z], 0.0825, [my, mz], 0.0415, 0.008));
      this.motorPulley = this.spinner(new THREE.Matrix4().makeTranslation(px, my, mz), omega * 2, (k) => {
        k.add(M.steel, toX(cylinder(0.01, 0.06)).translate(-0.02, 0, 0));
        const p = spokedPulley(0.04, 0.02, { spokes: 3, hubR: 0.014 });
        k.add(M.iron, p.rim);
        k.add(M.steel, p.hub);
      }, 'poulie du moteur');
      this.engine = { e, rotor };
      return;
    }

    // --- Machine à vapeur ------------------------------------------------------------
    const xc = u(0.37); // plan de la bielle, des glissières et du cylindre
    // Bâti : une seule fonte, posée au sol, boulonnée ; selle sous le cylindre et les glissières.
    const bedY = 0.2;
    const bz0 = zz(-0.16);
    const bz1 = zz(1.1);
    kit.add(M.paint, rbox(0.23, bedY, Math.abs(bz1 - bz0), 0.02).translate(u(0.375), bedY / 2, (bz0 + bz1) / 2));
    kit.add(M.iron, rbox(0.26, 0.02, Math.abs(bz1 - bz0) + 0.03, 0.006).translate(u(0.375), 0.01, (bz0 + bz1) / 2));
    for (const k of [-0.1, 0.25, 0.6, 1.0]) for (const s of [-1, 1]) kit.add(M.steel, nut(0.008).translate(u(0.375) + s * 0.1, bedY, zz(k)));
    kit.add(M.paint, rbox(0.2, 0.09, 0.32, 0.012).translate(xc, bedY + 0.045, zz(0.84)));
    kit.add(M.paint, rbox(0.13, 0.1, 0.42, 0.012).translate(xc, bedY + 0.05, zz(0.45)));
    // Palier principal sur le bâti.
    const main = pillowBlock(0.022, y - bedY);
    kit.add(M.iron, main.iron.translate(u(0.28), y, z));
    kit.add(M.steel, main.steel.translate(u(0.28), y, z));
    // Glissières : deux flasques, deux règles d'acier, entretoises.
    for (const s of [-1, 1]) {
      kit.add(M.paint, rbox(0.01, 0.2, 0.4, 0.004).translate(xc + s * 0.045, y, zz(0.45)));
      for (const k of [0.27, 0.63]) kit.add(M.steel, nut(0.005).rotateZ((-s * Math.PI) / 2).translate(xc + s * 0.05, y + 0.08, zz(k)));
    }
    for (const s of [-1, 1]) kit.add(M.steel, toZ(cylinder(0.008, 0.31, 0.002)).translate(xc, y + s * 0.05, zz(0.465)));
    kit.add(M.paint, rbox(0.1, 0.012, 0.03, 0.004).translate(xc, y + 0.105, zz(0.63)));
    // Cylindre : couvercles boulonnés, presse-étoupe, douelles de bois cerclées de laiton.
    const cyl = (k) => new THREE.Matrix4().makeRotationX(dir * Math.PI / 2).setPosition(xc, y, zz(k));
    kit.add(M.iron, cylinder(0.126, 0.024, 0.005, 48), cyl(0.672));
    kit.add(M.iron, cylinder(0.126, 0.024, 0.005, 48), cyl(1.008));
    kit.add(M.steel, boltCircle(10, 0.112, 0.012, 0.0065), cyl(1.008));
    kit.add(M.steel, boltCircle(10, 0.112, 0.012, 0.0065).rotateX(Math.PI), cyl(0.672));
    kit.add(M.wood, cylinder(0.112, 0.31, 0.003, 22), cyl(0.84));
    for (const k of [0.71, 0.84, 0.97]) kit.add(M.brass, ring(0.116, 0.111, 0.014, 0.003, 48), cyl(k));
    kit.add(M.brass, turn([[0.013, -0.04], [0.03, -0.04], [0.032, -0.036], [0.032, -0.02], [0.022, -0.016], [0.022, 0], [0.013, 0]], { segments: 24 }), cyl(0.66));
    for (const s of [-1, 1]) kit.add(M.brass, rod([xc + s * 0.05, y - 0.1, zz(0.8)], [xc + s * 0.05, y - 0.125, zz(0.8)], 0.006, 8)); // purgeurs
    // Boîte à vapeur et son couvercle, tige de tiroir, arrivée de vapeur.
    const chestY = y + 0.112 + 0.035;
    kit.add(M.paint, rbox(0.085, 0.07, 0.3, 0.008).translate(xc, chestY, zz(0.84)));
    kit.add(M.iron, rbox(0.095, 0.012, 0.31, 0.004).translate(xc, chestY + 0.041, zz(0.84)));
    for (let n = 0; n < 5; n++) for (const s of [-1, 1]) kit.add(M.steel, nut(0.0045).translate(xc + s * 0.038, chestY + 0.047, zz(0.72 + n * 0.06)));
    kit.add(M.brass, toZ(cylinder(0.014, 0.03, 0.003)).translate(xc, chestY, zz(0.675)));
    kit.add(M.steel, toZ(cylinder(0.005, 0.16)).translate(xc, chestY, zz(0.6)));
    const steamPipe = [[xc, chestY + 0.047, zz(0.92)], [xc, chestY + 0.14, zz(0.92)], [u(0.52), chestY + 0.14, zz(0.92)], [u(0.52), 0, zz(0.92)]];
    const bent = [steamPipe[0], ...fillet3(steamPipe.slice(0, 3), 0.05).slice(1, -1), ...fillet3(steamPipe.slice(1), 0.05).slice(1)];
    kit.add(M.iron, sweepGeometry(bent, 0.016, 14));
    kit.add(M.iron, ring(0.03, 0.016, 0.012).translate(xc, chestY + 0.053, zz(0.92)));
    kit.add(M.iron, ring(0.035, 0.016, 0.012).translate(u(0.52), 0.006, zz(0.92)));
    kit.add(M.brass, toX(cylinder(0.024, 0.04, 0.004)).translate((xc + u(0.52)) / 2, chestY + 0.14, zz(0.92))); // vanne d'arrêt
    kit.add(M.brass, cylinder(0.004, 0.04).translate((xc + u(0.52)) / 2, chestY + 0.17, zz(0.92)));
    kit.add(M.brass, toZ(ring(0.03, 0.025, 0.004)).translate((xc + u(0.52)) / 2, chestY + 0.19, zz(0.92)));

    // Bielle : tête (coussinet et chapeau boulonné), corps fuselé, pied ; posée à chaque image.
    const L = 0.42;
    const rodGroup = new THREE.Group();
    {
      const k = new Kit();
      k.add(M.steel, turn([[0, 0.03], [0.016, 0.03], [0.014, 0.12], [0.012, L - 0.06], [0.011, L - 0.03], [0, L - 0.03]], { segments: 18, smooth: 40 }));
      k.add(M.iron, rbox(0.04, 0.05, 0.055, 0.006));
      k.add(M.brass, toX(ring(0.02, 0.016, 0.042, 0.002)));
      for (const s of [-1, 1]) k.add(M.steel, nut(0.005).rotateX(Math.PI).translate(0, -0.025, s * 0.02));
      k.add(M.iron, rbox(0.03, 0.04, 0.04, 0.006).translate(0, L, 0));
      k.build(rodGroup, 'bielle');
    }
    // Crosse et tige de piston (le piston est dans le cylindre).
    const slider = new THREE.Group();
    {
      const k = new Kit();
      k.add(M.steel, rbox(0.06, 0.084, 0.07, 0.008));
      k.add(M.brass, toX(cylinder(0.012, 0.072)));
      k.add(M.steel, toZ(cylinder(0.011, 0.42, 0.002)).translate(0, 0, dir * 0.21));
      k.build(slider, 'crosse');
    }
    g.add(rodGroup, slider);

    // Régulateur : renvoi d'angle sur le palier principal, colonne, bras pesants, manchon.
    const gx = u(0.28);
    const govBase = y + 0.08;
    const govTop = y + 0.55;
    kit.add(M.paint, rbox(0.055, 0.04, 0.06, 0.008).translate(gx, govBase, z));
    kit.add(M.brass, cylinder(0.014, 0.03, 0.003).translate(gx, govBase + 0.035, z));
    kit.add(M.steel, rod([gx, govBase + 0.05, z], [gx, govTop, z], 0.0065, 12));
    const spinner = new THREE.Group();
    spinner.position.set(gx, govTop, z);
    const La = 0.16;
    const Ll = 0.085;
    const arms = [1, -1].map((s) => {
      const pivot = new THREE.Group();
      const k = new Kit();
      k.add(M.steel, cylinder(0.005, La, 0.001, 8).translate(0, -La / 2, 0));
      k.add(M.brass, turn([[0, -0.032], [0.022, -0.026], [0.032, -0.01], [0.033, 0], [0.032, 0.01], [0.022, 0.026], [0, 0.032]], { segments: 24, smooth: 50 }).translate(0, -La, 0));
      k.build(pivot, 'bras');
      pivot.userData.side = s;
      spinner.add(pivot);
      return pivot;
    });
    {
      const k = new Kit();
      k.add(M.brass, turn([[0, -0.012], [0.018, -0.012], [0.02, -0.008], [0.02, 0.01], [0.012, 0.02], [0.004, 0.03], [0, 0.03]], { segments: 20 }));
      k.build(spinner, 'tête du régulateur');
    }
    const links = [1, -1].map(() => {
      const l = new THREE.Mesh(cylinder(0.003, 1, 0.0005, 6), M.steel);
      spinner.add(l);
      return l;
    });
    const sleeve = new THREE.Mesh(ring(0.016, 0.006, 0.02, 0.003), M.brass);
    spinner.add(sleeve);
    g.add(spinner);

    // --- Réservoir d'air et compresseur ----------------------------------------------
    const tx = u(0.15);
    const tz = zz(0.8);
    const tr = 0.08;
    const prof = [[0, 0.09]];
    for (let n = 0; n <= 8; n++) prof.push([tr * Math.sin((n / 8) * (Math.PI / 2)), 0.09 + 0.035 * (1 - Math.cos((n / 8) * (Math.PI / 2)))]);
    prof.push([tr, 0.125], [tr, 0.47]);
    for (let n = 0; n <= 8; n++) prof.push([tr * Math.cos((n / 8) * (Math.PI / 2)), 0.47 + 0.04 * Math.sin((n / 8) * (Math.PI / 2))]);
    kit.add(M.paint, turn(prof, { segments: 40, smooth: 35 }).translate(tx, 0, tz));
    for (const yy of [0.15, 0.44]) kit.add(M.iron, ring(tr + 0.004, tr - 0.001, 0.01, 0.002, 40).translate(tx, yy, tz));
    for (let n = 0; n < 3; n++) {
      const a = (n / 3) * Math.PI * 2 + 0.3;
      kit.add(M.iron, between(rbox(0.016, 0.13, 0.016, 0.004), [tx + Math.cos(a) * 0.1, 0.006, tz + Math.sin(a) * 0.1], [tx + Math.cos(a) * 0.06, 0.12, tz + Math.sin(a) * 0.06]));
      kit.add(M.iron, cylinder(0.016, 0.008).translate(tx + Math.cos(a) * 0.104, 0.004, tz + Math.sin(a) * 0.104));
    }
    // Soupape de sûreté, purge, sortie vers la tourelle (sous le sol).
    kit.add(M.brass, turn([[0, 0.5], [0.012, 0.5], [0.012, 0.53], [0.008, 0.535], [0.008, 0.56], [0.014, 0.565], [0.014, 0.575], [0, 0.58]], { segments: 16 }).translate(tx, 0.005, tz - dir * 0.04));
    kit.add(M.brass, cylinder(0.008, 0.02).translate(tx, 0.08, tz));
    // Sortie vers la tourelle : elle part du côté de l'arbre et plonge dans le sol.
    kit.add(M.iron, sweepGeometry(fillet3([[u(0.08), 0.2, tz], [u(0.03), 0.2, tz], [u(0.03), 0, tz]], 0.03), 0.012, 12));
    kit.add(M.iron, ring(0.022, 0.012, 0.01).translate(u(0.03), 0.005, tz));
    // Compresseur sur le dôme : carter, cylindre à ailettes, culasse, tuyau vers le réservoir.
    const cy0 = 0.53;
    kit.add(M.paint, rbox(0.075, 0.06, 0.08, 0.01).translate(tx, cy0 + 0.03, tz));
    for (let n = 0; n < 7; n++) kit.add(M.iron, ring(0.032, 0.02, 0.004, 0.001).translate(tx, cy0 + 0.07 + n * 0.012, tz));
    kit.add(M.iron, cylinder(0.022, 0.09).translate(tx, cy0 + 0.105, tz));
    kit.add(M.paint, rbox(0.06, 0.02, 0.06, 0.006).translate(tx, cy0 + 0.16, tz));
    kit.add(M.steel, boltCircle(4, 0.03, cy0 + 0.17, 0.0035, Math.PI / 4).translate(tx, 0, tz));
    kit.add(M.steel, sweepGeometry(fillet3([[tx + 0.03, cy0 + 0.16, tz], [tx + 0.06, cy0 + 0.16, tz], [tx + 0.06, 0.48, tz]], 0.03), 0.006, 10));
    // Manomètre sur sa colonnette, tourné vers le public.
    kit.add(M.steel, rod([tx, 0.42, tz + tr], [tx, 0.42, tz + tr + 0.035], 0.004, 8));
    const gz = tz + tr + 0.04;
    kit.add(M.brass, toZ(turn([[0, -0.012], [0.046, -0.012], [0.05, -0.008], [0.05, 0.006], [0.046, 0.01], [0.042, 0.01], [0.042, 0.004], [0, 0.004]], { segments: 36 })).translate(tx, 0.42, gz));
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.042, 32), new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.5, emissive: 0x2a2620 }));
    face.position.set(tx, 0.42, gz + 0.0045);
    g.add(face);
    for (let n = 0; n <= 16; n++) {
      const a = -2.2 + (4.4 * n) / 16;
      const big = n % 2 === 0;
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.0018, big ? 0.008 : 0.004, 0.001), n < 3 ? new THREE.MeshBasicMaterial({ color: 0xc0201a }) : new THREE.MeshBasicMaterial({ color: 0x222222 }));
      tick.position.set(tx + Math.sin(a) * 0.034, 0.42 + Math.cos(a) * 0.034, gz + 0.005);
      tick.rotation.z = -a;
      g.add(tick);
    }
    const needle = new THREE.Group();
    needle.position.set(tx, 0.42, gz + 0.006);
    needle.add(new THREE.Mesh(new THREE.BoxGeometry(0.0025, 0.036, 0.0012).translate(0, 0.014, 0), new THREE.MeshBasicMaterial({ color: 0xc0201a })));
    needle.add(new THREE.Mesh(cylinder(0.004, 0.003), M.brass).rotateX(Math.PI / 2));
    g.add(needle);
    // Poulie du compresseur et sa courroie (depuis l'arbre).
    const cpx = u(0.045);
    const cpy = cy0 + 0.03;
    kit.add(M.steel, toX(cylinder(0.006, Math.abs(tx - cpx))).translate((tx + cpx) / 2, cpy, tz));
    kit.add(M.leather, beltLoop(cpx, [y, z], 0.0625, [cpy, tz], 0.0365, 0.008));
    this.spinner(new THREE.Matrix4().makeTranslation(cpx, cpy, tz), omega * (0.06 / 0.035), (k) => {
      const p = spokedPulley(0.035, 0.018, { spokes: 3, hubR: 0.012 });
      k.add(M.paint, p.rim);
      k.add(M.iron, p.hub);
    }, 'poulie du compresseur');

    this.engine = { e, rotor, rodGroup, slider, spinner, arms, links, sleeve, rc: 0.1, L, x: xc, gx, govTop, La, Ll, needle };
  }

  /** Meules qui tournent, étincelles quand une bille passe dessous. */
  updateGrinders(t) {
    const o = this.trunks.options;
    const sparks = this.sparks;
    if (!sparks) return;
    let n = 0;
    const p = new THREE.Vector3();
    const v = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1);
    for (const gr of this.grinders) {
      const line = gr.line;
      const at = (b) => b.born + line.grindAt / o.speed;
      const k = upperBound(line.balls, t, at) - 1;
      if (k < 0) continue;
      const age = t - at(line.balls[k]);
      if (age > 0.3) continue;
      for (let j = 0; j < SPARKS; j++) {
        const h = (c) => hash(k * 31 + j, c + line.grindAt * 100);
        const life = 0.12 + 0.18 * h(4);
        if (age > life) continue;
        // Lancée vers l'amont et vers le haut, par l'ouverture du carter, puis retombe.
        v.set((h(1) - 0.5) * 0.8, 0.4 + 1.0 * h(2), -(1.2 + 1.6 * h(3)));
        p.set(gr.contact[0] + v.x * age, gr.contact[1] + v.y * age - 4.9 * age * age, gr.contact[2] - 0.035 + v.z * age).applyMatrix4(gr.frame);
        v.y -= 9.8 * age;
        v.transformDirection(gr.frame);
        q.setFromUnitVectors(Z, v);
        const fade = 1 - age / life;
        this._m.compose(p, q, new THREE.Vector3(1, 1, 0.012 + 0.03 * fade));
        sparks.setMatrixAt(n, this._m);
        sparks.setColorAt(n, this._c.copy(SPARK_COLOR).multiplyScalar(fade));
        n++;
      }
    }
    sparks.count = n;
    sparks.instanceMatrix.needsUpdate = true;
    if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;
  }

  updateEngine(t) {
    const en = this.engine;
    if (!en.rodGroup) return;
    const { e } = en;
    const o = this.trunks.options;
    const theta = (2 * Math.PI * o.shaftSpin * t) % (2 * Math.PI);
    // Maneton après rotation de θ autour de x : (0, rc cos θ, rc sin θ) autour de l'axe.
    const pin = new THREE.Vector3(en.x, e.y + en.rc * Math.cos(theta), e.z + en.rc * Math.sin(theta));
    const cz = pin.z + e.dir * Math.sqrt(en.L * en.L - (pin.y - e.y) ** 2);
    en.slider.position.set(en.x, e.y, cz);
    en.rodGroup.position.copy(pin);
    en.rodGroup.quaternion.setFromUnitVectors(Y, new THREE.Vector3(en.x, e.y, cz).sub(pin).normalize());
    // Régulateur : il tourne ; ses boules s'affaissent quand la machine peine, le manchon descend.
    en.spinner.rotation.y = (2 * Math.PI * 1.5 * t) % (2 * Math.PI);
    const phi = 0.95 - 0.4 * Math.tanh(engineLoad(this.trunks, t) / 4);
    for (const arm of en.arms) arm.rotation.z = arm.userData.side * phi;
    const hx = (en.La / 2) * Math.sin(phi);
    const hy = -(en.La / 2) * Math.cos(phi);
    const sy = hy - Math.sqrt(Math.max(0, en.Ll * en.Ll - (hx - 0.016) ** 2));
    en.sleeve.position.set(0, sy, 0);
    en.links.forEach((l, i) => placeRod(l, new THREE.Vector3(i ? -hx : hx, hy, 0), new THREE.Vector3(i ? -0.016 : 0.016, sy, 0)));
    // Manomètre : de −2,2 rad (vide) à +2,2 rad (pleine pression).
    en.needle.rotation.z = -(-2.2 + 4.4 * airPressure(this.trunks, t));
  }

  update(t) {
    const tr = this.trunks;
    // La bande défile : la texture glisse à la vitesse des tapis ; le cuir à celle des courroies.
    this.beltTex.offset.x = -(((tr.options.speed * t) / BELT_PERIOD) % 1);
    this.leatherTex.offset.x = -(((2 * Math.PI * tr.options.shaftSpin * 0.09 * t) / 0.5) % 1);
    for (const { group, speed } of this.spinners) group.quaternion.copy(group.userData.base).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (speed * t) % (2 * Math.PI)));
    for (const { batch, groups } of this.spinBatches ?? []) {
      groups.forEach((group, i) => {
        group.updateMatrix();
        batch.setMatrixAt(i, group.matrix);
      });
      batch.instanceMatrix.needsUpdate = true;
    }
    if (this.engine) this.updateEngine(t);
    for (const { screw, pitch } of this.screws) screw.rotation.y = ((2 * Math.PI * tr.options.riserSpeed * t) / pitch) % (2 * Math.PI);
    this.updateGrinders(t);
    for (const rc of this.recyclers) {
      // Bulles : chacune monte du fond à la surface, en boucle, décalée des autres.
      for (let k = 0; k < rc.bubbles.count; k++) {
        const f = (t * 0.7 + hash(k, rc.x)) % 1;
        this._m.makeTranslation(rc.x + (hash(k, 1) - 0.5) * 0.09, 0.02 + f * 0.07, rc.z + (hash(k, 2) - 0.5) * 0.13);
        rc.bubbles.setMatrixAt(k, this._m);
      }
      rc.bubbles.instanceMatrix.needsUpdate = true;
    }
    for (const view of this.lines) {
      const { line, pool } = view;
      pool.begin();
      if (line.balls.length) {
        const first = lowerBound(line.balls, t - line.after, (b) => b.time);
        if (first < line.balls.length && upperBound(line.balls, t + line.before, (b) => b.time) > first)
          lineBalls(tr, line, t, (ball, p, v, paint, belt, scale) =>
            pool.add(p, v, paint >= 1 ? this.trackColors[ball.track] : paint <= 0 ? RAW : this._c.copy(RAW).lerp(this.trackColors[ball.track], paint), scale),
          );
      }
      if (line.stock) stackBalls(tr, line, t, (p) => pool.add(p, ZERO, RAW, tr.options.rawScale));
      pool.end();
      if (view.hinge) {
        view.hinge.rotation.x = -1.25 * gateOpening(line, t);
        view.hinge.updateMatrix();
        placeRod(view.plunger, view.plungerFrom, view.leverTip.clone().applyMatrix4(view.hinge.matrix));
      }
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
