import * as THREE from 'three';
import { BallPool } from './ballPool.js';
import { polyline, cupLift } from './ballistics.js';
import { mat, fx } from './materials.js';
import { lathe, rod, V } from './parts.js';
import { upperBound } from './util.js';
import { sweepGeometry } from './trunksView.js';

const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** Axe d'un tuyau (polyligne du modèle) vu comme une courbe Three. */
class PathCurve extends THREE.Curve {
  constructor(path) {
    super();
    this.path = path;
    this._p = [0, 0, 0];
  }

  getPoint(u, target = new THREE.Vector3()) {
    this.path.pointAt(this.path.length * u, this._p);
    return target.set(this._p[0], this._p[1], this._p[2]);
  }
}

/** Monte la rangée de billes d'un modèle (s'il en a une) sur sa vue : `view.rowView`, mis à jour par la vue. */
export function attachRow(view, model, trackColors, group) {
  if (!model.row) return;
  view.rowView = new BallRowView(model.row, trackColors, group);
  view.balls = view.rowView.balls;
  view.trails = view.rowView.trails;
}

/**
 * Rendu d'une rangée de stations de billes (voir ballRow.js) : rampe et collecteur,
 * une buse et un cornet par cible, les billes, et l'éclat des bouches au tir et à la
 * capture. Les pièces sont ajoutées à `group` (repère local de l'instrument).
 */
export class BallRowView {
  constructor(row, trackColors, group) {
    this.row = row;
    this.trackColors = trackColors;
    const o = row.options;
    const R = o.pipeRadius;
    const r = row.tubeRadius;
    const steel = Object.assign(mat.steel(), { side: THREE.DoubleSide });
    const brass = Object.assign(mat.brass(), { side: THREE.DoubleSide });
    const chrome = mat.chrome();
    const dark = mat.gunmetal();
    const bore = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });

    // Circuit : collecteur, coude, rampe ; bouchons aux deux bouts.
    const path = polyline(row.loop);
    const pipe = new THREE.Mesh(new THREE.TubeGeometry(new PathCurve(path), Math.ceil(path.length / 0.04), R, 14), steel);
    pipe.castShadow = pipe.receiveShadow = true;
    group.add(pipe);
    for (const p of [row.loop[0], row.loop[row.loop.length - 1]]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 1.02, 16, 10), chrome);
      cap.position.set(...p);
      group.add(cap);
    }
    // Collecteurs supplémentaires (touches noires) : droits, bouchés à gauche, raccordés au coude à droite.
    for (const [a, b] of row.pipes ?? []) {
      group.add(rod(V(...a), V(...b), R, steel, 14));
      const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 1.02, 16, 10), chrome);
      cap.position.set(...a);
      group.add(cap);
    }
    // Colonnes de verre du réseau : elles sortent de l'estrade par une collerette, l'une monte
    // jusqu'au bout de la rampe, l'autre descend du bout du collecteur.
    if (row.risers) {
      const glass = mat.glass();
      for (const pts of [row.risers.feed, row.risers.back]) {
        const column = new THREE.Mesh(sweepGeometry(pts, R, 10), glass);
        column.renderOrder = 2;
        column.name = 'colonne du réseau';
        const foot = pts[0][1] < pts[pts.length - 1][1] ? pts[0] : pts[pts.length - 1];
        const flange = new THREE.Mesh(new THREE.TorusGeometry(R + 0.03, 0.014, 8, 24), chrome);
        flange.rotation.x = Math.PI / 2;
        flange.position.set(foot[0], 0.02, foot[2]);
        const plate = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.075, R + 0.085, 0.012, 24), dark);
        plate.position.set(foot[0], 0.006, foot[2]);
        group.add(column, flange, plate);
      }
    }
    for (const [x, y, z] of row.posts) {
      group.add(rod(V(x, 0, z), V(x, y, z), 0.04, dark, 12));
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.05, 20), dark);
      foot.position.set(x, 0.025, z);
      group.add(foot);
    }
    group.add(rod(V(...row.strut[0]), V(...row.strut[1]), 0.03, dark, 10));

    // Buses et cornets : mêmes pièces pour toutes les cibles.
    const reach = o.reach;
    const nozzleGeo = new THREE.CylinderGeometry(r, r, reach, 16, 1, true);
    nozzleGeo.translate(0, -reach / 2, 0); // de la bouche (origine) vers la rampe (−y)
    const hornProfile = (length) => [
      [r, -length],
      [r, -0.13],
      [r + (row.hornRadius - r) * 0.35, -0.06],
      [row.hornRadius, 0],
      [row.hornRadius + 0.008, 0.01],
    ];
    const discGeo = new THREE.CircleGeometry(r * 0.97, 14);
    const collarGeo = new THREE.TorusGeometry(r + 0.004, 0.007, 6, 20);
    const count = row.stations.length;
    // Anneaux lumineux, instanciés : couleur de la piste, vive au tir et à la capture.
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const rings = (radius, tube) => {
      const mesh = fx(new THREE.InstancedMesh(new THREE.TorusGeometry(radius, tube, 6, 24), ringMat, count));
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    };
    this.nozzleRings = rings(r + 0.005, 0.009);
    this.catchRings = rings(row.hornRadius + 0.004, 0.007);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    row.stations.forEach((st, i) => {
      const mouth = V(...st.mouth);
      const out = V(...st.feed.tangentAt(st.feed.length)); // sens de sortie de la bille
      const nozzle = new THREE.Mesh(nozzleGeo, steel);
      nozzle.position.copy(mouth);
      nozzle.quaternion.setFromUnitVectors(UP, out);
      nozzle.castShadow = true;
      const collar = new THREE.Mesh(collarGeo, chrome);
      collar.position.copy(mouth).addScaledVector(out, -0.06);
      collar.quaternion.setFromUnitVectors(Z, out);
      const back = new THREE.Mesh(discGeo, bore);
      back.position.copy(mouth).addScaledVector(out, -(st.hideIn + 0.06));
      back.quaternion.setFromUnitVectors(Z, out);
      this.nozzleRings.setMatrixAt(i, m.compose(mouth, q.setFromUnitVectors(Z, out), one));

      const caught = V(...st.catch);
      const into = V(...st.drain.tangentAt(0)); // sens d'entrée de la bille
      const horn = lathe(hornProfile(st.drain.length), 28, brass);
      horn.position.copy(caught);
      horn.quaternion.setFromUnitVectors(UP, into.clone().negate());
      const bottom = new THREE.Mesh(discGeo, bore);
      bottom.position.copy(caught).addScaledVector(into, st.hideOut + 0.06);
      bottom.quaternion.setFromUnitVectors(Z, into);
      this.catchRings.setMatrixAt(i, m.compose(caught.clone().addScaledVector(into, -0.008), q.setFromUnitVectors(Z, into), one));
      group.add(nozzle, collar, back, horn, bottom);
    });

    if (row.kind === 'cups') this.buildCups(group, { brass, chrome, dark });
    this.pool = new BallPool(group, row.ballRadius, row.maxBalls);
    this.balls = this.pool.balls;
    this.trails = this.pool.trails;
    this._c = new THREE.Color();
    this._idle = new THREE.Color(0xffc46b).multiplyScalar(0.12);
  }

  /**
   * Coupelles à poussoir : une cuvette de laiton sur une tige qui coulisse dans un
   * fourreau, porté par une traverse. La cuvette et sa tige bougent (instanciées) ; une
   * bague s'allume tant que la bille tient la note.
   */
  buildCups(group, { brass, chrome, dark }) {
    const row = this.row;
    const b = row.ballRadius;
    const count = row.stations.length;
    const Rc = 1.6 * b; // rayon de courbure de la cuvette : la bille repose au fond
    const dishGeo = new THREE.LatheGeometry(
      Array.from({ length: 9 }, (_, i) => {
        const a = (i / 8) * 0.87;
        return new THREE.Vector2(Math.max(1e-4, Rc * Math.sin(a)), Rc * (1 - Math.cos(a)));
      }),
      24,
    );
    const rodLen = 0.24;
    const rodGeo = new THREE.CylinderGeometry(0.011, 0.011, rodLen, 8);
    rodGeo.translate(0, -rodLen / 2, 0);
    const instanced = (geometry, material) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    };
    this.dishes = instanced(dishGeo, brass);
    this.rods = instanced(rodGeo, chrome);
    this.holdRings = fx(new THREE.InstancedMesh(new THREE.TorusGeometry(0.03, 0.008, 6, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), count));
    this.holdRings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.holdRings.frustumCulled = false;
    group.add(this.holdRings);
    const [, y0, z0] = row.stations[0].hit;
    const railY = y0 - b - 0.2;
    const sleeveGeo = new THREE.CylinderGeometry(0.022, 0.026, 0.12, 12);
    const m = new THREE.Matrix4();
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    row.stations.forEach((st, i) => {
      const sleeve = new THREE.Mesh(sleeveGeo, dark);
      sleeve.position.set(st.hit[0], railY + 0.04, z0);
      group.add(sleeve);
      this.holdRings.setMatrixAt(i, m.compose(new THREE.Vector3(st.hit[0], railY + 0.11, z0), flat, new THREE.Vector3(1, 1, 1)));
    });
    // Traverse des fourreaux, sur deux pieds.
    const x0 = row.loop[0][0] + 0.12;
    const x1 = row.posts[1][0] - 0.12;
    group.add(rod(V(x0, railY, z0), V(x1, railY, z0), 0.028, dark, 12));
    for (const x of [x0, x1]) {
      group.add(rod(V(x, 0, z0), V(x, railY, z0), 0.03, dark, 12));
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.04, 16), dark);
      foot.position.set(x, 0.02, z0);
      group.add(foot);
    }
    this._m = new THREE.Matrix4();
  }

  updateCups(t) {
    const row = this.row;
    const b = row.ballRadius;
    row.stations.forEach((st, i) => {
      const k = upperBound(st.shots, t, (s) => s.time) - 1;
      const shot = st.shots[k];
      const lift = shot ? cupLift(st, t - shot.time, shot.hold) : 0;
      const held = shot && t - shot.time < shot.hold;
      this._m.makeTranslation(st.hit[0], st.hit[1] - b + lift, st.hit[2]);
      this.dishes.setMatrixAt(i, this._m);
      this.rods.setMatrixAt(i, this._m);
      if (held) this._c.copy(this.trackColors[shot.track]).multiplyScalar(2.5 + 2.5 * shot.velocity);
      else this._c.copy(this._idle);
      this.holdRings.setColorAt(i, this._c);
    });
    this.dishes.instanceMatrix.needsUpdate = true;
    this.rods.instanceMatrix.needsUpdate = true;
    this.holdRings.instanceColor.needsUpdate = true;
  }

  update(t) {
    const row = this.row;
    if (this.dishes) this.updateCups(t);
    this.pool.drawStations(t, row.shots, row, this.trackColors);
    row.stations.forEach((st, i) => {
      const glow = (mesh, offset) => {
        const k = upperBound(st.shots, t - offset, (s) => s.time) - 1;
        // Une note servie par un canon de passe n'allume pas la buse.
        const fired = k >= 0 && !(st.shots[k].pass && mesh === this.nozzleRings);
        const level = fired ? (0.4 + 0.6 * st.shots[k].velocity) * Math.exp(-(t - offset - st.shots[k].time) * 11) : 0;
        if (k >= 0) this._c.copy(this.trackColors[st.shots[k].track]).multiplyScalar(5 * level).add(this._idle);
        else this._c.copy(this._idle);
        mesh.setColorAt(i, this._c);
      };
      glow(this.nozzleRings, -st.flightIn);
      // Coupelles : le cornet s'allume quand la bille éjectée y tombe, après la tenue de la note.
      const k = row.kind === 'cups' ? upperBound(st.shots, t, (s) => s.time + s.hold) - 1 : -1;
      glow(this.catchRings, st.flightOut + (k >= 0 ? st.shots[k].hold : 0));
    });
    this.nozzleRings.instanceColor.needsUpdate = true;
    this.catchRings.instanceColor.needsUpdate = true;
  }
}
