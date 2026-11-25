import * as THREE from 'three';
import { pipeState } from './pipes.js';

/** Rendu des tubes d'orgue lumineux (voir pipes.js). */
export class PipesView {
  constructor(model, trackColors, parent) {
    this.model = model;
    this.trackColors = trackColors;
    const g = (this.group = new THREE.Group());
    g.position.set(...model.origin);
    g.rotation.y = model.yaw;
    parent.add(g);

    const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd6, roughness: 0.15, metalness: 1 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xd8a84a, roughness: 0.22, metalness: 1 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x9fb4ff,
      roughness: 0.05,
      metalness: 0.2,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const baseH = 0.35;

    // Socle commun
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(model.width, baseH, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x23262f, roughness: 0.3, metalness: 0.9 }),
    );
    plinth.position.y = baseH / 2;
    plinth.castShadow = plinth.receiveShadow = true;
    g.add(plinth);

    const column = new THREE.CylinderGeometry(1, 1, 1, 20);
    column.translate(0, 0.5, 0); // base à y = 0
    this.pipeViews = model.pipes.map((p) => {
      const r = model.spacing * 0.36;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, p.height, 24, 1, true), glass);
      tube.position.set(p.x, baseH + p.height / 2, 0);
      const cap = new THREE.Mesh(new THREE.TorusGeometry(r, 0.025, 8, 24), brass);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(p.x, baseH + p.height, 0);
      const lightMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 0 });
      const light = new THREE.Mesh(column, lightMat);
      light.position.set(p.x, baseH, 0);
      light.scale.set(r * 0.7, 0.001, r * 0.7);
      const valveMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 1, roughness: 0.2, emissive: 0xffffff, emissiveIntensity: 0 });
      const valve = new THREE.Mesh(new THREE.TorusGeometry(r * 1.1, 0.03, 8, 24), valveMat);
      valve.rotation.x = Math.PI / 2;
      valve.position.set(p.x, baseH + 0.04, 0);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.25, 0.08, 24), chrome);
      foot.position.set(p.x, baseH + 0.04, 0);
      g.add(tube, cap, light, valve, foot);
      return { p, light, lightMat, valve, valveMat, color: new THREE.Color() };
    });
  }

  update(t) {
    const m = this.model;
    for (const v of this.pipeViews) {
      const { level, valve, track } = pipeState(m, v.p, t);
      if (track >= 0) v.lightMat.emissive.copy(this.trackColors[track]);
      v.light.scale.y = Math.max(0.001, level * v.p.height);
      v.lightMat.emissiveIntensity = 0.6 + 1.6 * level;
      v.valve.position.y = 0.35 + 0.04 + valve * 0.12;
      v.valveMat.emissiveIntensity = valve * 0.8;
    }
  }
}
