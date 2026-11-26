// Décor de la scène : conque de bois derrière l'orchestre, plancher satiné qui reflète
// les instruments (rendu miroir flouté selon la rugosité), gril et pont de projecteurs
// à faisceaux, éclairage, carte d'environnement et poussières en suspension.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { tex, mat, fx } from './materials.js';
import { FINITE } from './glsl.js';

const HAZE = 0x070a14;
const BLUR_LEVELS = 4;
const ACCENTS = [0x49d8ff, 0xff4fa3, 0xffc46b, 0x8f7bff];

/**
 * Ambiances successives des sections. Chacune tient en une température dominante et un
 * seul accent : horizon (a, b) sombre et peu saturé, `key` = blanc des poursuites qui
 * éclairent les instruments, `accent` = couleur des faisceaux d'ambiance, du contre-jour
 * et de la bordure du plateau. Les couleurs vives restent aux notes (couleurs de piste).
 */
const MOODS = [
  { a: 0x14294a, b: 0x1c1a3c, key: 0xffe9cc, accent: 0x4fb8e8 },
  { a: 0x40230f, b: 0x2c1524, key: 0xfff2e0, accent: 0xf0a550 },
  { a: 0x0d3234, b: 0x151d3c, key: 0xffecd6, accent: 0x58d0a8 },
  { a: 0x281746, b: 0x111e40, key: 0xf3eeff, accent: 0x8a78f0 },
  { a: 0x401016, b: 0x200e2e, key: 0xffe4cf, accent: 0xf06058 },
];

/** Têtes du pont qui portent une vraie lumière (les deux de face) et rang de l'instrument suivi par chaque tête. */
const FOLLOW_HEADS = [7, 1];
const FOLLOW_RANK = { 7: 0, 1: 1, 3: 2, 5: 3 };

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

/** Plancher de scène satiné : MeshStandardMaterial enrichi d'un reflet planaire flouté. */
class ReflectiveFloor {
  constructor() {
    const options = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    // Sans multi-échantillonnage : le sol est satiné, il ne lit que les niveaux flous.
    this.target = new THREE.WebGLRenderTarget(512, 512, options);
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
      color: 0x1d1a17, // plancher peint en noir, assez clair pour que les poursuites y dessinent leur flaque
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
          // Plateau de scène : plancher peint, lames de 24 cm filant vers le public, abouts
          // décalés d'une lame à l'autre. Chaque planche a sa nuance et son poli ; l'usure
          // (carte de marbrures) dépolit par plaques. Autour du plateau, sol mat et sombre.
          float floorR = length(vFloorPos.xz);
          float onStage = 1.0 - smoothstep(uStageRadius - 0.05, uStageRadius + 0.05, floorR);
          float lane = vFloorPos.x / 0.24;
          float laneId = floor(lane);
          float run = vFloorPos.z / 3.2 + fract(sin(laneId * 91.7) * 43758.5453) * 7.0;
          float boardTone = fract(sin(laneId * 13.1 + floor(run) * 57.3) * 43758.5453);
          // Joints : traits fins, estompés quand ils deviennent plus petits que le pixel.
          float laneW = fwidth(lane);
          float runW = fwidth(run);
          float seam = (1.0 - smoothstep(0.012, 0.012 + 1.5 * laneW, min(fract(lane), 1.0 - fract(lane)))) * (1.0 - smoothstep(0.2, 0.7, laneW));
          seam = max(seam, (1.0 - smoothstep(0.001, 0.001 + 1.5 * runW, min(fract(run), 1.0 - fract(run)))) * (1.0 - smoothstep(0.004, 0.014, runW)) * 0.6);
          float wear = clamp(roughnessFactor * 2.0, 0.0, 1.0);
          float boards = mix(0.46, 0.7, wear) + (boardTone - 0.5) * 0.1;
          roughnessFactor = mix(0.88, mix(boards, 0.92, seam), onStage);
          diffuseColor.rgb *= mix(0.3, (0.82 + 0.36 * boardTone) * (1.0 - 0.55 * seam), onStage);
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
          outgoingLight += refl * uReflect * reflGloss * mix(0.3, 1.0, reflFresnel);
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


const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Pose l'instance i d'un cylindre unité (axe y, de −½ à ½) entre deux points. */
function setPipe(mesh, i, a, b) {
  const len = _d.subVectors(b, a).length();
  _q.setFromUnitVectors(UP, _d.divideScalar(len || 1));
  mesh.setMatrixAt(i, _m.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s.set(1, len, 1)));
}

const SHELL_SPAN = (210 * Math.PI) / 180; // ouverture de la conque, centrée sur le fond de scène
const SLAT_TIERS = 3;
const SLAT_MAX = 420; // lattes par étage
const PLINTH_H = 1;

/**
 * Conque de scène : paroi courbe derrière l'orchestre, habillée de lattes de bois sur
 * trois étages au-dessus d'une plinthe sombre. Elle ferme l'image (plus de vide derrière
 * les instruments) et donne l'échelle. Une rampe au pied de la paroi la lèche de bas en
 * haut dans les teintes de la section : c'est là que se lit la couleur du moment.
 */
class StageShell {
  constructor() {
    this.group = new THREE.Group();
    this.uniforms = { uWashA: { value: new THREE.Color(0x14294a) }, uWashB: { value: new THREE.Color(0x1c1a3c) }, uWash: { value: 1 } };
    const wash = (material) => {
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWashPos;')
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            vec4 washPos = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
            washPos = instanceMatrix * washPos;
            #endif
            vWashPos = (modelMatrix * washPos).xyz;`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uWashA; uniform vec3 uWashB; uniform float uWash;\nvarying vec3 vWashPos;')
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
            // Rampe au pied de la paroi : vive en bas, éteinte vers le haut, d'une teinte à
            // l'autre d'un bord à l'autre de la conque.
            vec3 washTint = mix(uWashA, uWashB, 0.5 + 0.5 * sin(atan(vWashPos.x, -vWashPos.z) + 0.6));
            totalEmissiveRadiance += diffuseColor.rgb * washTint * uWash * exp(-max(vWashPos.y, 0.0) / 5.5);`,
          );
      };
      material.customProgramCacheKey = () => 'shell-wash';
      return material;
    };
    const arc = (material) => {
      const geo = new THREE.CylinderGeometry(1, 1, 1, 120, 1, true, Math.PI - SHELL_SPAN / 2, SHELL_SPAN);
      geo.translate(0, 0.5, 0);
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      return mesh;
    };
    // Paroi porteuse, presque noire : on la devine entre les lattes.
    this.wall = arc(wash(new THREE.MeshStandardMaterial({ color: 0x0d0c0c, roughness: 0.92, side: THREE.BackSide })));
    this.plinth = arc(new THREE.MeshStandardMaterial({ color: 0x131318, roughness: 0.45, metalness: 0.3, side: THREE.BackSide }));
    const slats = (this.slats = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.3, 1, 0.07), // lattes de 30 cm tous les 42 cm : le plein domine, pas de zébrure
      wash(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })),
      SLAT_TIERS * SLAT_MAX,
    ));
    slats.receiveShadow = true;
    slats.frustumCulled = false;
    // Noyer, chaque latte d'une nuance un peu différente (tirage fixe : même décor à chaque fois).
    const tint = new THREE.Color();
    let seed = 7;
    for (let i = 0; i < slats.count; i++) {
      seed = (seed * 16807) % 2147483647;
      const k = 0.8 + 0.4 * (seed / 2147483647);
      slats.setColorAt(i, tint.setRGB(0.14 * k, 0.082 * k, 0.046 * k));
    }
    this.group.add(this.wall, this.plinth, this.slats);
  }

  /** Dimensionne la conque : rayon de la paroi et hauteur. */
  layout(radius, height) {
    this.wall.scale.set(radius, height, radius);
    this.plinth.scale.set(radius - 0.14, PLINTH_H, radius - 0.14);
    const n = Math.min(SLAT_MAX, Math.floor((SHELL_SPAN * radius) / 0.42));
    const tierH = (height - PLINTH_H - 0.1) / SLAT_TIERS;
    let i = 0;
    for (let tier = 0; tier < SLAT_TIERS; tier++) {
      for (let k = 0; k < n; k++) {
        const a = Math.PI - SHELL_SPAN / 2 + ((k + 0.5) / n) * SHELL_SPAN;
        // 1 cm devant la paroi, 10 cm au-dessus de la plinthe, 16 cm de joint entre étages.
        _p.set(Math.sin(a) * (radius - 0.045), PLINTH_H + 0.1 + tier * tierH + (tierH - 0.16) / 2, Math.cos(a) * (radius - 0.045));
        this.slats.setMatrixAt(i++, _m.compose(_p, _q.setFromAxisAngle(UP, a), _s.set(1, tierH - 0.16, 1)));
      }
    }
    this.slats.count = i;
    this.slats.instanceMatrix.needsUpdate = true;
  }
}

const TRUSS_NODES = 64;
const BATTEN_MAX = 40;

/**
 * Machinerie au-dessus du plateau : un gril de perches (tubes parallèles portés d'un
 * bord à l'autre de la conque), deux porteuses accrochées dessous, et le pont circulaire
 * des projecteurs, suspendu aux porteuses par quatre élingues. Le pont est une poutre
 * triangulée : une membrure basse, deux hautes, des diagonales.
 */
class Rigging {
  constructor(rig, root) {
    this.rig = rig;
    const steel = mat.gunmetal();
    this.pipes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 10), steel, BATTEN_MAX + 2);
    this.cables = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), steel, 4);
    root.add(this.pipes, this.cables);
    this.chords = [0, 1, 2].map(() => new THREE.Mesh(new THREE.BufferGeometry(), steel));
    this.struts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.016, 0.016, 1, 6), steel, TRUSS_NODES * 5);
    // Une rotule sous la membrure basse, au-dessus de chaque projecteur.
    this.clamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 12, 8), steel, 8);
    rig.add(...this.chords, this.struts, this.clamps);
    for (const o of [this.pipes, this.cables, this.struts, this.clamps]) o.frustumCulled = false;
  }

  /**
   * @param rigR rayon du pont ; il est centré sur `rig`, membrure basse à y = 0,3 (les
   *   têtes pivotent dessous sans la toucher)
   * @param grilY hauteur des perches ; wallR rayon de la conque
   */
  layout(rigR, grilY, wallR) {
    const LOW = 0.3;
    const HIGH = 0.75;
    const HALF = 0.22;
    const ring = (radius, y) => {
      const g = new THREE.TorusGeometry(radius, 0.035, 6, 160);
      g.rotateX(Math.PI / 2);
      g.translate(0, y, 0);
      return g;
    };
    [ring(rigR, LOW), ring(rigR - HALF, HIGH), ring(rigR + HALF, HIGH)].forEach((g, i) => {
      this.chords[i].geometry.dispose();
      this.chords[i].geometry = g;
    });
    const at = (a, radius, y) => new THREE.Vector3(Math.sin(a) * radius, y, Math.cos(a) * radius);
    let n = 0;
    for (let i = 0; i < TRUSS_NODES; i++) {
      const a0 = (i / TRUSS_NODES) * Math.PI * 2;
      const a1 = ((i + 1) / TRUSS_NODES) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const inner = at(am, rigR - HALF, HIGH);
      const outer = at(am, rigR + HALF, HIGH);
      setPipe(this.struts, n++, at(a0, rigR, LOW), inner);
      setPipe(this.struts, n++, inner, at(a1, rigR, LOW));
      setPipe(this.struts, n++, at(a0, rigR, LOW), outer);
      setPipe(this.struts, n++, outer, at(a1, rigR, LOW));
      setPipe(this.struts, n++, inner, outer);
    }
    this.struts.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.39;
      this.clamps.setMatrixAt(i, _m.makeTranslation(Math.sin(a) * rigR, LOW - 0.035 - 0.07, Math.cos(a) * rigR));
    }
    this.clamps.instanceMatrix.needsUpdate = true;

    // Perches : tous les 3 m environ, du fond de la conque jusqu'en avant du pont.
    const c = this.rig.position;
    const zBack = -(wallR - 3);
    const zFront = c.z + rigR + 2;
    const count = Math.min(BATTEN_MAX, Math.max(2, Math.round((zFront - zBack) / 3) + 1));
    for (let i = 0; i < count; i++) {
      const z = zBack + ((zFront - zBack) * i) / (count - 1);
      const half = Math.sqrt(Math.max(1, wallR * wallR - z * z)) - 1;
      setPipe(this.pipes, i, new THREE.Vector3(-half, grilY, z), new THREE.Vector3(half, grilY, z));
    }
    // Porteuses sous les perches (tube contre tube), élingues jusqu'aux membrures hautes.
    const reach = (rigR + HALF) * Math.SQRT1_2;
    [-1, 1].forEach((side, k) => {
      const x = side * reach;
      setPipe(this.pipes, count + k, new THREE.Vector3(x, grilY - 0.1, c.z - reach - 1), new THREE.Vector3(x, grilY - 0.1, c.z + reach + 1));
      [-1, 1].forEach((end, j) => {
        const z = c.z + end * reach;
        setPipe(this.cables, k * 2 + j, new THREE.Vector3(x, c.y + HIGH + 0.035, z), new THREE.Vector3(x, grilY - 0.15, z));
      });
    });
    this.pipes.count = count + 2;
    this.pipes.instanceMatrix.needsUpdate = true;
    this.cables.instanceMatrix.needsUpdate = true;
  }
}

/** Lointain, au-delà de la conque et côté salle : brume à l'horizon et colonnes de lumière perdues dans le noir. */
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
        vec3 col = uHaze + glow * (0.3 + 0.1 * uPulse) * pow(1.0 - h, 5.0);
        // Colonnes de lumière verticales, floues, perdues dans la brume.
        float bars = pow(max(0.0, 0.5 + 0.5 * cos(a * 28.0)), 40.0) + 0.5 * pow(max(0.0, 0.5 + 0.5 * cos(a * 12.0 + 1.3)), 90.0);
        col += glow * bars * (0.3 + 0.2 * uPulse) * smoothstep(0.0, 0.08, h) * pow(1.0 - h, 2.2);
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
    this._tmpColor = new THREE.Color();
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
    // Éclairage de plateau : une lumière d'ensemble faible (les instruments au repos restent
    // lisibles, dans la pénombre), et deux poursuites qui éclairent vraiment ceux qui jouent.
    root.add(new THREE.HemisphereLight(0x8fa4ff, 0x1a120c, 0.22));
    const key = (this.key = new THREE.DirectionalLight(0xdfe6ff, 0.4));
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
    this.rims = [rim(0xbcd4ff, 1.1), rim(0xff4fa3, 1.1)];
    const fill = (this.fill = new THREE.DirectionalLight(0x9fb6ff, 0.2));
    root.add(fill);
    // Poursuites : projecteurs à ombres portées, accrochés aux deux têtes de face du pont.
    // Leur nombre est fixe (pas de recompilation des shaders), seule leur visée change.
    this.follows = FOLLOW_HEADS.map((head) => {
      const light = new THREE.SpotLight(0xffe9cc, 0, 0, 0.2, 0.75, 0);
      light.castShadow = true;
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.03;
      light.shadow.radius = 4;
      light.shadow.blurSamples = 12;
      light.shadow.camera.near = 2;
      light.shadow.camera.far = 90;
      root.add(light, light.target);
      return { light, head, level: 0 };
    });

    // --- Sol et fond
    this.floor = new ReflectiveFloor();
    root.add(this.floor.mesh);
    this.backdrop = makeBackdrop();
    root.add(this.backdrop);
    this.shell = new StageShell();
    root.add(this.shell.group);

    // Bordure lumineuse du plateau.
    this.edgeMat = mat.glow(ACCENTS[0], 1);
    this.edge = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 200), this.edgeMat);
    this.edge.rotation.x = Math.PI / 2;
    this.edge.position.y = 0.02;
    this.curb = new THREE.Mesh(new THREE.TorusGeometry(1, 0.09, 10, 200), mat.gunmetal());
    this.curb.rotation.x = Math.PI / 2;
    root.add(this.edge, this.curb);

    // --- Pont de projecteurs : anneau suspendu, têtes mobiles et faisceaux volumétriques.
    this.rig = new THREE.Group();
    root.add(this.rig);
    this.rigging = new Rigging(this.rig, root);
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
      return { pivot, beam, beamMat, lensMat: lens.material, phase: i * 2.399, target: new THREE.Vector3(), goal: new THREE.Vector3() };
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
  setRadius(R, stage = R + 6.2) {
    this.radius = R;
    const stageR = (this.stageRadius = Math.max(R + 6.2, stage));
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
    // Conque à 5 m du bord du plateau ; gril au-dessus du pont et des plus hautes grues
    // de la caméra (voir director.js : plan d'ensemble à 0,42 × rayon du plateau + 4,5).
    const wallR = (this.wallRadius = stageR + 5);
    const grilY = (this.grilY = Math.max(rigY + 4, stageR * 0.42 + 6));
    this.shell.layout(wallR, grilY + 2.5);
    this.rigging.layout(rigR, grilY, wallR);
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
  update(wall, pulse = 0, mood = null, spots = []) {
    const R = this.radius;
    const down = new THREE.Vector3(0, -1, 0);
    const dir = new THREE.Vector3();
    const energy = mood?.energy ?? 0.5;
    // Ambiance de la section : palette (fondu depuis la section précédente) et énergie.
    if (mood) {
      const a = MOODS[mood.from % MOODS.length];
      const b = MOODS[mood.index % MOODS.length];
      const u = this.backdrop.material.uniforms;
      u.uA.value.setHex(a.a).lerp(this._tmpColor.setHex(b.a), mood.blend);
      u.uB.value.setHex(a.b).lerp(this._tmpColor.setHex(b.b), mood.blend);
      this.shell.uniforms.uWashA.value.copy(u.uA.value);
      this.shell.uniforms.uWashB.value.copy(u.uB.value);
      this.edgeMat.emissive.setHex(a.accent).lerp(this._tmpColor.setHex(b.accent), mood.blend);
      this.rims[1].color.copy(this.edgeMat.emissive);
      this.heads.forEach((h, i) => {
        // Têtes paires : ambiance (accent) ; têtes impaires : poursuites (blanc de la section).
        const tint = i % 2 ? 'key' : 'accent';
        h.beamMat.uniforms.uColor.value.setHex(a[tint]).lerp(this._tmpColor.setHex(b[tint]), mood.blend);
        h.lensMat.color.copy(h.beamMat.uniforms.uColor.value).multiplyScalar(2.2);
      });
      for (const f of this.follows) f.light.color.copy(this.heads[f.head].beamMat.uniforms.uColor.value);
    }
    // Les instruments les plus actifs sont suivis par une tête sur deux.
    const ranked = spots.filter((s) => s.level > 0.05).sort((p, q) => q.level - p.level);
    const speed = 0.6 + 0.9 * energy;
    this.heads.forEach((h, i) => {
      const spot = i % 2 === 1 ? ranked[FOLLOW_RANK[i] % Math.max(1, ranked.length)] : null;
      h.level = spot ? spot.level : 0;
      if (spot) {
        h.goal.set(spot.center.x, 0, spot.center.z);
      } else {
        // Point qui se promène sur le plateau, d'autant plus vite que la section est intense.
        const a = h.angle + Math.sin(wall * 0.13 * speed + h.phase) * 0.9;
        const r = R * (0.25 + 0.3 * (0.5 + 0.5 * Math.sin(wall * 0.09 * speed + h.phase * 1.7)));
        h.goal.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      }
      h.target.lerp(h.goal, 0.06);
      dir.copy(h.target).sub(h.pivot.position).setY(-this.rigY).normalize();
      h.pivot.quaternion.setFromUnitVectors(down, dir);
      h.beamMat.uniforms.uIntensity.value = this.beamGain * (0.45 + 0.7 * energy + 0.6 * pulse);
    });
    // Les poursuites partent de leur tête et visent le même point que son faisceau ; elles
    // montent quand l'instrument suivi joue et retombent (sans s'éteindre) entre deux phrases.
    for (const f of this.follows) {
      const h = this.heads[f.head];
      // Attaque franche, retombée lente : la lumière monte avec la note, pas après elle.
      f.level += (h.level - f.level) * (h.level > f.level ? 0.5 : 0.06);
      f.light.position.copy(this.rig.position).add(h.pivot.position);
      f.light.target.position.copy(h.target);
      f.light.intensity = this.followGain * (0.35 + 0.65 * Math.min(1, f.level * 1.6));
    }
    this.dustMat.uniforms.uTime.value = wall;
    this.backdrop.material.uniforms.uPulse.value = pulse + 0.6 * energy;
    this.shell.uniforms.uWash.value = this.washGain * (0.55 + 0.6 * energy + 0.35 * pulse);
    this.edgeMat.emissiveIntensity = 0.4 + 0.8 * energy + 2 * pulse;
  }

  /**
   * Garde un point (la caméra) dans le lieu : devant la conque, sous le gril. Côté salle,
   * la conque est ouverte : on peut reculer, jusqu'à ce que la brume avale la scène.
   */
  confine(p) {
    const wallR = this.wallRadius;
    const r = Math.hypot(p.x, p.z);
    // La conque couvre 210° : ses bords sont à z = 0,26 × rayon ; au-delà, c'est la salle.
    const limit = p.z < wallR * 0.2 ? wallR - 1.5 : wallR * 2.2;
    if (r > limit) {
      p.x *= limit / r;
      p.z *= limit / r;
    }
    p.y = Math.min(p.y, this.grilY - 0.6);
  }

  /**
   * Faisceaux à tracer dans la brume (voir volumetric.js) : sommet, axe, couleur,
   * intensité, demi-angle et longueur de chaque tête ; les poursuites donnent en plus
   * leur ombre (carte et matrice), pour que les instruments s'y découpent.
   */
  beams() {
    if (!this.volumetric) return [];
    return this.heads.map((h, i) => {
      const follow = this.follows.find((f) => f.head === i);
      const beam = (h.volume ??= { apex: new THREE.Vector3(), axis: new THREE.Vector3(), color: null, intensity: 0, angle: 0, length: 0, shadow: null });
      beam.apex.copy(this.rig.position).add(h.pivot.position);
      beam.axis.set(0, -1, 0).applyQuaternion(h.pivot.quaternion);
      beam.color = h.beamMat.uniforms.uColor.value;
      // Une poursuite est aussi large que sa flaque au sol et brille avec elle.
      // Têtes d'ambiance : même respiration que leurs cônes (énergie de la section, battue), en retrait.
      const breath = h.beamMat.uniforms.uIntensity.value / Math.max(this.beamGain, 1e-4);
      beam.intensity = this.volumeGain * (follow ? follow.light.intensity / this.followGain : 0.3 * breath);
      beam.angle = follow ? follow.light.angle : 0.13;
      beam.length = this.rigY * 1.6;
      beam.shadow = follow && follow.light.castShadow ? follow.light.shadow : null;
      return beam;
    });
  }

  /**
   * Met à jour la sonde de reflets (à appeler avant les autres rendus). Le sol y est
   * rendu sans son reflet miroir (calculé pour la caméra principale), et sans
   * faisceaux ni poussières, qui noieraient l'image vue de l'intérieur.
   */
  /**
   * Cadence des cartes d'ombres : chaque carte redessine toute la scène, trois par image
   * coûtent cher. La lumière d'ensemble est fixe et faible : une image sur trois lui
   * suffit. Les deux poursuites, lentes, se relaient une image sur deux. L'ombre d'une
   * pièce rapide a donc au plus une image de retard sous une poursuite.
   */
  scheduleShadows() {
    const n = (this.shadowFrame = (this.shadowFrame ?? 0) + 1);
    const turn = (shadow, due) => {
      shadow.autoUpdate = false;
      // Une carte pas encore créée (changement de qualité) est toujours dessinée.
      if (due || !shadow.map) shadow.needsUpdate = true;
    };
    turn(this.key.shadow, n % 3 === 0);
    this.follows.forEach((f, i) => turn(f.light.shadow, n % 2 === i));
  }

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
    this.probeFaces = level === 'low' ? 0 : 1; // une face de cube par image : sonde à jour en 6 images
    this.probe.setSize(level === 'high' ? 256 : 128);
    if (!this.probeFaces || !this.probe.filtered) this.scene.environment = this.studio;
    this.reflections = level !== 'low';
    this.reflectionScale = level === 'high' ? 0.5 : 0.4;
    this.floor.uniforms.uReflect.value = this.reflections ? 1 : 0;
    // Trois cartes d'ombres (ensemble + deux poursuites) : 2K en qualité haute, 1K en moyenne.
    for (const light of [this.key, ...this.follows.map((f) => f.light)]) {
      light.castShadow = level !== 'low';
      light.shadow.mapSize.setScalar(level === 'high' ? 2048 : 1024);
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }
    this.followGain = 8;
    this.washGain = 3.5;
    this.beamGain = level === 'low' ? 0 : 0.05;
    this.dust.visible = level !== 'low';
    // Qualité haute : faisceaux tracés dans la brume ; moyenne : cônes lumineux (repli).
    this.volumetric = level === 'high';
    this.volumeGain = 0.1;
    for (const h of this.heads) h.beam.visible = level === 'medium';
  }
}
