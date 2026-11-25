// Pièces de construction partagées par les vues des instruments.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, fx } from './materials.js';

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

/**
 * Socle : bloc laqué ceinturé d'un filet lumineux. Occupe y ∈ [bottom, bottom + height].
 * @returns { group, led } led = matériau du filet, à faire pulser depuis la vue
 */
export function plinth(width, depth, height, { bottom = 0, color = 0x49d8ff } = {}) {
  const group = new THREE.Group();
  const body = roundedBox(width, height, depth, 0.03, mat.gunmetal());
  body.position.y = bottom + height / 2;
  const led = mat.glow(color, 3);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(width + 0.012, 0.022, depth + 0.012), led);
  strip.position.y = bottom + height - Math.min(0.08, height * 0.3);
  const top = roundedBox(width - 0.06, 0.03, depth - 0.06, 0.012, mat.lacquer(0x14161c, 0.4));
  top.position.y = bottom + height + 0.012;
  group.add(body, strip, top);
  return { group, led };
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
  const mesh = new THREE.Mesh(
    shadowGeo,
    new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: new THREE.Vector2(sx, sz) },
        uHalf: { value: new THREE.Vector2(halfX, halfZ) },
        uShape: { value: new THREE.Vector3(radius, spread, strength) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec2 uSize; uniform vec2 uHalf; uniform vec3 uShape; varying vec2 vUv;
        void main() {
          vec2 p = abs((vUv - 0.5) * uSize) - uHalf;
          float d = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - uShape.x;
          float a = 1.0 - smoothstep(0.0, uShape.y, d);
          gl_FragColor = vec4(0.0, 0.0, 0.0, uShape.z * a * a);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
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
