import * as THREE from 'three';
import { keyDepth, keyHammerAngle, tineVibration, sustainPedal } from './keys.js';
import { mat } from './materials.js';
import { rod, roundedBox, Piston, V } from './parts.js';

const KEY_TOP = 0.92; // hauteur du dessus des touches blanches
const WHITE_LEN = 0.62;
const BLACK_LEN = 0.39;
const TRAVEL = 0.055; // rotation (rad) d'une touche enfoncée

/** Rendu du clavier mécanique (voir keys.js). */
export class KeysView {
  constructor(model, trackColors, parent) {
    this.model = model;
    this.trackColors = trackColors;
    const g = (this.group = new THREE.Group());
    g.position.set(...model.origin);
    g.rotation.y = model.yaw;
    parent.add(g);

    const kw = model.keyWidth;
    const half = model.width / 2;
    const chrome = mat.steel();
    const dark = mat.gunmetal();
    const body = mat.lacquer(0x0a0a0d, 0.2);
    const felt = mat.rubber();
    const ivory = mat.ivory();
    const ebony = mat.ebony();

    // Meuble : sommier sous les touches, joues, bandeau arrière qui porte les lames.
    const bed = roundedBox(model.width, 0.14, WHITE_LEN + 0.5, 0.03, body);
    bed.position.set(0, KEY_TOP - 0.13, -0.2);
    g.add(bed);
    for (const x of [-half + 0.09, half - 0.09]) {
      const cheek = roundedBox(0.16, 0.2, WHITE_LEN + 0.12, 0.03, body);
      cheek.position.set(x, KEY_TOP - 0.02, 0.05);
      g.add(cheek);
    }
    const combY = KEY_TOP + 0.1;
    const combZ = -0.42;
    const comb = roundedBox(model.width, 0.1, 0.12, 0.02, dark);
    comb.position.set(0, combY - 0.05, combZ);
    this.ledMat = mat.glow(0x49d8ff, 1.5);
    const led = new THREE.Mesh(new THREE.BoxGeometry(model.width - 0.4, 0.014, 0.014), this.ledMat);
    led.position.set(0, KEY_TOP - 0.2, WHITE_LEN / 2 + 0.055);
    g.add(comb, led);
    // Piètement en X.
    for (const x of [-half * 0.72, half * 0.72]) {
      g.add(rod(V(x, 0, -0.5), V(x, KEY_TOP - 0.2, 0.2), 0.028, chrome));
      g.add(rod(V(x, 0, 0.3), V(x, KEY_TOP - 0.2, -0.4), 0.028, chrome));
    }
    g.add(rod(V(-half * 0.72, 0.35, -0.11), V(half * 0.72, 0.35, -0.11), 0.02, chrome));

    const whiteGeo = roundedBox(kw * 0.93, 0.05, WHITE_LEN, 0.008).geometry;
    whiteGeo.translate(0, -0.025, WHITE_LEN / 2);
    const blackGeo = roundedBox(kw * 0.56, 0.085, BLACK_LEN, 0.012).geometry;
    blackGeo.translate(0, 0.0, BLACK_LEN / 2);
    const tineW = Math.max(0.018, kw * 0.42);
    const hammerZ = -0.14; // axe des marteaux, entre le fond des touches et les lames

    this.keyViews = model.keys.map((k) => {
      const played = k.hits.length > 0;
      // Chaque touche pivote autour de son bord arrière.
      const material = played ? (k.black ? mat.ebony() : mat.ivory()) : k.black ? ebony : ivory;
      const mesh = new THREE.Mesh(k.black ? blackGeo : whiteGeo, material);
      mesh.position.set(k.x, KEY_TOP, -WHITE_LEN / 2 + 0.05);
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
      if (!played) return { k, mesh };

      // Lame vibrante, dressée derrière le clavier.
      const tineMat = mat.steel();
      tineMat.emissive = new THREE.Color(0x000000);
      const tineGeo = new THREE.BoxGeometry(tineW, k.tine, 0.012);
      tineGeo.translate(0, k.tine / 2, 0);
      const tine = new THREE.Mesh(tineGeo, tineMat);
      tine.position.set(k.x, combY, combZ);
      tine.castShadow = true;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(tineW * 0.62, 12, 8), tineMat);
      tip.position.y = k.tine;
      tine.add(tip);

      // Marteau : au contact, le bras est horizontal et le feutre touche la lame.
      const hammer = new THREE.Group();
      const strikeY = combY + Math.min(0.14, k.tine * 0.3);
      hammer.position.set(k.x, strikeY, hammerZ);
      const headR = Math.min(0.026, tineW * 0.9);
      const armLen = hammerZ - combZ - 0.006 - headR;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, armLen, 6), chrome);
      arm.rotation.x = Math.PI / 2;
      arm.position.z = -armLen / 2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 12, 8), felt);
      head.position.z = -armLen;
      head.castShadow = true;
      hammer.add(arm, head);
      g.add(tine, hammer);
      return { k, mesh, material, tine, tineMat, hammer };
    });
    g.add(rod(V(-half + 0.2, combY + 0.04, hammerZ), V(half - 0.2, combY + 0.04, hammerZ), 0.012, dark, 8));

    // Pédale de sustain : la pédale au sol tire, par une tringle, la barre d'étouffoirs
    // (feutre) qui s'écarte des lames tant qu'elle est enfoncée.
    const tineTop = Math.min(...model.played.map((k) => k.tine));
    this.damperY = combY + Math.min(0.32, tineTop * 0.6);
    this.damperZ = combZ - 0.035;
    const damper = new THREE.Group();
    const felt2 = roundedBox(model.width - 0.5, 0.05, 0.04, 0.012, mat.rubber());
    felt2.material = new THREE.MeshStandardMaterial({ color: 0x6b1420, roughness: 0.9 });
    const bar = roundedBox(model.width - 0.45, 0.03, 0.03, 0.01, chrome);
    bar.position.z = -0.03;
    damper.add(felt2, bar);
    damper.position.set(0, this.damperY, this.damperZ);
    this.damper = damper;
    this.damperLed = mat.glow(0xff4fa3, 0);
    const damperLed = new THREE.Mesh(new THREE.BoxGeometry(model.width - 0.6, 0.008, 0.008), this.damperLed);
    damperLed.position.set(0, 0.03, 0);
    damper.add(damperLed);
    g.add(damper);
    const pedal = new THREE.Group();
    const plate = roundedBox(0.13, 0.025, 0.32, 0.01, mat.brass());
    plate.position.z = 0.16;
    pedal.add(plate);
    pedal.position.set(0.25, 0.09, 0.12);
    const pedalBox = roundedBox(0.5, 0.08, 0.32, 0.02, dark);
    pedalBox.position.set(0.25, 0.04, 0.0);
    this.pedal = pedal;
    g.add(pedal, pedalBox);
    this.linkage = new Piston(g, { radius: 0.014, body: 0.5, bodyMat: dark });
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  update(t) {
    const m = this.model;
    let glow = 0;
    for (const v of this.keyViews) {
      if (!v.tine) continue;
      const depth = keyDepth(m, v.k, t);
      v.mesh.rotation.x = depth * TRAVEL;
      v.hammer.rotation.x = keyHammerAngle(m, v.k, t);
      const { amp, since, track } = tineVibration(m, v.k, t);
      if (track >= 0) {
        v.tineMat.emissive.copy(this.trackColors[track]);
        v.material.emissive.copy(this.trackColors[track]);
      }
      v.tineMat.emissiveIntensity = amp * 2.6;
      v.material.emissiveIntensity = depth * (v.k.black ? 1.2 : 0.5);
      v.tine.rotation.x = amp > 0.002 ? amp * 0.05 * Math.sin(since * 75) : 0;
      glow = Math.max(glow, amp);
    }
    this.ledMat.emissiveIntensity = 2.5 + 4 * glow;
    const p = sustainPedal(m, t);
    this.pedal.rotation.x = 0.16 * p; // l'avant de la pédale s'enfonce
    this.damper.position.z = this.damperZ - 0.09 * p;
    this.damper.position.y = this.damperY + 0.04 * p;
    this.damperLed.emissiveIntensity = 3 * p;
    this.linkage.update(this._a.set(0.25, 0.1, 0.0), this._b.set(0.25, this.damper.position.y - 0.02, this.damper.position.z - 0.03));
  }
}
