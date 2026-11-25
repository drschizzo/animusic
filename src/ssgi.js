// Illumination globale en espace écran (SSGI) : la lumière émise ou renvoyée par ce
// qui est visible à l'écran éclaire les surfaces voisines (un tube d'orgue allumé
// teinte son socle, une lame qui brille éclaire ses rails…).
//
// 1. Tampon géométrique : un rendu de la scène avec un matériau unique, qui écrit
//    la normale et la couleur de base de chaque surface opaque (deux sorties).
//    Il sert aussi à l'occlusion ambiante (GTAO), qui n'a plus à le calculer.
// 2. Pour chaque pixel (à demi-résolution), quelques rayons partent dans l'hémisphère
//    de la surface et marchent dans le tampon de profondeur ; quand un rayon passe
//    derrière une surface visible, on récolte la lumière de l'image à cet endroit.
// 3. Débruitage par flous successifs qui respectent les arêtes (profondeur, normale).
// 4. Ajout à l'image : lumière récoltée × couleur de base de la surface.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const quadVertex = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const geometry = /* glsl */ `
  uniform sampler2D tDepth; uniform sampler2D tNormal;
  uniform mat4 uProjection; uniform mat4 uProjectionInverse;
  vec3 viewPosition(vec2 uv, float depth) {
    vec4 p = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  vec3 viewNormal(vec2 uv) { return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0); }
`;

/** Tampon géométrique : normales (espace caméra), couleur de base et profondeur. */
export class GBuffer {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.depthTexture = new THREE.DepthTexture(1, 1);
    this.depthTexture.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: this.depthTexture,
    });
    this.normalTexture = this.target.textures[0];
    this.albedoTexture = this.target.textures[1];
    const material = (this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      uniforms: { uAlbedo: { value: new THREE.Color() } },
      vertexShader: /* glsl */ `
        #include <common>
        varying vec3 vViewNormal;
        void main() {
          #include <beginnormal_vertex>
          #include <defaultnormal_vertex>
          #include <begin_vertex>
          #include <project_vertex>
          vViewNormal = normalize(transformedNormal);
        }`,
      fragmentShader: /* glsl */ `
        layout(location = 0) out highp vec4 gNormal;
        layout(location = 1) out highp vec4 gAlbedo;
        uniform vec3 uAlbedo;
        varying vec3 vViewNormal;
        void main() {
          vec3 n = normalize(vViewNormal) * (gl_FrontFacing ? 1.0 : -1.0);
          gNormal = vec4(n * 0.5 + 0.5, 1.0);
          gAlbedo = vec4(uAlbedo, 1.0);
        }`,
    }));
    material.isGBufferMaterial = true;
    this._hidden = [];
    // Appelé par le moteur avant de dessiner chaque objet : pendant le rendu du tampon,
    // on transmet la couleur de base de l'objet au matériau unique.
    const albedo = material.uniforms.uAlbedo.value;
    this.hook = function (renderer, scene, camera, geo, mat) {
      if (!mat.isGBufferMaterial) return;
      const own = this.material;
      // Un métal poli ne diffuse presque rien (il reflète) ; un métal brossé renvoie une
      // lumière large, assimilée ici à de la lumière diffuse teintée par le métal.
      const weight = own.metalness === undefined ? 1 : 1 + own.metalness * (Math.min(1, own.roughness * 1.4) - 1);
      // Les surfaces très sombres (sol, socles) reçoivent un minimum : sans cela la
      // lumière des instruments n'y laisserait aucune trace visible.
      const boost = this.userData.giAlbedo ?? 0.05;
      albedo.copy(own.color ?? WHITE).multiplyScalar(weight).addScalar(boost);
      mat.uniformsNeedUpdate = true;
    };
  }

  setSize(w, h) {
    this.target.setSize(w, h);
  }

  render(renderer) {
    // Seules les surfaces opaques comptent : ni vitres, ni rayons, ni halos.
    const hidden = this._hidden;
    this.scene.traverse((o) => {
      if (!o.visible) return;
      const m = o.material;
      if (o.isPoints || o.isLine || o.userData.fx || (m && (Array.isArray(m) || m.transparent || m.isShaderMaterial))) {
        o.visible = false;
        hidden.push(o);
      } else if (o.isMesh && o.onBeforeRender !== this.hook) o.onBeforeRender = this.hook;
    });
    const previous = renderer.getRenderTarget();
    const background = this.scene.background;
    const override = this.scene.overrideMaterial;
    this.scene.background = null;
    this.scene.overrideMaterial = this.material;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = override;
    this.scene.background = background;
    renderer.setRenderTarget(previous);
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/** Passe du compositeur : rend le tampon géométrique, puis (si active) ajoute la lumière indirecte. */
export class SSGIPass extends Pass {
  constructor(gbuffer, camera) {
    super();
    this.gbuffer = gbuffer;
    this.camera = camera;
    this.gi = true; // false : seul le tampon géométrique est rendu (pour l'occlusion ambiante)
    const options = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.a = new THREE.WebGLRenderTarget(1, 1, options);
    this.b = new THREE.WebGLRenderTarget(1, 1, options);
    const shared = {
      tDepth: { value: gbuffer.depthTexture },
      tNormal: { value: gbuffer.normalTexture },
      uProjection: { value: new THREE.Matrix4() },
      uProjectionInverse: { value: new THREE.Matrix4() },
    };
    this.shared = shared;

    this.trace = new FullScreenQuad(
      new THREE.ShaderMaterial({
        defines: { RAYS: 6, STEPS: 10 },
        uniforms: { ...shared, tColor: { value: null }, uRadius: { value: 3.2 }, uThickness: { value: 0.35 }, uClamp: { value: 8 } },
        vertexShader: quadVertex,
        fragmentShader: /* glsl */ `
          ${geometry}
          uniform sampler2D tColor; uniform float uRadius; uniform float uThickness; uniform float uClamp;
          varying vec2 vUv;
          // Bruit « à gradient entrelacé » : réparti régulièrement, donc facile à débruiter.
          float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
          void main() {
            float depth = texture2D(tDepth, vUv).x;
            if (depth >= 1.0) { gl_FragColor = vec4(0.0); return; }
            vec3 P = viewPosition(vUv, depth);
            vec3 N = viewNormal(vUv);
            vec3 T = normalize(abs(N.z) < 0.99 ? cross(N, vec3(0.0, 0.0, 1.0)) : vec3(1.0, 0.0, 0.0));
            vec3 B = cross(N, T);
            float noise = ign(gl_FragCoord.xy);
            vec3 origin = P + N * (0.02 + 0.004 * -P.z);
            vec3 sum = vec3(0.0);
            for (int i = 0; i < RAYS; i++) {
              // Direction tirée selon le cosinus : chaque rayon compte autant.
              float u1 = fract(noise + float(i) * 0.61803399);
              float u2 = (float(i) + fract(noise * 5.17 + 0.37)) / float(RAYS);
              float r = sqrt(u2);
              float phi = 6.2831853 * u1;
              vec3 dir = normalize(T * (r * cos(phi)) + B * (r * sin(phi)) + N * sqrt(1.0 - u2));
              float jitter = fract(noise * 3.31 + float(i) * 0.41);
              for (int s = 0; s < STEPS; s++) {
                // Pas resserrés près de la surface, plus longs au loin.
                float f = (float(s) + jitter) / float(STEPS);
                float dist = uRadius * f * f;
                vec3 Q = origin + dir * dist;
                if (Q.z > -0.1) break;
                vec4 clip = uProjection * vec4(Q, 1.0);
                vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
                float sceneDepth = texture2D(tDepth, uv).x;
                if (sceneDepth >= 1.0) continue;
                float behind = viewPosition(uv, sceneDepth).z - Q.z;
                if (behind > 0.0 && behind < uThickness + 0.25 * dist) {
                  // Seule une surface tournée vers nous peut nous éclairer.
                  float facing = step(0.0, -dot(viewNormal(uv), dir));
                  sum += min(texture2D(tColor, uv).rgb, vec3(uClamp)) * facing;
                  break;
                }
              }
            }
            gl_FragColor = vec4(sum / float(RAYS), 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );

    this.denoise = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { ...shared, tInput: { value: null }, uStep: { value: new THREE.Vector2() } },
        vertexShader: quadVertex,
        fragmentShader: /* glsl */ `
          ${geometry}
          uniform sampler2D tInput; uniform vec2 uStep;
          varying vec2 vUv;
          void main() {
            float depth = texture2D(tDepth, vUv).x;
            if (depth >= 1.0) { gl_FragColor = vec4(0.0); return; }
            float z = viewPosition(vUv, depth).z;
            vec3 n = viewNormal(vUv);
            vec3 sum = vec3(0.0);
            float total = 0.0;
            for (int k = -4; k <= 4; k++) {
              vec2 uv = vUv + uStep * float(k);
              float d = texture2D(tDepth, uv).x;
              if (d >= 1.0) continue;
              // Un voisin ne compte que s'il est sur la même surface (même profondeur, même orientation).
              float dz = abs(viewPosition(uv, d).z - z) / (0.04 + 0.03 * -z);
              float w = exp(-0.12 * float(k * k)) * exp(-dz * dz) * pow(max(0.0, dot(n, viewNormal(uv))), 8.0);
              sum += texture2D(tInput, uv).rgb * w;
              total += w;
            }
            gl_FragColor = vec4(sum / max(total, 1e-4), 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );

    this.compose = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tColor: { value: null }, tGi: { value: this.a.texture }, tAlbedo: { value: gbuffer.albedoTexture }, uIntensity: { value: 2.4 } },
        vertexShader: quadVertex,
        fragmentShader: /* glsl */ `
          uniform sampler2D tColor; uniform sampler2D tGi; uniform sampler2D tAlbedo; uniform float uIntensity;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(tColor, vUv);
            vec4 albedo = texture2D(tAlbedo, vUv);
            gl_FragColor = vec4(base.rgb + texture2D(tGi, vUv).rgb * albedo.rgb * albedo.a * uIntensity, base.a);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.debug = false; // true : affiche la seule lumière indirecte (réglage)
  }

  setSize(w, h) {
    this.gbuffer.setSize(w, h);
    const hw = Math.max(1, Math.ceil(w / 2));
    const hh = Math.max(1, Math.ceil(h / 2));
    this.a.setSize(hw, hh);
    this.b.setSize(hw, hh);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.gbuffer.render(renderer);
    this.needsSwap = this.gi;
    if (!this.gi) return;
    this.shared.uProjection.value.copy(this.camera.projectionMatrix);
    this.shared.uProjectionInverse.value.copy(this.camera.projectionMatrixInverse);

    this.trace.material.uniforms.tColor.value = readBuffer.texture;
    renderer.setRenderTarget(this.a);
    this.trace.render(renderer);

    // Deux tours de flou (horizontal puis vertical), le second plus large.
    const u = this.denoise.material.uniforms;
    const blur = (source, target, x, y) => {
      u.tInput.value = source.texture;
      u.uStep.value.set(x / this.a.width, y / this.a.height);
      renderer.setRenderTarget(target);
      this.denoise.render(renderer);
    };
    blur(this.a, this.b, 1, 0);
    blur(this.b, this.a, 0, 1);
    blur(this.a, this.b, 2.5, 0);
    blur(this.b, this.a, 0, 2.5);

    const c = this.compose.material.uniforms;
    c.tColor.value = this.debug ? null : readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compose.render(renderer);
  }
}
