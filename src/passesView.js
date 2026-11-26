import * as THREE from 'three';
import { launcherPose } from './choreography.js';
import { BallPool } from './ballPool.js';
import { mat, fx } from './materials.js';
import { lathe, ringOf, V } from './parts.js';

const UP = new THREE.Vector3(0, 1, 0);
const boltGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.02, 8);

/**
 * Canons de passe (voir passes.js) : un mât derrière l'instrument qui tire, une rotule,
 * un fût qui vise la cible avant chaque tir, recule et tremble après. Le mât est monté
 * sur l'élévateur de son instrument (il sort du sol avec lui) ; les billes volent d'un
 * instrument à l'autre, donc dans le repère de la scène.
 */
export class PassesView {
  constructor(passes, trackColors, lifts, content) {
    this.passes = passes;
    this.trackColors = trackColors;
    const steel = mat.steel();
    const dark = mat.gunmetal();
    const chrome = mat.chrome();
    const gold = mat.gold();
    const bore = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.aim = { options: { aimWindow: passes.options.aimWindow } };
    this.barrels = new Set(); // maillages des fûts (la bille en sort : exclus du contrôle des collisions)
    // Un mât par canon : celui de la tourelle du marimba sert plusieurs instruments.
    const mounts = [...new Map(passes.cannons.map((c) => [c.mount, c])).values()];
    this.pools = passes.cannons.map((c) => ({ c, pool: new BallPool(content, c.ballRadius, c.maxBalls, { comet: true }) }));
    this.cannons = mounts.map((c) => {
      const lift = lifts[c.sender];
      const [px, py, pz] = c.pivot;
      const L = c.barrel;
      const r = c.ballRadius + 0.02; // âme du fût
      // Mât : embase boulonnée, colonne effilée, collier lumineux dans la couleur de l'instrument qui tire.
      const mast = lathe(
        [
          [0.2, 0],
          [0.2, 0.05],
          [0.1, 0.12],
          [0.07, py - 0.5],
          [0.055, py - 0.12],
        ],
        20,
        dark,
      );
      mast.position.set(px, c.baseY, pz);
      mast.scale.y = (py - c.baseY) / py;
      const bolts = ringOf(6, 0.16, boltGeo, chrome, 0.06);
      bolts.position.set(px, c.baseY, pz);
      const ledMat = mat.glow(0xffc46b, 0.4);
      const led = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.012, 8, 28), ledMat);
      led.rotation.x = Math.PI / 2;
      led.position.set(px, py - 0.5, pz);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), chrome);
      joint.position.set(px, py, pz);
      joint.castShadow = true;
      lift.add(mast, bolts, led, joint);

      const barrel = new THREE.Group();
      const tube = lathe(
        [
          [0, -0.14],
          [r + 0.035, -0.14],
          [r + 0.05, -0.1],
          [r + 0.05, 0.02],
          [r + 0.03, 0.06],
          [r + 0.022, L - 0.14],
          [r + 0.04, L - 0.12],
          [r + 0.04, L - 0.015],
          [r + 0.028, L],
          [r, L],
          [r, L - 0.4],
        ],
        24,
        steel,
      );
      const band = new THREE.Mesh(new THREE.TorusGeometry(r + 0.034, 0.012, 8, 24), gold);
      band.rotation.x = Math.PI / 2;
      band.position.y = 0.2;
      const ringMat = mat.glow(0xffffff, 0);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.03, 0.014, 8, 24), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = L - 0.07;
      const hole = new THREE.Mesh(new THREE.CircleGeometry(r, 16), bore);
      hole.rotation.x = -Math.PI / 2;
      hole.position.y = L - 0.39;
      const flashMat = mat.light(0x000000);
      const flash = fx(new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), flashMat));
      flash.position.y = L + 0.04;
      barrel.add(tube, band, ring, hole, flash);
      barrel.position.set(px, py, pz);
      barrel.traverse((o) => this.barrels.add(o));
      lift.add(barrel);
      // Le mât n'est pas une pièce de l'instrument : hors de son encombrement déclaré.
      for (const o of [mast, bolts, led, joint, barrel]) o.traverse((x) => (x.userData.pass = true));

      return { c, barrel, ringMat, flashMat, flash, ledMat, pivot: new THREE.Vector3(px, py, pz), launcher: { shots: c.launches, restDir: c.restDir } };
    });
    this._dir = new THREE.Vector3();
    this._h = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  update(t) {
    for (const { c, pool } of this.pools) pool.drawStations(t, c.shots, c, this.trackColors);
    for (const v of this.cannons) {
      const c = v.c;
      const { dir, recoil, shake } = launcherPose(this.aim, v.launcher, t);
      this._dir.set(dir[0], dir[1], dir[2]);
      v.barrel.quaternion.setFromUnitVectors(UP, this._dir);
      // Tremblement après le tir : petite rotation autour de l'axe horizontal du fût.
      this._h.set(this._dir.x, 0, this._dir.z);
      if (this._h.lengthSq() < 1e-8) this._h.set(1, 0, 0);
      this._h.normalize();
      this._axis.set(-this._h.z, 0, this._h.x);
      v.barrel.quaternion.premultiply(this._q.setFromAxisAngle(this._axis, shake));
      v.barrel.position.copy(v.pivot).addScaledVector(this._dir, -0.12 * recoil);
      v.ringMat.emissiveIntensity = 0.25 + 5 * recoil;
      v.flash.visible = recoil > 0.02;
      v.flashMat.color.setRGB(1, 0.8, 0.5).multiplyScalar(0.9 * recoil * recoil);
      v.flash.scale.setScalar(0.5 + recoil);
      v.ledMat.emissive.copy(this.trackColors[c.track] ?? this.trackColors[0]);
      v.ledMat.emissiveIntensity = 0.4 + 4 * recoil;
    }
  }
}
