import * as THREE from 'three';
import { keyDepth, keyHammerAngle, tineVibration, sustainPedal } from './keys.js';
import { mat, instanceGlow } from './materials.js';
import { rod, roundedBox, Piston, V } from './parts.js';
import { attachRow } from './ballRowView.js';

const KEY_TOP = 0.92; // hauteur du dessus des touches blanches
const WHITE_LEN = 0.62;
const BLACK_LEN = 0.39;
const TRAVEL = 0.055; // rotation (rad) d'une touche enfoncée

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * Pièces identiques d'un clavier (touches, lames, marteaux) en un seul maillage
 * instancié : un appel de rendu pour toutes au lieu d'un par pièce. Chaque instance a sa
 * matrice et sa lueur (couleur × intensité, voir instanceGlow).
 */
function instanced(geometry, material, count, { cast = false, receive = false } = {}) {
  const mesh = new THREE.InstancedMesh(geometry.clone(), instanceGlow(material), count);
  mesh.geometry.setAttribute('instanceGlow', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.frustumCulled = false; // les instances bougent : la sphère englobante de la géométrie ne vaut rien
  // Pièces solides : l'export glTF et le contrôle des collisions les déplient en pièces.
  mesh.userData.unfold = true;
  return mesh;
}

/** Lueur d'une instance (attribut instanceGlow). */
function glowAt(mesh, i, color, intensity) {
  const a = mesh.geometry.attributes.instanceGlow;
  a.setXYZ(i, color.r * intensity, color.g * intensity, color.b * intensity);
}

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

    // Touches (blanches, noires), lames et leurs têtes, bras et feutres des marteaux : un
    // maillage instancié par sorte de pièce. Mêmes formes et mêmes places qu'une pièce par
    // maillage ; les touches jouées s'allument par leur lueur d'instance.
    const whites = model.keys.filter((k) => !k.black);
    const blacks = model.keys.filter((k) => k.black);
    const played = model.keys.filter((k) => k.hits.length > 0);
    this.whiteKeys = instanced(whiteGeo, mat.ivory(), whites.length, { cast: true, receive: true });
    this.blackKeys = instanced(blackGeo, mat.ebony(), blacks.length, { cast: true, receive: true });
    const tineMat = mat.steel();
    tineMat.emissive = new THREE.Color(0x000000);
    const tineGeo = new THREE.BoxGeometry(tineW, 1, 0.012);
    tineGeo.translate(0, 0.5, 0); // hauteur 1, mise à la longueur de chaque lame par l'instance
    this.tines = instanced(tineGeo, tineMat, played.length, { cast: true });
    const tipMat = mat.steel();
    tipMat.emissive = new THREE.Color(0x000000);
    this.tips = instanced(new THREE.SphereGeometry(tineW * 0.62, 12, 8), tipMat, played.length);
    const headR = Math.min(0.026, tineW * 0.9);
    const armLen = hammerZ - combZ - 0.006 - headR;
    // Bras couché le long de -z, feutre au bout : posés dans la géométrie, l'instance ne
    // porte que la position et l'angle du marteau.
    const armGeo = new THREE.CylinderGeometry(0.006, 0.006, armLen, 6);
    armGeo.rotateX(Math.PI / 2);
    armGeo.translate(0, 0, -armLen / 2);
    const headGeo = new THREE.SphereGeometry(headR, 12, 8);
    headGeo.translate(0, 0, -armLen);
    this.arms = instanced(armGeo, mat.steel(), played.length);
    this.heads = instanced(headGeo, mat.rubber(), played.length, { cast: true });
    g.add(this.whiteKeys, this.blackKeys, this.tines, this.tips, this.arms, this.heads);

    const slot = new Map([...whites.map((k, i) => [k, i]), ...blacks.map((k, i) => [k, i])]);
    this.keyViews = model.keys.map((k) => {
      const v = { k, keys: k.black ? this.blackKeys : this.whiteKeys, key: slot.get(k), at: new THREE.Vector3(k.x, KEY_TOP, -WHITE_LEN / 2 + 0.05) };
      if (k.hits.length > 0) {
        v.slot = played.indexOf(k);
        v.tineAt = new THREE.Vector3(k.x, combY, combZ);
        v.hammerAt = new THREE.Vector3(k.x, combY + Math.min(0.14, k.tine * 0.3), hammerZ);
      }
      return v;
    });
    this.pose(0, true);
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
    attachRow(this, model, trackColors, g);
  }

  /**
   * Pose les instances à l'instant t (au repos si `rest`) : touches enfoncées, marteaux,
   * lames qui vibrent et leurs lueurs. Rend l'amplitude de la lame la plus vive.
   */
  pose(t, rest = false) {
    const m = this.model;
    let glow = 0;
    for (const v of this.keyViews) {
      const depth = rest || v.slot === undefined ? 0 : keyDepth(m, v.k, t);
      v.keys.setMatrixAt(v.key, _m.makeRotationX(depth * TRAVEL).setPosition(v.at));
      if (v.slot === undefined) continue;
      const hammer = rest ? 0 : keyHammerAngle(m, v.k, t);
      const { amp, since, track } = rest ? { amp: 0, since: 0, track: -1 } : tineVibration(m, v.k, t);
      if (track >= 0) v.color = this.trackColors[track];
      const color = v.color ?? _c.setRGB(0, 0, 0);
      glowAt(v.keys, v.key, color, depth * (v.k.black ? 1.2 : 0.5));
      glowAt(this.tines, v.slot, color, amp * 2.6);
      glowAt(this.tips, v.slot, color, amp * 2.6);
      // Lame : dressée à sa longueur, elle bat autour de son pied ; sa tête la suit.
      _r.makeRotationX(amp > 0.002 ? amp * 0.05 * Math.sin(since * 75) : 0).setPosition(v.tineAt);
      this.tines.setMatrixAt(v.slot, _m.multiplyMatrices(_r, _s.makeScale(1, v.k.tine, 1)));
      this.tips.setMatrixAt(v.slot, _m.multiplyMatrices(_r, _s.makeTranslation(0, v.k.tine, 0)));
      _m.makeRotationX(hammer).setPosition(v.hammerAt);
      this.arms.setMatrixAt(v.slot, _m);
      this.heads.setMatrixAt(v.slot, _m);
      glow = Math.max(glow, amp);
    }
    for (const mesh of [this.whiteKeys, this.blackKeys, this.tines, this.tips, this.arms, this.heads]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.attributes.instanceGlow.needsUpdate = true;
    }
    return glow;
  }

  update(t) {
    const m = this.model;
    this.rowView?.update(t);
    const glow = this.pose(t);
    this.ledMat.emissiveIntensity = 0.25 + 3 * glow;
    const p = sustainPedal(m, t);
    this.pedal.rotation.x = 0.16 * p; // l'avant de la pédale s'enfonce
    this.damper.position.z = this.damperZ - 0.09 * p;
    this.damper.position.y = this.damperY + 0.04 * p;
    this.damperLed.emissiveIntensity = 3 * p;
    this.linkage.update(this._a.set(0.25, 0.1, 0.0), this._b.set(0.25, this.damper.position.y - 0.02, this.damper.position.z - 0.03));
  }
}
