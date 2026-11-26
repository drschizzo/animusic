import * as THREE from 'three';
import { BallPool } from './ballPool.js';
import { polyline } from './ballistics.js';
import { mat, fx } from './materials.js';
import { lathe, rod, V } from './parts.js';
import { upperBound } from './util.js';

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
    const hornProfile = [
      [r, -reach],
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
      const horn = lathe(hornProfile, 28, brass);
      horn.position.copy(caught);
      horn.quaternion.setFromUnitVectors(UP, into.clone().negate());
      const bottom = new THREE.Mesh(discGeo, bore);
      bottom.position.copy(caught).addScaledVector(into, st.hideOut + 0.06);
      bottom.quaternion.setFromUnitVectors(Z, into);
      this.catchRings.setMatrixAt(i, m.compose(caught.clone().addScaledVector(into, -0.008), q.setFromUnitVectors(Z, into), one));
      group.add(nozzle, collar, back, horn, bottom);
    });

    this.pool = new BallPool(group, row.ballRadius, row.maxBalls);
    this.balls = this.pool.balls;
    this.trails = this.pool.trails;
    this._c = new THREE.Color();
    this._idle = new THREE.Color(0xffc46b).multiplyScalar(0.12);
  }

  update(t) {
    const row = this.row;
    this.pool.drawStations(t, row.shots, row, this.trackColors);
    row.stations.forEach((st, i) => {
      const glow = (mesh, offset) => {
        const k = upperBound(st.shots, t - offset, (s) => s.time) - 1;
        const level = k >= 0 ? (0.4 + 0.6 * st.shots[k].velocity) * Math.exp(-(t - offset - st.shots[k].time) * 11) : 0;
        if (k >= 0) this._c.copy(this.trackColors[st.shots[k].track]).multiplyScalar(5 * level).add(this._idle);
        else this._c.copy(this._idle);
        mesh.setColorAt(i, this._c);
      };
      glow(this.nozzleRings, -st.flightIn);
      glow(this.catchRings, st.flightOut);
    });
    this.nozzleRings.instanceColor.needsUpdate = true;
    this.catchRings.instanceColor.needsUpdate = true;
  }
}
