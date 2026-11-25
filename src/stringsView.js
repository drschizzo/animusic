import * as THREE from 'three';
import { carrierPose, stringVibration } from './strings.js';

/** Rendu de la basse à cordes pincées (voir strings.js). */
export class StringsView {
  constructor(model, trackColors, parent) {
    this.model = model;
    this.trackColors = trackColors;
    const o = model.options;
    const g = (this.group = new THREE.Group());
    g.position.set(...model.origin);
    g.rotation.y = model.yaw;
    parent.add(g);

    const frame = new THREE.MeshStandardMaterial({ color: 0x23262f, roughness: 0.3, metalness: 0.9 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd6, roughness: 0.15, metalness: 1 });
    const strings = model.strings;
    const x0 = strings[0].x - 0.3;
    const x1 = strings[strings.length - 1].x + 0.3;
    const topL = o.bottom + strings[0].length;
    const topR = o.bottom + strings[strings.length - 1].length;

    // Châssis en forme de harpe : chevalet bas, poutre haute inclinée, deux montants.
    const beam = (a, b, r) => {
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), frame);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.castShadow = true;
      g.add(m);
    };
    const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);
    beam(V(x0, o.bottom - 0.05), V(x1, o.bottom - 0.05), 0.07);
    beam(V(x0, topL + 0.05), V(x1, topR + 0.05), 0.07);
    beam(V(x0, 0), V(x0, topL + 0.12), 0.08);
    beam(V(x1, 0), V(x1, topR + 0.12), 0.08);

    // Cordes : âme métallique + enveloppe floue qui s'élargit quand la corde vibre.
    const lathe = new THREE.LatheGeometry(
      Array.from({ length: 17 }, (_, i) => new THREE.Vector2(Math.sin((Math.PI * i) / 16), i / 16 - 0.5)),
      16,
    );
    this.stringViews = strings.map((s) => {
      const r = 0.022 - 0.01 * s.u;
      const coreMat = new THREE.MeshStandardMaterial({ color: 0xd8c9a0, roughness: 0.3, metalness: 1, emissive: 0x000000 });
      const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, s.length, 8), coreMat);
      core.position.set(s.x, o.bottom + s.length / 2, 0);
      const blurMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const blur = new THREE.Mesh(lathe, blurMat);
      blur.position.copy(core.position);
      blur.scale.set(0.001, s.length, 0.001);
      core.castShadow = true;
      g.add(core, blur);
      // Chevilles
      for (const y of [o.bottom, o.bottom + s.length]) {
        const peg = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), chrome);
        peg.position.set(s.x, y, 0);
        g.add(peg);
      }
      return { s, coreMat, blur, blurMat };
    });

    // Rail des chariots, devant les cordes (côté +z).
    const railZ = 0.45;
    beam(V(x0, o.pickY, railZ), V(x1, o.pickY, railZ), 0.035);
    beam(V(x0, 0, railZ), V(x0, o.pickY, railZ), 0.03);
    beam(V(x1, 0, railZ), V(x1, o.pickY, railZ), 0.03);

    this.carrierViews = model.carriers.map(() => {
      const c = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.16), new THREE.MeshStandardMaterial({ color: 0xd9dde6, roughness: 0.35, metalness: 0.3 }));
      body.position.z = railZ;
      body.castShadow = true;
      const armLen = railZ - 0.05;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, armLen, 8), chrome);
      arm.rotation.x = Math.PI / 2;
      arm.position.z = railZ - armLen / 2;
      const pickMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffffff, emissiveIntensity: 0.2 });
      const pick = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.1, 3), pickMat);
      pick.rotation.x = -Math.PI / 2; // pointe vers les cordes
      pick.scale.z = 0.3;
      pick.position.z = 0;
      c.add(body, arm, pick);
      c.position.y = o.pickY;
      g.add(c);
      return { c, pickMat };
    });
  }

  update(t) {
    const m = this.model;
    for (const v of this.stringViews) {
      const { amp, since, track } = stringVibration(m, v.s, t);
      const color = track >= 0 ? this.trackColors[track] : null;
      // Vibration visible : l'enveloppe « flou de mouvement » oscille légèrement en largeur.
      const width = amp > 0.002 ? amp * (0.07 + 0.015 * Math.sin(since * 90)) : 0.001;
      v.blur.scale.x = v.blur.scale.z = width;
      v.blurMat.opacity = Math.min(0.6, amp * 0.6);
      if (color) {
        v.blurMat.color.copy(color);
        v.coreMat.emissive.copy(color);
      }
      v.coreMat.emissiveIntensity = amp * 1.5;
    }
    m.carriers.forEach((c, i) => {
      const { x, z } = carrierPose(m, c, t);
      const view = this.carrierViews[i];
      view.c.position.x = x;
      view.c.position.z = z;
      // Le médiator s'illumine au moment du pincement.
      view.pickMat.emissiveIntensity = 0.2 + 2 * Math.max(0, 1 - Math.abs(z) / m.options.pickOffset) ** 4;
    });
  }
}
