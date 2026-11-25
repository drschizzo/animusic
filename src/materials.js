// Bibliothèque de matériaux physiques et de textures procédurales (aucun fichier
// image : tout est dessiné une fois dans des canvas, puis partagé).

import * as THREE from 'three';

const textures = new Map();

/** Bruit de valeur lissé, périodique (raccord invisible quand la texture se répète). */
function makeNoise(seed) {
  const N = 64;
  const grid = new Float32Array(N * N);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < grid.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    grid[i] = (s >>> 0) / 4294967296;
  }
  const at = (x, y) => grid[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * u;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * u;
    return a + (b - a) * v;
  };
}

/** Texture dessinée pixel par pixel : fn(u, v) → [r, v, b] (0..255). Mise en cache par nom. */
function pixelTexture(name, size, fn, { srgb = false, repeat = [1, 1] } = {}) {
  if (textures.has(name)) return textures.get(name);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = fn(x / size, y / size);
      const i = (y * size + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(...repeat);
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  textures.set(name, tex);
  return tex;
}

const gray = (v) => {
  const g = Math.max(0, Math.min(255, Math.round(v * 255)));
  return [g, g, g];
};

/** Veinage de bois (le fil suit l'axe u), en niveaux de brun à teinter. */
function woodTexture() {
  const n = makeNoise(11);
  return pixelTexture(
    'wood',
    256,
    (u, v) => {
      const warp = n(u * 6, v * 5) * 0.35;
      const rings = 0.5 + 0.5 * Math.sin((v * 22 + warp * 9 + n(u * 3, v * 40) * 0.6) * Math.PI);
      const fibre = n(u * 8, v * 64) * 0.35 + n(u * 32, v * 64) * 0.15;
      const k = 0.62 + 0.2 * rings + fibre * 0.45;
      return [255 * Math.min(1, k), 255 * Math.min(1, k * 0.78), 255 * Math.min(1, k * 0.62)];
    },
    { srgb: true },
  );
}

/** Stries de métal brossé (le long de u) : sert de carte de rugosité. */
function brushedTexture() {
  const n = makeNoise(23);
  return pixelTexture('brushed', 256, (u, v) => gray(0.6 + 0.16 * (n(u * 3, v * 64) - 0.5) + 0.12 * (n(u * 9, v * 64 + 17) - 0.5)));
}

/** Marbrures larges : rugosité irrégulière d'un sol poli. */
function blotchTexture() {
  const n = makeNoise(37);
  return pixelTexture('blotch', 256, (u, v) => {
    const a = n(u * 8, v * 8) * 0.55 + n(u * 16, v * 16) * 0.3 + n(u * 32, v * 32) * 0.15;
    return gray(0.25 + 0.75 * a);
  });
}

export const tex = { wood: woodTexture, brushed: brushedTexture, blotch: blotchTexture };

const P = (o) => new THREE.MeshPhysicalMaterial(o);
const S = (o) => new THREE.MeshStandardMaterial(o);

/** Fabriques de matériaux : chaque appel rend un matériau neuf (textures partagées). */
export const mat = {
  chrome: () => S({ color: 0xdfe3ec, roughness: 0.12, metalness: 1 }),
  steel: () => S({ color: 0x9aa1b2, roughness: 0.5, metalness: 1, roughnessMap: brushedTexture() }),
  gunmetal: () => S({ color: 0x23262f, roughness: 0.55, metalness: 0.9, roughnessMap: brushedTexture() }),
  brass: () => S({ color: 0xe0ac4a, roughness: 0.42, metalness: 1, roughnessMap: brushedTexture() }),
  copper: () => S({ color: 0xd9825a, roughness: 0.3, metalness: 1, roughnessMap: brushedTexture() }),
  gold: () => S({ color: 0xffcf6a, roughness: 0.16, metalness: 1 }),
  /** Laque sous vernis (fûts de batterie, carrosserie). */
  lacquer: (color, metalness = 0.55) => P({ color, roughness: 0.42, metalness, clearcoat: 1, clearcoatRoughness: 0.06 }),
  shell: () => P({ color: 0xc4c8d2, roughness: 0.45, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.15 }),
  rubber: () => S({ color: 0x0b0c10, roughness: 0.85, metalness: 0 }),
  wood: (color = 0xb5562a) => P({ color, map: woodTexture(), roughness: 0.42, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.25 }),
  paleWood: () => S({ color: 0xf0d6a4, map: woodTexture(), roughness: 0.55 }),
  skin: () => S({ color: 0xcfcabd, roughness: 0.62, metalness: 0, emissive: 0x000000 }),
  ivory: () => P({ color: 0xc9c5b8, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2, emissive: 0x000000 }),
  ebony: () => P({ color: 0x0c0c0f, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.12, emissive: 0x000000 }),
  glass: () =>
    P({
      color: 0xbfd0ff,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 2.2,
    }),
  /** Surface lumineuse (éteinte par défaut) : l'intensité est pilotée par la vue. */
  glow: (color = 0xffffff, intensity = 0) => S({ color: 0x050506, roughness: 0.4, emissive: color, emissiveIntensity: intensity }),
  /** Lumière pure additive (rayons, halos), ignorée par les ombres et l'occlusion. */
  light: (color = 0xffffff) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
};

/** Couleur vive poussée au-delà de 1 pour déclencher le halo (bloom). */
export const hdr = (color, gain) => color.clone().multiplyScalar(gain);

/** Active les ombres portées et reçues sur un objet et ses descendants opaques. */
export function shadowed(object) {
  object.traverse((o) => {
    if (o.isMesh && !o.material.transparent) o.castShadow = o.receiveShadow = true;
  });
  return object;
}

/** Marque un objet comme pur effet lumineux : hors export glTF et hors occlusion ambiante. */
export function fx(object) {
  object.userData.fx = true;
  return object;
}
