import * as THREE from 'three';
import { trunkBall } from './trunks.js';
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

/**
 * Rendu du réseau (voir trunks.js) : le labyrinthe de tuyaux de verre posé au sol, les
 * collerettes des plongées, et les billes qui y roulent ou montent dans les colonnes des
 * instruments (les colonnes elles-mêmes sont dessinées par chaque rangée).
 */
export class TrunksView {
  constructor(trunks, trackColors, content) {
    this.trunks = trunks;
    this.trackColors = trackColors;
    const o = trunks.options;
    const g = (this.group = new THREE.Group());
    g.name = 'réseau';
    content.add(g);
    const glass = mat.glass();
    const chrome = mat.chrome();
    const dark = mat.gunmetal();
    const flangeGeo = new THREE.TorusGeometry(o.radius + 0.03, 0.014, 8, 24);
    const plateGeo = new THREE.CylinderGeometry(o.radius + 0.075, o.radius + 0.085, 0.012, 24);
    const saddleGeo = new THREE.BoxGeometry(0.05, o.axisY - o.radius, 0.16);
    const up = new THREE.Vector3(0, 0, 1);
    this.lines = trunks.lines.map((line) => {
      const tube = new THREE.Mesh(sweepGeometry(line.maze.points, o.radius, 10), glass);
      tube.renderOrder = 2;
      g.add(tube);
      // Plongées : platine sombre vissée au sol et collerette chromée.
      for (const [x, , z] of line.grommets) {
        const plate = new THREE.Mesh(plateGeo, dark);
        plate.position.set(x, 0.006, z);
        plate.receiveShadow = true;
        const flange = new THREE.Mesh(flangeGeo, chrome);
        flange.rotation.x = Math.PI / 2;
        flange.position.set(x, 0.02, z);
        g.add(plate, flange);
      }
      // Berceaux : le tuyau repose sur de petites cales, tous les deux mètres.
      for (let s = 1; s < line.maze.length - 1; s += 2) {
        const p = line.maze.pointAt(s);
        if (p[1] < o.axisY - 1e-3) continue;
        const d = line.maze.tangentAt(s);
        const saddle = new THREE.Mesh(saddleGeo, dark);
        saddle.position.set(p[0], (o.axisY - o.radius) / 2, p[2]);
        saddle.quaternion.setFromUnitVectors(up, new THREE.Vector3(d[0], 0, d[2]).normalize());
        saddle.rotateY(Math.PI / 2);
        g.add(saddle);
      }
      // Réservoir : le plus grand nombre de billes en vie à la fois sur la ligne.
      const life = line.before + line.after;
      let most = 0;
      for (let i = 0, j = 0; i < line.balls.length; i++) {
        while (line.balls[i].time - line.balls[j].time > life) j++;
        most = Math.max(most, i - j + 1);
      }
      const pool = new BallPool(g, line.ballRadius, most + 2);
      pool.trails.visible = false; // dans le verre, pas de traînée
      return { line, pool };
    });
    this.pools = this.lines.map((l) => l.pool);
    this._p = [0, 0, 0];
    this._d = [0, 0, 0];
    this._v = [0, 0, 0];
  }

  update(t) {
    const tr = this.trunks;
    const v = tr.options.speed;
    for (const { line, pool } of this.lines) {
      pool.begin();
      const balls = line.balls;
      for (let i = lowerBound(balls, t - line.after, (b) => b.time); i < upperBound(balls, t + line.before, (b) => b.time); i++) {
        if (!trunkBall(tr, line, balls[i], t, this._p, this._d)) continue;
        // Vitesse : le long du tuyau, pour le flou de mouvement.
        this._v[0] = this._d[0] * v;
        this._v[1] = this._d[1] * v;
        this._v[2] = this._d[2] * v;
        pool.add(this._p, this._v, this.trackColors[balls[i].track]);
      }
      pool.end();
    }
  }
}
