// Bibliothèque de matériaux physiques et de textures procédurales (aucun fichier
// image : tout est dessiné une fois dans des canvas, puis partagé). Les matières ont un
// grain (voir `detail`) : relief fin et poli inégal, projetés dans le repère des pièces.

import * as THREE from 'three';
import { nodes, shared } from './gpu.js';

/**
 * Taille apparente des lampes. Les lumières de three.js sont des points : sur une matière
 * polie (chrome, acier usiné), le reflet d'un projecteur devient une tête d'épingle
 * d'une intensité démesurée, que le halo transforme en éclat grossier. Un vrai projecteur
 * a une lentille de vingt centimètres : son reflet a une taille. On l'approche comme les
 * moteurs de jeu, en donnant au reflet des lampes (et à lui seul) une rugosité minimale ;
 * les reflets du décor (sonde, sol) gardent tout leur poli.
 */
export const LAMP_MIN_ROUGHNESS = 0.3;
/**
 * Part du reflet des lampes (l'éclairage diffus n'en dépend pas). Comme l'échelle
 * spéculaire des éclairagistes de jeu vidéo : un projecteur braqué sur une machine
 * l'éclaire franchement, sans allumer chaque tube d'acier comme un néon.
 */
export const LAMP_SPECULAR = 0.55;
{
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const direct = 'void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {';
  if (chunk.includes(direct) && !chunk.includes('lampMaterial')) {
    const min = LAMP_MIN_ROUGHNESS.toFixed(3);
    let patched = chunk.replace(
      direct,
      `${direct}\n\tPhysicalMaterial lampMaterial = material;\n\tlampMaterial.roughness = max( material.roughness, ${min} );\n\t#ifdef USE_CLEARCOAT\n\tlampMaterial.clearcoatRoughness = max( material.clearcoatRoughness, ${min} );\n\t#endif`,
    );
    const head = patched.indexOf(direct);
    const end = patched.indexOf('#define RE_Direct\t', head);
    const body = patched.slice(head, end).replace('reflectedLight.directSpecular += irradiance *', `reflectedLight.directSpecular += ${LAMP_SPECULAR.toFixed(3)} * irradiance *`).replace('clearcoatSpecularDirect += ccIrradiance *', `clearcoatSpecularDirect += ${LAMP_SPECULAR.toFixed(3)} * ccIrradiance *`).replace('BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material )', 'BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, lampMaterial )').replace('BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material )', 'BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, lampMaterial )');
    patched = patched.slice(0, head) + body + patched.slice(end);
    THREE.ShaderChunk.lights_physical_pars_fragment = patched;
  }
}
nodes?.installLampModel(LAMP_MIN_ROUGHNESS, LAMP_SPECULAR);

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

// Sous WebGPURenderer (gpu.js), les matériaux retouchés sont des matériaux à nœuds.
const P = (o) => (nodes ? nodes.physical(o) : new THREE.MeshPhysicalMaterial(o));
const S = (o) => (nodes ? nodes.standard(o) : new THREE.MeshStandardMaterial(o));
/** Matériaux de base à retoucher hors de ce fichier (billes, sol, rayons…). */
export const base = { standard: S, physical: P, basic: (o) => (nodes ? nodes.basic(o) : new THREE.MeshBasicMaterial(o)) };

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
  // Le grain est exprimé dans le repère de la pièce : la fusion des pièces fixes le conserve.
  material.userData.freezable = true;
  if (nodes) return nodes.detail(material, detailTexture(), { scale, bump, rough });
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
  return material;
}

/**
 * Verre : presque invisible de face, de plus en plus présent vers les bords, où le regard
 * le traverse en biais. C'est ce contour qui fait lire un tube comme un tube de verre et
 * non comme un voile uniforme.
 */
function rimmed(material, edge = 0.7) {
  material.userData.freezable = true;
  if (nodes) return nodes.rimmed(material, edge);
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
  return material;
}

/**
 * Métal tourné (cymbales) : sillons concentriques autour de l'axe y de la pièce. Ils
 * étirent les reflets en éventail, comme sur une vraie cymbale, et se fondent en un
 * simple satiné quand ils deviennent plus fins que le pixel.
 * @param pitch écart entre deux sillons (m)
 */
function lathed(material, pitch = 0.006) {
  // uShimmer (force, phase) : vibration après une frappe, pilotée par la vue.
  const uniforms = (material.userData.lathe = shared({ uLathe: { value: new THREE.Vector2((2 * Math.PI) / pitch, 0.3) }, uShimmer: { value: new THREE.Vector2(0, 0) } }));
  material.userData.freezable = true;
  if (nodes) return nodes.lathed(material, uniforms);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLatheP; varying mat3 vLatheBasis;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLatheP = position;\nvLatheBasis = normalMatrix;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uLathe; uniform vec2 uShimmer;\nvarying vec3 vLatheP; varying mat3 vLatheBasis;')
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float latheR = length(vLatheP.xz);
        float lathePhase = latheR * uLathe.x;
        float latheSharp = 1.0 - smoothstep(0.8, 2.4, fwidth(lathePhase));
        // Bandes larges : le tour laisse des zones plus ou moins polies.
        roughnessFactor = clamp(roughnessFactor + 0.07 * sin(latheR * 71.0) * sin(latheR * 23.0 + 1.3), 0.04, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        vec3 latheOut = vLatheBasis * vec3(vLatheP.x, 0.0, vLatheP.z);
        latheOut /= max(length(latheOut), 1e-5);
        // Chaque sillon renvoie la lumière un peu plus vers le centre ou vers le bord : le
        // reflet d'un projecteur s'étire en éventail le long du rayon. Quand les sillons
        // passent sous le pixel, on tire leur pente au hasard par pixel : l'éventail
        // reste, en grain fin, au lieu de se moirer ou de s'éteindre.
        float latheDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 2.0 - 1.0;
        vec3 latheBent = normal - latheOut * mix(latheDither, cos(lathePhase), latheSharp) * uLathe.y;
        // Vibration : des ondes tournent autour de la cymbale et font courir les reflets,
        // surtout vers le bord (le centre est tenu par le pied).
        vec3 latheAround = vLatheBasis * vec3(-vLatheP.z, 0.0, vLatheP.x);
        latheAround /= max(length(latheAround), 1e-5);
        float latheAngle = atan(vLatheP.z, vLatheP.x);
        float latheWave = sin(latheAngle * 5.0 + uShimmer.y) * sin(latheR * 38.0 - uShimmer.y * 0.6) + 0.6 * sin(latheAngle * 3.0 - uShimmer.y * 1.7);
        latheBent += (latheOut * 0.5 + latheAround) * latheWave * uShimmer.x * 0.22 * smoothstep(0.03, 0.3, latheR);
        normal = latheBent / max(length(latheBent), 1e-4);`,
      );
  };
  return material;
}

const lightMaterial = (o) => (nodes ? nodes.seeThrough(nodes.basic(o)) : new THREE.MeshBasicMaterial(o));

/** Fabriques de matériaux : chaque appel rend un matériau neuf (textures partagées). */
export const mat = {
  chrome: () => detail(S({ color: 0xdfe3ec, roughness: 0.12, metalness: 1 }), { scale: 3, bump: 0, rough: 0.07 }),
  /** Métaux brossés : stries (carte de rugosité), traces de doigts et micro-relief par-dessus. */
  steel: () => detail(S({ color: 0x9aa1b2, roughness: 0.5, metalness: 1, roughnessMap: brushedTexture() }), { scale: 6, bump: 0.035, rough: 0.1 }),
  /** Fonte peinte au four : grain de poudre, poli inégal. */
  gunmetal: () => detail(S({ color: 0x23262f, roughness: 0.55, metalness: 0.9, roughnessMap: brushedTexture() }), { scale: 4.5, bump: 0.14, rough: 0.14 }),
  brass: () => detail(S({ color: 0xe0ac4a, roughness: 0.42, metalness: 1, roughnessMap: brushedTexture() }), { scale: 6, bump: 0.035, rough: 0.12 }),
  /** Bronze de cymbale, tourné : sillons concentriques autour de l'axe de la pièce. */
  cymbal: () => lathed(S({ color: 0xc8a258, roughness: 0.24, metalness: 1, emissive: 0x000000, side: THREE.DoubleSide })),
  /** Cuivre martelé : mille petits coups de marteau, relief large et marqué. */
  hammered: (color = 0xc9764e) => detail(S({ color, roughness: 0.34, metalness: 1 }), { scale: 2.2, bump: 0.55, rough: 0.1 }),
  copper: () => detail(S({ color: 0xd9825a, roughness: 0.3, metalness: 1, roughnessMap: brushedTexture() }), { scale: 6, bump: 0.035, rough: 0.12 }),
  gold: () => detail(S({ color: 0xffcf6a, roughness: 0.16, metalness: 1 }), { scale: 3, bump: 0, rough: 0.07 }),
  /** Laque sous vernis (fûts de batterie, carrosserie) : vernis tendu, poli marbré dessous. */
  lacquer: (color, metalness = 0.55) =>
    detail(P({ color, roughness: 0.42, metalness, clearcoat: 1, clearcoatRoughness: 0.06 }), { scale: 2.5, bump: 0.03, rough: 0.12 }),
  /** Carter d'aluminium moulé, peint gris chaud (bras des robots). */
  shell: () => detail(P({ color: 0xb4b0a6, roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.35 }), { scale: 5, bump: 0.14, rough: 0.12 }),
  /** Émail de machine sur fonte : peinture épaisse et tendue, vernis satiné, grain à peine sensible. */
  enamel: (color = 0x24453a) =>
    detail(P({ color, roughness: 0.4, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.22, side: THREE.DoubleSide }), { scale: 2.2, bump: 0.012, rough: 0.05 }),
  /** Fonte noircie (bâtis, socles) : mate, à peine métallique, grain de fonderie discret. */
  castIron: () => detail(S({ color: 0x1b1c1f, roughness: 0.58, metalness: 0.6, side: THREE.DoubleSide }), { scale: 3, bump: 0.035, rough: 0.08 }),
  /** Acier usiné (arbres, axes, pièces tournées) : poli de tour, reflets nets. */
  machined: () => detail(S({ color: 0xb9bec8, roughness: 0.24, metalness: 1, roughnessMap: brushedTexture() }), { scale: 5, bump: 0.01, rough: 0.05 }),
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
    lightMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
};

// Recette de chaque matériau (fabrique et arguments) : deux matériaux de même recette et
// de mêmes réglages s'affichent à l'identique, la fusion des pièces fixes (freeze.js) les
// confond. Sans cela, chaque pièce ayant son propre matériau, presque rien ne fusionnait.
// Les cymbales n'en ont pas : leurs sillons tournent autour de l'axe de chaque pièce.
for (const [name, make] of Object.entries(mat)) {
  if (name === 'cymbal') continue;
  mat[name] = (...args) => {
    const material = make(...args);
    material.userData.recipe = `${name}(${args.join(',')})`;
    return material;
  };
}

/**
 * Lueur par instance : chaque instance d'un InstancedMesh s'allume dans sa propre couleur
 * (attribut `instanceGlow`, couleur × intensité, à poser sur la géométrie), en plus de
 * l'émissif du matériau. Une touche ou une lame qui s'éclaire n'a donc plus besoin de son
 * propre matériau, ni de son propre appel de rendu.
 */
export function instanceGlow(material) {
  if (nodes) return nodes.instanceGlow(material);
  const previous = material.onBeforeCompile;
  const previousKey = previous.toString();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 instanceGlow;\nvarying vec3 vInstanceGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceGlow = instanceGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vInstanceGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vInstanceGlow;');
  };
  material.customProgramCacheKey = () => `instance-glow|${previousKey}`;
  return material;
}

/**
 * Lueur par pièce d'un maillage fusionné (freeze.js) : chaque sommet porte le numéro de sa
 * pièce (attribut `glowSlot`), et une petite texture donne la lueur de chaque pièce,
 * recopiée de son matériau d'origine (que la vue continue d'animer) par `syncGlow()`.
 * @param source matériau dont le fusionné reprend l'apparence (sans sa lueur)
 * @param sources matériaux d'origine, dans l'ordre des numéros
 */
export function slotGlow(source, sources) {
  const material = source.clone();
  if (Object.hasOwn(source, 'onBeforeCompile')) material.onBeforeCompile = source.onBeforeCompile;
  if (Object.hasOwn(source, 'customProgramCacheKey')) material.customProgramCacheKey = source.customProgramCacheKey;
  material.emissive.setRGB(0, 0, 0);
  material.emissiveIntensity = 1;
  // WebGPU : une plage de la texture commune (un seul shader pour tous les fusionnés).
  const slots = nodes?.glowSlots(sources.length);
  const base = (material.glowBase = slots?.base ?? 0);
  const data = slots?.data ?? new Float32Array(sources.length * 4);
  const glow = slots?.texture ?? new THREE.DataTexture(data, sources.length, 1, THREE.RGBAFormat, THREE.FloatType);
  if (slots) material.addEventListener('dispose', slots.release);
  else glow.needsUpdate = true;
  material.syncGlow = () => {
    let changed = false;
    sources.forEach((m, i) => {
      const k = m.emissiveIntensity;
      const rgb = [m.emissive.r * k, m.emissive.g * k, m.emissive.b * k];
      for (let c = 0; c < 3; c++)
        if (data[(base + i) * 4 + c] !== rgb[c]) {
          data[(base + i) * 4 + c] = rgb[c];
          changed = true;
        }
    });
    if (changed) glow.needsUpdate = true;
  };
  if (nodes) return nodes.slotGlow(material, glow);
  const previous = material.onBeforeCompile;
  const previousKey = previous.toString();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.tSlotGlow = { value: glow };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glowSlot;\nuniform sampler2D tSlotGlow;\nvarying vec3 vSlotGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlotGlow = texelFetch(tSlotGlow, ivec2(int(glowSlot + 0.5), 0), 0).rgb;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSlotGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vSlotGlow;');
  };
  material.customProgramCacheKey = () => `slot-glow|${previousKey}`;
  return material;
}

/** Chrome des billes, teinté par la couleur de l'instance et légèrement lumineux dans cette couleur. */
export function ballMaterial() {
  const material = S({ color: 0xffffff, metalness: 1, roughness: 0.14, envMapIntensity: 1.6 });
  if (nodes) return nodes.ballGlow(material);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * 0.4;\n#endif',
    );
  };
  return material;
}

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
