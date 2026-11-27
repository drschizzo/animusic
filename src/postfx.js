// Chaîne de post-traitement : rendu HDR anticrénelé (MSAA), lumière indirecte et
// occlusion ambiante en espace écran (une seule passe de rayons, voir ssgi.js), profondeur
// de champ, halo des sources lumineuses (bloom), puis « objectif » (vignettage, grain) et
// conversion finale (AgX + sRVB) dans la même passe.
//
// Seul le rendu de la scène est multi-échantillonné : il est résolu une fois, puis toutes
// les passes plein écran travaillent dans des tampons simples (quatre fois moins de
// mémoire à écrire, pas de résolution après chaque passe).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GBuffer, SSGIPass } from './ssgi.js';
import { MotionBlurPass } from './motionblur.js';
import { VolumetricPass } from './volumetric.js';
import { FINITE } from './glsl.js';

/**
 * Rendu de la scène dans un tampon multi-échantillonné, puis résolution vers le tampon
 * du compositeur par une copie qui remplace les pixels non finis (NaN, Inf) et écrête
 * les valeurs extrêmes. Sans cela, le halo (flou en cascade) transforme un seul pixel
 * NaN en un grand rectangle noir, et la lumière indirecte le recopie à son tour.
 */
class ScenePass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.copy = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: this.target.texture }, uClamp: { value: 256 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
          uniform sampler2D tDiffuse; uniform float uClamp; varying vec2 vUv;
          ${FINITE}
          void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            gl_FragColor = vec4(min(max(finite(c.rgb), vec3(0.0)), vec3(uClamp)), 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  setSize(w, h) {
    this.target.setSize(w, h);
  }

  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.copy.render(renderer);
  }
}

/**
 * Profondeur de champ : flou dont le rayon croît avec l'écart à la distance de mise au
 * point, lu dans la profondeur du tampon géométrique. Un échantillon n'est retenu que
 * s'il est lui-même flou à cette distance ou s'il est derrière : un premier plan net ne
 * bave pas sur l'arrière-plan flou.
 */
const DofShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 250 },
    uFocus: { value: 10 },
    uAperture: { value: 0 },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uMaxBlur: { value: 10 },
  },
  defines: { TAPS: 36 },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform float cameraNear; uniform float cameraFar; uniform float uFocus; uniform float uAperture; uniform float uMaxBlur;
    uniform vec2 uTexel;
    varying vec2 vUv;
    float viewDist(vec2 uv) {
      return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    }
    float coc(float z) {
      return clamp(uAperture * abs(z - uFocus) / max(z, 0.1) * 18.0, 0.0, uMaxBlur);
    }
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    // Les points lumineux pèsent plus lourd : hors du point, une source devient un disque
    // net et brillant (bokeh) au lieu de se dissoudre dans la moyenne.
    float glint(vec3 c) { return 1.0 + min(dot(c, vec3(0.2126, 0.7152, 0.0722)), 8.0); }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float z = viewDist(vUv);
      float c = coc(z);
      if (c < 0.6) { gl_FragColor = base; return; }
      float wsum = glint(base.rgb);
      vec3 sum = base.rgb * wsum;
      // Spirale tournée d'un angle différent à chaque pixel : pas d'anneaux réguliers.
      float turn = ign(gl_FragCoord.xy) * 6.2831853;
      for (int i = 0; i < TAPS; i++) {
        float a = float(i) * 2.39996 + turn;
        float r = sqrt((float(i) + 0.5) / float(TAPS)) * c;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
        float zs = viewDist(uv);
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float w = (coc(zs) >= r * 0.9 || zs > z) ? glint(s) : 0.0;
        sum += s * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / wsum, base.a);
    }`,
};

/**
 * Dernière passe : vignettage doux, courbe de tons du moteur, étalonnage, sRVB et grain,
 * le tout en une seule écriture plein écran.
 */
const LensShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.3 }, uGrain: { value: 0.02 }, uContrast: { value: 1.35 }, uSaturation: { value: 1.15 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; uniform float uContrast; uniform float uSaturation;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      col *= 1.0 - uVignette * smoothstep(0.12, 0.75, dot(c, c) * 1.7);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
      #include <tonemapping_fragment>
      // Étalonnage : AgX seul est doux et un peu terne ; contraste autour du gris moyen
      // et légère saturation, appliqués après la courbe (les hautes lumières restent pâles).
      vec3 graded = 0.18 * pow(max(gl_FragColor.rgb, 0.0) / 0.18, vec3(uContrast));
      gl_FragColor.rgb = clamp(mix(vec3(dot(graded, vec3(0.2126, 0.7152, 0.0722))), graded, uSaturation), 0.0, 1.0);
      #include <colorspace_fragment>
      // Grain après la courbe de tons : même amplitude perçue dans les ombres et les lumières.
      gl_FragColor.rgb += (hash(vUv * 917.0 + fract(uTime) * 61.0) - 0.5) * uGrain;
    }`,
};

/**
 * Halo plus fin que celui d'origine, qui recopie tel quel tout pixel au-dessus du seuil :
 * un reflet minuscule mais très intense y devenait une grosse tache, et le seuil franc
 * faisait clignoter le halo d'une image à l'autre. Ici :
 * - moyenne de Karis sur quatre échantillons (chacun pesé par 1 / (1 + luminance)) : un
 *   pixel isolé très chaud ne compte plus que pour ce qu'il couvre ;
 * - seuil à genou doux : on garde l'excès au-dessus du seuil, raccordé en douceur ;
 * - compression des très hautes valeurs : un éclat reste un éclat, pas un projecteur.
 */
function softenBloom(bloom) {
  const u = bloom.highPassUniforms;
  u.uTexel = { value: new THREE.Vector2(1 / 1024, 1 / 1024) };
  u.uKnee = { value: 0.5 };
  u.uCeiling = { value: 6 };
  const m = bloom.materialHighPassFilter;
  m.fragmentShader = /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float luminosityThreshold;
    uniform float uKnee;
    uniform float uCeiling;
    uniform vec2 uTexel;
    varying vec2 vUv;
    float haloLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 haloTap(vec2 o, inout float w) {
      vec3 c = texture2D(tDiffuse, vUv + o * uTexel).rgb;
      float k = 1.0 / (1.0 + haloLuma(c));
      w += k;
      return c * k;
    }
    void main() {
      float w = 0.0;
      vec3 c = haloTap(vec2(-0.5, -0.5), w) + haloTap(vec2(0.5, -0.5), w) + haloTap(vec2(-0.5, 0.5), w) + haloTap(vec2(0.5, 0.5), w);
      c /= max(w, 1e-4);
      float b = max(c.r, max(c.g, c.b));
      float soft = clamp(b - luminosityThreshold + uKnee, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-4);
      c *= max(soft, b - luminosityThreshold) / max(b, 1e-4);
      c *= uCeiling / (uCeiling + haloLuma(c));
      gl_FragColor = vec4(c, 1.0);
    }`;
  m.needsUpdate = true;
}

export class PostFX {
  constructor(renderer, scene, camera, environment) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    const composer = (this.composer = new EffectComposer(renderer, target));
    composer.addPass(new ScenePass(scene, camera));

    // Tampon géométrique (normales, couleur de base, profondeur), puis lumière indirecte
    // et occlusion ambiante, tirées des mêmes rayons.
    this.gbuffer = new GBuffer(scene, camera);
    this.ssgi = new SSGIPass(this.gbuffer, camera);
    composer.addPass(this.ssgi);

    // Flou de mouvement (qualité haute : il lit la vitesse et la profondeur du tampon géométrique).
    this.motion = new MotionBlurPass(this.gbuffer, camera);
    composer.addPass(this.motion);

    // Profondeur de champ (qualité haute : elle lit la profondeur du tampon géométrique).
    this.dof = new ShaderPass(DofShader);
    this.dof.uniforms.tDepth.value = this.gbuffer.depthTexture;
    composer.addPass(this.dof);

    // Faisceaux des projecteurs dans la brume (qualité haute), avant le halo qui les adoucit.
    this.beams = new VolumetricPass(this.gbuffer.depthTexture, camera, environment);
    composer.addPass(this.beams);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.36, 0.75, 1.7);
    softenBloom(this.bloom);
    composer.addPass(this.bloom);
    this.lens = new ShaderPass(LensShader);
    composer.addPass(this.lens);
    this.enabled = true;
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    const ratio = this.renderer.getPixelRatio();
    this.dof.uniforms.uTexel.value.set(1 / (w * ratio), 1 / (h * ratio));
    this.dof.uniforms.uMaxBlur.value = 9 * ratio;
    this.bloom.highPassUniforms.uTexel.value.set(1 / (w * ratio), 1 / (h * ratio));
  }

  /**
   * Mouvement depuis l'image précédente.
   * @param shutter temps de pose rapporté à la durée de l'image (0 : pas de flou)
   * @param dt temps musical écoulé (s) : vitesse propre des billes
   */
  setMotion(shutter, dt) {
    this.motion.scale = shutter;
    this.gbuffer.dt = dt;
  }

  /** Mise au point : distance (m) et ouverture relative (0 = tout net). Appelée à chaque image. */
  setFocus(distance, aperture, snap = false) {
    const u = this.dof.uniforms;
    // Lissage : le point et l'ouverture « glissent » d'un sujet à l'autre au lieu de sauter
    // (`snap` : coupe franche, le point est fait d'emblée).
    u.uFocus.value += (distance - u.uFocus.value) * (snap ? 1 : 0.12);
    u.uAperture.value += (aperture - u.uAperture.value) * (snap ? 1 : 0.1);
  }

  /**
   * 'high' : lumière indirecte + occlusion ambiante ; 'medium' : halo et objectif seuls ;
   * 'low' : aucun post-traitement. `gi` (réglage utilisateur) coupe la seule lumière
   * indirecte : l'occlusion ambiante reste.
   */
  setQuality(level, gi = this.giWanted ?? true) {
    this.giWanted = gi;
    this.enabled = level !== 'low';
    this.ssgi.enabled = this.motion.enabled = this.dof.enabled = this.beams.enabled = level === 'high';
    this.ssgi.gi = gi;
  }

  render(wall) {
    if (!this.enabled) return this.renderer.render(this.scene, this.camera);
    this.lens.uniforms.uTime.value = wall;
    this.dof.uniforms.cameraNear.value = this.camera.near;
    this.dof.uniforms.cameraFar.value = this.camera.far;
    this.composer.render();
  }
}
