import * as THREE from 'three';
import { windState } from './winds.js';
import { mat, fx } from './materials.js';
import { plinth, rod, lathe, V } from './parts.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Souffle visible : cône lumineux additif, parcouru d'anneaux qui s'éloignent de la
 * bouche (l'air qui sort). uLevel = intensité du souffle, uTime = temps musical.
 */
function plumeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uLevel: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uLevel; uniform float uTime; varying vec2 vUv;
      void main() {
        float along = clamp(vUv.y, 0.0, 1.0);
        float rings = pow(0.5 + 0.5 * sin(along * 22.0 - uTime * 26.0), 3.0);
        float a = uLevel * (0.25 + 0.75 * rings) * pow(1.0 - along, 1.6);
        gl_FragColor = vec4(uColor * a * 1.6, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

/** Rendu des vents (voir winds.js) : cors et anches à pavillon, ou flûte de Pan. */
export class WindsView {
  constructor(model, trackColors, parent) {
    this.model = model;
    this.trackColors = trackColors;
    const g = (this.group = new THREE.Group());
    parent.add(g);
    this.place();

    const style = model.style;
    const riser = model.origin[1];
    const chrome = mat.chrome();
    const dark = mat.gunmetal();
    const brass = mat.brass();
    brass.side = THREE.DoubleSide;
    const body = style === 'reed' ? mat.ebony() : style === 'flute' ? mat.chrome() : brass;
    const bellMat = style === 'reed' ? chrome.clone() : brass;
    bellMat.side = THREE.DoubleSide;

    // Socle (jusqu'au sol s'il est sur estrade) et nourrice d'air commune à l'arrière.
    const base = plinth(model.width, 1.1, riser + 0.14, { bottom: -riser, color: 0xffc46b });
    this.led = base.led;
    g.add(base.group);
    const deck = 0.14;
    const half = model.width / 2 - 0.25;
    const manifoldY = deck + 0.12;
    g.add(rod(V(-half, manifoldY, -0.38), V(half, manifoldY, -0.38), 0.05, dark, 16));

    const plumeGeo = new THREE.CylinderGeometry(1, 1.9, 1, 28, 1, true); // de la bouche (bas) vers le large (haut)
    plumeGeo.translate(0, 0.5, 0);
    this.pipeViews = model.pipes.map((p) => {
      const L = p.length;
      const v = { p };
      if (style === 'flute') {
        // Flûte de Pan : tuyau vertical ouvert, une buse vient souffler sur son bord.
        const r = 0.05 - 0.015 * p.u;
        const tube = lathe([[r, 0], [r, L], [r * 0.82, L], [r * 0.82, 0.02]], 24, body);
        tube.position.set(p.x, deck, 0);
        g.add(tube);
        const top = deck + L;
        // Buse sur un bras articulé, qui s'abaisse vers le bord du tuyau.
        const nozzle = new THREE.Group();
        nozzle.position.set(p.x, top + 0.12, -0.16);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.16, 10), dark);
        arm.rotation.x = Math.PI / 2;
        arm.position.z = 0.08;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 12), chrome);
        tip.rotation.x = Math.PI / 2;
        tip.position.z = 0.17;
        nozzle.add(arm, tip);
        g.add(nozzle, rod(V(p.x, manifoldY, -0.38), V(p.x, top + 0.12, -0.16), 0.012, dark, 8));
        // Souffle : jet de la buse, puis colonne d'air qui s'échappe par le haut du tuyau.
        const plumeMat = plumeMaterial();
        const plume = fx(new THREE.Mesh(plumeGeo, plumeMat));
        plume.position.set(p.x, top, 0);
        plume.scale.set(r * 0.9, 0.45, r * 0.9);
        const glowMat = mat.light(0x000000);
        const glow = fx(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r * 0.7, L * 0.96, 16, 1, true), glowMat));
        glow.position.set(p.x, deck + L / 2, 0);
        g.add(plume, glow);
        Object.assign(v, { nozzle, plumeMat, glowMat, glow, rest: -0.35 });
        return v;
      }
      // Cor ou anche : tube puis pavillon évasé, pointé vers le public et légèrement vers le haut.
      const rb = 0.17 - 0.07 * p.u; // rayon du pavillon
      const r0 = 0.034 - 0.01 * p.u;
      const horn = new THREE.Group();
      const height = deck + 0.5 + 0.25 * (1 - p.u);
      horn.position.set(p.x, height, -0.3);
      horn.quaternion.setFromUnitVectors(UP, new THREE.Vector3(0, Math.sin(0.25), Math.cos(0.25)));
      const tubeLen = L * 0.62;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(r0, r0, tubeLen, 16), body);
      tube.position.y = tubeLen / 2;
      tube.castShadow = true;
      const flare = [];
      for (let k = 0; k <= 12; k++) {
        const u = k / 12;
        flare.push([r0 + (rb - r0) * u ** 3, tubeLen + (L - tubeLen) * u]);
      }
      const bell = lathe(flare, 36, bellMat);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(rb, 0.012, 8, 36), bellMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = L;
      const mouth = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 1.4, r0 * 0.8, 0.07, 14), chrome);
      mouth.position.y = -0.02;
      // Piston : enfoncé pendant la note (l'air est dirigé vers ce tuyau).
      const pistonMat = mat.glow(0xffffff, 0);
      pistonMat.color.set(0xc0c4cc);
      pistonMat.metalness = 1;
      pistonMat.roughness = 0.25;
      const piston = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.9, r0 * 0.9, 0.16, 12), chrome);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 1.5, r0 * 1.5, 0.025, 16), pistonMat);
      cap.position.y = 0.09;
      piston.add(shaft, cap);
      // Le dessus du tube est du côté −z local (le cor est couché vers le public).
      piston.position.set(0, tubeLen * 0.35, -(r0 + 0.05));
      piston.rotation.x = -Math.PI / 2;
      // Disque lumineux au fond du pavillon et souffle qui en sort.
      const coreMat = mat.light(0x000000);
      const core = fx(new THREE.Mesh(new THREE.CircleGeometry(rb * 0.75, 28), coreMat));
      core.rotation.x = -Math.PI / 2;
      core.position.y = L - 0.03;
      const plumeMat = plumeMaterial();
      const plume = fx(new THREE.Mesh(plumeGeo, plumeMat));
      plume.position.y = L;
      plume.scale.set(rb * 0.95, 0.6 + 0.4 * (1 - p.u), rb * 0.95);
      horn.add(tube, bell, rim, mouth, piston, core, plume);
      g.add(horn);
      // Alimentation : de la nourrice à l'embouchure.
      const mouthWorld = new THREE.Vector3(0, -0.05, 0).applyQuaternion(horn.quaternion).add(horn.position);
      g.add(rod(V(p.x, manifoldY, -0.38), mouthWorld, 0.012, dark, 8));
      Object.assign(v, { horn, bell, piston, pistonMat, coreMat, plumeMat, rest: piston.position.z });
      return v;
    });

    this.lamp = fx(new THREE.PointLight(0xffffff, 0, 8, 1.6));
    this.lamp.position.set(0, 1.4, 0.9);
    g.add(this.lamp);
    this._c = new THREE.Color();
  }

  /** Position et orientation (le placement est décidé par l'arrangeur). */
  place() {
    this.group.position.set(...this.model.origin);
    this.group.rotation.y = this.model.yaw;
  }

  update(t) {
    const m = this.model;
    let energy = 0;
    let best = 0;
    for (const v of this.pipeViews) {
      const { level, valve, track, vibrato } = windState(m, v.p, t);
      const color = track >= 0 ? this.trackColors[track] : null;
      const breath = level * (1 + 0.25 * vibrato * Math.sin(t * 36));
      if (color) {
        v.plumeMat.uniforms.uColor.value.copy(color);
        (v.coreMat ?? v.glowMat).color.copy(color).multiplyScalar(2.5 * breath);
      } else (v.coreMat ?? v.glowMat).color.setRGB(0, 0, 0);
      v.plumeMat.uniforms.uLevel.value = breath;
      v.plumeMat.uniforms.uTime.value = t;
      if (v.nozzle) {
        // La buse s'abaisse sur le bord du tuyau avant la note.
        v.nozzle.rotation.x = v.rest * (1 - valve) + 0.35 * valve;
        v.glow.visible = level > 0.003;
      } else {
        v.piston.position.z = v.rest + 0.05 * valve;
        if (color) v.pistonMat.emissive.copy(color);
        v.pistonMat.emissiveIntensity = 2.5 * valve;
        // Le pavillon vibre pendant la note.
        const s = 1 + 0.035 * level * Math.sin(t * 90 + v.p.index);
        v.bell.scale.set(s, 1, s);
      }
      energy += level;
      if (level > best && color) {
        best = level;
        this._c.copy(color);
      }
    }
    energy = Math.min(1, energy / 2);
    this.lamp.color.copy(this._c);
    this.lamp.intensity = 8 * energy;
    if (best > 0) this.led.emissive.copy(this._c);
    this.led.emissiveIntensity = 2 + 4 * energy;
  }
}
