import * as THREE from 'three';
import { carrierPose, stringVibration } from './strings.js';
import { mat, fx } from './materials.js';
import { rod, plinth, roundedBox, V } from './parts.js';
import { BallRowView } from './ballRowView.js';

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

    // Basse : châssis laqué sombre ; cordes pincées (guitare, shamisen, harpe) : bois clair.
    const frame = model.style === 'plucked' ? mat.wood(0x9a5a28) : mat.lacquer(0x1a0d10, 0.3);
    const chrome = mat.chrome();
    const gold = mat.gold();
    const dark = mat.gunmetal();
    const strings = model.strings;
    const x0 = strings[0].x - 0.3;
    const x1 = strings[strings.length - 1].x + 0.3;
    const topL = o.bottom + strings[0].length;
    const topR = o.bottom + strings[strings.length - 1].length;

    // Avec les billes, le socle s'avance jusque sous la rampe des buses.
    const row = model.row;
    const front = row ? row.extent.maxZ + 0.25 : 0.95;
    const base = plinth(model.width + 0.5, front + 0.55, 0.12, { color: 0x3dc6ff });
    base.group.position.z = (front - 0.55) / 2;
    this.led = base.led;
    g.add(base.group);

    // Châssis en forme de harpe : chevalet bas, poutre haute inclinée, deux montants.
    g.add(rod(V(x0, o.bottom - 0.05), V(x1, o.bottom - 0.05), 0.07, frame, 20));
    g.add(rod(V(x0, topL + 0.05), V(x1, topR + 0.05), 0.07, frame, 20));
    g.add(rod(V(x0, 0.1), V(x0, topL + 0.12), 0.085, frame, 20));
    g.add(rod(V(x1, 0.1), V(x1, topR + 0.12), 0.085, frame, 20));
    for (const [x, y] of [
      [x0, topL + 0.13],
      [x1, topR + 0.13],
    ]) {
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), gold);
      finial.position.set(x, y, 0);
      finial.castShadow = true;
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.022, 8, 24), gold);
      collar.rotation.x = Math.PI / 2;
      collar.position.set(x, o.bottom + 0.12, 0);
      g.add(finial, collar);
    }

    // Cordes : âme métallique + enveloppe floue qui s'élargit quand la corde vibre.
    const blurGeo = new THREE.LatheGeometry(
      Array.from({ length: 17 }, (_, i) => new THREE.Vector2(Math.sin((Math.PI * i) / 16), i / 16 - 0.5)),
      16,
    );
    const pegGeo = new THREE.SphereGeometry(0.035, 12, 8);
    this.stringViews = strings.map((s) => {
      const r = 0.022 - 0.01 * s.u;
      const coreMat = mat.copper();
      coreMat.emissive = new THREE.Color(0x000000);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, s.length, 10), coreMat);
      core.position.set(s.x, o.bottom + s.length / 2, 0);
      const blurMat = mat.light(0x000000);
      const blur = fx(new THREE.Mesh(blurGeo, blurMat));
      blur.position.copy(core.position);
      blur.scale.set(0.001, s.length, 0.001);
      core.castShadow = true;
      g.add(core, blur);
      for (const y of [o.bottom, o.bottom + s.length]) {
        const peg = new THREE.Mesh(pegGeo, gold);
        peg.position.set(s.x, y, 0);
        g.add(peg);
      }
      return { s, coreMat, blur, blurMat };
    });

    this._c = new THREE.Color();
    if (row) {
      this.carrierViews = [];
      this.rowView = new BallRowView(row, trackColors, g);
      this.balls = this.rowView.balls;
      this.trails = this.rowView.trails;
      return;
    }

    // Rail des chariots, devant les cordes (côté +z).
    const railZ = 0.45;
    g.add(rod(V(x0, o.pickY, railZ), V(x1, o.pickY, railZ), 0.035, mat.steel()));
    g.add(rod(V(x0, 0.1, railZ), V(x0, o.pickY, railZ), 0.03, dark));
    g.add(rod(V(x1, 0.1, railZ), V(x1, o.pickY, railZ), 0.03, dark));

    this.carrierViews = model.carriers.map(() => {
      const c = new THREE.Group();
      const body = roundedBox(0.22, 0.17, 0.17, 0.035, mat.shell());
      body.position.z = railZ;
      const eyeMat = mat.glow(0x3dc6ff, 2);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.012), eyeMat);
      eye.position.set(0, 0.03, railZ + 0.085);
      const armLen = railZ - 0.05;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, armLen, 8), chrome);
      arm.rotation.x = Math.PI / 2;
      arm.position.z = railZ - armLen / 2;
      const pickMat = mat.glow(0xffffff, 0.2);
      const pick = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.1, 3), pickMat);
      pick.rotation.x = -Math.PI / 2; // pointe vers les cordes
      pick.scale.z = 0.3;
      c.add(body, eye, arm, pick);
      c.position.y = o.pickY;
      g.add(c);
      return { c, pickMat, eyeMat };
    });
    this._c = new THREE.Color();
  }

  update(t) {
    const m = this.model;
    let glow = 0;
    for (const v of this.stringViews) {
      const { amp, since, track } = stringVibration(m, v.s, t);
      const color = track >= 0 ? this.trackColors[track] : null;
      // Vibration visible : l'enveloppe « flou de mouvement » oscille légèrement en largeur.
      const width = amp > 0.002 ? amp * (0.07 + 0.015 * Math.sin(since * 90)) : 0.001;
      v.blur.scale.x = v.blur.scale.z = width;
      v.blur.visible = amp > 0.002;
      if (color) {
        v.blurMat.color.copy(color).multiplyScalar(Math.min(0.9, amp * 0.9));
        v.coreMat.emissive.copy(color);
        if (amp > glow) this.led.emissive.copy(color);
      }
      v.coreMat.emissiveIntensity = amp * 3;
      glow = Math.max(glow, amp);
    }
    this.led.emissiveIntensity = 0.25 + 3 * glow;
    this.rowView?.update(t);
    m.carriers.forEach((c, i) => {
      const { x, z, sway, tilt } = carrierPose(m, c, t);
      const view = this.carrierViews[i];
      view.c.position.x = x;
      view.c.position.z = z;
      // Balancement en s'arrêtant, à-coup du médiator au pincement.
      view.c.rotation.z = -sway;
      view.c.rotation.x = tilt;
      // Le médiator s'illumine au moment du pincement.
      const strike = Math.max(0, 1 - Math.abs(z) / m.options.pickOffset) ** 4;
      view.pickMat.emissiveIntensity = 0.2 + 4 * strike;
      view.eyeMat.emissiveIntensity = 0.3 + 4 * strike;
    });
  }
}
