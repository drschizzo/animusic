// Chaîne de post-traitement : rendu HDR anticrénelé (MSAA), lumière indirecte en
// espace écran (SSGI), occlusion ambiante (GTAO), halo des sources lumineuses (bloom), puis « objectif » (vignettage,
// légère aberration chromatique, grain) et conversion finale (ACES + sRVB).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GBuffer, SSGIPass } from './ssgi.js';
import { FINITE } from './glsl.js';

/**
 * Première passe après le rendu : remplace les pixels non finis (NaN, Inf) et écrête
 * les valeurs extrêmes. Sans elle, le halo (flou en cascade) transforme un seul pixel
 * NaN en un grand rectangle noir, et la lumière indirecte le recopie à son tour.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null }, uClamp: { value: 256 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uClamp; varying vec2 vUv;
    ${FINITE}
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(min(max(finite(c.rgb), vec3(0.0)), vec3(uClamp)), 1.0);
    }`,
};

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
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float z = viewDist(vUv);
      float c = coc(z);
      if (c < 0.6) { gl_FragColor = base; return; }
      vec3 sum = base.rgb;
      float wsum = 1.0;
      for (int i = 0; i < 28; i++) {
        float a = float(i) * 2.39996;
        float r = sqrt(float(i) + 0.5) / sqrt(28.0) * c;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
        float zs = viewDist(uv);
        float w = (coc(zs) >= r * 0.9 || zs > z) ? 1.0 : 0.0;
        sum += texture2D(tDiffuse, uv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / wsum, base.a);
    }`,
};

const LensShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAberration: { value: 0.0016 }, uVignette: { value: 0.42 }, uGrain: { value: 0.035 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uAberration; uniform float uVignette; uniform float uGrain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // Aberration chromatique croissante vers les bords.
      vec2 shift = c * r2 * uAberration * 4.0;
      vec3 col = vec3(texture2D(tDiffuse, vUv + shift).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - shift).b);
      col *= 1.0 - uVignette * smoothstep(0.12, 0.75, r2 * 1.7);
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += (hash(vUv * 917.0 + fract(uTime) * 61.0) - 0.5) * uGrain * (0.25 + min(1.0, lum));
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = (this.composer = new EffectComposer(renderer, target));
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new ShaderPass(SanitizeShader));

    // Tampon géométrique partagé (normales, couleur de base, profondeur), puis lumière indirecte.
    this.gbuffer = new GBuffer(scene, camera);
    this.ssgi = new SSGIPass(this.gbuffer, camera);
    composer.addPass(this.ssgi);

    // L'occlusion ambiante lit le même tampon au lieu de rendre le sien.
    const ao = (this.ao = new GTAOPass(scene, camera, 1, 1));
    ao.normalRenderTarget.dispose();
    ao.normalRenderTarget = { setSize() {}, dispose() {}, texture: this.gbuffer.normalTexture, depthTexture: this.gbuffer.depthTexture };
    ao.setGBuffer(this.gbuffer.depthTexture, this.gbuffer.normalTexture);
    ao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.25, samples: 12, screenSpaceRadius: false });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    ao.blendIntensity = 0.9;
    composer.addPass(ao);

    // Profondeur de champ (qualité haute : elle lit la profondeur du tampon géométrique).
    this.dof = new ShaderPass(DofShader);
    this.dof.uniforms.tDepth.value = this.gbuffer.depthTexture;
    composer.addPass(this.dof);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.6, 1.5);
    composer.addPass(this.bloom);
    this.lens = new ShaderPass(LensShader);
    composer.addPass(this.lens);
    composer.addPass(new OutputPass());
    this.enabled = true;
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    const ratio = this.renderer.getPixelRatio();
    this.dof.uniforms.uTexel.value.set(1 / (w * ratio), 1 / (h * ratio));
    this.dof.uniforms.uMaxBlur.value = 6 * ratio;
  }

  /** Mise au point : distance (m) et ouverture relative (0 = tout net). */
  setFocus(distance, aperture) {
    const u = this.dof.uniforms;
    u.uFocus.value = distance;
    // Lissage : la mise au point « glisse » d'un sujet à l'autre au lieu de sauter.
    u.uAperture.value += (aperture - u.uAperture.value) * 0.1;
  }

  /**
   * 'high' : lumière indirecte + occlusion ambiante ; 'medium' : halo et objectif seuls ;
   * 'low' : aucun post-traitement. `gi` (réglage utilisateur) coupe la seule lumière indirecte.
   */
  setQuality(level, gi = this.giWanted ?? true) {
    this.giWanted = gi;
    this.enabled = level !== 'low';
    this.ao.enabled = this.ssgi.enabled = this.dof.enabled = level === 'high';
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
