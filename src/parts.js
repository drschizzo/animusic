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

const gearCache = new Map();

/**
 * Roue dentée (dans le plan xy, épaisseur selon z, centrée) : `teeth` dents trapézoïdales
 * entre les rayons `inner` (pied) et `outer` (tête), moyeu percé de `hole`.
 */
export function gearGeometry(teeth, outer, inner, thickness, hole = inner * 0.35) {
  const key = [teeth, outer, inner, thickness, hole].join();
  if (gearCache.has(key)) return gearCache.get(key);
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts = [
      [inner, a],
      [outer, a + step * 0.18],
      [outer, a + step * 0.48],
      [inner, a + step * 0.66],
    ];
    pts.forEach(([r, b], k) => {
      const x = Math.cos(b) * r;
      const y = Math.sin(b) * r;
      if (i === 0 && k === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const holePath = new THREE.Path();
  holePath.absarc(0, 0, hole, 0, Math.PI * 2, true);
  shape.holes.push(holePath);
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: thickness * 0.15, bevelSize: thickness * 0.12, bevelSegments: 1, curveSegments: 24 });
  g.translate(0, 0, -thickness / 2);
  gearCache.set(key, g);
  return g;
}

/** Roue dentée prête à poser (tourne autour de son axe z local). */
export function gear(teeth, outer, inner, thickness, material) {
  const m = new THREE.Mesh(gearGeometry(teeth, outer, inner, thickness), material);
  m.castShadow = m.receiveShadow = true;
  return m;
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
 * Faisceau de câbles souples (gaines, flexibles) : chaque câble est une suite de
 * segments instanciés le long d'une courbe pendante entre deux points. Un seul appel
 * de dessin pour tous les câbles d'un instrument. set(i, a, b, sag) puis commit().
 */
export class CableBundle {
  constructor(parent, count, { radius = 0.018, segments = 14, material = mat.rubber() } = {}) {
    this.segments = segments;
    this.radius = radius;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.InstancedMesh(geo, material, Math.max(1, count * segments));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._d = new THREE.Vector3();
  }

  /** Point du câble i à l'abscisse u (0..1) : corde + flèche parabolique vers le bas. */
  point(a, b, sag, u, out) {
    return out.copy(a).lerp(b, u).setY(a.y + (b.y - a.y) * u - 4 * sag * u * (1 - u));
  }

  /** Pose le câble i entre a et b (même repère que le parent), avec une flèche `sag`. */
  set(i, a, b, sag = 0.2) {
    const n = this.segments;
    this.point(a, b, sag, 0, this._p);
    for (let k = 1; k <= n; k++) {
      this.point(a, b, sag, k / n, this._n);
      const d = this._d.copy(this._n).sub(this._p);
      const len = d.length();
      this._q.setFromUnitVectors(UP, d.divideScalar(Math.max(1e-6, len)));
      this._s.set(this.radius, len * 1.04, this.radius);
      this.mesh.setMatrixAt(i * n + k - 1, this._m.compose(this._p, this._q, this._s));
      this._p.copy(this._n);
    }
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
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
  const mesh = new THREE.Mesh(
    shadowGeo,
    new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: new THREE.Vector2(sx, sz) },
        uHalf: { value: new THREE.Vector2(halfX, halfZ) },
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: 0 },
      },
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
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  mesh.scale.set(sx, 1, sz);
  mesh.renderOrder = -1;
  return fx(mesh);
}
