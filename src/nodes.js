// Retouches de matériaux en TSL, pour WebGPURenderer : les équivalents nœud pour nœud des
// greffes GLSL faites par onBeforeCompile (que WebGPURenderer ignore). Chargé seulement
// par le prototype (voir gpu.js) ; les explications de fond restent à côté des versions
// GLSL, dans materials.js et dans les vues.

import { MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  If,
  uniform,
  texture,
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

/** Billes : chrome teinté légèrement lumineux, dans la couleur de l'instance (matériau blanc). */
export function ballGlow(material) {
  material.emissiveNode = diffuseColor.rgb.mul(0.4);
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

const nonFinite = (x) => floatBitsToUint(x).bitAnd(uint(0x7f800000)).equal(uint(0x7f800000));
/** Protection contre les valeurs non finies (voir glsl.js). */
const finite = (c) => select(nonFinite(c.r).or(nonFinite(c.g)).or(nonFinite(c.b)), vec3(0), c);

/**
 * Plancher de scène et son reflet planaire (environment.js, ReflectiveFloor).
 * u : { uReflectMatrix, uReflect, uStageRadius } ; sharp : texture du reflet net ;
 * blurred : textures de la pyramide de flous, du moins flou au plus flou.
 */
export function stageFloor(material, u, sharp, blurred) {
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
  // Poli vu par le reflet ; l'éclairage direct voit une surface plus mate.
  const gloss = mix(0.88, mix(boards, 0.92, seam), onStage);
  material.colorNode = materialColor.mul(mix(0.3, tone.mul(0.36).add(0.82).mul(seam.mul(0.55).oneMinus()), onStage));
  material.roughnessNode = max(gloss, 0.5);

  const levels = blurred.length;
  material.emissiveNode = Fn(() => {
    const light = vec3(0).toVar();
    // Sauté quand le reflet est coupé : une texture périmée ne doit pas contaminer le sol.
    If(u.uReflect.greaterThan(0), () => {
      const clip = u.uReflectMatrix.mul(vec4(p, 1));
      const uv = clip.xy.div(clip.w);
      const level = gloss.mul(5.5).add(0.15).clamp(0, levels);
      // Lectures au niveau 0 (ces textures n'ont pas de mipmaps) : permises dans une branche.
      const lo = texture(sharp, uv).level(0).rgb.toVar();
      const hi = texture(blurred[0], uv).level(0).rgb.toVar();
      for (let i = 1; i < levels; i++) {
        If(level.greaterThan(i), () => {
          lo.assign(hi);
          hi.assign(texture(blurred[i], uv).level(0).rgb);
        });
      }
      const refl = finite(mix(lo, hi, select(level.greaterThanEqual(levels), float(1), fract(level))));
      const fresnel = positionViewDirection.dot(normalView).saturate().oneMinus().pow(4);
      light.assign(refl.mul(u.uReflect).mul(gloss.oneMinus()).mul(mix(0.3, 1, fresnel)));
    });
    return light;
  })();
  return material;
}
