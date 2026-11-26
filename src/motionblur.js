// Flou de mouvement : chaque pixel est étalé le long de son déplacement à l'écran
// pendant le temps de pose (obturateur d'une caméra de cinéma).
//
// La vitesse vient du tampon géométrique (ssgi.js), qui projette chaque surface à sa
// position précédente : matrice de l'objet à l'image d'avant et, pour les billes, vitesse
// exacte tirée de leur trajectoire (elles changent de place dans leur réservoir
// d'instances d'une image à l'autre, on ne peut pas comparer deux images).
//
// 1. Par pavé de 16 × 16 pixels, la plus grande vitesse ; puis le maximum des pavés
//    voisins : un objet rapide et fin (une baguette) doit pouvoir baver hors de sa
//    silhouette, donc les pixels voisins doivent savoir qu'il passe près d'eux.
// 2. Chaque pixel en mouvement (ou voisin d'un mouvement) moyenne l'image le long de
//    cette vitesse. Un échantillon compte s'il s'étale lui-même jusqu'au pixel, ou s'il
//    est derrière un pixel qui bouge ; un premier plan immobile reste net.
//
// Les pixels au repos sortent tout de suite : la passe ne coûte que là où ça bouge.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const TILE = 16;
const quadVertex = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const quad = (uniforms, fragmentShader, defines = {}) =>
  new FullScreenQuad(new THREE.ShaderMaterial({ uniforms, defines, vertexShader: quadVertex, fragmentShader, depthTest: false, depthWrite: false }));

export class MotionBlurPass extends Pass {
  constructor(gbuffer, camera) {
    super();
    this.camera = camera;
    this.scale = 0; // temps de pose / durée de l'image ; 0 = pas de flou (pause, coupe, saut)
    const options = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    this.tiles = new THREE.WebGLRenderTarget(1, 1, options);
    this.spread = new THREE.WebGLRenderTarget(1, 1, options);
    const velocity = { value: gbuffer.velocityTexture };

    this.tileMax = quad(
      { tVelocity: velocity, uTexel: { value: new THREE.Vector2() } },
      /* glsl */ `
        uniform sampler2D tVelocity; uniform vec2 uTexel; varying vec2 vUv;
        void main() {
          vec2 best = vec2(0.0);
          float bestLen = 0.0;
          for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
            vec2 v = texture2D(tVelocity, vUv + (vec2(float(i), float(j)) - 3.5) * 2.0 * uTexel).xy;
            float l = dot(v, v);
            if (l > bestLen) { bestLen = l; best = v; }
          }
          gl_FragColor = vec4(best, 0.0, 1.0);
        }`,
    );
    this.neighbourMax = quad(
      { tTiles: { value: this.tiles.texture }, uTexel: { value: new THREE.Vector2() } },
      /* glsl */ `
        uniform sampler2D tTiles; uniform vec2 uTexel; varying vec2 vUv;
        void main() {
          vec2 best = vec2(0.0);
          float bestLen = 0.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 v = texture2D(tTiles, vUv + vec2(float(i), float(j)) * uTexel).xy;
            float l = dot(v, v);
            if (l > bestLen) { bestLen = l; best = v; }
          }
          gl_FragColor = vec4(best, 0.0, 1.0);
        }`,
    );
    this.blur = quad(
      {
        tColor: { value: null },
        tVelocity: velocity,
        tSpread: { value: this.spread.texture },
        tDepth: { value: gbuffer.depthTexture },
        uSize: { value: new THREE.Vector2(1, 1) },
        uTileTexel: { value: new THREE.Vector2() },
        uScale: { value: 0 },
        uMaxPixels: { value: 40 },
        cameraNear: { value: 0.1 },
        cameraFar: { value: 250 },
      },
      /* glsl */ `
        #include <packing>
        uniform sampler2D tColor; uniform sampler2D tVelocity; uniform sampler2D tSpread; uniform sampler2D tDepth;
        uniform vec2 uSize; uniform vec2 uTileTexel; uniform float uScale; uniform float uMaxPixels;
        uniform float cameraNear; uniform float cameraFar;
        varying vec2 vUv;
        float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
        float viewDist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
        // Demi-longueur (pixels) de la traînée d'un pixel, bornée.
        float reach(vec2 uv) { return min(0.5 * length(texture2D(tVelocity, uv).xy * uScale * uSize), uMaxPixels); }
        float cone(float d, float r) { return clamp(1.0 - d / max(r, 1e-3), 0.0, 1.0); }
        float cylinder(float d, float r) { return 1.0 - smoothstep(0.95 * r, 1.05 * r + 1e-3, d); }
        void main() {
          vec4 base = texture2D(tColor, vUv);
          float noise = ign(gl_FragCoord.xy);
          // Pavé lu avec un léger décalage aléatoire : pas de frontière visible entre pavés.
          vec2 spread = texture2D(tSpread, vUv + (vec2(noise, fract(noise * 7.13)) - 0.5) * uTileTexel).xy * uScale * uSize;
          float span = 0.5 * length(spread);
          if (span < 0.75) { gl_FragColor = base; return; }
          vec2 dir = spread / (2.0 * span);
          span = min(span, uMaxPixels);
          float mine = reach(vUv);
          float z = viewDist(vUv);
          float extent = 0.08 + 0.02 * z;
          float total = 1.0 / max(mine, 1.0);
          vec3 sum = base.rgb * total;
          for (int i = 0; i < SAMPLES; i++) {
            float along = mix(-1.0, 1.0, (float(i) + noise) / float(SAMPLES)) * span;
            vec2 uv = vUv + dir * along / uSize;
            float d = abs(along);
            float theirs = reach(uv);
            float zs = viewDist(uv);
            float inFront = clamp(1.0 - (zs - z) / extent, 0.0, 1.0);
            float behind = clamp(1.0 - (z - zs) / extent, 0.0, 1.0);
            float w = inFront * cone(d, theirs) + behind * cone(d, mine) + 2.0 * cylinder(d, theirs) * cylinder(d, mine);
            sum += texture2D(tColor, uv).rgb * w;
            total += w;
          }
          gl_FragColor = vec4(sum / total, base.a);
        }`,
      { SAMPLES: 16 },
    );
  }

  setSize(w, h) {
    const tw = Math.max(1, Math.ceil(w / TILE));
    const th = Math.max(1, Math.ceil(h / TILE));
    this.tiles.setSize(tw, th);
    this.spread.setSize(tw, th);
    this.tileMax.material.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.neighbourMax.material.uniforms.uTexel.value.set(1 / tw, 1 / th);
    const u = this.blur.material.uniforms;
    u.uSize.value.set(w, h);
    u.uTileTexel.value.set(1 / tw, 1 / th);
    u.uMaxPixels.value = h * 0.03;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.needsSwap = this.scale > 0;
    if (!this.needsSwap) return;
    renderer.setRenderTarget(this.tiles);
    this.tileMax.render(renderer);
    renderer.setRenderTarget(this.spread);
    this.neighbourMax.render(renderer);
    const u = this.blur.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.uScale.value = this.scale;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.blur.render(renderer);
  }
}
