// Pièces de construction partagées par les vues des instruments.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, fx } from './materials.js';
import { nodes } from './gpu.js';

const UP = new THREE.Vector3(0, 1, 0);
export const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);

/** Tige cylindrique entre deux points. */
export function rod(a, b, radius, material, segments = 14) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, segments), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Boîte aux arêtes adoucies (les arêtes vives ne prennent pas la lumière). */
export function roundedBox(w, h, d, radius = 0.02, material) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(radius, w / 2, h / 2, d / 2)), material);
  m.castShadow = m.receiveShadow = true;
  return m;
}

const KICK = 0.07; // hauteur de la plinthe en retrait au pied des socles et des estrades
const screwGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.004, 8);

/**
 * Corps d'un meuble de scène posé au sol : au-dessus de 30 cm, il repose sur une plinthe
 * en retrait (ombre portée au pied, comme un vrai meuble) ; plus bas, c'est un bloc.
 * Occupe y ∈ [bottom, bottom + height], sans dépasser width × depth.
 */
function cabinet(width, depth, height, bottom, radius) {
  const parts = [];
  const kick = height >= 0.3 ? KICK : 0;
  if (kick) {
    const base = roundedBox(width - 0.06, kick, depth - 0.06, 0.008, mat.rubber());
    base.position.y = bottom + kick / 2;
    parts.push(base);
  }
  const body = roundedBox(width, height - kick, depth, radius, mat.gunmetal());
  body.position.y = bottom + kick + (height - kick) / 2;
  parts.push(body);
  return parts;
}

/**
 * Socle : bloc laqué ceinturé d'un filet lumineux, plaque de facteur en laiton sur la
 * face avant (+z) quand il est assez haut. Occupe y ∈ [bottom, bottom + height].
 * @returns { group, led } led = matériau du filet, à faire pulser depuis la vue
 */
export function plinth(width, depth, height, { bottom = 0, color = 0x49d8ff } = {}) {
  const group = new THREE.Group();
  group.add(...cabinet(width, depth, height, bottom, 0.03));
  if (height >= 0.3 && width >= 0.8) {
    // Plaque posée contre la face (3 mm d'épaisseur), sous le filet lumineux.
    const plate = roundedBox(0.18, 0.055, 0.003, 0.001, mat.brass());
    plate.position.set(width / 2 - 0.22, bottom + KICK + (height - KICK) * 0.42, depth / 2 + 0.0015);
    plate.castShadow = false;
    group.add(plate);
  }
  const led = mat.glow(color, 0.3);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(width + 0.012, 0.022, depth + 0.012), led);
  strip.position.y = bottom + height - Math.min(0.08, height * 0.3);
  const top = roundedBox(width - 0.06, 0.03, depth - 0.06, 0.012, mat.lacquer(0x14161c, 0.4));
  top.position.y = bottom + height + 0.012;
  group.add(strip, top);
  return { group, led };
}

/**
 * Lampe virtuelle : une lumière ponctuelle (couleur, intensité, portée) que la vue pose
 * comme une vraie, mais que la scène confie à l'une des quelques lumières réelles
 * réservées aux instruments (les plus vives à l'image). Le nombre de lumières reste
 * constant : pas de recompilation de tous les shaders quand un instrument entre, et un
 * coût par pixel borné quel que soit le nombre d'instruments.
 */
export function lamp(color = 0xffffff, intensity = 0, distance = 8, decay = 1.6) {
  const o = new THREE.Object3D();
  o.color = new THREE.Color(color);
  o.intensity = intensity;
  o.distance = distance;
  o.decay = decay;
  o.userData.lamp = true;
  o.userData.fx = true;
  return o;
}

/**
 * Estrade d'un gradin : bloc sombre (demi-côtés halfX, halfZ, hauteur h, du sol à h),
 * plateau laqué et filet lumineux dans la couleur de l'instrument sous le rebord.
 */
export function riserBlock(halfX, halfZ, h, color) {
  const group = new THREE.Group();
  group.add(...cabinet(2 * halfX, 2 * halfZ, h, 0, 0.04));
  // Plateau vissé aux quatre coins (têtes posées sur le plateau, hors de l'emprise de l'instrument).
  const screws = new THREE.InstancedMesh(screwGeo, mat.chrome(), 4);
  const m = new THREE.Matrix4();
  [-1, 1].forEach((sx, i) => [-1, 1].forEach((sz, j) => screws.setMatrixAt(i * 2 + j, m.makeTranslation(sx * (halfX - 0.1), h + 0.004, sz * (halfZ - 0.1)))));
  group.add(screws);
  const top = roundedBox(2 * halfX - 0.08, 0.03, 2 * halfZ - 0.08, 0.012, mat.lacquer(0x14161c, 0.4));
  top.position.y = h - 0.013; // affleure (2 mm) : l'instrument se pose juste dessus
  top.receiveShadow = true;
  const led = mat.glow(color, 0.3);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(2 * halfX + 0.012, 0.02, 2 * halfZ + 0.012), led);
  strip.position.y = h - 0.06;
  group.add(top, strip);
  return group;
}

const shadowGeo = new THREE.PlaneGeometry(1, 1);
shadowGeo.rotateX(-Math.PI / 2);

/**
 * Ombre de contact posée sur le sol : assombrit le sol (et son reflet) au pied d'un
 * objet, pour qu'il ne paraisse pas flotter. Forme : rectangle arrondi de demi-côtés
 * (halfX, halfZ) et de rayon `radius` (un disque si les demi-côtés sont nuls), qui
 * s'estompe sur la distance `spread`.
 */
export function contactShadow(halfX, halfZ, { radius = 0, spread = 0.35, strength = 0.75, y = 0.004 } = {}) {
  const sx = 2 * (halfX + radius + spread);
  const sz = 2 * (halfZ + radius + spread);
  const uniforms = {
    uSize: { value: new THREE.Vector2(sx, sz) },
    uHalf: { value: new THREE.Vector2(halfX, halfZ) },
    uShape: { value: new THREE.Vector3(radius, spread, strength) },
  };
  const options = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const mesh = new THREE.Mesh(
    shadowGeo,
    nodes?.contactShadow(uniforms, options) ??
    new THREE.ShaderMaterial({
      ...options,
      uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec2 uSize; uniform vec2 uHalf; uniform vec3 uShape; varying vec2 vUv;
        void main() {
          vec2 p = abs((vUv - 0.5) * uSize) - uHalf;
          float d = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - uShape.x;
          float a = 1.0 - smoothstep(0.0, uShape.y, d);
          gl_FragColor = vec4(0.0, 0.0, 0.0, uShape.z * a * a);
        }`,
    }),
  );
  mesh.scale.set(sx, 1, sz);
  mesh.position.y = y;
  mesh.renderOrder = -1;
  return fx(mesh);
}

/** Ombre de contact en disque, centrée en (x, z). */
export function footShadow(x, z, radius, options) {
  const mesh = contactShadow(0, 0, { radius, ...options });
  mesh.position.x = x;
  mesh.position.z = z;
  return mesh;
}

/** Profil de révolution : liste de [rayon, hauteur]. */
export function lathe(profile, segments = 40, material) {
  const m = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments), material);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Couronne de petits éléments identiques (tirants, boulons) autour de l'axe y. */
export function ringOf(count, radius, geometry, material, y = 0) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    p.set(Math.cos(a) * radius, y, Math.sin(a) * radius);
    q.setFromAxisAngle(UP, -a);
    mesh.setMatrixAt(i, m.compose(p, q, s));
  }
  mesh.castShadow = true;
  return mesh;
}

const pistonBody = new THREE.CylinderGeometry(1, 1, 1, 16);
pistonBody.translate(0, 0.5, 0); // de 0 à 1 le long de y

/**
 * Vérin hydraulique entre deux points mobiles : un corps fixé en `a`, une tige chromée
 * qui coulisse et rejoint `b`. update(a, b) en coordonnées du parent.
 */
export class Piston {
  constructor(parent, { radius = 0.035, body = 0.35, bodyMat = mat.gunmetal(), rodMat = mat.chrome(), capMat = null } = {}) {
    this.radius = radius;
    this.length = body;
    this.body = new THREE.Mesh(pistonBody, bodyMat);
    this.rod = new THREE.Mesh(pistonBody, rodMat);
    this.body.castShadow = this.rod.castShadow = true;
    const capGeo = new THREE.SphereGeometry(radius * 1.25, 12, 8);
    this.capA = new THREE.Mesh(capGeo, capMat ?? bodyMat);
    this.capB = new THREE.Mesh(capGeo, capMat ?? bodyMat);
    parent.add(this.body, this.rod, this.capA, this.capB);
    this._d = new THREE.Vector3();
  }

  update(a, b) {
    const d = this._d.copy(b).sub(a);
    const len = Math.max(1e-4, d.length());
    d.divideScalar(len);
    const body = Math.min(this.length, len * 0.92);
    this.body.position.copy(a);
    this.body.quaternion.setFromUnitVectors(UP, d);
    this.body.scale.set(this.radius, body, this.radius);
    this.rod.position.copy(b);
    this.rod.quaternion.setFromUnitVectors(UP, d.negate());
    this.rod.scale.set(this.radius * 0.45, Math.max(1e-3, len - body * 0.6), this.radius * 0.45);
    this.capA.position.copy(a);
    this.capB.position.copy(b);
  }
}

/**
 * Gouttière : demi-cylindre ouvert vers le haut, balayé le long d'une suite de points
 * (axe du demi-cylindre). Les deux faces sont visibles.
 */
export function channelGeometry(points, radius, sides = 14) {
  const pos = [];
  const idx = [];
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    T.subVectors(b, a).normalize();
    B.crossVectors(T, UP).normalize();
    N.crossVectors(B, T).normalize();
    for (let k = 0; k <= sides; k++) {
      const th = Math.PI + (k / sides) * Math.PI;
      pos.push(
        p.x + (Math.cos(th) * B.x + Math.sin(th) * N.x) * radius,
        p.y + (Math.cos(th) * B.y + Math.sin(th) * N.y) * radius,
        p.z + (Math.cos(th) * B.z + Math.sin(th) * N.z) * radius,
      );
      if (i > 0 && k > 0) {
        const r0 = (i - 1) * (sides + 1);
        const r1 = i * (sides + 1);
        idx.push(r0 + k - 1, r1 + k - 1, r0 + k, r0 + k, r1 + k - 1, r1 + k);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Trappe lumineuse au sol : contour de rectangle arrondi (demi-côtés halfX, halfZ) qui
 * brille pendant qu'un instrument sort du sol. Intensité : uniforms.uIntensity.
 */
export function floorHalo(halfX, halfZ, color = 0x49d8ff) {
  const pad = 0.8;
  const sx = 2 * (halfX + pad);
  const sz = 2 * (halfZ + pad);
  const uniforms = {
    uSize: { value: new THREE.Vector2(sx, sz) },
    uHalf: { value: new THREE.Vector2(halfX, halfZ) },
    uColor: { value: new THREE.Color(color) },
    uIntensity: { value: 0 },
  };
  const options = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false };
  const mesh = new THREE.Mesh(
    shadowGeo,
    nodes?.floorHalo(uniforms, options) ??
    new THREE.ShaderMaterial({
      ...options,
      uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec2 uSize; uniform vec2 uHalf; uniform vec3 uColor; uniform float uIntensity; varying vec2 vUv;
        void main() {
          vec2 p = abs((vUv - 0.5) * uSize) - uHalf + 0.12;
          float d = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - 0.12;
          float line = exp(-abs(d) * 40.0) + 0.35 * exp(-abs(d) * 9.0);
          float inside = d < 0.0 ? 0.15 : 0.0;
          gl_FragColor = vec4(uColor * uIntensity * (line + inside), 1.0);
        }`,
    }),
  );
  mesh.scale.set(sx, 1, sz);
  mesh.renderOrder = -1;
  return fx(mesh);
}
