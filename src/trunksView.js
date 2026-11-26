import * as THREE from 'three';
import { feedBall, backBall } from './trunks.js';
import { BallPool } from './ballPool.js';
import { mat } from './materials.js';
import { lathe } from './parts.js';
import { lowerBound, upperBound } from './util.js';

/** Tuyau balayé le long d'une polyligne (repères transportés de proche en proche, sans vrille). */
function sweepGeometry(points, radius, sides = 12) {
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
 * Rendu du réseau (voir trunks.js) : la tour de colonnes de verre sur son socle, les
 * tuyaux d'alimentation et de retour de chaque instrument, et les billes qui y circulent.
 * Tout est fixe, dans le repère de la scène : un instrument qui sort du sol vient se
 * raccorder sous ses tuyaux.
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
    const collarGeo = new THREE.TorusGeometry(o.radius + 0.006, 0.01, 6, 20);
    const collar = (p, dir) => {
      const ring = new THREE.Mesh(collarGeo, chrome);
      ring.position.set(...p);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...dir));
      g.add(ring);
    };
    const gold = mat.gold();
    const capGeo = new THREE.TorusGeometry(o.radius + 0.012, 0.016, 8, 24);
    const footGeo = new THREE.CylinderGeometry(o.radius + 0.03, o.radius + 0.045, 0.1, 20);
    this.lines = trunks.lines.map((line) => {
      // Chaque colonne : pied d'acier sur le socle, bague dorée à la naissance de l'arche.
      for (const [path, tall, foot] of line.back ? [[line.feed, line.tall, line.foot], [line.back, line.tall + 0.5, line.backFoot]] : [[line.feed, line.tall, line.foot]]) {
        const base = new THREE.Mesh(footGeo, dark);
        base.position.set(foot[0], foot[1] + 0.05, foot[2]);
        const cap = new THREE.Mesh(capGeo, gold);
        cap.rotation.x = Math.PI / 2;
        cap.position.set(foot[0], tall, foot[2]);
        g.add(base, cap);
        void path;
      }
      for (const path of line.back ? [line.feed, line.back] : [line.feed]) {
        const tube = new THREE.Mesh(sweepGeometry(path.points, o.radius), glass);
        tube.renderOrder = 2;
        g.add(tube);
        // Colliers chromés : aux deux bouts, et à intervalles réguliers.
        for (let s = 0.15; s < path.length; s += 2.4) collar(path.pointAt(s), path.tangentAt(s));
        collar(path.pointAt(path.length - 0.05), path.tangentAt(path.length - 0.05));
      }
      // Une bille par note : le réservoir couvre le tuyau plein, billes serrées.
      const most = (balls, span) => {
        let max = 0;
        for (let i = 0, j = 0; i < balls.length; i++) {
          while (balls[i].time - balls[j].time > span) j++;
          max = Math.max(max, i - j + 1);
        }
        return max;
      };
      const pool = new BallPool(g, line.ballRadius, most(line.feedBalls, line.feedSpan) + most(line.backBalls, line.backSpan) + 2);
      pool.balls.castShadow = false;
      pool.trails.visible = false; // dans le verre, pas de traînée
      return { line, pool };
    });
    this.pools = this.lines.map((l) => l.pool);
    const c = trunks.colonnade;
    if (c) {
      // Socle en arc de cercle sous la colonnade, souligné d'un filet lumineux.
      const r0 = c.feed - 0.14;
      const r1 = c.back + 0.14;
      const arc = (profile, material) => {
        const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 48, -c.half, 2 * c.half), material);
        mesh.castShadow = mesh.receiveShadow = true;
        g.add(mesh);
        return mesh;
      };
      const body = Object.assign(dark.clone(), { side: THREE.DoubleSide });
      arc([[r0, 0], [r0, c.top], [r1, c.top], [r1, 0]], body);
      this.led = mat.glow(0xffc46b, 0.6);
      arc([[r1 + 0.006, c.top - 0.07], [r1 + 0.006, c.top - 0.05]], Object.assign(this.led, { side: THREE.DoubleSide }));
      // Joues aux deux bouts du socle.
      for (const s of [-1, 1]) {
        const cheek = new THREE.Mesh(new THREE.PlaneGeometry(r1 - r0, c.top), body);
        cheek.position.set(Math.sin(s * c.half) * ((r0 + r1) / 2), c.top / 2, Math.cos(s * c.half) * ((r0 + r1) / 2));
        cheek.rotation.y = s * c.half - Math.PI / 2;
        g.add(cheek);
      }
    }
    this._p = [0, 0, 0];
    this._v = [0, 0, 0];
  }

  update(t) {
    const tr = this.trunks;
    const v = tr.options.speed;
    for (const { line, pool } of this.lines) {
      pool.begin();
      const draw = (balls, from, to, at, path, sign) => {
        for (let i = lowerBound(balls, from, (b) => b.time); i < upperBound(balls, to, (b) => b.time); i++) {
          if (!at(tr, line, balls[i], t, this._p)) continue;
          // Vitesse : le long du tuyau, pour le flou de mouvement.
          const s = sign > 0 ? v * (t - balls[i].time) : path.length - v * (balls[i].time - t);
          const d = path.tangentAt(s);
          this._v[0] = d[0] * v;
          this._v[1] = d[1] * v;
          this._v[2] = d[2] * v;
          pool.add(this._p, this._v, this.trackColors[balls[i].track]);
        }
      };
      draw(line.feedBalls, t, t + line.feedSpan, feedBall, line.feed, -1);
      if (line.back) draw(line.backBalls, t - line.backSpan, t, backBall, line.back, 1);
      pool.end();
    }
  }
}
