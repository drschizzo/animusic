// Décor de la scène : carte d'environnement « studio », éclairage, sol poli qui
// reflète réellement les instruments (rendu miroir flouté selon la rugosité),
// fond brumeux, projecteurs à faisceaux volumétriques et poussières en suspension.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { tex, mat, fx } from './materials.js';
import { FINITE } from './glsl.js';

const HAZE = 0x070a14;
const BLUR_LEVELS = 4;
const ACCENTS = [0x49d8ff, 0xff4fa3, 0xffc46b, 0x8f7bff];

const PROBE_LAYER = 1; // objets visibles seulement par la sonde de reflets

/** Boîtes à lumière du « studio » : elles n'existent que dans les reflets. */
function studioPanels() {
  const group = new THREE.Group();
  const panel = (color, gain, w, h, pos, look = [0, 0, 0]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(gain), side: THREE.DoubleSide, fog: false }),
    );
    m.position.set(...pos);
    m.lookAt(...look);
    group.add(m);
  };
  panel(0xfff2e0, 2.2, 14, 8, [0, 11.5, 2]); // grande boîte zénithale chaude
  panel(0x7fd4ff, 3.5, 3, 14, [-19, 3, -4]); // bandes latérales froides
  panel(0x7fd4ff, 2.5, 3, 14, [19, 3, 6]);
  panel(0xff5fae, 3, 10, 2.5, [6, 4, -19]); // accent magenta au fond
  panel(0xffffff, 2, 16, 1.2, [0, 1.5, 19]); // liseré bas côté public
  for (let i = 0; i < 6; i++) panel(0xffffff, 7, 1.2, 1.2, [-12.5 + i * 5, 9, -12 + (i % 2) * 20]); // spots ponctuels
  return group;
}

/** Environnement fixe (qualité basse, et point de départ) : pièce sombre et boîtes à lumière. */
function studioEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(40, 24, 40), new THREE.MeshBasicMaterial({ color: 0x05060a, side: THREE.BackSide })));
  scene.add(studioPanels());
  const pmrem = new THREE.PMREMGenerator(renderer);
  const map = pmrem.fromScene(scene, 0.03).texture;
  pmrem.dispose();
  scene.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  return map;
}

/**
 * Sonde de reflets dynamique : une caméra à six faces, au-dessus du centre de la scène,
 * filme en continu ce qui l'entoure (instruments, lumières, boîtes à lumière). L'image
 * obtenue, préfiltrée par niveaux de rugosité, remplace l'environnement fixe : les
 * métaux reflètent alors l'orgue ou le laser qui s'allument à côté d'eux, et toutes les
 * surfaces reçoivent leur lumière ambiante.
 *
 * Pour étaler le coût, seules quelques faces sont rendues à chaque image ; le
 * préfiltrage a lieu quand le tour des six faces est terminé.
 */
class ReflectionProbe {
  constructor(renderer) {
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.filtered = null;
    this.face = 0;
    // Chaque face est d'abord rendue dans une image 2D, puis recopiée dans le cube par
    // une passe qui remplace toute valeur non finie et écrête les pics : la sonde se
    // filme elle-même (les métaux reflètent l'environnement qu'elle produit), un seul
    // pixel NaN y deviendrait permanent et contaminerait toute la scène.
    this.copy = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tSource: { value: null }, uClamp: { value: 48 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
          uniform sampler2D tSource; uniform float uClamp; varying vec2 vUv;
          ${FINITE}
          void main() { gl_FragColor = vec4(min(finite(texture2D(tSource, vUv).rgb), vec3(uClamp)), 1.0); }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.setSize(256);
  }

  setSize(size) {
    if (this.size === size) return;
    this.size = size;
    this.target?.dispose();
    this.faceTarget?.dispose();
    this.filtered?.dispose();
    this.filtered = null;
    this.target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, depthBuffer: false });
    this.faceTarget = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType });
    this.camera = new THREE.CubeCamera(0.3, 200, this.target);
    this.camera.coordinateSystem = this.renderer.coordinateSystem;
    this.camera.updateCoordinateSystem();
    for (const c of this.camera.children) c.layers.enable(PROBE_LAYER);
    this.face = 0;
  }

  /** Rend `faces` faces de plus ; renvoie la texture d'environnement si elle vient d'être refaite. */
  update(scene, position, faces) {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    this.camera.position.copy(position);
    this.camera.updateMatrixWorld();
    this.copy.material.uniforms.tSource.value = this.faceTarget.texture;
    let fresh = null;
    for (let i = 0; i < faces; i++) {
      renderer.setRenderTarget(this.faceTarget);
      renderer.clear();
      renderer.render(scene, this.camera.children[this.face]);
      renderer.setRenderTarget(this.target, this.face);
      this.copy.render(renderer);
      this.face = (this.face + 1) % 6;
      if (this.face === 0) {
        this.filtered = this.pmrem.fromCubemap(this.target.texture, this.filtered);
        fresh = this.filtered.texture;
      }
    }
    renderer.setRenderTarget(previous);
    return fresh;
  }
}

/** Sol poli : MeshStandardMaterial enrichi d'un reflet planaire flouté. */
class ReflectiveFloor {
  constructor() {
    const options = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.target = new THREE.WebGLRenderTarget(512, 512, { ...options, samples: 4 });
    // Pyramide de flous gaussiens : chaque niveau est deux fois plus petit et deux fois
    // plus flou que le précédent. Le sol interpole entre deux niveaux selon sa rugosité.
    this.levels = Array.from({ length: BLUR_LEVELS }, () => ({
      temp: new THREE.WebGLRenderTarget(1, 1, options),
      blurred: new THREE.WebGLRenderTarget(1, 1, options),
    }));
    this.blur = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tSource: { value: null }, uStep: { value: new THREE.Vector2() }, uClamp: { value: 1e4 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
          uniform sampler2D tSource; uniform vec2 uStep; uniform float uClamp; varying vec2 vUv;
          ${FINITE}
          vec3 tap(float k) { return min(finite(texture2D(tSource, vUv + uStep * k).rgb), vec3(uClamp)); }
          void main() {
            // Gaussienne à 9 points (σ ≈ 2 texels de destination).
            vec3 c = tap(0.0) * 0.2042;
            c += (tap(1.0) + tap(-1.0)) * 0.1802;
            c += (tap(2.0) + tap(-2.0)) * 0.1238;
            c += (tap(3.0) + tap(-3.0)) * 0.0663;
            c += (tap(4.0) + tap(-4.0)) * 0.0276;
            gl_FragColor = vec4(c, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.camera = new THREE.PerspectiveCamera();
    this.uniforms = {
      tReflect: { value: this.target.texture },
      tReflectBlur: { value: this.levels.map((l) => l.blurred.texture) },
      uReflectMatrix: { value: new THREE.Matrix4() },
      uReflect: { value: 1 },
      uStageRadius: { value: 12 },
    };
    const material = new THREE.MeshStandardMaterial({
      color: 0x08090d,
      roughness: 0.5,
      metalness: 0.0,
      roughnessMap: tex.blotch(),
      envMapIntensity: 0.25,
    });
    material.roughnessMap.repeat.set(14, 14);
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 uReflectMatrix;\nvarying vec4 vReflectUv;\nvarying vec3 vFloorPos;')
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvec4 floorWorld = modelMatrix * vec4(transformed, 1.0);\nvFloorPos = floorWorld.xyz;\nvReflectUv = uReflectMatrix * floorWorld;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\n' + FINITE + '\nuniform sampler2D tReflect;\nuniform sampler2D tReflectBlur[' + BLUR_LEVELS + '];\nuniform float uReflect;\nuniform float uStageRadius;\nvarying vec4 vReflectUv;\nvarying vec3 vFloorPos;',
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          // Plateau de scène : disque plus lisse que le sol alentour, joints concentriques.
          float floorR = length(vFloorPos.xz);
          float onStage = 1.0 - smoothstep(uStageRadius - 0.05, uStageRadius + 0.05, floorR);
          float seam = 1.0 - smoothstep(0.008, 0.022, abs(fract(floorR / 2.5 + 0.5) - 0.5) * 2.5);
          roughnessFactor = mix(0.4 + 0.12 * roughnessFactor, roughnessFactor * 0.6, onStage);
          roughnessFactor = mix(roughnessFactor, 0.9, seam * onStage);
          diffuseColor.rgb *= mix(0.3, 1.0, onStage) * (1.0 - 0.5 * seam * onStage);
          // Le reflet garde ce poli ; l'éclairage direct, lui, voit une surface plus mate
          // (sinon chaque projecteur dessine une tache spéculaire aveuglante).
          float reflRough = roughnessFactor;
          roughnessFactor = max(roughnessFactor, 0.5);`,
        )
        .replace(
          '#include <opaque_fragment>',
          `// Reflet planaire : net sur une surface lisse, puis de plus en plus flou avec la
          // rugosité (interpolation entre deux niveaux de la pyramide de flous).
          // Sauté quand le reflet est coupé : 0 × NaN vaut NaN, une texture périmée
          // ne doit pas pouvoir contaminer le sol.
          if (uReflect > 0.0) {
          vec2 reflUv = vReflectUv.xy / vReflectUv.w;
          float reflLevel = clamp(0.15 + reflRough * 5.5, 0.0, float(${BLUR_LEVELS}));
          vec3 reflLo = texture2D(tReflect, reflUv).rgb;
          vec3 reflHi = texture2D(tReflectBlur[0], reflUv).rgb;
          ${Array.from({ length: BLUR_LEVELS - 1 }, (_, i) => `if (reflLevel > ${i + 1}.0) { reflLo = reflHi; reflHi = texture2D(tReflectBlur[${i + 1}], reflUv).rgb; }`).join('\n          ')}
          vec3 refl = finite(mix(reflLo, reflHi, reflLevel >= float(${BLUR_LEVELS}) ? 1.0 : fract(reflLevel)));
          float reflFresnel = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 4.0);
          float reflGloss = 1.0 - reflRough;
          outgoingLight += refl * uReflect * reflGloss * mix(0.5, 1.0, reflFresnel);
          }
          #include <opaque_fragment>`,
        );
    };
    this.material = material;
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(90, 96), material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.receiveShadow = true;
    this.mesh.userData.giAlbedo = 0.2; // le sol capte bien la lumière indirecte (flaques de lumière)
    this._v = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  }

  setSize(w, h) {
    w = Math.max(64, Math.round(w));
    h = Math.max(64, Math.round(h));
    this.target.setSize(w, h);
    this.levels.forEach((l, i) => {
      const lw = Math.max(8, Math.round(w / 2 ** (i + 1)));
      const lh = Math.max(8, Math.round(h / 2 ** (i + 1)));
      l.temp.setSize(lw, lh);
      l.blurred.setSize(lw, lh);
    });
  }

  /** Rend la scène vue depuis la caméra symétrique par rapport au sol (y = 0). */
  render(renderer, scene, camera, hidden) {
    const v = this.camera;
    camera.updateMatrixWorld();
    v.position.setFromMatrixPosition(camera.matrixWorld);
    this._v.set(0, 0, -1).transformDirection(camera.matrixWorld).add(v.position);
    this._up.set(0, 1, 0).transformDirection(camera.matrixWorld);
    v.position.y *= -1;
    this._v.y *= -1;
    this._up.y *= -1;
    v.up.copy(this._up);
    v.lookAt(this._v);
    v.projectionMatrix.copy(camera.projectionMatrix);
    v.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    v.updateMatrixWorld();
    this.uniforms.uReflectMatrix.value.copy(this._bias).multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);

    const visible = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, v);
    hidden.forEach((o, i) => (o.visible = visible[i]));

    // Flous successifs : horizontal puis vertical, chaque niveau partant du précédent.
    const u = this.blur.material.uniforms;
    let source = this.target;
    this.levels.forEach((l, i) => {
      // Les points très lumineux sont écrêtés avant le premier flou : sinon chaque
      // source ponctuelle devient une tache qui scintille.
      u.uClamp.value = i === 0 ? 6 : 1e4;
      u.tSource.value = source.texture;
      u.uStep.value.set(1 / l.temp.width, 0);
      renderer.setRenderTarget(l.temp);
      this.blur.render(renderer);
      u.uClamp.value = 1e4;
      u.tSource.value = l.temp.texture;
      u.uStep.value.set(0, 1 / l.temp.height);
      renderer.setRenderTarget(l.blurred);
      this.blur.render(renderer);
      source = l.blurred;
    });
    renderer.setRenderTarget(previous);
  }
}

/** Fond : grande paroi cylindrique, brume à l'horizon et colonnes de lumière lointaines. */
function makeBackdrop() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uHaze: { value: new THREE.Color(HAZE) }, uA: { value: new THREE.Color(0x1a3a6a) }, uB: { value: new THREE.Color(0x4a1848) }, uPulse: { value: 0 } },
    vertexShader: 'varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uHaze; uniform vec3 uA; uniform vec3 uB; uniform float uPulse;
      varying vec3 vPos;
      void main() {
        float h = clamp(vPos.y / 45.0, 0.0, 1.0);
        float a = atan(vPos.x, -vPos.z);
        // Dégradé d'horizon, plus chaud d'un côté que de l'autre.
        vec3 glow = mix(uA, uB, 0.5 + 0.5 * sin(a * 1.0 + 0.6));
        vec3 col = uHaze + glow * (0.5 + 0.15 * uPulse) * pow(1.0 - h, 5.0);
        // Colonnes de lumière verticales, floues, perdues dans la brume.
        float bars = pow(max(0.0, 0.5 + 0.5 * cos(a * 28.0)), 40.0) + 0.5 * pow(max(0.0, 0.5 + 0.5 * cos(a * 12.0 + 1.3)), 90.0);
        col += glow * bars * (0.55 + 0.4 * uPulse) * smoothstep(0.0, 0.08, h) * pow(1.0 - h, 2.2);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(85, 85, 90, 96, 1, true), material);
  mesh.position.y = 44.5;
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return fx(mesh);
}

const beamVertex = `
  varying vec3 vNormalV; varying vec3 vViewDir; varying float vAlong;
  void main() {
    vAlong = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const beamFragment = `
  uniform vec3 uColor; uniform float uIntensity;
  varying vec3 vNormalV; varying vec3 vViewDir; varying float vAlong;
  void main() {
    // Dense dans l'axe, transparent sur les bords ; s'éteint en s'éloignant du projecteur.
    // Les bornes ne sont pas décoratives : en anticrénelage multi-échantillon, les
    // varyings sont extrapolés hors du triangle sur ses bords ; vAlong y devient
    // légèrement négatif et pow(négatif, 1.6) vaut NaN (c'était la graine de
    // l'écran noir : le NaN se propageait par le reflet du sol et la sonde).
    vec3 n = vNormalV / max(length(vNormalV), 1e-5);
    vec3 v = vViewDir / max(length(vViewDir), 1e-5);
    float facing = clamp(abs(dot(n, v)), 0.0, 1.0);
    float a = pow(facing, 2.5) * pow(clamp(vAlong, 0.0, 1.0), 1.6);
    gl_FragColor = vec4(uColor * uIntensity * a, 1.0);
  }`;

export class Environment {
  constructor(renderer, scene) {
    this.scene = scene;
    this.radius = 8;
    scene.background = new THREE.Color(HAZE);
    scene.fog = new THREE.FogExp2(HAZE, 0.016);
    this.studio = studioEnvironment(renderer);
    scene.environment = this.studio;
    scene.environmentIntensity = 0.8;
    this.probe = new ReflectionProbe(renderer);
    this.probePosition = new THREE.Vector3();

    const root = (this.root = new THREE.Group());
    scene.add(root);
    // Les boîtes à lumière sont dans la scène, mais seule la sonde de reflets les voit.
    this.panels = studioPanels();
    this.panels.traverse((o) => o.layers.set(PROBE_LAYER));
    root.add(this.panels);

    // --- Lumières
    root.add(new THREE.HemisphereLight(0x8fa4ff, 0x1a120c, 0.32));
    const key = (this.key = new THREE.DirectionalLight(0xfff0dc, 2.0));
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 5;
    key.shadow.blurSamples = 16;
    root.add(key, key.target);
    const rim = (color, intensity) => {
      const l = new THREE.SpotLight(color, intensity, 0, 0.75, 0.9, 0);
      root.add(l, l.target);
      return l;
    };
    this.rims = [rim(0x45c8ff, 1.5), rim(0xff4fa3, 1.3)];
    const fill = (this.fill = new THREE.DirectionalLight(0x9fb6ff, 0.35));
    root.add(fill);

    // --- Sol et fond
    this.floor = new ReflectiveFloor();
    root.add(this.floor.mesh);
    this.backdrop = makeBackdrop();
    root.add(this.backdrop);

    // Bordure lumineuse du plateau.
    this.edgeMat = mat.glow(ACCENTS[0], 3);
    this.edge = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 200), this.edgeMat);
    this.edge.rotation.x = Math.PI / 2;
    this.edge.position.y = 0.02;
    this.curb = new THREE.Mesh(new THREE.TorusGeometry(1, 0.09, 10, 200), mat.gunmetal());
    this.curb.rotation.x = Math.PI / 2;
    root.add(this.edge, this.curb);

    // --- Pont de projecteurs : anneau suspendu, têtes mobiles et faisceaux volumétriques.
    this.rig = new THREE.Group();
    root.add(this.rig);
    this.truss = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 8, 96), mat.gunmetal());
    this.truss.rotation.x = Math.PI / 2;
    this.rig.add(this.truss);
    const cone = new THREE.CylinderGeometry(0.12, 1, 1, 40, 1, true);
    cone.translate(0, -0.5, 0); // sommet à l'origine, s'ouvre vers -y
    const headGeo = new THREE.CylinderGeometry(0.2, 0.26, 0.45, 20);
    const lensGeo = new THREE.CircleGeometry(0.17, 20);
    this.heads = Array.from({ length: 8 }, (_, i) => {
      const color = new THREE.Color(i % 2 ? ACCENTS[(i >> 1) % ACCENTS.length] : 0xdfe8ff);
      const pivot = new THREE.Group();
      const body = new THREE.Mesh(headGeo, mat.gunmetal());
      body.position.y = 0.2;
      const lens = new THREE.Mesh(lensGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.2), toneMapped: false }));
      lens.rotation.x = Math.PI / 2;
      lens.position.y = -0.03;
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: color }, uIntensity: { value: 0.1 } },
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const beam = fx(new THREE.Mesh(cone, beamMat));
      pivot.add(body, lens, beam);
      this.rig.add(pivot);
      return { pivot, beam, beamMat, phase: i * 2.399, target: new THREE.Vector3() };
    });

    // --- Poussières en suspension, accrochant la lumière.
    const count = 700;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      pos.set([Math.cos(a) * r, Math.random(), Math.sin(a) * r], i * 3);
      seed[i] = Math.random();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uRadius: { value: 12 }, uScale: { value: 1 } },
      vertexShader: `
        attribute float aSeed; uniform float uTime; uniform float uRadius; uniform float uScale; varying float vFade;
        void main() {
          vec3 p = position;
          p.xz *= uRadius * 1.35;
          p.y = mod(p.y * 9.0 + uTime * (0.03 + 0.05 * aSeed), 9.0);
          p.x += sin(uTime * 0.21 + aSeed * 40.0) * 0.4;
          p.z += cos(uTime * 0.17 + aSeed * 70.0) * 0.4;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vFade = smoothstep(0.0, 1.0, p.y) * (1.0 - smoothstep(6.0, 9.0, p.y)) * smoothstep(1.0, 4.0, -mv.z) * (0.4 + 0.6 * aSeed);
          gl_PointSize = uScale * (1.5 + 2.5 * aSeed) * 6.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vFade;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * vFade * (1.0 - smoothstep(0.0, 0.5, d)) * 0.5, 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.dust = fx(new THREE.Points(dustGeo, this.dustMat));
    this.dust.frustumCulled = false;
    root.add(this.dust);

    this.setQuality('high');
    this.setRadius(8);
  }

  /** Adapte le décor à la taille de l'ensemble (rayon de l'arc de lames). */
  setRadius(R) {
    this.radius = R;
    const stageR = (this.stageRadius = R + 6.2);
    this.floor.uniforms.uStageRadius.value = stageR;
    this.edge.scale.setScalar(stageR - 0.14);
    this.edge.scale.z = 1;
    this.curb.scale.setScalar(stageR);
    this.curb.scale.z = 1;
    this.dustMat.uniforms.uRadius.value = stageR;
    this.panels.scale.setScalar(stageR / 14.2);
    this.probePosition.set(0, 2.8 + R * 0.1, -R * 0.2);
    this.probe.face = 0;

    // Lumière principale : cadre d'ombre ajusté au plateau pour garder des ombres nettes.
    this.key.position.set(R * 0.55, R * 1.5 + 6, R * 0.75);
    this.key.target.position.set(0, 0, -R * 0.25);
    const s = stageR * 1.02;
    Object.assign(this.key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: R * 4 + 30 });
    this.key.shadow.camera.updateProjectionMatrix();
    this.rims[0].position.set(-R * 1.5, R * 0.9 + 3, -R * 1.7);
    this.rims[1].position.set(R * 1.5, R * 0.9 + 3, -R * 1.7);
    for (const l of this.rims) l.target.position.set(0, 1, -R * 0.2);
    this.fill.position.set(-R, 4, R * 2);

    const rigR = R * 0.95 + 2;
    const rigY = (this.rigY = R * 0.55 + 6.5);
    this.rig.position.set(0, rigY, -R * 0.25);
    this.truss.scale.set(rigR, rigR, 1);
    this.heads.forEach((h, i) => {
      const a = (i / this.heads.length) * Math.PI * 2 + 0.39;
      h.pivot.position.set(Math.sin(a) * rigR, -0.35, Math.cos(a) * rigR);
      h.angle = a;
      const len = rigY * 1.25;
      h.beam.scale.set(len * 0.13, len, len * 0.13);
    });
  }

  /**
   * @param wall temps réel (s) : balayage lent des projecteurs, dérive des poussières
   * @param pulse battue du morceau (0..1, grosse caisse) : les lumières respirent avec elle
   */
  update(wall, pulse = 0) {
    const R = this.radius;
    const down = new THREE.Vector3(0, -1, 0);
    const dir = new THREE.Vector3();
    for (const h of this.heads) {
      // Chaque tête vise un point qui se promène lentement sur le plateau.
      const a = h.angle + Math.sin(wall * 0.13 + h.phase) * 0.9;
      const r = R * (0.25 + 0.3 * (0.5 + 0.5 * Math.sin(wall * 0.09 + h.phase * 1.7)));
      h.target.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      dir.copy(h.target).sub(h.pivot.position).setY(-this.rigY).normalize();
      h.pivot.quaternion.setFromUnitVectors(down, dir);
      h.beamMat.uniforms.uIntensity.value = this.beamGain * (0.75 + 0.6 * pulse);
    }
    this.dustMat.uniforms.uTime.value = wall;
    this.backdrop.material.uniforms.uPulse.value = pulse;
    this.edgeMat.emissiveIntensity = 3 + 4 * pulse;
  }

  /**
   * Met à jour la sonde de reflets (à appeler avant les autres rendus). Le sol y est
   * rendu sans son reflet miroir (calculé pour la caméra principale), et sans
   * faisceaux ni poussières, qui noieraient l'image vue de l'intérieur.
   */
  renderProbe() {
    if (!this.probeFaces) return;
    const hidden = [this.dust, ...this.heads.map((h) => h.beam)];
    const visible = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const reflect = this.floor.uniforms.uReflect.value;
    this.floor.uniforms.uReflect.value = 0;
    const fresh = this.probe.update(this.scene, this.probePosition, this.probeFaces);
    this.floor.uniforms.uReflect.value = reflect;
    hidden.forEach((o, i) => (o.visible = visible[i]));
    if (fresh) this.scene.environment = fresh;
  }

  /** Rendu du reflet du sol (à appeler avant le rendu principal). */
  renderReflection(renderer, camera) {
    if (!this.reflections) return;
    this.floor.render(renderer, this.scene, camera, [this.floor.mesh, this.dust, this.edge, this.curb]);
  }

  setSize(w, h) {
    this.floor.setSize(w * this.reflectionScale, h * this.reflectionScale);
    this.dustMat.uniforms.uScale.value = h / 720;
  }

  setQuality(level) {
    // Sonde de reflets : deux faces par image en qualité haute, une (plus petite) en moyenne.
    this.probeFaces = level === 'high' ? 2 : level === 'medium' ? 1 : 0;
    this.probe.setSize(level === 'high' ? 256 : 128);
    if (!this.probeFaces || !this.probe.filtered) this.scene.environment = this.studio;
    this.reflections = level !== 'low';
    this.reflectionScale = level === 'high' ? 0.75 : 0.5;
    this.floor.uniforms.uReflect.value = this.reflections ? 1 : 0;
    this.key.castShadow = level !== 'low';
    this.key.shadow.mapSize.setScalar(level === 'high' ? 4096 : 2048);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
    this.beamGain = level === 'low' ? 0 : 0.07;
    this.dust.visible = level !== 'low';
    for (const h of this.heads) h.beam.visible = level !== 'low';
  }
}
