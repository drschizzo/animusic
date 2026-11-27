// Chaîne d'effets en nœuds TSL, pour WebGPURenderer : l'équivalent de postfx.js (GLSL).
// Chargée seulement par le prototype (voir gpu.js).
//
//   scène (couleur + vitesse, sans MSAA) ── occlusion ambiante (GTAO) injectée dans les
//   matériaux : elle n'assombrit que la lumière ambiante, pas l'éclairage direct
//     → anticrénelage temporel (TAAU)
//     → flou de mouvement → profondeur de champ        (qualité haute)
//     → halo → objectif (vignettage, courbe de tons, étalonnage, grain)
//
// Le flou de mouvement, la profondeur de champ, le filtre du halo et l'objectif sont les
// portages des passes GLSL (motionblur.js, postfx.js), où sont leurs explications.
// L'ordre suit github.com/marcofugaro/three-advanced-techniques.
//
// Pas encore portés : lumière indirecte (ssgi.js) et faisceaux dans la brume (volumetric.js).

import { RenderPipeline, Matrix4, Vector2, AgXToneMapping, SRGBColorSpace, NearestFilter } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  pass,
  mrt,
  output,
  velocity,
  normalView,
  screenUV,
  screenCoordinate,
  uv,
  rtt,
  uniform,
  float,
  uint,
  vec2,
  vec3,
  vec4,
  mix,
  max,
  min,
  clamp,
  smoothstep,
  select,
  sin,
  cos,
  dot,
  fract,
  length,
  luminance,
  floatBitsToUint,
  perspectiveDepthToViewZ,
  interleavedGradientNoise,
  builtinAOContext,
  workingToColorSpace,
  toneMappingExposure,
} from 'three/tsl';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { motion } from './nodes.js';

const TILE = 16; // côté (pixels) des pavés du flou de mouvement
const BLUR_SAMPLES = 16;
const DOF_TAPS = 36;

const nonFinite = (x) => floatBitsToUint(x).bitAnd(uint(0x7f800000)).equal(uint(0x7f800000));
/** Pixels non finis remplacés, valeurs extrêmes écrêtées (voir ScenePass, postfx.js). */
const sanitized = (c) => vec4(clamp(select(nonFinite(c.r).or(nonFinite(c.g)).or(nonFinite(c.b)), vec3(0), c.rgb), 0, 256), 1);

export class PostFX {
  constructor(renderer, scene, camera) {
    Object.assign(this, { renderer, scene, camera });
    const u = (this.uniforms = {
      near: uniform(camera.near),
      far: uniform(camera.far),
      size: uniform(new Vector2(1, 1)), // taille de l'image (pixels)
      tileTexel: uniform(new Vector2(1, 1)),
      shutter: uniform(0), // temps de pose / durée de l'image ; 0 = pas de flou
      maxBlur: uniform(20),
      focus: uniform(10),
      aperture: uniform(0),
      maxCoc: uniform(9),
      ao: uniform(1),
      time: uniform(0),
      vignette: uniform(0.3),
      grain: uniform(0.02),
      contrast: uniform(1.35),
      saturation: uniform(1.15),
    });
    this._viewProjection = new Matrix4();

    // --- Occlusion ambiante : passe préalable (normales, profondeur) des seuls objets opaques.
    const prePass = (this.prePass = pass(scene, camera, { samples: 0 }));
    prePass.transparent = false;
    prePass.setMRT(mrt({ output: normalView }));
    const occlusion = (this.occlusion = ao(prePass.getTextureNode('depth'), prePass.getTextureNode(), camera));
    occlusion.resolutionScale = 0.5;
    occlusion.radius.value = 0.5;

    // --- Scène : couleur et vitesse, sans MSAA (TAAU anticrénelle).
    const scenePass = (this.scenePass = pass(scene, camera, { samples: 0 }));
    scenePass.setMRT(mrt({ output, velocity }));
    scenePass.contextNode = builtinAOContext(mix(1, occlusion.getTextureNode().sample(screenUV).r, u.ao));
    const depth = scenePass.getTextureNode('depth');
    const speed = scenePass.getTextureNode('velocity');
    const viewDist = (at) => perspectiveDepthToViewZ(depth.sample(at).level(0).r, u.near, u.far).negate();

    // --- Anticrénelage temporel.
    const resolve = (this.taa = taau(sanitized(scenePass.getTextureNode('output')), depth, speed, camera));
    const steady = resolve.getTextureNode();

    // --- Flou de mouvement. Vitesse en pixels pendant le temps de pose.
    const pixels = (v) => v.xy.mul(vec2(0.5, -0.5)).mul(u.shutter).mul(u.size);
    const fastest = (source, step, count, centre) =>
      Fn(() => {
        const best = vec2(0).toVar();
        const bestLength = float(0).toVar();
        Loop(count, count, ({ i, j }) => {
          const v = source.sample(uv().add(vec2(float(i), float(j)).sub(centre).mul(step))).level(0).xy;
          const l = dot(v, v);
          If(l.greaterThan(bestLength), () => {
            bestLength.assign(l);
            best.assign(v);
          });
        });
        return vec4(best, 0, 1);
      })();
    const nearest = { minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false };
    // Par pavé, la plus grande vitesse ; puis le maximum des pavés voisins.
    const tiles = (this.tiles = rtt(fastest(speed, u.tileTexel.div(TILE / 2), 8, 3.5), 1, 1, nearest));
    const spread = (this.spread = rtt(fastest(tiles, u.tileTexel, 3, 1), 1, 1, nearest));
    const blurred = Fn(() => {
      const base = steady.sample(uv());
      const result = base.toVar();
      const noise = interleavedGradientNoise(screenCoordinate.xy);
      const reach = (at) => min(length(pixels(speed.sample(at).level(0))).mul(0.5), u.maxBlur);
      const cone = (d, r) => d.div(max(r, 1e-3)).oneMinus().clamp(0, 1);
      const cylinder = (d, r) => smoothstep(r.mul(0.95), r.mul(1.05).add(1e-3), d).oneMinus();
      // Pavé lu avec un léger décalage aléatoire : pas de frontière visible entre pavés.
      const around = pixels(spread.sample(uv().add(vec2(noise, fract(noise.mul(7.13))).sub(0.5).mul(u.tileTexel))).level(0));
      const span = length(around).mul(0.5).toVar();
      If(span.greaterThanEqual(0.75), () => {
        const dir = around.div(span.mul(2));
        span.assign(min(span, u.maxBlur));
        const mine = reach(uv()).toVar();
        const z = viewDist(uv()).toVar();
        const extent = z.mul(0.02).add(0.08);
        const total = float(1).div(max(mine, 1)).toVar();
        const sum = base.rgb.mul(total).toVar();
        Loop(BLUR_SAMPLES, ({ i }) => {
          const along = mix(-1, 1, float(i).add(noise).div(BLUR_SAMPLES)).mul(span);
          const at = uv().add(dir.mul(along).div(u.size));
          const d = along.abs();
          const theirs = reach(at);
          const zs = viewDist(at);
          const inFront = zs.sub(z).div(extent).oneMinus().clamp(0, 1);
          const behind = z.sub(zs).div(extent).oneMinus().clamp(0, 1);
          const w = inFront.mul(cone(d, theirs)).add(behind.mul(cone(d, mine))).add(cylinder(d, theirs).mul(cylinder(d, mine)).mul(2));
          sum.addAssign(steady.sample(at).level(0).rgb.mul(w));
          total.addAssign(w);
        });
        result.assign(vec4(sum.div(total), base.a));
      });
      return result;
    })();
    const moving = rtt(blurred);

    // --- Profondeur de champ.
    const focused = Fn(() => {
      const base = moving.sample(uv());
      const result = base.toVar();
      const coc = (z) => clamp(u.aperture.mul(z.sub(u.focus).abs()).div(max(z, 0.1)).mul(18), 0, u.maxCoc);
      // Les points lumineux pèsent plus lourd : hors du point, une source devient un disque net.
      const glint = (c) => min(luminance(c), 8).add(1);
      const z = viewDist(uv()).toVar();
      const c = coc(z).toVar();
      If(c.greaterThanEqual(0.6), () => {
        const total = glint(base.rgb).toVar();
        const sum = base.rgb.mul(total).toVar();
        const turn = interleavedGradientNoise(screenCoordinate.xy).mul(6.2831853);
        Loop(DOF_TAPS, ({ i }) => {
          const a = float(i).mul(2.39996).add(turn);
          const r = float(i).add(0.5).div(DOF_TAPS).sqrt().mul(c);
          const at = uv().add(vec2(cos(a), sin(a)).mul(r).div(u.size));
          const zs = viewDist(at);
          const s = moving.sample(at).level(0).rgb;
          const w = select(coc(zs).greaterThanEqual(r.mul(0.9)).or(zs.greaterThan(z)), glint(s), 0);
          sum.addAssign(s.mul(w));
          total.addAssign(w);
        });
        result.assign(vec4(sum.div(total), base.a));
      });
      return result;
    })();
    const sharp = rtt(focused);

    // --- Halo, puis objectif.
    const halo = (image) => {
      const node = bloom(image, 0.36, 0.75, 1.7);
      // Filtre adouci (voir softenBloom, postfx.js) : moyenne de Karis, genou doux, plafond.
      node.highPassFn = ({ input, threshold }) =>
        Fn(() => {
          const knee = 0.5;
          const ceiling = 6;
          const weight = float(0).toVar();
          const c = vec3(0).toVar();
          for (const o of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
            const tap = input.sample(uv().add(vec2(...o).div(u.size))).rgb;
            const k = float(1).div(luminance(tap).add(1));
            c.addAssign(tap.mul(k));
            weight.addAssign(k);
          }
          c.divAssign(max(weight, 1e-4));
          const b = max(c.r, max(c.g, c.b));
          const soft = clamp(b.sub(threshold).add(knee), 0, 2 * knee);
          c.mulAssign(max(soft.mul(soft).div(4 * knee + 1e-4), b.sub(threshold)).div(max(b, 1e-4)));
          c.mulAssign(float(ceiling).div(luminance(c).add(ceiling)));
          return vec4(c, 1);
        })();
      return node;
    };
    const lens = (image) =>
      Fn(() => {
        const centre = uv().sub(0.5);
        const lit = max(image.rgb.mul(smoothstep(0.12, 0.75, dot(centre, centre).mul(1.7)).mul(u.vignette).oneMinus()), 0);
        const toned = vec3(lit.toneMapping(AgXToneMapping, toneMappingExposure).rgb);
        // Étalonnage après la courbe : contraste autour du gris moyen, légère saturation.
        const graded = max(toned, 0).div(0.18).pow(vec3(u.contrast)).mul(0.18);
        const colour = clamp(mix(vec3(luminance(graded)), graded, u.saturation), 0, 1);
        const hash = fract(sin(dot(uv().mul(917).add(fract(u.time).mul(61)), vec2(12.9898, 78.233))).mul(43758.5453));
        return vec4(workingToColorSpace(colour, SRGBColorSpace).rgb.add(hash.sub(0.5).mul(u.grain)), 1);
      })();
    const finished = (image) => lens(vec4(image.rgb.add(halo(image).rgb), 1));
    this.outputs = { high: finished(sharp), medium: finished(steady) };

    const pipeline = (this.pipeline = new RenderPipeline(renderer));
    pipeline.outputColorTransform = false; // l'objectif applique lui-même courbe de tons et sRVB
    this.enabled = true;
    this.setQuality('high');
  }

  setSize(w, h) {
    const ratio = this.renderer.getPixelRatio();
    const width = Math.max(1, Math.round(w * ratio));
    const height = Math.max(1, Math.round(h * ratio));
    const tw = Math.max(1, Math.ceil(width / TILE));
    const th = Math.max(1, Math.ceil(height / TILE));
    const u = this.uniforms;
    u.size.value.set(width, height);
    u.tileTexel.value.set(1 / tw, 1 / th);
    u.maxBlur.value = height * 0.03;
    u.maxCoc.value = 9 * ratio;
    this.tiles.setSize(tw, th);
    this.spread.setSize(tw, th);
  }

  /** Voir PostFX.setMotion (postfx.js). */
  setMotion(shutter, dt) {
    this.uniforms.shutter.value = shutter;
    motion.uDt.value = dt;
  }

  /** Voir PostFX.setFocus (postfx.js). */
  setFocus(distance, aperture, snap = false) {
    const u = this.uniforms;
    u.focus.value += (distance - u.focus.value) * (snap ? 1 : 0.12);
    u.aperture.value += (aperture - u.aperture.value) * (snap ? 1 : 0.1);
  }

  /** 'high' : tout ; 'medium' : anticrénelage, halo et objectif ; 'low' : rendu direct. */
  setQuality(level) {
    this.enabled = level !== 'low';
    const high = level === 'high';
    this.uniforms.ao.value = high ? 1 : 0;
    // L'occlusion est câblée dans les matériaux de la scène : pour la couper sans tout
    // recompiler, ses deux passes cessent simplement d'être rendues.
    for (const node of [this.prePass, this.occlusion]) {
      node._updateBefore ??= node.updateBefore;
      node.updateBefore = high ? node._updateBefore : () => {};
    }
    const wanted = this.outputs[high ? 'high' : 'medium'];
    if (this.pipeline.outputNode !== wanted) {
      this.pipeline.outputNode = wanted;
      this.pipeline.needsUpdate = true;
    }
  }

  render(wall = 0) {
    const { camera, uniforms: u } = this;
    // Caméra de l'image précédente et de celle-ci, pour les vitesses écrites à la main.
    camera.updateMatrixWorld();
    motion.uPrevViewProjection.value.copy(this._viewProjection);
    this._viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    motion.uViewProjection.value.copy(this._viewProjection);
    if (!this.enabled) return this.renderer.render(this.scene, this.camera);
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.time.value = wall;
    this.pipeline.render();
  }
}
