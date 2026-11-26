import * as THREE from 'three';
import { laserState, laserExpression } from './laser.js';
import { mat, fx } from './materials.js';
import { rod, plinth, lathe, V, lamp } from './parts.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Rendu de la harpe laser (voir laser.js). */
export class LaserView {
  constructor(model, trackColors, parent) {
    this.model = model;
    this.trackColors = trackColors;
    const o = model.options;
    const g = (this.group = new THREE.Group());
    g.position.set(...model.origin);
    g.rotation.y = model.yaw;
    parent.add(g);

    const chrome = mat.chrome();
    const dark = mat.gunmetal();
    const half = model.width / 2;
    const focus = new THREE.Vector3(...model.focus);
    const depth = 1.4 + o.curve * half * half;

    const base = plinth(model.width + 1.2, depth + 0.8, model.origin[1] + 0.001, { bottom: -model.origin[1], color: 0xff4fa3 });
    this.led = base.led;
    base.group.position.z = (o.curve * half * half) / 2;
    g.add(base.group);

    // Potence : deux mâts et un anneau qui porte le cristal.
    for (const x of [-half, half]) {
      g.add(rod(V(x, 0, -0.45), V(x, focus.y + 0.2, -0.45), 0.055, dark));
      g.add(rod(V(x, focus.y + 0.2, -0.45), V(Math.sign(x) * 0.52, focus.y, 0), 0.03, mat.steel()));
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.06, 24), dark);
      foot.position.set(x, 0.03, -0.45);
      g.add(foot);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.03, 12, 64), chrome);
    ring.position.copy(focus);
    ring.castShadow = true;
    this.gimbal = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.018, 10, 56), mat.gold());
    this.gimbal.position.copy(focus);
    g.add(ring, this.gimbal);

    this.crystalMat = new THREE.MeshPhysicalMaterial({
      color: 0xdfe6ff,
      roughness: 0.05,
      metalness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      envMapIntensity: 2.5,
      emissive: 0xffffff,
      emissiveIntensity: 0.05,
      flatShading: true,
    });
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.27, 0), this.crystalMat);
    this.crystal.scale.y = 1.55;
    this.crystal.position.copy(focus);
    this.crystal.castShadow = true;
    g.add(this.crystal);

    // Halo, faisceau vers le ciel et lumière réelle émise par le cristal.
    this.haloMat = mat.light(0x000000);
    this.halo = fx(new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), this.haloMat));
    this.halo.position.copy(focus);
    this.skyMat = mat.light(0x000000);
    const sky = new THREE.CylinderGeometry(0.5, 0.04, 16, 24, 1, true);
    sky.translate(0, 8, 0);
    this.sky = fx(new THREE.Mesh(sky, this.skyMat));
    this.skyMat.side = THREE.DoubleSide;
    this.sky.position.copy(focus);
    this.lamp = lamp(0xffffff, 0, 14, 1.6);
    this.lamp.position.copy(focus);
    g.add(this.halo, this.sky, this.lamp);

    // Rayon subdivisé sur sa longueur : il se courbe avec le pitch bend et ondule avec la modulation.
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 32, true);
    beamGeo.translate(0, 0.5, 0);
    const bendable = (material) => {
      const u = (material.userData.uniforms = { uBend: { value: 0 }, uWave: { value: 0 }, uTime: { value: 0 } });
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uBend; uniform float uWave; uniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            float arch = 4.0 * position.y * (1.0 - position.y);
            transformed.x += uBend * arch + uWave * arch * sin(position.y * 38.0 - uTime * 24.0);`,
          );
      };
      material.customProgramCacheKey = () => 'laser-beam';
      return material;
    };
    const turret = [
      [0.1, 0],
      [0.1, 0.06],
      [0.07, 0.1],
      [0.07, 0.3],
      [0.085, 0.32],
      [0.085, 0.4],
      [0.05, 0.4],
    ];
    this.emitterViews = model.emitters.map((e) => {
      const p = new THREE.Vector3(...e.position);
      const dir = focus.clone().sub(p);
      const len = dir.length();
      dir.normalize();
      const s = Math.min(1, model.spacing / 0.3);
      // Tourelle orientée vers le cristal, posée sur une rotule.
      const head = new THREE.Group();
      head.position.copy(p).addScaledVector(dir, -0.4 * s);
      head.quaternion.setFromUnitVectors(UP, dir);
      const body = lathe(turret, 20, dark);
      body.scale.setScalar(s);
      const irisMat = mat.glow(0xffffff, 0);
      const iris = new THREE.Mesh(new THREE.TorusGeometry(0.07 * s, 0.014 * s, 8, 24), irisMat);
      iris.rotation.x = Math.PI / 2;
      iris.position.y = 0.4 * s;
      head.add(body, iris);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.09 * s, 16, 12), chrome);
      ball.position.copy(head.position);
      const stem = rod(V(p.x, 0, p.z - 0.05), head.position, 0.03 * s, chrome, 10);
      g.add(head, ball, stem);

      const coreMat = bendable(mat.light(0x000000));
      const sheathMat = bendable(mat.light(0x000000));
      const core = fx(new THREE.Mesh(beamGeo, coreMat));
      const sheath = fx(new THREE.Mesh(beamGeo, sheathMat));
      for (const b of [core, sheath]) {
        b.position.copy(p);
        b.quaternion.copy(head.quaternion);
        b.visible = false;
        g.add(b);
      }
      core.scale.set(0.012, len, 0.012);
      sheath.scale.set(0.045, len, 0.045);
      return { e, irisMat, core, sheath, coreMat, sheathMat, len };
    });
    this._c = new THREE.Color();
  }

  update(t) {
    const m = this.model;
    let energy = 0;
    let best = 0;
    this._c.setRGB(0, 0, 0);
    for (const v of this.emitterViews) {
      const { level, valve, track } = laserState(m, v.e, t);
      const color = track >= 0 ? this.trackColors[track] : null;
      if (color) v.irisMat.emissive.copy(color);
      v.irisMat.emissiveIntensity = valve * 2.5;
      const on = level > 0.004;
      v.core.visible = v.sheath.visible = on;
      if (on) {
        // Léger scintillement : le rayon « vit » pendant la note.
        const flicker = 0.9 + 0.1 * Math.sin(t * 47 + v.e.index * 1.7);
        v.coreMat.color.copy(color).lerp(WHITE, 0.6).multiplyScalar(5 * level * flicker);
        v.sheathMat.color.copy(color).multiplyScalar(0.9 * level * flicker);
        const w = 0.6 + 0.4 * level;
        v.sheath.scale.set(0.045 * w, v.len, 0.045 * w);
        // Courbure (en mètres, au milieu du rayon) ramenée à l'échelle locale de chaque gaine.
        const { bend, mod } = laserExpression(m, track, t);
        const arc = bend * 0.45;
        const wave = mod * 0.05;
        for (const [mesh, material] of [[v.core, v.coreMat], [v.sheath, v.sheathMat]]) {
          const u = material.userData.uniforms;
          u.uBend.value = arc / mesh.scale.x;
          u.uWave.value = wave / mesh.scale.x;
          u.uTime.value = t;
        }
        v.irisMat.emissiveIntensity += 1.5 * Math.abs(bend);
      }
      energy += level;
      if (level > best) {
        best = level;
        this._c.copy(color);
      }
    }
    energy = Math.min(1, energy);
    this.crystal.rotation.y = t * 0.7;
    this.gimbal.rotation.set(t * 0.9, t * 0.5, 0);
    this.crystal.scale.set(1 + 0.12 * energy, 1.55 * (1 + 0.12 * energy), 1 + 0.12 * energy);
    if (best > 0) this.crystalMat.emissive.copy(this._c);
    this.crystalMat.emissiveIntensity = 0.05 + 3.5 * energy;
    this.haloMat.color.copy(this._c).multiplyScalar(0.35 * energy);
    this.halo.visible = this.sky.visible = energy > 0.004;
    this.skyMat.color.copy(this._c).multiplyScalar(0.3 * energy);
    this.lamp.color.copy(best > 0 ? this._c : WHITE);
    this.lamp.intensity = 10 * energy;
    this.led.emissiveIntensity = 0.25 + 3 * energy;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
