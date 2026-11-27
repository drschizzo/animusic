// Chaîne d'effets en nœuds TSL, pour WebGPURenderer : l'équivalent de postfx.js (GLSL).
// Chargée seulement par le prototype (voir gpu.js).
//
//   scène (couleur + vitesse, sans MSAA) ── occlusion ambiante (GTAO) injectée dans les
//   matériaux : elle n'assombrit que la lumière ambiante, pas l'éclairage direct
//     → anticrénelage temporel (TAAU)
//     → lumière indirecte → flou de mouvement → profondeur de champ
//       → faisceaux dans la brume                      (qualité haute)
//     → halo → objectif (vignettage, courbe de tons, étalonnage, grain)
//
// La lumière indirecte, le flou de mouvement, la profondeur de champ, les faisceaux, le
// filtre du halo et l'objectif sont les portages des passes GLSL (ssgi.js, motionblur.js,
// volumetric.js, postfx.js), où sont leurs explications.
// L'ordre suit github.com/marcofugaro/three-advanced-techniques.

import { RenderPipeline, BlendMode, MaterialBlending, Matrix4, Vector2, Vector3, DepthTexture, LessEqualCompare, AgXToneMapping, SRGBColorSpace, NearestFilter } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Break,
  Continue,
  uniformArray,
  texture,
  materialColor,
  getViewPosition,
  getScreenPosition,
  normalize,
  cross,
  sqrt,
  exp,
  step,
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
const GI_RAYS = 6;
const GI_STEPS = 10;
const BEAMS = 8; // têtes de projecteur tracées dans la brume
const SHADOWED = 2; // dont celles qui lisent leur carte d'ombres (les poursuites)
const BEAM_STEPS = 10;

/**
 * Couleur de base vue par la lumière indirecte (voir GBuffer, ssgi.js) : un métal poli ne
 * diffuse presque rien, et les surfaces très sombres reçoivent un minimum.
 */
const giAlbedo = Fn((builder) => {
  const { material, object } = builder;
  const weight = material.metalness === undefined ? 1 : 1 + material.metalness * (Math.min(1, material.roughness * 1.4) - 1);
  return vec4(materialColor.rgb.mul(weight).add(object.userData.giAlbedo ?? 0.05), 1);
})();

const nonFinite = (x) => floatBitsToUint(x).bitAnd(uint(0x7f800000)).equal(uint(0x7f800000));
/** Pixels non finis remplacés, valeurs extrêmes écrêtées (voir ScenePass, postfx.js). */
const sanitized = (c) => vec4(clamp(select(nonFinite(c.r).or(nonFinite(c.g)).or(nonFinite(c.b)), vec3(0), c.rgb), 0, 256), 1);

export class PostFX {
  /** @param environment décor : `beams()` rend les faisceaux à tracer (voir environment.js) */
  constructor(renderer, scene, camera, environment) {
    Object.assign(this, { renderer, scene, camera, environment });
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
      projection: uniform(new Matrix4()),
      projectionInverse: uniform(new Matrix4()),
      cameraWorld: uniform(new Matrix4()),
      eye: uniform(new Vector3()),
      giIntensity: uniform(2.4),
      giRadius: uniform(3.2),
      giThickness: uniform(0.35),
      giClamp: uniform(8),
      giAoRadius: uniform(0.9),
      giAo: uniform(1),
      giAoPower: uniform(1.6),
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
    prePass.setMRT(mrt({ output: normalView, albedo: giAlbedo }));
    // Géométrie des seules surfaces opaques, lue par la lumière indirecte et les faisceaux.
    const solidDepth = prePass.getTextureNode('depth');
    const solidNormal = prePass.getTextureNode();
    const depthAt = (at) => solidDepth.sample(at).level(0).r;
    const viewAt = (at, d) => getViewPosition(at, d, u.projectionInverse);
    const normalAt = (at) => {
      const n = solidNormal.sample(at).level(0).xyz;
      return n.div(max(length(n), 1e-5));
    };
    const occlusion = (this.occlusion = ao(prePass.getTextureNode('depth'), prePass.getTextureNode(), camera));
    occlusion.resolutionScale = 0.5;
    occlusion.radius.value = 0.5;

    // --- Scène : couleur et vitesse, sans MSAA (TAAU anticrénelle).
    const scenePass = (this.scenePass = pass(scene, camera, { samples: 0 }));
    // La vitesse suit le mélange du matériau : les opaques l'écrivent, les effets
    // additifs y ajoutent un zéro (nodes.seeThrough) et laissent celle de ce qu'ils couvrent.
    scenePass.setMRT(mrt({ output, velocity }).setBlendMode('velocity', new BlendMode(MaterialBlending)));
    scenePass.contextNode = builtinAOContext(mix(1, occlusion.getTextureNode().sample(screenUV).r, u.ao));
    const depth = scenePass.getTextureNode('depth');
    const speed = scenePass.getTextureNode('velocity');
    const viewDist = (at) => perspectiveDepthToViewZ(depth.sample(at).level(0).r, u.near, u.far).negate();

    // --- Anticrénelage temporel.
    const resolve = (this.taa = taau(sanitized(scenePass.getTextureNode('output')), depth, speed, camera));
    const steady = resolve.getTextureNode();

    // --- Lumière indirecte et occlusion, tirées des mêmes rayons (demi-résolution).
    const half = { resolutionScale: 0.5, depthBuffer: false };
    const traced = rtt(
      Fn(() => {
        const result = vec4(0, 0, 0, 1).toVar();
        const depth = depthAt(uv()).toVar();
        If(depth.lessThan(1), () => {
          const P = viewAt(uv(), depth).toVar();
          const N = normalAt(uv()).toVar();
          const T = normalize(select(N.z.abs().lessThan(0.99), cross(N, vec3(0, 0, 1)), vec3(1, 0, 0))).toVar();
          const B = cross(N, T).toVar();
          const noise = interleavedGradientNoise(screenCoordinate.xy).toVar();
          const origin = P.add(N.mul(P.z.negate().mul(0.004).add(0.02))).toVar();
          const sum = vec3(0).toVar();
          const occlusion = float(0).toVar();
          Loop(GI_RAYS, ({ i }) => {
            // Direction tirée selon le cosinus : chaque rayon compte autant.
            const u1 = fract(noise.add(float(i).mul(0.61803399)));
            const u2 = float(i).add(fract(noise.mul(5.17).add(0.37))).div(GI_RAYS).toVar();
            const r = sqrt(u2);
            const phi = u1.mul(6.2831853).toVar();
            const dir = normalize(T.mul(r.mul(cos(phi))).add(B.mul(r.mul(sin(phi)))).add(N.mul(sqrt(max(0, u2.oneMinus()))))).toVar();
            const jitter = fract(noise.mul(3.31).add(float(i).mul(0.41))).toVar();
            Loop({ start: 0, end: GI_STEPS, name: 's' }, ({ s }) => {
              // Pas resserrés près de la surface, plus longs au loin.
              const f = float(s).add(jitter).div(GI_STEPS);
              const dist = f.mul(f).mul(u.giRadius).toVar();
              const Q = origin.add(dir.mul(dist)).toVar();
              If(Q.z.greaterThan(-0.1), () => {
                Break();
              });
              const at = getScreenPosition(Q, u.projection).toVar();
              If(at.x.lessThan(0).or(at.x.greaterThan(1)).or(at.y.lessThan(0)).or(at.y.greaterThan(1)), () => {
                Break();
              });
              const sceneDepth = depthAt(at).toVar();
              If(sceneDepth.lessThan(1), () => {
                const behind = viewAt(at, sceneDepth).z.sub(Q.z).toVar();
                If(behind.greaterThan(0).and(behind.lessThan(dist.mul(0.25).add(u.giThickness))), () => {
                  // Seule une surface tournée vers nous peut nous éclairer.
                  const facing = step(0, dot(normalAt(at), dir).negate());
                  sum.addAssign(min(steady.sample(at).level(0).rgb, u.giClamp).mul(facing));
                  // Occlusion : totale au contact, nulle au-delà de giAoRadius.
                  const open = min(1, dist.div(u.giAoRadius));
                  occlusion.addAssign(open.mul(open).oneMinus());
                  Break();
                });
              });
            });
          });
          result.assign(vec4(sum.div(GI_RAYS), occlusion.div(GI_RAYS).oneMinus()));
        });
        return result;
      })(),
      null,
      null,
      half,
    );
    // Débruitage : flous qui respectent les arêtes (même profondeur, même orientation).
    const denoised = (input, x, y) =>
      rtt(
        Fn(() => {
          const result = vec4(0, 0, 0, 1).toVar();
          const depth = depthAt(uv()).toVar();
          If(depth.lessThan(1), () => {
            const z = viewAt(uv(), depth).z.toVar();
            const n = normalAt(uv()).toVar();
            const sum = vec4(0).toVar();
            const total = float(0).toVar();
            Loop(9, ({ i }) => {
              const k = float(i).sub(4).toVar();
              const at = uv().add(vec2(x, y).div(u.size.mul(0.5)).mul(k)).toVar();
              const d = depthAt(at).toVar();
              If(d.lessThan(1), () => {
                const dz = viewAt(at, d).z.sub(z).abs().div(z.negate().mul(0.03).add(0.04));
                const w = exp(k.mul(k).mul(-0.12)).mul(exp(dz.mul(dz).negate())).mul(max(0, dot(n, normalAt(at))).pow(8));
                sum.addAssign(input.sample(at).level(0).mul(w));
                total.addAssign(w);
              });
            });
            result.assign(select(total.greaterThan(1e-4), sum.div(max(total, 1e-4)), vec4(0, 0, 0, 1)));
          });
          return result;
        })(),
        null,
        null,
        half,
      );
    // Deux tours de flou (horizontal puis vertical), le second plus large.
    const indirect = denoised(denoised(denoised(denoised(traced, 1, 0), 0, 1), 2.5, 0), 0, 2.5);
    const lit = rtt(
      Fn(() => {
        const base = steady.sample(uv());
        // Hors des surfaces opaques (fond, vitres seules) : ni ombre ni lumière.
        const solid = step(depthAt(uv()), 0.9999999);
        const gi = indirect.sample(uv());
        const shade = mix(1, clamp(gi.a, 0, 1).pow(u.giAoPower), u.giAo.mul(solid));
        return vec4(base.rgb.mul(shade).add(gi.rgb.mul(prePass.getTextureNode('albedo').sample(uv()).rgb).mul(solid).mul(u.giIntensity)), base.a);
      })(),
    );

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
      const base = lit.sample(uv());
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
          sum.addAssign(lit.sample(at).level(0).rgb.mul(w));
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

    // --- Faisceaux des projecteurs dans la brume, au quart de la résolution.
    const vectors = () => Array.from({ length: BEAMS }, () => new Vector3());
    const beams = (this.beams = { apex: vectors(), axis: vectors(), color: vectors(), shape: vectors() }); // shape : cosinus du demi-angle, longueur, indice de carte d'ombres (−1 : aucune)
    const [apexes, axes, colors, shapes] = [beams.apex, beams.axis, beams.color, beams.shape].map((list) => uniformArray(list));
    // Cartes d'ombres des poursuites : créées par le moteur à leur premier rendu, branchées alors.
    this.shadows = Array.from({ length: SHADOWED }, () => {
      const blank = new DepthTexture(1, 1);
      blank.compareFunction = LessEqualCompare;
      return { map: texture(blank), matrix: uniform(new Matrix4()) };
    });
    const litBy = (slot, p) => {
      const visible = float(1).toVar();
      this.shadows.forEach(({ map, matrix }, index) => {
        If(slot.sub(index).abs().lessThan(0.5), () => {
          const c = matrix.mul(vec4(p, 1)).toVar();
          const sh = c.xyz.div(c.w).toVar();
          If(c.w.greaterThan(0).and(sh.x.greaterThanEqual(0)).and(sh.x.lessThanEqual(1)).and(sh.y.greaterThanEqual(0)).and(sh.y.lessThanEqual(1)).and(sh.z.lessThanEqual(1)), () => {
            visible.assign(map.sample(vec2(sh.x, sh.y.oneMinus())).compare(sh.z.sub(0.0005)));
          });
        });
      });
      return visible;
    };
    const reachAt = (at) => length(viewAt(at, depthAt(at)));
    const marched = rtt(
      Fn(() => {
        const world = u.cameraWorld.mul(vec4(viewAt(uv(), depthAt(uv())), 1)).xyz;
        const reach = length(world.sub(u.eye)).toVar();
        const dir = world.sub(u.eye).div(max(reach, 1e-4)).toVar();
        const noise = interleavedGradientNoise(screenCoordinate.xy).toVar();
        const sum = vec3(0).toVar();
        Loop(BEAMS, ({ i }) => {
          const color = colors.element(i).toVar();
          If(color.r.add(color.g).add(color.b).lessThanEqual(0), () => {
            Continue();
          });
          const apex = apexes.element(i).toVar();
          const axis = axes.element(i).toVar();
          const shape = shapes.element(i).toVar();
          const cosEdge = shape.x;
          const len = shape.y;
          // Cône : (P − sommet)·axe ≥ |P − sommet|·cos. Le long du rayon, c'est un trinôme en t.
          const co = u.eye.sub(apex).toVar();
          const vd = dot(dir, axis).toVar();
          const cd = dot(co, axis).toVar();
          const c2 = cosEdge.mul(cosEdge).toVar();
          const a = vd.mul(vd).sub(c2).toVar();
          const b = vd.mul(cd).sub(c2.mul(dot(dir, co))).mul(2).toVar();
          const k = cd.mul(cd).sub(c2.mul(dot(co, co)));
          const t0 = float(0).toVar();
          const t1 = float(reach).toVar();
          const disc = b.mul(b).sub(a.mul(k).mul(4)).toVar();
          If(a.abs().lessThan(1e-5), () => {
            Continue();
          });
          If(disc.lessThan(0), () => {
            // Aucune racine : le rayon est tout entier hors du cône, ou tout entier dedans.
            If(a.lessThan(0), () => {
              Continue();
            });
          }).Else(() => {
            const root = sqrt(disc);
            const ra = b.negate().sub(root).div(a.mul(2));
            const rb = b.negate().add(root).div(a.mul(2));
            const lo = min(ra, rb).toVar();
            const hi = max(ra, rb).toVar();
            If(a.lessThan(0), () => {
              // Dans le cône entre les deux racines (si c'est bien la nappe du faisceau).
              If(cd.add(lo.add(hi).mul(0.5).mul(vd)).lessThanEqual(0), () => {
                Continue();
              });
              t0.assign(max(t0, lo));
              t1.assign(min(t1, hi));
            })
              .ElseIf(cd.add(lo.sub(1).mul(vd)).greaterThan(0), () => {
                t1.assign(min(t1, lo));
              })
              .Else(() => {
                t0.assign(max(t0, hi));
              });
          });
          // Tronqué le long de l'axe : de la lentille au bout du faisceau.
          If(vd.abs().greaterThan(1e-5), () => {
            const ta = float(0.25).sub(cd).div(vd).toVar();
            const tb = len.sub(cd).div(vd).toVar();
            t0.assign(max(t0, min(ta, tb)));
            t1.assign(min(t1, max(ta, tb)));
          }).ElseIf(cd.lessThan(0.25).or(cd.greaterThan(len)), () => {
            Continue();
          });
          If(t1.lessThanEqual(t0), () => {
            Continue();
          });
          const stepLength = t1.sub(t0).div(BEAM_STEPS).toVar();
          const gathered = float(0).toVar();
          Loop({ start: 0, end: BEAM_STEPS, name: 's' }, ({ s }) => {
            const p = u.eye.add(dir.mul(t0.add(float(s).add(noise).mul(stepLength)))).toVar();
            const rel = p.sub(apex).toVar();
            const along = dot(rel, axis).toVar();
            const cosine = along.div(max(length(rel), 1e-4));
            // Dense dans l'axe, fondu sur le bord ; la lumière se dilue en s'élargissant
            // et la brume l'éteint avant le bout du faisceau.
            const radial = smoothstep(cosEdge, mix(cosEdge, 1, 0.7), cosine);
            const spread = float(1).div(along.mul(along).mul(0.06).add(1));
            const fade = smoothstep(len.mul(0.55), len, along).oneMinus();
            const visible = float(1).toVar();
            If(shape.z.greaterThanEqual(0), () => {
              visible.assign(litBy(shape.z, p));
            });
            gathered.addAssign(radial.mul(spread).mul(fade).mul(visible));
          });
          sum.addAssign(color.mul(gathered).mul(stepLength));
        });
        // La distance marchée accompagne la lumière : l'agrandissement s'en sert.
        return vec4(sum, reach);
      })(),
      null,
      null,
      { resolutionScale: 0.25, depthBuffer: false },
    );
    // Agrandissement : seuls comptent les voisins qui ont marché jusqu'à la même distance.
    const hazed = Fn(() => {
      const base = vec4(focused);
      const reach = reachAt(uv()).toVar();
      const sum = vec3(0).toVar();
      const total = float(0).toVar();
      Loop(3, 3, ({ i, j }) => {
        const beam = marched.sample(uv().add(vec2(float(i), float(j)).sub(1).div(u.size.mul(0.25)))).level(0);
        const w = float(1).div(reach.mul(0.02).add(beam.a.sub(reach).abs()));
        sum.addAssign(beam.rgb.mul(w));
        total.addAssign(w);
      });
      return vec4(base.rgb.add(sum.div(total)), base.a);
    })();
    const sharp = rtt(hazed);

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

  /**
   * 'high' : tout ; 'medium' : anticrénelage, halo et objectif ; 'low' : rendu direct.
   * `gi` (réglage utilisateur) coupe la seule lumière indirecte : l'occlusion reste.
   */
  setQuality(level, gi = this.giWanted ?? true) {
    this.giWanted = gi;
    this.uniforms.giIntensity.value = gi ? 2.4 : 0;
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

  /** Faisceaux de l'image : têtes du décor, et carte d'ombres de celles qui en ont une. */
  updateBeams() {
    const list = this.environment?.beams() ?? [];
    const { apex, axis, color, shape } = this.beams;
    let shadows = 0;
    for (let i = 0; i < BEAMS; i++) {
      const beam = list[i];
      if (!beam) {
        color[i].set(0, 0, 0);
        continue;
      }
      apex[i].copy(beam.apex);
      axis[i].copy(beam.axis);
      color[i].set(beam.color.r, beam.color.g, beam.color.b).multiplyScalar(beam.intensity);
      const map = beam.shadow?.map?.depthTexture;
      const slot = map && shadows < SHADOWED ? shadows++ : -1;
      if (slot >= 0) {
        this.shadows[slot].map.value = map;
        this.shadows[slot].matrix.value.copy(beam.shadow.matrix);
      }
      shape[i].set(Math.cos(beam.angle), beam.length, slot);
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
    u.projection.value.copy(camera.projectionMatrix);
    u.projectionInverse.value.copy(camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.eye.value.setFromMatrixPosition(camera.matrixWorld);
    this.updateBeams();
    this.pipeline.render();
  }
}
