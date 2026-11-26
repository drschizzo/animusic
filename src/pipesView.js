import * as THREE from 'three';
import { pipeState } from './pipes.js';
import { mat, fx } from './materials.js';
import { plinth, lathe, lamp } from './parts.js';

/** Rendu des tubes d'orgue lumineux (voir pipes.js). */
export class PipesView {
  constructor(model, trackColors, parent) {
    this.model = model;
    this.trackColors = trackColors;
    const g = (this.group = new THREE.Group());
    g.position.set(...model.origin);
    g.rotation.y = model.yaw;
    parent.add(g);

    const chrome = mat.chrome();
    const gold = mat.gold();
    const glass = mat.glass();
    const baseH = (this.baseH = 0.35);

    const base = plinth(model.width, 0.8, baseH, { color: 0x5cff8f });
    this.led = base.led;
    g.add(base.group);

    const column = new THREE.CylinderGeometry(1, 1, 1, 24);
    column.translate(0, 0.5, 0); // base à y = 0
    const r = model.spacing * 0.36;
    const footGeo = new THREE.LatheGeometry(
      [
        [r * 1.45, 0],
        [r * 1.45, 0.03],
        [r * 1.2, 0.06],
        [r * 1.2, 0.11],
        [r * 1.02, 0.13],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
      28,
    );
    const capGeo = new THREE.TorusGeometry(r, 0.024, 10, 32);
    const valveGeo = new THREE.TorusGeometry(r * 1.12, 0.022, 8, 28);
    this.pipeViews = model.pipes.map((p) => {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, p.height, 32, 1, true), glass);
      tube.position.set(p.x, baseH + p.height / 2, 0);
      tube.renderOrder = 2;
      const cap = new THREE.Mesh(capGeo, gold);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(p.x, baseH + p.height, 0);
      cap.castShadow = true;
      const lightMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
      const light = new THREE.Mesh(column, lightMat);
      light.position.set(p.x, baseH + 0.1, 0);
      light.scale.set(r * 0.66, 0.001, r * 0.66);
      const valveMat = mat.glow(0xffffff, 0);
      valveMat.color.set(0x8a8f9c);
      valveMat.metalness = 1;
      valveMat.roughness = 0.2;
      const valve = new THREE.Mesh(valveGeo, valveMat);
      valve.rotation.x = Math.PI / 2;
      valve.position.set(p.x, baseH + 0.15, 0);
      const foot = new THREE.Mesh(footGeo, chrome);
      foot.position.set(p.x, baseH + 0.02, 0);
      foot.castShadow = true;
      g.add(tube, cap, light, valve, foot);
      return { p, light, lightMat, valve, valveMat };
    });

    // La lumière des tubes éclaire réellement les alentours.
    this.lamp = lamp(0xffffff, 0, 12, 1.6);
    this.lamp.position.set(0, baseH + 1.3, 0.5);
    g.add(this.lamp);
    this._c = new THREE.Color();
  }

  update(t) {
    const m = this.model;
    let total = 0;
    let best = 0;
    for (const v of this.pipeViews) {
      const { level, valve, track } = pipeState(m, v.p, t);
      const color = track >= 0 ? this.trackColors[track] : null;
      if (level <= 0.003) v.lightMat.color.setRGB(0, 0, 0);
      else if (color) {
        // Cœur presque blanc à pleine puissance, couleur de la piste autour (halo).
        // Assez vive pour rayonner, pas au point de blanchir : la colonne garde la couleur de sa piste.
        v.lightMat.color.copy(color).lerp(WHITE, 0.1 * level).multiplyScalar(0.4 + 1.1 * level);
      }
      if (color) v.valveMat.emissive.copy(color);
      v.light.scale.y = Math.max(0.001, level * (v.p.height - 0.14));
      v.valve.position.y = this.baseH + 0.15 + valve * 0.12;
      v.valveMat.emissiveIntensity = valve * 1.6;
      total += level;
      if (level > best) {
        best = level;
        this._c.copy(color);
      }
    }
    const energy = Math.min(1, total / 2.5);
    if (best > 0) {
      this.lamp.color.copy(this._c);
      this.led.emissive.copy(this._c);
    }
    this.lamp.intensity = 9 * energy;
    this.led.emissiveIntensity = 0.25 + 3 * energy;

  }
}

const WHITE = new THREE.Color(1, 1, 1);
