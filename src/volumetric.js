// Faisceaux volumétriques : la lumière des projecteurs diffusée par la brume de scène.
//
// Pour chaque pixel (au quart de la résolution), le rayon de vue est coupé par le cône de
// chaque projecteur : l'intersection est calculée exactement, puis quelques pas marchent
// seulement dans la partie du rayon qui traverse le faisceau. Les deux poursuites lisent
// leur carte d'ombres à chaque pas : un instrument découpe son ombre dans la brume. Les
// têtes d'ambiance, sans carte d'ombres, ne sont arrêtées que par ce que la caméra voit.
//
// L'image obtenue est ensuite agrandie en respectant la profondeur (un faisceau qui
// passe derrière un bras ne bave pas dessus) et ajoutée à l'image.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const BEAMS = 8;
const SHADOWED = 2;
const quadVertex = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

export class VolumetricPass extends Pass {
  /**
   * @param depthTexture profondeur de la scène (tampon géométrique)
   * @param source décor : `beams()` rend les faisceaux à tracer (voir environment.js)
   */
  constructor(depthTexture, camera, source) {
    super();
    this.camera = camera;
    this.source = source;
    this.gain = 1;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    const vectors = () => Array.from({ length: BEAMS }, () => new THREE.Vector3());

    this.march = new FullScreenQuad(
      new THREE.ShaderMaterial({
        defines: { BEAMS, SHADOWED, STEPS: 10 },
        uniforms: {
          tDepth: { value: depthTexture },
          uProjectionInverse: { value: new THREE.Matrix4() },
          uCameraWorld: { value: new THREE.Matrix4() },
          uApex: { value: vectors() },
          uAxis: { value: vectors() },
          uColor: { value: vectors() },
          uShape: { value: vectors() }, // cosinus du demi-angle, longueur, indice de carte d'ombres (−1 : aucune)
          uShadowMap: { value: Array.from({ length: SHADOWED }, () => null) },
          uShadowMatrix: { value: Array.from({ length: SHADOWED }, () => new THREE.Matrix4()) },
        },
        vertexShader: quadVertex,
        fragmentShader: /* glsl */ `
          #include <packing>
          uniform sampler2D tDepth;
          uniform mat4 uProjectionInverse; uniform mat4 uCameraWorld;
          uniform vec3 uApex[BEAMS]; uniform vec3 uAxis[BEAMS]; uniform vec3 uColor[BEAMS]; uniform vec3 uShape[BEAMS];
          uniform sampler2D uShadowMap[SHADOWED]; uniform mat4 uShadowMatrix[SHADOWED];
          varying vec2 vUv;
          float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

          float lit(int index, vec3 p) {
            vec4 c = (index == 0 ? uShadowMatrix[0] : uShadowMatrix[1]) * vec4(p, 1.0);
            vec3 s = c.xyz / c.w;
            if (c.w <= 0.0 || s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
            vec4 stored = index == 0 ? texture2D(uShadowMap[0], s.xy) : texture2D(uShadowMap[1], s.xy);
            return step(s.z - 0.0005, unpackRGBAToDepth(stored));
          }

          void main() {
            float depth = texture2D(tDepth, vUv).x;
            vec4 view = uProjectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
            vec3 world = (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
            vec3 eye = uCameraWorld[3].xyz;
            float reach = length(world - eye);
            vec3 dir = (world - eye) / max(reach, 1e-4);
            float noise = ign(gl_FragCoord.xy);
            vec3 sum = vec3(0.0);
            for (int i = 0; i < BEAMS; i++) {
              vec3 color = uColor[i];
              if (color.r + color.g + color.b <= 0.0) continue;
              vec3 axis = uAxis[i];
              float cosEdge = uShape[i].x;
              float len = uShape[i].y;
              // Cône : (P − sommet)·axe ≥ |P − sommet|·cos. Le long du rayon, c'est un trinôme en t.
              vec3 co = eye - uApex[i];
              float vd = dot(dir, axis);
              float cd = dot(co, axis);
              float c2 = cosEdge * cosEdge;
              float a = vd * vd - c2;
              float b = 2.0 * (vd * cd - c2 * dot(dir, co));
              float k = cd * cd - c2 * dot(co, co);
              float t0 = 0.0;
              float t1 = reach;
              float disc = b * b - 4.0 * a * k;
              if (abs(a) < 1e-5) continue;
              if (disc < 0.0) {
                // Aucune racine : le rayon est tout entier hors du cône, ou tout entier dedans.
                if (a < 0.0) continue;
              } else {
                float root = sqrt(disc);
                float ra = (-b - root) / (2.0 * a);
                float rb = (-b + root) / (2.0 * a);
                float lo = min(ra, rb);
                float hi = max(ra, rb);
                if (a < 0.0) {
                  // Dans le cône entre les deux racines (si c'est bien la nappe du faisceau).
                  if (cd + 0.5 * (lo + hi) * vd <= 0.0) continue;
                  t0 = max(t0, lo);
                  t1 = min(t1, hi);
                } else if (cd + (lo - 1.0) * vd > 0.0) {
                  t1 = min(t1, lo);
                } else {
                  t0 = max(t0, hi);
                }
              }
              // Tronqué le long de l'axe : de la lentille au bout du faisceau.
              if (abs(vd) > 1e-5) {
                float ta = (0.25 - cd) / vd;
                float tb = (len - cd) / vd;
                t0 = max(t0, min(ta, tb));
                t1 = min(t1, max(ta, tb));
              } else if (cd < 0.25 || cd > len) continue;
              if (t1 <= t0) continue;

              int shadow = int(uShape[i].z);
              float stepLength = (t1 - t0) / float(STEPS);
              float gathered = 0.0;
              for (int s = 0; s < STEPS; s++) {
                vec3 p = eye + dir * (t0 + (float(s) + noise) * stepLength);
                vec3 rel = p - uApex[i];
                float along = dot(rel, axis);
                float cosine = along / max(length(rel), 1e-4);
                // Dense dans l'axe, fondu sur le bord ; la lumière se dilue en s'élargissant
                // et la brume l'éteint avant le bout du faisceau.
                float radial = smoothstep(cosEdge, mix(cosEdge, 1.0, 0.7), cosine);
                float spread = 1.0 / (1.0 + along * along * 0.06);
                float fade = 1.0 - smoothstep(0.55 * len, len, along);
                float visible = shadow >= 0 ? lit(shadow, p) : 1.0;
                gathered += radial * spread * fade * visible;
              }
              sum += color * gathered * stepLength;
            }
            // La distance marchée accompagne la lumière : l'agrandissement s'en sert.
            gl_FragColor = vec4(sum, reach);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );

    this.compose = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          tColor: { value: null },
          tBeams: { value: this.target.texture },
          tDepth: { value: depthTexture },
          uProjectionInverse: this.march.material.uniforms.uProjectionInverse,
          uTexel: { value: new THREE.Vector2() },
        },
        vertexShader: quadVertex,
        fragmentShader: /* glsl */ `
          uniform sampler2D tColor; uniform sampler2D tBeams; uniform sampler2D tDepth;
          uniform mat4 uProjectionInverse; uniform vec2 uTexel;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(tColor, vUv);
            vec4 view = uProjectionInverse * vec4(vUv * 2.0 - 1.0, texture2D(tDepth, vUv).x * 2.0 - 1.0, 1.0);
            float reach = length(view.xyz / view.w);
            // Neuf voisins du quart de résolution : ceux qui ont marché jusqu'à la même
            // distance que ce pixel comptent, les autres (de l'autre côté d'un bord) non.
            vec3 sum = vec3(0.0);
            float total = 0.0;
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
              vec4 beam = texture2D(tBeams, vUv + vec2(float(i), float(j)) * uTexel);
              float w = 1.0 / (0.02 * reach + abs(beam.a - reach));
              sum += beam.rgb * w;
              total += w;
            }
            gl_FragColor = vec4(base.rgb + sum / total, base.a);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  setSize(w, h) {
    const qw = Math.max(1, Math.ceil(w / 4));
    const qh = Math.max(1, Math.ceil(h / 4));
    this.target.setSize(qw, qh);
    this.compose.material.uniforms.uTexel.value.set(1 / qw, 1 / qh);
  }

  render(renderer, writeBuffer, readBuffer) {
    const beams = this.source?.beams() ?? [];
    this.needsSwap = beams.length > 0 && this.gain > 0;
    if (!this.needsSwap) return;
    const u = this.march.material.uniforms;
    u.uProjectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    let shadows = 0;
    for (let i = 0; i < BEAMS; i++) {
      const beam = beams[i];
      if (!beam) {
        u.uColor.value[i].set(0, 0, 0);
        continue;
      }
      u.uApex.value[i].copy(beam.apex);
      u.uAxis.value[i].copy(beam.axis);
      u.uColor.value[i].set(beam.color.r, beam.color.g, beam.color.b).multiplyScalar(beam.intensity * this.gain);
      const map = beam.shadow?.map?.texture;
      const slot = map && shadows < SHADOWED ? shadows++ : -1;
      if (slot >= 0) {
        u.uShadowMap.value[slot] = map;
        u.uShadowMatrix.value[slot].copy(beam.shadow.matrix);
      }
      u.uShape.value[i].set(Math.cos(beam.angle), beam.length, slot);
    }
    renderer.setRenderTarget(this.target);
    this.march.render(renderer);
    this.compose.material.uniforms.tColor.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compose.render(renderer);
  }
}
