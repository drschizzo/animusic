import * as THREE from 'three';
import { bowPose, bowedString } from './bowed.js';
import { mat, fx } from './materials.js';
import { lathe, rod, roundedBox, V, lamp } from './parts.js';

/** Rendu des cordes frottées (voir bowed.js). */
export class BowedView {
  constructor(model, trackColors, parent) {
    this.model = model;
    this.trackColors = trackColors;
    const o = model.options;
    const R = model.radius;
    const g = (this.group = new THREE.Group());
    g.position.set(...model.origin);
    g.rotation.y = model.yaw;
    parent.add(g);

    const chrome = mat.chrome();
    const gold = mat.gold();
    const dark = mat.gunmetal();
    const wood = mat.wood(0x7a3012);
    const at = (a, r, y) => V(Math.sin(a) * r, y, Math.cos(a) * r);

    // Socle circulaire en bois verni, ceinturé de lumière, et cordier doré.
    const base = lathe(
      [
        [0, 0],
        [R + 0.62, 0],
        [R + 0.62, 0.06],
        [R + 0.5, 0.12],
        [R + 0.5, 0.26],
        [R + 0.38, 0.32],
        [0, 0.32],
      ],
      72,
      wood,
    );
    this.ledMat = mat.glow(0xff8a3d, 2.5);
    const led = new THREE.Mesh(new THREE.TorusGeometry(R + 0.51, 0.014, 8, 96), this.ledMat);
    led.rotation.x = Math.PI / 2;
    led.position.y = 0.2;
    const tail = new THREE.Mesh(new THREE.TorusGeometry(R, 0.035, 10, 96), gold);
    tail.rotation.x = Math.PI / 2;
    tail.position.y = o.bottom;
    g.add(base, led, tail);

    // Mât central et spirale qui tient le haut des cordes.
    const strings = model.strings;
    const tops = strings.map((s) => at(s.angle, R, o.bottom + s.length));
    const topY = Math.max(...tops.map((p) => p.y));
    g.add(rod(V(0, 0.3, 0), V(0, topY + 0.25, 0), 0.07, dark, 20));
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), gold);
    finial.position.set(0, topY + 0.3, 0);
    g.add(finial);
    if (tops.length > 1) {
      const helix = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tops), tops.length * 6, 0.04, 10), wood);
      helix.castShadow = true;
      g.add(helix);
    }
    strings.forEach((s, i) => {
      if (i % 3 !== 0 && i !== strings.length - 1) return;
      g.add(rod(V(0, tops[i].y - 0.05, 0), tops[i], 0.018, chrome, 8));
    });
    // Montants de la cage (entre deux cordes) jusqu'au cordier.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      g.add(rod(at(a, R + 0.08, 0.3), at(a, R * 0.6, o.bottom + 0.05), 0.02, dark, 8));
    }

    // Cordes : âme cuivrée + enveloppe floue lumineuse quand elle vibre.
    const blurGeo = new THREE.LatheGeometry(
      Array.from({ length: 17 }, (_, i) => new THREE.Vector2(Math.sin((Math.PI * i) / 16), i / 16 - 0.5)),
      12,
    );
    const pegGeo = new THREE.SphereGeometry(0.03, 10, 8);
    this.stringViews = strings.map((s) => {
      const r = 0.016 - 0.008 * s.u;
      const coreMat = mat.copper();
      coreMat.emissive = new THREE.Color(0x000000);
      const p = at(s.angle, R, o.bottom + s.length / 2);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, s.length, 8), coreMat);
      core.position.copy(p);
      core.castShadow = true;
      const blurMat = mat.light(0x000000);
      const blur = fx(new THREE.Mesh(blurGeo, blurMat));
      blur.position.copy(p);
      blur.rotation.y = s.angle; // l'enveloppe s'élargit dans la direction du frottement
      blur.scale.set(0.001, s.length, 0.001);
      const peg = new THREE.Mesh(pegGeo, gold);
      peg.position.copy(at(s.angle, R, o.bottom));
      g.add(core, blur, peg);
      return { s, coreMat, blur, blurMat };
    });

    // Archets : chacun sur son anneau, à sa hauteur.
    this.bowViews = model.bows.map((b) => {
      const rail = new THREE.Mesh(new THREE.TorusGeometry(R + 0.6, 0.022, 8, 96), mat.steel());
      rail.rotation.x = Math.PI / 2;
      rail.position.y = b.y + 0.1;
      g.add(rail);
      // Supports de l'anneau.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4 + b.index * 0.3;
        g.add(rod(at(a, R + 0.6, 0.3), at(a, R + 0.6, b.y + 0.1), 0.016, dark, 8));
      }
      const carriage = new THREE.Group();
      const body = roundedBox(0.2, 0.14, 0.16, 0.03, mat.shell());
      body.position.set(0, b.y + 0.1, R + 0.6);
      const eyeMat = mat.glow(0xff8a3d, 1.5);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.018, 0.01), eyeMat);
      eye.position.set(0, b.y + 0.13, R + 0.685);
      carriage.add(body, eye);
      // Bras télescopique vers la cage (se rallonge pour poser l'archet).
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 10), chrome);
      arm.rotation.x = Math.PI / 2;
      const holder = roundedBox(0.12, 0.08, 0.06, 0.015, dark);
      carriage.add(arm, holder);
      // L'archet glisse dans son support, le long de la tangente (axe x local).
      const bow = new THREE.Group();
      const L = o.bowLength;
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.019, L, 10), mat.wood(0x5a2410));
      stick.rotation.z = Math.PI / 2;
      stick.position.z = 0.03;
      const hairMat = mat.glow(0xffffff, 0);
      hairMat.color.set(0xd8d2c0);
      const hair = new THREE.Mesh(new THREE.BoxGeometry(L * 0.94, 0.022, 0.008), hairMat);
      const frog = roundedBox(0.08, 0.05, 0.04, 0.01, mat.ebony());
      frog.position.set(-L / 2 + 0.06, 0, 0.02);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), mat.ivory());
      tip.position.set(L / 2, 0, 0.03);
      bow.add(stick, hair, frog, tip);
      carriage.add(bow);
      g.add(carriage);
      return { b, carriage, arm, holder, bow, hairMat, eyeMat };
    });

    this.lamp = lamp(0xffffff, 0, 8, 1.6);
    this.lamp.position.set(0, 1.6, R + 0.6);
    g.add(this.lamp);
    this._c = new THREE.Color();
  }

  update(t) {
    const m = this.model;
    const R = m.radius;
    let glow = 0;
    for (const v of this.stringViews) {
      const { amp, track, vibrato } = bowedString(m, v.s, t);
      const color = track >= 0 ? this.trackColors[track] : null;
      const on = amp > 0.003;
      v.blur.visible = on;
      if (on) {
        // Frottement : enveloppe large et régulière ; le vibrato la fait respirer.
        const w = amp * (0.045 + 0.01 * Math.sin(t * 90 + v.s.index) + 0.02 * vibrato * Math.sin(t * 34));
        v.blur.scale.set(w, v.s.length, w * 0.35);
        if (color) v.blurMat.color.copy(color).multiplyScalar(0.8 * amp);
      }
      if (color) v.coreMat.emissive.copy(color);
      v.coreMat.emissiveIntensity = amp * 2.5;
      if (amp > glow && color) {
        glow = amp;
        this._c.copy(color);
      }
    }
    for (const v of this.bowViews) {
      const { angle, press, stroke, playing, track } = bowPose(m, v.b, t);
      v.carriage.rotation.y = angle;
      // Archet posé contre la corde (rayon R) ou écarté de 15 cm.
      const z = R + 0.03 + (1 - press) * 0.15;
      const y = v.b.y;
      v.bow.position.set(stroke, y, z);
      v.holder.position.set(0, y, z + 0.05);
      const reach = R + 0.6 - (z + 0.08);
      v.arm.position.set(0, y + 0.05, z + 0.08 + reach / 2);
      v.arm.scale.y = Math.max(0.01, reach);
      const color = track >= 0 ? this.trackColors[track] : null;
      if (color) {
        v.hairMat.emissive.copy(color);
        v.eyeMat.emissive.copy(color);
      }
      v.hairMat.emissiveIntensity = 2.5 * playing * press;
      v.eyeMat.emissiveIntensity = 0.3 + 3 * playing;
    }
    this.lamp.color.copy(this._c);
    this.lamp.intensity = 7 * glow;
    this.ledMat.emissiveIntensity = 0.25 + 3 * glow;
    if (glow > 0) this.ledMat.emissive.copy(this._c);
  }
}
