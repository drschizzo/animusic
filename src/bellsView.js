import * as THREE from 'three';
import { hammerAngle, bellState } from './bells.js';
import { mat, hdr } from './materials.js';
import { rod, plinth, V } from './parts.js';
import { BallRowView } from './ballRowView.js';

/** Rendu du carillon de cloches tubulaires (voir bells.js). */
export class BellsView {
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
    const felt = mat.rubber();
    const half = model.width / 2;
    const top = o.top;

    // Estrade (jusqu'au sol) et portique.
    // Avec les billes, l'estrade s'avance jusque sous la rampe des buses.
    const row = model.row;
    const front = row ? row.extent.maxZ + 0.25 : 1.1;
    const base = plinth(model.width + 1.2, front + 1.1, model.origin[1] + 0.001, { bottom: -model.origin[1], color: 0xffc46b });
    base.group.position.z = (front - 1.1) / 2;
    this.led = base.led;
    g.add(base.group);
    if (row) {
      this.rowView = new BallRowView(row, trackColors, g);
      this.balls = this.rowView.balls;
      this.trails = this.rowView.trails;
    }
    for (const x of [-half, half]) {
      g.add(rod(V(x, 0, 0), V(x, top + 0.25, 0), 0.07, dark));
      g.add(rod(V(x, 0, -0.42), V(x, top - 0.1, -0.42), 0.045, dark));
      g.add(rod(V(x, top + 0.25, 0), V(x, top - 0.1, -0.42), 0.035, dark));
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), chrome);
      cap.position.set(x, top + 0.27, 0);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 24), dark);
      foot.position.set(x, 0.03, 0);
      g.add(cap, foot);
    }
    g.add(rod(V(-half, top, 0), V(half, top, 0), 0.05, mat.steel(), 20));
    // Rail des marteaux, derrière les cloches.
    const railZ = -0.36;
    const railY = top - o.cord - 0.1;
    if (!row) g.add(rod(V(-half, railY, railZ - 0.06), V(half, railY, railZ - 0.06), 0.03, dark));

    this.bellViews = model.bells.map((b) => {
      const r = model.radius;
      const tubeMat = mat.gold();
      tubeMat.emissive = new THREE.Color(0x000000);
      const pivot = new THREE.Group();
      pivot.position.set(b.x, top, 0);
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, o.cord, 6), felt);
      cord.position.y = -o.cord / 2;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, b.length, 28, 1, true), tubeMat);
      tubeMat.side = THREE.DoubleSide;
      tube.position.y = -o.cord - b.length / 2;
      const rimTop = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 8, 28), chrome);
      rimTop.rotation.x = Math.PI / 2;
      rimTop.position.y = -o.cord;
      const rimBottom = rimTop.clone();
      rimBottom.position.y = -o.cord - b.length;
      tube.castShadow = true;
      pivot.add(cord, tube, rimTop, rimBottom);
      g.add(pivot);
      if (row) return { b, pivot, tubeMat };

      // Marteau : bras horizontal au contact, tête en feutre contre le haut du tube.
      const hammer = new THREE.Group();
      hammer.position.set(b.x, railY, railZ);
      const headR = Math.min(0.04, r * 0.7);
      const armLen = -railZ - r - headR;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, armLen, 8), chrome);
      arm.rotation.x = Math.PI / 2;
      arm.position.z = armLen / 2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 14, 10), felt);
      head.position.z = armLen;
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, Math.min(0.1, model.spacing * 0.6), 12), dark);
      hinge.rotation.z = Math.PI / 2;
      head.castShadow = true;
      hammer.add(arm, head, hinge);
      g.add(hammer);
      return { b, pivot, hammer, tubeMat };
    });
  }

  update(t) {
    const m = this.model;
    let glow = 0;
    for (const v of this.bellViews) {
      if (v.hammer) v.hammer.rotation.x = -hammerAngle(m, v.b, t);
      const { angle, pulse, track } = bellState(m, v.b, t);
      // Le marteau frappe par l'arrière, la bille par l'avant : la cloche part à l'opposé.
      v.pivot.rotation.x = v.hammer ? -angle : angle;
      if (track >= 0) v.tubeMat.emissive.copy(this.trackColors[track]);
      v.tubeMat.emissiveIntensity = pulse * 1.6;
      glow = Math.max(glow, pulse);
    }
    this.led.emissiveIntensity = 0.25 + 3 * glow;
    this.rowView?.update(t);
  }
}
