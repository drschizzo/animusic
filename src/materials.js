// Bibliothèque de matériaux physiques et de textures procédurales (aucun fichier
// image : tout est dessiné une fois dans des canvas, puis partagé). Les matières ont un
// grain (voir `detail`) : relief fin et poli inégal, projetés dans le repère des pièces.

import * as THREE from 'three';

const textures = new Map();

/**
 * Bruit de valeur lissé, périodique : n(x, y, px, py) se répète tous les px en x et py
 * en y (entiers ≤ 64), donc sans raccord visible si la texture couvre un nombre entier
 * de périodes.
 */
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
  const wrap = (i, p) => ((i % p) + p) % p;
  return (x, y, px = N, py = N) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const x0 = wrap(xi, px);
    const x1 = wrap(xi + 1, px);
    const y0 = wrap(yi, py) * N;
    const y1 = wrap(yi + 1, py) * N;
    const a = grid[y0 + x0] + (grid[y0 + x1] - grid[y0 + x0]) * u;
    const b = grid[y1 + x0] + (grid[y1 + x1] - grid[y1 + x0]) * u;
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
      img.data[i + 3] = c[3] ?? 255;
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

/**
 * Bois débité sur dosse (le fil suit l'axe u), en niveaux de brun à teinter : cernes
 * irréguliers très étirés dans le sens du fil, fibres fines, pores sombres en tirets.
 */
function woodTexture() {
  const n = makeNoise(11);
  return pixelTexture(
    'wood',
    512,
    (u, v) => {
      // Les cernes ondulent lentement le long de la planche.
      const drift = (n(u * 2, v * 3, 2, 3) - 0.5) * 1.1 + (n(u * 5, v * 9, 5, 9) - 0.5) * 0.3;
      const ring = v * 14 + drift;
      // Bois d'été sombre et étroit, bois de printemps clair : dent de scie adoucie.
      const f = ring - Math.floor(ring);
      const late = Math.pow(f, 3) * (1 - Math.pow(f, 24));
      const band = n(u * 3, Math.floor(ring) * 7.3, 3, 64);
      const fibre = n(u * 6, v * 240, 6, 60) * 0.6 + n(u * 24, v * 480, 24, 60) * 0.4;
      const pore = n(u * 40, v * 320, 40, 64) > 0.78 ? 0.1 : 0;
      const k = 0.82 + 0.1 * band - 0.2 * late - 0.1 * (fibre - 0.5) - pore;
      return [255 * Math.min(1, k), 255 * Math.min(1, k * 0.8), 255 * Math.min(1, k * 0.64)];
    },
    { srgb: true },
  );
}

/** Peau de fût sablée : grain fin, zone de frappe polie et grisée au centre, traces de baguettes. */
function drumheadTexture() {
  const n = makeNoise(53);
  return pixelTexture(
    'drumhead',
    256,
    (u, v) => {
      const x = u - 0.5;
      const y = v - 0.5;
      const r = Math.hypot(x, y) * 2;
      const grain = n(u * 64, v * 64) - 0.5;
      // Usure : tache irrégulière au centre, là où tombent les baguettes.
      const worn = Math.max(0, 1 - r / (0.42 + 0.18 * n(u * 5 + 9, v * 5))) ** 1.5;
      const dents = n(u * 28 + 3, v * 28) > 0.72 ? worn * 0.5 : 0;
      const k = 0.93 + 0.05 * grain - 0.2 * worn - 0.1 * dents;
      return [255 * k, 255 * k * 0.985, 255 * k * 0.95];
    },
    { srgb: true },
  );
}

/**
 * Texture de détail partagée par toutes les matières : relief fin isotrope (pente en
 * rouge et vert, 0,5 = plat) et marbrures larges (bleu : traces de doigts, usure du
 * poli). Projetée par axes sur les pièces (voir `detail`), jamais par leurs UV.
 */
function detailTexture() {
  const n = makeNoise(71);
  // Trois couches de fréquences sans rapport simple, dont une tournée de 45° : un bruit
  // de valeur seul laisse voir sa grille (une trame de points), leur mélange non.
  const height = (u, v) =>
    0.12 * n(u * 23, v * 23, 23, 23) + 0.4 * n((u + v) * 29 + 7.3, (u - v) * 29 + 2.1, 29, 29) + 0.48 * n(u * 53 + 11.7, v * 53 + 5.9, 53, 53);
  const e = 1 / 256;
  return pixelTexture('detail', 256, (u, v) => {
    const dx = (height(u + e, v) - height(u - e, v)) * 1.6;
    const dy = (height(u, v + e) - height(u, v - e)) * 1.6;
    const smudge = 0.55 * n(u * 4, v * 4, 4, 4) + 0.3 * n(u * 9, v * 9, 9, 9) + 0.15 * n(u * 20, v * 20, 20, 20);
    return [255 * Math.min(1, Math.max(0, 0.5 + dx)), 255 * Math.min(1, Math.max(0, 0.5 + dy)), 255 * smudge];
  });
}

/** Stries de métal brossé (le long de u) : sert de carte de rugosité. */
function brushedTexture() {
  const n = makeNoise(23);
  return pixelTexture('brushed', 256, (u, v) => gray(0.6 + 0.16 * (n(u * 3, v * 64, 3, 64) - 0.5) + 0.12 * (n(u * 9, v * 64 + 17, 9, 64) - 0.5)));
}

/** Marbrures larges : rugosité irrégulière d'un sol poli. */
function blotchTexture() {
  const n = makeNoise(37);
  return pixelTexture('blotch', 256, (u, v) => {
    const a = n(u * 8, v * 8, 8, 8) * 0.55 + n(u * 16, v * 16, 16, 16) * 0.3 + n(u * 32, v * 32, 32, 32) * 0.15;
    return gray(0.25 + 0.75 * a);
  });
}

export const tex = { wood: woodTexture, brushed: brushedTexture, blotch: blotchTexture, drumhead: drumheadTexture, detail: detailTexture };

const P = (o) => new THREE.MeshPhysicalMaterial(o);
const S = (o) => new THREE.MeshStandardMaterial(o);

/**
 * Grain de surface : ajoute à une matière le relief fin et les marbrures de la texture
 * de détail. Aucune surface réelle n'est parfaitement lisse ni uniformément polie ; c'est
 * ce qui manque à une image de synthèse « propre ».
 *
 * La texture est projetée selon l'axe dominant de la normale, dans le repère de la pièce
 * et en mètres : même densité sur une tige et sur un socle, quels que soient leurs UV,
 * et le grain reste collé aux pièces qui bougent. Deux lectures de texture par pixel.
 *
 * @param scale répétitions par mètre (peu : un motif serré se voit dès qu'il est petit à
 *   l'écran, sa répétition dessine une trame) ; bump : force du relief ; rough :
 *   amplitude des variations de rugosité (marbrures)
 */
function detail(material, { scale = 8, bump = 0.2, rough = 0.1 } = {}) {
  const uniforms = { tDetail: { value: detailTexture() }, uDetail: { value: new THREE.Vector3(scale, bump, rough) } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetailP; varying vec3 vDetailN; varying mat3 vDetailBasis;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvDetailN = objectNormal;\nvDetailBasis = normalMatrix;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDetailP = position * vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D tDetail; uniform vec3 uDetail;\nvarying vec3 vDetailP; varying vec3 vDetailN; varying mat3 vDetailBasis;',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        vec3 detailAxis = abs(vDetailN);
        vec3 detailDx = dFdx(vDetailP) * uDetail.x;
        vec3 detailDy = dFdy(vDetailP) * uDetail.x;
        vec3 detailQ = vDetailP * uDetail.x;
        vec2 detailUv;
        vec2 detailGx;
        vec2 detailGy;
        vec3 detailU;
        vec3 detailV;
        if (detailAxis.x > detailAxis.y && detailAxis.x > detailAxis.z) {
          detailUv = detailQ.yz; detailGx = detailDx.yz; detailGy = detailDy.yz; detailU = vDetailBasis[1]; detailV = vDetailBasis[2];
        } else if (detailAxis.y > detailAxis.z) {
          detailUv = detailQ.xz; detailGx = detailDx.xz; detailGy = detailDy.xz; detailU = vDetailBasis[0]; detailV = vDetailBasis[2];
        } else {
          detailUv = detailQ.xy; detailGx = detailDx.xy; detailGy = detailDy.xy; detailU = vDetailBasis[0]; detailV = vDetailBasis[1];
        }
        // Deux lectures : le grain fin, et la même texture tournée de 37° et trois fois
        // plus large pour les grandes variations. Leurs périodes n'ont aucun rapport, le
        // carreau de la texture ne se retrouve donc nulle part (une seule lecture répétée
        // dessine un quadrillage sur les grandes faces). Dérivées explicites : le choix de
        // l'axe ne crée pas de couture de filtrage.
        const mat2 detailTurn = mat2(0.2954, 0.2225, -0.2225, 0.2954);
        vec4 detailFine = textureGrad(tDetail, detailUv, detailGx, detailGy);
        vec4 detailBroad = textureGrad(tDetail, detailTurn * detailUv + vec2(0.37, 0.61), detailTurn * detailGx, detailTurn * detailGy);
        vec2 detailBroadSlope = (detailBroad.rg - 0.5) * mat2(0.7986, 0.6018, -0.6018, 0.7986);
        vec2 detailSlopeSum = (detailFine.rg - 0.5) + 0.7 * detailBroadSlope;
        roughnessFactor = clamp(roughnessFactor + (detailBroad.b - 0.5) * 2.0 * uDetail.z, 0.04, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        vec2 detailSlope = detailSlopeSum * 2.0 * uDetail.y;
        vec3 detailBent = normal - (normalize(detailU) * detailSlope.x + normalize(detailV) * detailSlope.y);
        normal = detailBent / max(length(detailBent), 1e-4);`,
      );
  };
  // Le grain est exprimé dans le repère de la pièce : la fusion des pièces fixes le conserve.
  material.userData.freezable = true;
  return material;
}

/**
 * Verre : presque invisible de face, de plus en plus présent vers les bords, où le regard
 * le traverse en biais. C'est ce contour qui fait lire un tube comme un tube de verre et
 * non comme un voile uniforme.
 */
function rimmed(material, edge = 0.7) {
  const uniforms = { uRim: { value: edge } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRim;')
      .replace(
        '#include <opaque_fragment>',
        `float rimGlance = 1.0 - saturate(abs(dot(normalize(vViewPosition), normal)));
        diffuseColor.a = mix(diffuseColor.a, uRim, rimGlance * rimGlance * rimGlance);
        #include <opaque_fragment>`,
      );
  };
  material.userData.freezable = true;
  return material;
}

/**
 * Métal tourné (cymbales) : sillons concentriques autour de l'axe y de la pièce. Ils
 * étirent les reflets en éventail, comme sur une vraie cymbale, et se fondent en un
 * simple satiné quand ils deviennent plus fins que le pixel.
 * @param pitch écart entre deux sillons (m)
 */
function lathed(material, pitch = 0.006) {
  const uniforms = { uLathe: { value: new THREE.Vector2((2 * Math.PI) / pitch, 0.38) } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLatheP; varying mat3 vLatheBasis;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLatheP = position;\nvLatheBasis = normalMatrix;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uLathe;\nvarying vec3 vLatheP; varying mat3 vLatheBasis;')
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float latheR = length(vLatheP.xz);
        float lathePhase = latheR * uLathe.x;
        float latheSharp = 1.0 - smoothstep(0.8, 2.4, fwidth(lathePhase));
        // Sillons trop fins pour l'écran : leur effet moyen est une surface plus mate.
        roughnessFactor = clamp(roughnessFactor + 0.16 * (1.0 - latheSharp), 0.04, 1.0);
        // Bandes larges : le tour laisse des zones plus ou moins polies.
        roughnessFactor = clamp(roughnessFactor + 0.07 * sin(latheR * 71.0) * sin(latheR * 23.0 + 1.3), 0.04, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        vec3 latheOut = vLatheBasis * vec3(vLatheP.x, 0.0, vLatheP.z);
        vec3 latheBent = normal - latheOut / max(length(latheOut), 1e-5) * cos(lathePhase) * uLathe.y * latheSharp;
        normal = latheBent / max(length(latheBent), 1e-4);`,
      );
  };
  material.userData.freezable = true;
  return material;
}

/** Fabriques de matériaux : chaque appel rend un matériau neuf (textures partagées). */
export const mat = {
  chrome: () => detail(S({ color: 0xdfe3ec, roughness: 0.12, metalness: 1 }), { scale: 3, bump: 0, rough: 0.07 }),
  /** Métaux brossés : stries (carte de rugosité), traces de doigts et micro-relief par-dessus. */
  steel: () => detail(S({ color: 0x9aa1b2, roughness: 0.5, metalness: 1, roughnessMap: brushedTexture() }), { scale: 6, bump: 0.035, rough: 0.1 }),
  /** Fonte peinte au four : grain de poudre, poli inégal. */
  gunmetal: () => detail(S({ color: 0x23262f, roughness: 0.55, metalness: 0.9, roughnessMap: brushedTexture() }), { scale: 4.5, bump: 0.14, rough: 0.14 }),
  brass: () => detail(S({ color: 0xe0ac4a, roughness: 0.42, metalness: 1, roughnessMap: brushedTexture() }), { scale: 6, bump: 0.035, rough: 0.12 }),
  /** Bronze de cymbale, tourné : sillons concentriques autour de l'axe de la pièce. */
  cymbal: () => lathed(S({ color: 0xd8a445, roughness: 0.38, metalness: 1, emissive: 0x000000, side: THREE.DoubleSide })),
  copper: () => detail(S({ color: 0xd9825a, roughness: 0.3, metalness: 1, roughnessMap: brushedTexture() }), { scale: 6, bump: 0.035, rough: 0.12 }),
  gold: () => detail(S({ color: 0xffcf6a, roughness: 0.16, metalness: 1 }), { scale: 3, bump: 0, rough: 0.07 }),
  /** Laque sous vernis (fûts de batterie, carrosserie) : vernis tendu, poli marbré dessous. */
  lacquer: (color, metalness = 0.55) =>
    detail(P({ color, roughness: 0.42, metalness, clearcoat: 1, clearcoatRoughness: 0.06 }), { scale: 2.5, bump: 0.03, rough: 0.12 }),
  /** Carter d'aluminium moulé, peint gris chaud (bras des robots). */
  shell: () => detail(P({ color: 0xb4b0a6, roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.35 }), { scale: 5, bump: 0.14, rough: 0.12 }),
  rubber: () => detail(S({ color: 0x0b0c10, roughness: 0.85, metalness: 0 }), { scale: 5, bump: 0.3, rough: 0.1 }),
  wood: (color = 0xb5562a) => P({ color, map: woodTexture(), roughness: 0.42, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.25 }),
  paleWood: () => S({ color: 0xf0d6a4, map: woodTexture(), roughness: 0.55 }),
  /** Peau de fût : la vue y greffe sa vibration (voir drumsView.js), donc pas de grain ici. */
  skin: () => S({ color: 0xdcd8cc, map: drumheadTexture(), roughness: 0.66, metalness: 0, emissive: 0x000000 }),
  ivory: () => detail(P({ color: 0xc9c5b8, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2, emissive: 0x000000 }), { scale: 6, bump: 0, rough: 0.12 }),
  ebony: () => detail(P({ color: 0x0c0c0f, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.12, emissive: 0x000000 }), { scale: 6, bump: 0, rough: 0.12 }),
  glass: () =>
    rimmed(P({
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
    })),
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
