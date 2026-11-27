// Retouches de matériaux en TSL, pour WebGPURenderer : les équivalents nœud pour nœud des
// greffes GLSL faites par onBeforeCompile (que WebGPURenderer ignore). Chargé seulement
// par le prototype (voir gpu.js) ; les explications de fond restent à côté des versions
// GLSL, dans materials.js et dans les vues.

import {
  MeshStandardNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshBasicNodeMaterial,
  NodeMaterial,
  PointsNodeMaterial,
  QuadMesh,
  RenderTarget,
  CubeRenderTarget,
  InstancedBufferAttribute,
  Sprite,
  Matrix4,
  Vector2,
  AdditiveBlending,
} from 'three/webgpu';
import {
  Fn,
  If,
  uniform,
  uv,
  attribute,
  instancedBufferAttribute,
  mrt,
  texture,
  textureLoad,
  ivec2,
  varying,
  select,
  float,
  uint,
  vec2,
  vec3,
  vec4,
  mix,
  max,
  min,
  smoothstep,
  sin,
  cos,
  atan,
  exp,
  floor,
  fract,
  mod,
  pow,
  length,
  dFdx,
  dFdy,
  fwidth,
  floatBitsToUint,
  positionGeometry,
  positionLocal,
  positionWorld,
  positionViewDirection,
  normalGeometry,
  normalLocal,
  normalView,
  modelScale,
  modelNormalMatrix,
  cameraViewMatrix,
  modelViewMatrix,
  viewportSize,
  screenDPR,
  materialColor,
  materialRoughness,
  materialOpacity,
  materialEmissive,
  diffuseColor,
  roughness,
  clearcoatRoughness,
  screenCoordinate,
} from 'three/tsl';

export const standard = (o) => new MeshStandardNodeMaterial(o);
export const physical = (o) => new MeshPhysicalNodeMaterial(o);
export const basic = (o) => new MeshBasicNodeMaterial(o);

/**
 * Uniformes partagés : { nom: { value } } → { nom: nœud uniforme }. Les nœuds gardent
 * l'interface `.value`, le code qui les pilote est donc le même pour les deux moteurs.
 */
export function uniforms(spec) {
  const out = {};
  for (const [name, u] of Object.entries(spec)) out[name] = uniform(u.value);
  return out;
}

/** Image, dans le repère de la caméra, d'un vecteur de la pièce par la matrice des normales (non normalisée). */
const axisView = (v) => cameraViewMatrix.mul(vec4(modelNormalMatrix.mul(v), 0)).xyz;

const unit = (v, floor_ = 1e-4) => v.div(max(length(v), floor_));

/**
 * Taille apparente des lampes (voir materials.js) : rugosité minimale et part réduite pour
 * le reflet des lampes, et lui seul. Posé une fois sur tous les matériaux physiques, comme
 * la retouche du fragment d'éclairage côté GLSL.
 */
export function installLampModel(minRoughness, specular) {
  for (const Material of [MeshStandardNodeMaterial, MeshPhysicalNodeMaterial]) {
    const setup = Material.prototype.setupLightingModel;
    Material.prototype.setupLightingModel = function (builder) {
      const model = setup.call(this, builder);
      const direct = model.direct;
      model.direct = function (input, stack) {
        const { reflectedLight } = input;
        const rough = roughness.toVar();
        const before = reflectedLight.directSpecular.toVar();
        roughness.assign(max(rough, minRoughness));
        let coatRough = null;
        let coatBefore = null;
        if (this.clearcoat === true) {
          coatRough = clearcoatRoughness.toVar();
          coatBefore = this.clearcoatSpecularDirect.toVar();
          clearcoatRoughness.assign(max(coatRough, minRoughness));
        }
        direct.call(this, input, stack);
        reflectedLight.directSpecular.assign(mix(before, reflectedLight.directSpecular, specular));
        roughness.assign(rough);
        if (this.clearcoat === true) {
          this.clearcoatSpecularDirect.assign(mix(coatBefore, this.clearcoatSpecularDirect, specular));
          clearcoatRoughness.assign(coatRough);
        }
      };
      return model;
    };
  }
}

/** Grain de surface (materials.js, `detail`). */
export function detail(material, map, { scale, bump, rough }) {
  const p = varying(positionGeometry.mul(modelScale), 'vDetailP');
  const axis = varying(normalGeometry, 'vDetailN').abs();
  const basis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)].map((e, i) => varying(axisView(e), `vDetailBasis${i}`));
  const isX = axis.x.greaterThan(axis.y).and(axis.x.greaterThan(axis.z));
  const isY = axis.y.greaterThan(axis.z);
  const pick = (x, y, z) => select(isX, x, select(isY, y, z));
  const q = p.mul(scale);
  const dx = dFdx(p).mul(scale);
  const dy = dFdy(p).mul(scale);
  const uv = pick(q.yz, q.xz, q.xy);
  const gx = pick(dx.yz, dx.xz, dx.xy);
  const gy = pick(dy.yz, dy.xz, dy.xy);
  // Seconde lecture tournée de 37° et trois fois plus large.
  const turn = (v) => vec2(v.x.mul(0.2954).sub(v.y.mul(0.2225)), v.x.mul(0.2225).add(v.y.mul(0.2954)));
  const broad = texture(map, turn(uv).add(vec2(0.37, 0.61))).grad(turn(gx), turn(gy));
  material.roughnessNode = materialRoughness.add(broad.b.sub(0.5).mul(2 * rough)).clamp(0.04, 1);
  if (bump > 0) {
    const fine = texture(map, uv).grad(gx, gy);
    const b = broad.rg.sub(0.5);
    const broadSlope = vec2(b.x.mul(0.7986).add(b.y.mul(0.6018)), b.y.mul(0.7986).sub(b.x.mul(0.6018)));
    const slope = fine.rg.sub(0.5).add(broadSlope.mul(0.7)).mul(2 * bump);
    const u = pick(basis[1], basis[0], basis[0]).normalize();
    const v = pick(basis[2], basis[2], basis[1]).normalize();
    material.normalNode = unit(normalView.sub(u.mul(slope.x).add(v.mul(slope.y))));
  }
  return material;
}

/** Verre (materials.js, `rimmed`). */
export function rimmed(material, edge) {
  const glance = positionViewDirection.dot(normalView).abs().saturate().oneMinus();
  material.opacityNode = mix(materialOpacity, edge, glance.mul(glance).mul(glance));
  return material;
}

/** Métal tourné (materials.js, `lathed`). u : { uLathe, uShimmer }. */
export function lathed(material, u) {
  const p = varying(positionGeometry, 'vLatheP');
  const r = length(p.xz);
  const phase = r.mul(u.uLathe.x);
  material.roughnessNode = materialRoughness.add(sin(r.mul(71)).mul(sin(r.mul(23).add(1.3))).mul(0.07)).clamp(0.04, 1);
  const sharp = smoothstep(0.8, 2.4, fwidth(phase)).oneMinus();
  const out = unit(varying(axisView(vec3(positionGeometry.x, 0, positionGeometry.z)), 'vLatheOut'), 1e-5);
  const around = unit(varying(axisView(vec3(positionGeometry.z.negate(), 0, positionGeometry.x)), 'vLatheAround'), 1e-5);
  const dither = fract(fract(screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715))).mul(52.9829189)).mul(2).sub(1);
  const angle = atan(p.z, p.x);
  const t = u.uShimmer.y;
  const wave = sin(angle.mul(5).add(t)).mul(sin(r.mul(38).sub(t.mul(0.6)))).add(sin(angle.mul(3).sub(t.mul(1.7))).mul(0.6));
  const bent = normalView
    .sub(out.mul(mix(dither, cos(phase), sharp)).mul(u.uLathe.y))
    .add(out.mul(0.5).add(around).mul(wave.mul(u.uShimmer.x).mul(0.22).mul(smoothstep(0.03, 0.3, r))));
  material.normalNode = unit(bent);
  return material;
}

/**
 * Mouvement d'une image à l'autre, pour les vecteurs de vitesse écrits à la main (la chaîne
 * d'effets, postfxNodes.js, les tient à jour) : caméra de l'image courante et de la
 * précédente (sans le décalage de TAAU), temps musical écoulé.
 */
export const motion = { uViewProjection: uniform(new Matrix4()), uPrevViewProjection: uniform(new Matrix4()), uDt: uniform(0) };

/** Vitesse à l'écran (écart en coordonnées normalisées, comme le nœud `velocity` de three) d'un point passé de `before` à `now`. */
function screenVelocity(now, before) {
  const clipNow = varying(motion.uViewProjection.mul(vec4(now, 1)));
  const clipBefore = varying(motion.uPrevViewProjection.mul(vec4(before, 1)));
  return clipNow.xy.div(clipNow.w).sub(clipBefore.xy.div(clipBefore.w));
}

let renderer = null;
/** Moteur de rendu du prototype : les vitesses écrites à la main lui demandent quelle passe est en cours. */
export function useRenderer(r) {
  renderer = r;
}

/**
 * Remplace la vitesse calculée par three pour ce matériau, dans les seules passes qui
 * écrivent une vitesse : ailleurs (ombres, passe de normales, rendu direct), un MRT de
 * matériau sans cible correspondante donne un shader invalide.
 */
function overrideVelocity(material, node) {
  const override = mrt({ velocity: node });
  Object.defineProperty(material, 'mrtNode', { get: () => (renderer?.getMRT()?.has('velocity') ? override : null), set() {}, configurable: true });
  return material;
}

/**
 * Effets additifs (halos, faisceaux, poussières, souffles) : ils n'écrivent aucune
 * vitesse. La passe de scène additionne la vitesse avec le mélange du matériau
 * (postfxNodes.js) : un zéro de couverture nulle laisse intacte celle de l'objet vu au
 * travers. Sinon TAAU recalerait la bille qui passe derrière un faisceau sur le
 * mouvement du faisceau, et le flou de mouvement la traînerait avec lui.
 */
export function seeThrough(material) {
  return overrideVelocity(material, vec4(0));
}

/**
 * Billes : chrome teinté légèrement lumineux, dans la couleur de l'instance (matériau
 * blanc). Leur vitesse à l'écran vient de l'attribut `instanceVelocity` (m/s), pas de la
 * comparaison de deux images : elles changent de rang dans leur réservoir.
 */
export function ballGlow(material) {
  material.emissiveNode = diffuseColor.rgb.mul(0.4);
  return overrideVelocity(material, screenVelocity(positionWorld, positionWorld.sub(attribute('instanceVelocity', 'vec3').mul(motion.uDt))));
}

/** Lueur par instance (materials.js, `instanceGlow`) : attribut `instanceGlow` ajouté à l'émissif. */
export function instanceGlow(material) {
  material.emissiveNode = materialEmissive.add(attribute('instanceGlow', 'vec3'));
  return material;
}

/** Lueur par pièce d'un maillage fusionné (materials.js, `slotGlow`) : case `glowSlot` de la texture. */
export function slotGlow(material, glow) {
  const slot = attribute('glowSlot', 'float').add(0.5).toInt();
  material.emissiveNode = materialEmissive.add(textureLoad(glow, ivec2(slot, 0)).rgb);
  return material;
}

/** Peau qui vibre (drumsView.js, `membrane`). u : { uAmp, uSince, uRadius, uAngle }. */
export function membrane(material, u) {
  const modes = (p, s) => {
    const r = length(p).div(u.uRadius).clamp(0, 1);
    const th = atan(p.y, p.x).sub(u.uAngle);
    const edge = r.mul(r).oneMinus();
    return edge.mul(
      cos(s.mul(95))
        .add(r.mul(1.3).mul(cos(th)).mul(sin(s.mul(151))))
        .add(r.mul(r).mul(0.9).mul(cos(th.mul(2))).mul(sin(s.mul(204)))),
    );
  };
  // Comme l'ossature (skinning) de three : position et normale sont déformées dans le
  // repère de la pièce, avant tout le reste.
  const setupPosition = material.setupPosition;
  material.setupPosition = function (builder) {
    setupPosition.call(this, builder);
    const xy = positionGeometry.xy;
    const s = u.uSince;
    const env = u.uAmp.mul(exp(s.mul(-7)));
    const eps = u.uRadius.mul(0.02);
    const slopeX = modes(xy.add(vec2(eps, 0)), s).sub(modes(xy.sub(vec2(eps, 0)), s)).div(eps.mul(2));
    const slopeY = modes(xy.add(vec2(0, eps)), s).sub(modes(xy.sub(vec2(0, eps)), s)).div(eps.mul(2));
    normalLocal.assign(normalLocal.add(vec3(slopeX, slopeY, 0).mul(env).mul(9)).normalize());
    positionLocal.z.subAssign(env.mul(modes(xy, s)));
    return positionLocal;
  };
  return material;
}

/** Rayon laser qui se courbe et ondule (laserView.js). u : { uBend, uWave, uTime }. */
export function bendable(material, u) {
  const y = positionGeometry.y;
  const arch = y.mul(4).mul(y.oneMinus());
  const shift = arch.mul(u.uBend.add(u.uWave.mul(sin(y.mul(38).sub(u.uTime.mul(24))))));
  material.positionNode = positionLocal.add(vec3(shift, 0, 0));
  return material;
}

/** Rampe au pied de la conque (environment.js, StageShell). u : { uWashA, uWashB, uWash }. */
export function wash(material, u) {
  const p = positionWorld;
  const tint = mix(u.uWashA, u.uWashB, sin(atan(p.x, p.z.negate()).add(0.6)).mul(0.5).add(0.5));
  material.emissiveNode = materialEmissive.add(diffuseColor.rgb.mul(tint).mul(u.uWash).mul(exp(max(p.y, 0).div(-5.5))));
  return material;
}

/** Cibles de rendu du moteur (les classes WebGL de three ne conviennent pas toutes à WebGPURenderer). */
export const target = (w, h, options) => new RenderTarget(w, h, options);
export const cubeTarget = (size, options) => new CubeRenderTarget(size, options);

/**
 * Passe plein écran : même usage que FullScreenQuad + ShaderMaterial côté GLSL
 * (`material.uniforms.nom.value`, `render(renderer)`).
 */
function fullScreen(uniforms, fragment) {
  const material = new NodeMaterial();
  material.fragmentNode = fragment;
  material.depthTest = false;
  material.depthWrite = false;
  material.uniforms = uniforms;
  return new QuadMesh(material);
}

/** Copie qui remplace les valeurs non finies et écrête les pics (sonde de reflets, environment.js). */
export function sanitizeQuad(ceiling) {
  const u = { tSource: texture(), uClamp: uniform(ceiling) };
  return fullScreen(u, vec4(min(finite(u.tSource.sample(uv()).rgb), u.uClamp), 1));
}

const nonFinite = (x) => floatBitsToUint(x).bitAnd(uint(0x7f800000)).equal(uint(0x7f800000));
/** Protection contre les valeurs non finies (voir glsl.js). */
const finite = (c) => select(nonFinite(c.r).or(nonFinite(c.g)).or(nonFinite(c.b)), vec3(0), c);

/**
 * Plancher de scène (environment.js, ReflectiveFloor) : lames, joints et usure. Pas de
 * reflet planaire en WebGPU : les reflets en espace écran (postfxNodes.js) le remplacent.
 * u : { uStageRadius }.
 */
export function stageFloor(material, u) {
  const p = positionWorld;
  const onStage = smoothstep(u.uStageRadius.sub(0.05), u.uStageRadius.add(0.05), length(p.xz)).oneMinus();
  const hash = (x) => fract(sin(x).mul(43758.5453));
  const lane = p.x.div(0.24);
  const laneId = floor(lane);
  const run = p.z.div(3.2).add(hash(laneId.mul(91.7)).mul(7));
  const tone = hash(laneId.mul(13.1).add(floor(run).mul(57.3)));
  const laneW = fwidth(lane);
  const runW = fwidth(run);
  const toEdge = (x) => min(fract(x), fract(x).oneMinus());
  const laneSeam = smoothstep(0.012, laneW.mul(1.5).add(0.012), toEdge(lane)).oneMinus().mul(smoothstep(0.2, 0.7, laneW).oneMinus());
  const runSeam = smoothstep(0.001, runW.mul(1.5).add(0.001), toEdge(run)).oneMinus().mul(smoothstep(0.004, 0.014, runW).oneMinus()).mul(0.6);
  const seam = max(laneSeam, runSeam);
  const wear = materialRoughness.mul(2).clamp(0, 1);
  const boards = mix(0.46, 0.7, wear).add(tone.sub(0.5).mul(0.1));
  // Poli des lames ; l'éclairage direct voit une surface plus mate (sinon chaque
  // projecteur dessine une tache spéculaire aveuglante).
  const gloss = mix(0.88, mix(boards, 0.92, seam), onStage);
  material.colorNode = materialColor.mul(mix(0.3, tone.mul(0.36).add(0.82).mul(seam.mul(0.55).oneMinus()), onStage));
  material.roughnessNode = max(gloss, 0.5);
  return material;
}

// --- Effets écrits à la main en GLSL (ShaderMaterial) : leurs équivalents en nœuds.

/**
 * Matériau d'effet, à la place d'un ShaderMaterial : `uniforms` garde l'interface
 * { nom: { value } } que pilotent les vues ; `color(u)` donne ce qu'écrivait
 * gl_FragColor. Ni éclairage, ni brouillard, ni occlusion : la sortie est posée telle quelle.
 */
export function effect(spec, color, options = {}) {
  const u = uniforms(spec);
  const material = new NodeMaterial();
  material.fog = false;
  material.lights = false;
  material.setValues(options);
  material.uniforms = u;
  material.outputNode = color(u);
  return material.blending === AdditiveBlending ? seeThrough(material) : material;
}

/** Lointain : brume d'horizon et colonnes de lumière (environment.js, makeBackdrop). */
export function backdrop(spec, options) {
  return effect(
    spec,
    (u) => {
      const p = positionGeometry;
      const h = p.y.div(45).clamp(0, 1);
      const fall = h.oneMinus();
      const a = atan(p.x, p.z.negate());
      const glow = mix(u.uA, u.uB, sin(a.add(0.6)).mul(0.5).add(0.5));
      const lobe = (k, phase, sharp) => pow(max(0, cos(a.mul(k).add(phase)).mul(0.5).add(0.5)), sharp);
      const bars = lobe(28, 0, 40).add(lobe(12, 1.3, 90).mul(0.5));
      const haze = u.uHaze.add(glow.mul(u.uPulse.mul(0.1).add(0.3)).mul(pow(fall, 5)));
      const columns = glow.mul(bars).mul(u.uPulse.mul(0.2).add(0.3)).mul(smoothstep(0, 0.08, h)).mul(pow(fall, 2.2));
      return vec4(haze.add(columns), 1);
    },
    options,
  );
}

/** Cône d'un projecteur : dense dans l'axe, éteint en s'éloignant (environment.js, beamFragment). */
export function beam(spec, options) {
  return effect(
    spec,
    (u) => {
      const facing = unit(normalView, 1e-5).dot(unit(positionViewDirection, 1e-5)).abs().clamp(0, 1);
      const a = pow(facing, 2.5).mul(pow(uv().y.clamp(0, 1), 1.6));
      return vec4(u.uColor.mul(u.uIntensity).mul(a), 1);
    },
    options,
  );
}

/**
 * Poussières en suspension (environment.js) : `count` lutins instanciés, WebGPU ne
 * dessinant les points qu'à un pixel. positions, seeds : mêmes tableaux que la
 * géométrie de points GLSL. spec : { uTime, uRadius, uScale }.
 */
export function dust(positions, seeds, spec) {
  const u = uniforms(spec);
  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: false });
  material.fog = false;
  material.lights = false;
  material.uniforms = u;
  const seed = instancedBufferAttribute(new InstancedBufferAttribute(seeds, 1));
  const start = instancedBufferAttribute(new InstancedBufferAttribute(positions, 3));
  const t = u.uTime;
  const spread = u.uRadius.mul(1.35);
  const p = vec3(
    start.x.mul(spread).add(sin(t.mul(0.21).add(seed.mul(40))).mul(0.4)),
    mod(start.y.mul(9).add(t.mul(seed.mul(0.05).add(0.03))), 9),
    start.z.mul(spread).add(cos(t.mul(0.17).add(seed.mul(70))).mul(0.4)),
  );
  material.positionNode = p;
  const distance = modelViewMatrix.mul(vec4(p, 1)).z.negate();
  // Même taille à l'écran que gl_PointSize côté GLSL (uScale = hauteur en pixels / 720),
  // exprimée en part de la hauteur de la cible : juste aussi quand TAAU rend plus petit.
  material.sizeNode = viewportSize.y.mul(seed.mul(2.5).add(1.5)).mul(6 / 720).div(max(distance, 0.05)).div(screenDPR);
  const fade = varying(
    smoothstep(0, 1, p.y)
      .mul(smoothstep(6, 9, p.y).oneMinus())
      .mul(smoothstep(1, 4, distance))
      .mul(seed.mul(0.6).add(0.4)),
    'vDustFade',
  );
  // Coin du quad (−0,5 à 0,5) : la géométrie des lutins n'a pas d'uv pour WebGPU.
  const d = length(positionGeometry.xy);
  material.outputNode = vec4(vec3(0.75, 0.85, 1).mul(fade).mul(smoothstep(0, 0.5, d).oneMinus()).mul(0.5), 1);
  seeThrough(material);
  const sprites = new Sprite(material);
  sprites.count = seeds.length;
  return sprites;
}

/** Rectangle arrondi signé, en mètres, sur un carré de sol de côtés `size` (parts.js). */
const roundedRect = (size, half, radius, inset = 0) => {
  const q = uv().sub(0.5).mul(size).abs().sub(half).add(inset);
  return length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(radius);
};

/** Ombre de contact au sol (parts.js, contactShadow). spec : { uSize, uHalf, uShape }. */
export function contactShadow(spec, options) {
  return effect(
    spec,
    (u) => {
      const a = smoothstep(0, u.uShape.y, roundedRect(u.uSize, u.uHalf, u.uShape.x)).oneMinus();
      return vec4(0, 0, 0, u.uShape.z.mul(a).mul(a));
    },
    options,
  );
}

/** Trappe lumineuse au sol (parts.js, floorHalo). spec : { uSize, uHalf, uColor, uIntensity }. */
export function floorHalo(spec, options) {
  return effect(
    spec,
    (u) => {
      const d = roundedRect(u.uSize, u.uHalf, 0.12, 0.12);
      // Halo diffus vers l'extérieur seulement : le sol sous l'instrument ne se teinte pas.
      const glow = select(d.lessThan(0), float(0), exp(d.mul(-9)).mul(0.35));
      const line = exp(d.abs().mul(-40)).add(glow);
      return vec4(u.uColor.mul(u.uIntensity).mul(line), 1);
    },
    options,
  );
}

/** Souffle visible des vents (windsView.js, plumeMaterial). spec : { uColor, uLevel, uTime }. */
export function plume(spec, options) {
  return effect(
    spec,
    (u) => {
      const along = uv().y.clamp(0, 1);
      const rings = pow(sin(along.mul(22).sub(u.uTime.mul(26))).mul(0.5).add(0.5), 3);
      const a = u.uLevel.mul(rings.mul(0.75).add(0.25)).mul(pow(along.oneMinus(), 1.6));
      return vec4(u.uColor.mul(a).mul(1.6), 1);
    },
    options,
  );
}
