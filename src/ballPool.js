import * as THREE from 'three';
import { mat, fx } from './materials.js';
import { stationBall } from './ballistics.js';
import { lowerBound, upperBound } from './util.js';

const TRAIL_STEP = 0.012; // écart (s) entre deux fantômes d'une bille
const VELOCITY_STEP = 1 / 120; // pas (s) de la différence qui donne la vitesse d'une bille

const TRAIL = 5; // fantômes lumineux derrière chaque bille (qualité moyenne et basse)

/**
 * Réservoir de billes instanciées : chrome teinté par la couleur de la piste, vitesse
 * par instance (flou de mouvement), fantômes lumineux quand le vrai flou est coupé.
 * Usage, à chaque image : begin() ; add(…) et ghost(…) pour chaque bille ; end().
 */
export class BallPool {
  /** @param options comet : traînée longue et vive, toujours visible (billes de passe, vues de loin) */
  constructor(parent, radius, count, { comet = false } = {}) {
    this.trailStep = comet ? 0.028 : TRAIL_STEP;
    this.trailGain = comet ? 2.5 : 0.22;
    this.trailSize = comet ? 2.2 : 1;
    const pool = Math.max(1, count);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.14, envMapIntensity: 1.6 });
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor * 0.4;\n#endif',
      );
    };
    const balls = (this.balls = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 24, 16), material, pool));
    balls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pool * 3), 3);
    // Vitesse de chaque bille (m/s), lue par le tampon géométrique pour le flou de mouvement.
    this.velocity = new THREE.InstancedBufferAttribute(new Float32Array(pool * 3), 3);
    balls.geometry.setAttribute('instanceVelocity', this.velocity);
    balls.castShadow = true;
    balls.frustumCulled = false;
    balls.count = 0;
    const trails = (this.trails = fx(new THREE.InstancedMesh(new THREE.SphereGeometry(radius * 0.9, 10, 8), mat.light(0xffffff), pool * TRAIL)));
    trails.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pool * TRAIL * 3), 3);
    trails.frustumCulled = false;
    trails.count = 0;
    parent.add(balls, trails);
    this.trailLength = TRAIL;
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
    this.n = 0;
    this.k = 0;
    this._p = [0, 0, 0];
    this._q = [0, 0, 0];
    this._v = [0, 0, 0];
  }

  /**
   * Pose les billes de stations (voir ballistics.js) en vie à l'instant t.
   * @param shots [{ time, station, track }] triées par instant de frappe
   * @param span { before, after } vie maximale d'une bille autour de sa frappe
   */
  drawStations(t, shots, span, trackColors) {
    this.begin();
    const first = lowerBound(shots, t - span.after, (s) => s.time);
    const last = upperBound(shots, t + span.before, (s) => s.time);
    for (let i = first; i < last; i++) {
      const shot = shots[i];
      const st = shot.station;
      const dt = t - shot.time;
      const hold = shot.hold ?? 0;
      if (!stationBall(st, dt, this._p, hold)) continue;
      const color = trackColors[shot.track];
      // Vitesse exacte : écart de trajectoire sur 1/120 s (nulle à la naissance).
      if (stationBall(st, dt - VELOCITY_STEP, this._q, hold)) for (let c = 0; c < 3; c++) this._v[c] = (this._p[c] - this._q[c]) / VELOCITY_STEP;
      else this._v[0] = this._v[1] = this._v[2] = 0;
      this.add(this._p, this._v, color);
      // Pas de fantôme dans les tuyaux : il brillerait à travers le métal.
      if (dt >= hold + st.flightOut || (dt >= 0 && dt < hold)) continue;
      for (let j = 1; j <= TRAIL; j++) {
        const dj = dt - j * this.trailStep;
        if (dj < -st.flightIn) break;
        stationBall(st, dj, this._q, hold);
        this.ghost(this._q, color, j);
      }
    }
    this.end();
  }

  begin() {
    this.n = 0;
    this.k = 0;
  }

  /** Bille au point p (tableau), de vitesse v (m/s), dans la couleur donnée. */
  add(p, v, color) {
    if (this.n >= this.balls.instanceMatrix.count) return;
    this.balls.setMatrixAt(this.n, this._m.makeTranslation(p[0], p[1], p[2]));
    this.balls.setColorAt(this.n, color);
    this.velocity.setXYZ(this.n, v[0], v[1], v[2]);
    this.n++;
  }

  /** Fantôme n° j (1 = le plus proche de la bille) au point p. */
  ghost(p, color, j) {
    if (this.k >= this.trails.instanceMatrix.count) return;
    const f = 1 - j / (TRAIL + 1);
    const size = f * this.trailSize;
    this.trails.setMatrixAt(this.k, this._m.makeScale(size, size, size).setPosition(p[0], p[1], p[2]));
    this.trails.setColorAt(this.k, this._c.copy(color).multiplyScalar(this.trailGain * f * f));
    this.k++;
  }

  end() {
    this.balls.count = this.n;
    this.balls.instanceMatrix.needsUpdate = true;
    this.balls.instanceColor.needsUpdate = true;
    this.velocity.needsUpdate = true;
    this.trails.count = this.k;
    this.trails.instanceMatrix.needsUpdate = true;
    this.trails.instanceColor.needsUpdate = true;
  }
}
