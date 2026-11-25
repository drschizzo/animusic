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
  }

  /**
   * 'high' : lumière indirecte + occlusion ambiante ; 'medium' : halo et objectif seuls ;
   * 'low' : aucun post-traitement. `gi` (réglage utilisateur) coupe la seule lumière indirecte.
   */
  setQuality(level, gi = this.giWanted ?? true) {
    this.giWanted = gi;
    this.enabled = level !== 'low';
    this.ao.enabled = this.ssgi.enabled = level === 'high';
    this.ssgi.gi = gi;
  }

  render(wall) {
    if (!this.enabled) return this.renderer.render(this.scene, this.camera);
    this.lens.uniforms.uTime.value = wall;
    this.composer.render();
  }
}
