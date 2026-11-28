import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BallsView } from './ballsView.js';
import { DrumKitView } from './drumsView.js';
import { StringsView } from './stringsView.js';
import { PipesView } from './pipesView.js';
import { BellsView } from './bellsView.js';
import { LaserView } from './laserView.js';
import { KeysView } from './keysView.js';
import { BowedView } from './bowedView.js';
import { WindsView } from './windsView.js';
import { PassesView } from './passesView.js';
import { TrunksView } from './trunksView.js';
import { Environment } from './environment.js';
import { PostFX } from './postfx.js';
import { hitPulse } from './drums.js';
import { analyzeSong, deployAt, sectionAt } from './sections.js';
import { floorHalo, riserBlock } from './parts.js';
import { lowerBound, drain, sliced, breathe } from './util.js';
import { freezeStatic } from './freeze.js';
import { WEBGPU, RAW, gpuRenderer, hideUnsupported, NodePostFX } from './gpu.js';

/** Résolution interne par niveau : rapport maximal et nombre de pixels maximal. */
const PIXEL_BUDGET = {
  // Haute : tous les effets plein écran se paient au pixel ; 2,4 Mpx, adoucis par le flou
  // de mouvement et la profondeur de champ, valent mieux qu'une image plus fine et saccadée.
  high: { cap: 2, budget: 2048 * 1152 },
  medium: { cap: 1.5, budget: 1920 * 1080 },
  low: { cap: 1, budget: 1920 * 1080 },
};

const LAMP_POOL = 4;

/** Temps de pose du flou de mouvement : 1/48 s, l'obturateur à 180° d'une caméra à 24 images/s. */
const SHUTTER = 1 / 48;
/** Focale de référence (champ vertical, degrés) : celle des cadrages du réalisateur et de la vue libre. */
const BASE_FOV = 40;

const VIEWS = { balls: BallsView, drums: DrumKitView, bass: StringsView, pads: PipesView, bells: BellsView, laser: LaserView, bowed: BowedView, winds: WindsView, plucked: StringsView, keys: KeysView };

/** Boîte englobante des pièces solides (sans effets lumineux ni maillages instanciés). */
function solidBox(root) {
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.userData.fx) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(part.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return box;
}

/**
 * Monte chaque instrument de l'ensemble sur un élévateur (groupe déplacé verticalement
 * pour l'entrée en scène) : sa vue, son estrade s'il est sur un gradin, et le liseré au
 * sol dans la couleur de sa piste principale (identité de l'instrument). Sans rendu :
 * utilisé aussi par le détecteur d'interpénétrations (tools/collide.mjs).
 * @returns { lifts, views, hatches: [{ height, halo }] }
 */
export function mountInstruments(ensemble, trackColors, content, options) {
  return drain(mountSteps(ensemble, trackColors, content, options));
}

/** Le même montage, par étapes (voir `sliced` dans util.js) : un instrument à la fois. */
export function* mountSteps(ensemble, trackColors, content, { freeze = true } = {}) {
  const lifts = ensemble.instruments.map(() => {
    const lift = new THREE.Group();
    content.add(lift);
    return lift;
  });
  const views = [];
  for (const [k, inst] of ensemble.instruments.entries()) {
    views.push(new VIEWS[inst.kind](inst.model, trackColors, lifts[k]));
    yield;
  }
  const hatches = views.map((view, k) => {
    const inst = ensemble.instruments[k];
    if (inst.kind === 'balls') {
      const box = solidBox(lifts[k]);
      return { height: Number.isFinite(box.max.y) ? box.max.y + 0.1 : 4, halo: null };
    }
    const root = view.group ?? view.content;
    const saved = [root.position.clone(), root.quaternion.clone()];
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    root.updateMatrixWorld(true);
    const local = solidBox(root);
    root.position.copy(saved[0]);
    root.quaternion.copy(saved[1]);
    const halfX = (local.max.x - local.min.x) / 2 + 0.15;
    const halfZ = (local.max.z - local.min.z) / 2 + 0.15;
    const center = local.getCenter(new THREE.Vector3()).setY(0).applyQuaternion(root.quaternion).add(root.position).setY(0);
    const color = trackColors[inst.mainTrack] ?? new THREE.Color(0x49d8ff);
    // Estrade : l'instrument est posé dessus, elle monte avec lui à son entrée.
    const riser = inst.riser ?? 0;
    if (riser > 0) {
      root.position.y += riser + 0.003;
      const block = riserBlock(halfX + 0.2, halfZ + 0.2, riser, color);
      block.position.copy(center);
      block.quaternion.copy(root.quaternion);
      lifts[k].add(block);
    }
    root.updateMatrixWorld(true);
    const box = solidBox(lifts[k]);
    const height = Number.isFinite(box.max.y) ? box.max.y + 0.1 : 4;
    // Liseré au sol (autour de l'estrade s'il y en a une) : il identifie l'instrument,
    // s'avive quand il joue et éclate pendant qu'il sort du sol.
    const pad = riser > 0 ? 0.35 : 0;
    const halo = floorHalo(halfX + pad, halfZ + pad, color);
    halo.position.copy(center).setY(0.006);
    halo.quaternion.copy(root.quaternion);
    content.add(halo);
    return { height, halo };
  });
  // Pièces fixes fusionnées par matériau (voir freeze.js) : beaucoup moins d'appels de rendu.
  let frozen = 0;
  yield;
  if (freeze)
    for (const [k, view] of views.entries()) {
      const inst = ensemble.instruments[k];
      const times = Array.from({ length: 8 }, (_, i) => inst.start + ((i + 0.5) / 8) * (inst.end - inst.start));
      frozen += freezeStatic(lifts[k], view, view.group ?? view.content, (t) => view.update(t), times);
      yield;
    }
  // Canons de passe : montés après la fusion (leurs fûts bougent), sur l'élévateur de l'instrument qui tire.
  const passView = ensemble.passes?.cannons.length ? new PassesView(ensemble.passes, trackColors, lifts, content) : null;
  yield;
  // Réseau de tuyaux de verre qui relie les instruments à la tour : fixe, dans le repère de la scène.
  const trunkView = ensemble.trunks?.lines.length ? yield* TrunksView.steps(ensemble.trunks, trackColors, content) : null;
  if (freeze && trunkView) {
    // Le réseau compte des centaines de pièces fixes (bâtis, capots, tuyaux) : fusionnées aussi.
    const t0 = Math.min(...ensemble.instruments.map((i) => i.start));
    const t1 = Math.max(...ensemble.instruments.map((i) => i.end));
    const times = Array.from({ length: 8 }, (_, i) => t0 + ((i + 0.5) / 8) * (t1 - t0));
    frozen += freezeStatic(trunkView.group, trunkView, trunkView.group, (t) => trunkView.update(t), times);
    yield;
  }
  return { lifts, views, hatches, frozen, passView, trunkView };
}

const GPUClippingGroup = WEBGPU ? (await import('three/webgpu')).ClippingGroup : null;

/** Scène brute (?raw) : même interface que PostFX, mais rendu direct de la scène. */
class RawRender {
  constructor(renderer, scene, camera) {
    Object.assign(this, { renderer, scene, camera });
  }
  setSize() {}
  setMotion() {}
  setFocus() {}
  setQuality() {}
  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

/** Scène Three.js : construit les objets à partir d'une chorégraphie et les pose à l'instant t. */
export class Stage {
  constructor(container) {
    this.container = container;
    const renderer = (this.renderer = gpuRenderer ?? new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap a disparu de three (r182) : PCF est désormais filtré en douceur
    // AgX : les hautes lumières saturées (lames, rayons, tubes) pâlissent vers le blanc au
    // lieu de virer au fluo comme avec ACES.
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.5;
    // Tout ce qui passe sous le sol est découpé : les instruments en sortent à leur entrée.
    const ground = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.001)];
    if (!WEBGPU) renderer.clippingPlanes = ground;
    container.appendChild(renderer.domElement);

    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 250);
    this.camera.position.set(0, 7, 12);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    // Décor (sol réfléchissant, lumières, projecteurs) et post-traitement.
    this.environment = new Environment(renderer, scene);
    // Prototype (gpu.js) : en WebGPU, la chaîne d'effets en nœuds ; en ?raw, la scène brute.
    this.post = NodePostFX ? new NodePostFX(renderer, scene, this.camera, this.environment) : RAW ? new RawRender(renderer, scene, this.camera) : new PostFX(renderer, scene, this.camera, this.environment);
    this.pulse = 0;
    this.time = 0;
    this._last = { wall: 0, time: 0, eye: new THREE.Vector3() };

    this.content = new THREE.Group();
    if (WEBGPU) {
      // WebGPURenderer n'a pas de plans de coupe globaux : un groupe de coupe les porte.
      this.clipGroup = new GPUClippingGroup();
      this.clipGroup.clippingPlanes = ground;
      this.clipGroup.add(this.content);
      scene.add(this.clipGroup);
    } else scene.add(this.content);
    // Lumières réservées aux instruments : toujours présentes (nombre constant, donc pas
    // de recompilation des shaders), confiées chaque image aux lampes les plus vives.
    this.lampPool = Array.from({ length: LAMP_POOL }, () => {
      const light = new THREE.PointLight(0xffffff, 0, 8, 1.6);
      light.userData.fx = true;
      scene.add(light);
      return light;
    });

    // Le conteneur peut changer de taille sans que la fenêtre ne bouge (mise en page).
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    // Conteneur pas encore mis en page : des cibles de taille nulle rendraient les
    // tampons incomplets (erreurs WebGL à chaque image).
    if (!w || !h) return;
    // Résolution interne plafonnée par un budget de pixels : sur un grand écran Retina,
    // la chaîne HDR complète à 2× dépasserait vite la mémoire et le temps GPU.
    const dpr = window.devicePixelRatio || 1;
    const { cap, budget } = PIXEL_BUDGET[this.quality ?? 'high'];
    this.renderer.setPixelRatio(Math.max(1, Math.min(dpr, cap, Math.sqrt(budget / (w * h)))));
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
    const ratio = this.renderer.getPixelRatio();
    this.environment.setSize(w * ratio, h * ratio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.content.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
    });
    this.content.clear();
  }

  /**
   * Construit la vue de chaque instrument de l'ensemble (voir arranger.js), par tranches :
   * le fil principal n'est jamais retenu longtemps (l'écran de chargement reste fluide).
   * @param ensemble { instruments: [{kind, model, ...}], radius }
   * @param trackColors tableau de THREE.Color indexé par piste
   * @param onProgress(fraction, étape) avancement, de 0 à 1
   */
  async build(ensemble, trackColors, onProgress = () => {}) {
    this.clear();
    this.ensemble = ensemble;
    this.environment.setRadius(ensemble.radius, ensemble.stageRadius, spreadOf(ensemble));
    this.kick = ensemble.instruments.find((i) => i.kind === 'drums')?.model;
    this.song = analyzeSong(ensemble);
    onProgress(0, 'machines');
    Object.assign(this, await sliced(mountSteps(ensemble, trackColors, this.content)));
    this.lamps = [];
    this.lifts.forEach((lift, k) => lift.traverse((o) => o.userData.lamp && this.lamps.push({ o, k })));
    this.mood = sectionAt(this.song, 0);
    this.spots = ensemble.instruments.map((inst) => ({ center: new THREE.Vector3(...inst.focus.center), level: 0 }));
    this.showTrails();
    // La colonne de lumière de la harpe laser s'arrête sous le gril (elle mesure 16 m).
    const base = new THREE.Vector3();
    for (const view of this.views) {
      if (!view.sky) continue;
      view.sky.getWorldPosition(base);
      view.sky.scale.y = Math.min(1, Math.max(0.1, (this.environment.grilY - 0.6 - base.y) / 16));
    }

    this.resetView();
    this.controls.update();
    await this.warmUp(onProgress);
  }

  /**
   * Rodage : tous les instruments en place, shaders compilés, géométries envoyées au GPU,
   * variantes d'ombre, de reflet et de profondeur prêtes. Sans lui, un instrument qui entre
   * en scène pour la première fois fait hoqueter l'image en pleine lecture.
   *
   * En WebGL, compiler un shader à son premier dessin bloque le fil principal jusqu'à la fin
   * de la compilation. On procède donc en deux temps : des images « à blanc », où chaque passe
   * déroule son vrai parcours mais où chaque dessin se borne à créer son programme (le
   * pilote les compile alors en parallèle, sans bloquer personne) ; puis, une fois tous les
   * programmes prêts, les vraies images, instrument par instrument.
   */
  async warmUp(onProgress = () => {}) {
    if (!this.container.clientWidth || !this.container.clientHeight) return;
    const renderer = this.renderer;
    // Les pièces cachées au repos (rayons, éclairs, flou des cordes) sont montrées le temps du rodage.
    const hidden = [];
    this.content.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    try {
      onProgress(0.4, 'shaders');
      if (renderer.isWebGPURenderer) {
        hideUnsupported(this.scene);
        await this.warmUpGPU(onProgress);
        return;
      }
      if (renderer.extensions.get('KHR_parallel_shader_compile')) {
        const before = renderer.info.programs.length;
        // Six images : les faces de la sonde et les cartes d'ombre se relaient d'une image à l'autre.
        for (let i = 0; i < 6; i++) {
          this.dryRender();
          await breathe();
        }
        const programs = renderer.info.programs.slice(before);
        const deadline = performance.now() + 60000;
        for (;;) {
          const ready = programs.filter((p) => p.isReady()).length;
          onProgress(0.4 + 0.45 * (programs.length ? ready / programs.length : 1), 'shaders');
          if (ready === programs.length || performance.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      // Vraies images : le décor seul, puis chaque instrument seul, puis tout ensemble.
      onProgress(0.85, 'scène');
      const lifts = this.lifts ?? [];
      for (let k = -1; k < lifts.length; k++) {
        lifts.forEach((lift, i) => (lift.visible = i === k));
        this.render();
        onProgress(0.85 + (0.15 * (k + 2)) / (lifts.length + 2), 'scène');
        await breathe();
      }
      lifts.forEach((lift) => (lift.visible = true));
      this.render();
    } finally {
      for (const o of hidden) o.visible = false;
      for (const small of this._dryTiny?.values() ?? []) small.dispose();
      this._dryTiny = this._drySeen = null;
    }
  }

  /**
   * Rodage WebGPU. Pas de compileAsync : ses objets ne portent pas les mêmes clés de cache
   * que ceux du vrai rendu (contexte de passe, MRT), si bien que presque tout était construit
   * deux fois. On rend donc de vraies images, mais en demandant chaque pipeline nouveau de
   * façon asynchrone (createRenderPipelineAsync). Créé en synchrone, un pipeline est compilé
   * par Metal (newLibraryWithSource, ~0,5 s pour une grosse matière quand le cache Metal ne
   * l'a pas) sur le fil principal du processus GPU, celui qui dessine aussi la page : une
   * cinquantaine à la suite figeaient tout l'onglet 5 à 9 s (mesuré sous trace Chrome). En
   * asynchrone, Metal compile sur les fils secondaires du processus GPU et la page reste
   * fluide. Un dessin dont le pipeline n'est pas prêt est simplement sauté ; on attend
   * qu'ils le soient tous.
   *
   * Chaque étape (décor seul, chaque instrument seul, tout ensemble) passe par toutes les
   * variantes : trois images pour les trois cartes d'ombres qui se relaient, les six faces
   * de la sonde, et rien d'écarté hors du champ (la caméra du réalisateur ira partout).
   */
  async warmUpGPU(onProgress) {
    const pipelines = this.renderer._pipelines;
    const pending = [];
    const update = pipelines.updateForRender;
    pipelines.updateForRender = (renderObject) => pipelines.getForRender(renderObject, pending);
    const culled = [];
    this.scene.traverse((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
    });
    // Attente des compilations, toutes lancées en même temps (le pilote les répartit sur
    // ses fils) : les attendre étape par étape les sérialisait (20 s au lieu de 7, à froid).
    let total = 0;
    let done = 0;
    const settle = async (from, to) => {
      while (pending.length) {
        const batch = pending.splice(0);
        total += batch.length;
        batch.forEach((p) => p.then(() => onProgress(from + ((to - from) * ++done) / total, 'shaders')));
        await Promise.all(batch);
      }
    };
    // Les passes en nœuds (scène, ombres) ne se refont qu'une fois par image du moteur,
    // qui avance au rythme de requestAnimationFrame : on attend donc une vraie image entre
    // deux rendus (délai de secours : un onglet en arrière-plan ne dessine pas).
    const nextFrame = () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
        setTimeout(resolve, 100);
      });
    const pass = async () => {
      for (let i = 0; i < 3; i++) {
        await nextFrame();
        this.render();
      }
      this.environment.renderProbe(6);
    };
    try {
      const lifts = this.lifts ?? [];
      for (let k = -1; k < lifts.length; k++) {
        lifts.forEach((lift, i) => (lift.visible = i === k));
        await pass();
        onProgress(0.4 + (0.2 * (k + 2)) / (lifts.length + 1), 'scène');
      }
      lifts.forEach((lift) => (lift.visible = true));
      await pass();
      await settle(0.6, 0.95);
      // Une fois tout dessiné pour de bon, quelques variantes peuvent encore apparaître
      // (sonde refaite, environnement remplacé) : un dernier tour, attendu lui aussi.
      await pass();
      await settle(0.95, 1);
    } finally {
      pipelines.updateForRender = update;
      for (const o of culled) o.frustumCulled = true;
    }
    // Tout est prêt : la sonde refaite pour de bon (ses dessins sautés l'avaient laissée
    // incomplète), puis une image complète.
    this.environment.renderProbe(6);
    await nextFrame();
    this.render();
  }

  /**
   * Une image « à blanc » : toutes les passes se déroulent (ombres, sonde, reflet, image,
   * effets), mais chaque dessin est remplacé par la création de son programme, dans l'état
   * exact où la passe le demande (cible de rendu, lumières, matériau de substitution).
   */
  dryRender() {
    const renderer = this.renderer;
    const draw = renderer.renderBufferDirect;
    const seen = (this._drySeen ??= new WeakMap());
    const ids = (this._dryIds ??= new WeakMap());
    let next = (this._dryNext ??= 1);
    const id = (o) => {
      if (!o) return 0;
      if (!ids.has(o)) ids.set(o, next++);
      return ids.get(o);
    };
    const tiny = (this._dryTiny ??= new Map());
    renderer.renderBufferDirect = (camera, scene, geometry, material, object) => {
      const attributes = Object.keys(geometry.attributes).join();
      if (!scene) {
        // Passe d'ombres : son programme dépend de l'état des lumières laissé par le rendu
        // précédent, que `compile` ne reproduit pas. On la dessine donc pour de bon (shaders
        // de profondeur, vite compilés), mais avec un triangle à la place de la géométrie.
        let small = tiny.get(attributes);
        if (!small) {
          small = new THREE.BufferGeometry();
          for (const [name, a] of Object.entries(geometry.attributes)) small.setAttribute(name, new THREE.BufferAttribute(new a.array.constructor(3 * a.itemSize), a.itemSize, a.normalized));
          tiny.set(attributes, small);
        }
        draw.call(renderer, camera, null, small, material, object, null);
        return;
      }
      // Une seule fois par variante : même matériau, même cible, même genre d'objet.
      const key = [
        material.version,
        material.side,
        id(renderer.getRenderTarget()),
        id(scene),
        attributes,
        object.isInstancedMesh ? 1 : 0,
        object.isSkinnedMesh ? 1 : 0,
        object.receiveShadow ? 1 : 0,
        object.instanceColor ? 1 : 0,
        object.isPoints ? 2 : object.isLine ? 1 : 0,
      ].join('|');
      let keys = seen.get(material);
      if (!keys) seen.set(material, (keys = new Set()));
      if (keys.has(key)) return;
      keys.add(key);
      // `compile` prend le matériau de l'objet : on lui présente l'objet sous celui de la passe.
      const stand = Object.create(object, { material: { value: material }, children: { value: [] } });
      renderer.compile(stand, camera, scene);
    };
    try {
      this.render();
    } finally {
      renderer.renderBufferDirect = draw;
      this._dryNext = next;
    }
  }

  /** Place la caméra (pose calculée par le réalisateur) ; `fov` = champ vertical de l'objectif. */
  setCamera({ position, target, focus, aperture = 0.5, fov = BASE_FOV }) {
    this.camera.position.set(...position);
    this.controls.target.set(...target);
    this.setLens(fov);
    // À cadrage égal, une longue focale est plus loin et écrase davantage l'arrière-plan :
    // son flou grandit avec le rapport des focales (racine : au-delà, un grand instrument
    // net seulement en son centre prend un air de maquette).
    const tele = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2)) / Math.tan(THREE.MathUtils.degToRad(fov / 2));
    this.focus = { distance: focus, aperture: aperture * Math.sqrt(tele) };
  }

  setLens(fov) {
    if (Math.abs(this.camera.fov - fov) < 1e-3) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** Revient au plan d'ensemble initial. */
  resetView() {
    // Comme le plan d'ensemble du réalisateur : tout l'amphithéâtre, de face.
    const S = this.ensemble?.stageRadius ?? 14.2;
    this.setLens(BASE_FOV);
    this.controls.target.set(0, 1.5, -S * 0.42);
    this.camera.position.set(0, 1.5 + S * 0.42 + 3, S * 0.73 + 4);
  }

  /** Pose tous les objets à l'instant musical t. */
  update(t) {
    this.time = t;
    const instruments = this.ensemble?.instruments ?? [];
    (this.views ?? []).forEach((v, k) => {
      const d = deployAt(this.song, k, t);
      const lift = this.lifts[k];
      const { height, halo } = this.hatches[k];
      lift.visible = d > 0;
      lift.position.y = d < 1 ? -height * (1 - d) : Math.min(0.08, (d - 1) * 0.6);
      if (d > 0) {
        v.update(t);
        // Lueurs des pièces fusionnées (freeze.js) : recopiées de leurs matériaux animés.
        for (const sync of lift.glowSyncs ?? []) sync();
      }
      // Activité récente (pour les projecteurs qui suivent l'action, et le liseré au sol).
      const on = instruments[k].onsets;
      const i = lowerBound(on, t + 1e-6) - 1;
      const activity = i >= 0 ? Math.exp(-(t - on[i]) * 1.5) : 0;
      this.spots[k].level = d >= 1 ? activity : 0;
      if (halo) {
        const rising = d > 0 && d < 1 ? Math.sin(Math.PI * Math.min(1, d)) : 0;
        halo.visible = d > 0;
        halo.material.uniforms.uIntensity.value = 2.5 * rising + (d >= 1 ? 0.05 + 0.35 * activity : 0);
      }
    });
    this.passView?.update(t);
    this.trunkView?.update(t);
    for (const sync of this.trunkView?.group.glowSyncs ?? []) sync();
    this.assignLamps();
    if (this.song) this.mood = sectionAt(this.song, t);
    // Battue du morceau (grosse caisse) : le décor respire avec elle.
    const kick = this.kick?.pieces.find((p) => p.name === 'kick');
    this.pulse = kick ? hitPulse(this.kick, kick, t).pulse : 0;
  }

  /** Confie les lumières réservées aux lampes d'instruments les plus vives. */
  assignLamps() {
    const lit = (this.lamps ?? []).filter(({ o, k }) => this.lifts[k].visible && o.intensity > 0.01).sort((a, b) => b.o.intensity - a.o.intensity);
    this.lampPool.forEach((light, i) => {
      const lamp = lit[i]?.o;
      light.intensity = lamp ? lamp.intensity : 0;
      if (!lamp) return;
      lamp.updateWorldMatrix(true, false);
      light.position.setFromMatrixPosition(lamp.matrixWorld);
      light.color.copy(lamp.color);
      light.distance = lamp.distance;
      light.decay = lamp.decay;
    });
  }

  /**
   * Niveau de qualité : 'high' (tout : ombres 2K, reflets, lumière indirecte, occlusion ambiante, halo),
   * 'medium' (sans occlusion, reflets et ombres allégés), 'low' (rendu direct, résolution 1).
   */
  setQuality(level) {
    this.quality = level;
    // Qualité basse : rendu direct, sans passe d'étalonnage. ACES porte son propre
    // contraste ; AgX, plus doux, compte sur l'étalonnage de la dernière passe.
    this.renderer.toneMapping = level === 'low' ? THREE.ACESFilmicToneMapping : THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = level === 'low' ? 2.6 : 1.5;
    this.renderer.shadowMap.enabled = level !== 'low';
    this.environment.setQuality(level);
    this.post.setQuality(level);
    this.showTrails();
    // Les matériaux doivent être recompilés quand les ombres changent.
    this.scene.traverse((o) => {
      if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true));
    });
    this.resize();
  }

  /**
   * Fantômes lumineux derrière les billes : ils tiennent lieu de flou de mouvement en
   * qualité moyenne et basse ; en haute, le vrai flou les remplace.
   */
  showTrails() {
    for (const view of this.views ?? []) if (view.trails) view.trails.visible = this.quality !== 'high';
  }

  /** Active ou coupe la lumière indirecte (SSGI), effective en qualité haute. */
  setIndirectLight(on) {
    this.post.setQuality(this.quality, on);
  }

  render() {
    this.controls.update();
    // La caméra reste dans le lieu : ni derrière la conque, ni au-dessus du gril.
    this.environment.confine(this.camera.position);
    const wall = performance.now() / 1000;
    // Flou de mouvement : mesuré d'une image à la suivante, donc coupé quand elles ne se
    // suivent pas (première image, saut dans le morceau, coupe franche de la caméra).
    const last = this._last;
    const frame = wall - last.wall;
    const dt = this.time - last.time;
    const steady = frame > 1e-3 && frame < 0.25 && Math.abs(dt) < 0.25 && this.camera.position.distanceTo(last.eye) / frame < 60;
    this.post.setMotion(steady ? Math.min(2.5, SHUTTER / frame) : 0, steady ? Math.max(0, dt) : 0);
    // Mise au point : sujet du plan du réalisateur, sinon le point visé par la souris. Elle
    // glisse d'un sujet à l'autre, sauf sur une coupe franche où elle est faite d'emblée.
    const free = this.camera.position.distanceTo(this.controls.target);
    this.post.setFocus(this.focus?.distance ?? free, this.focus?.aperture ?? 0.3, !steady);
    this.focus = null;
    last.wall = wall;
    last.time = this.time;
    last.eye.copy(this.camera.position);
    this.environment.update(wall, this.pulse, this.mood, this.spots);
    // Les ombres ne dépendent pas de la caméra : calculées au premier rendu de l'image
    // (sonde ou reflet), elles resservent pour tous les suivants.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.environment.scheduleShadows();
    // Les vues créent des objets en cours de route (billes…) : contrôle régulier.
    if ((WEBGPU || RAW) && (this._hideTick = (this._hideTick ?? 0) + 1) % 30 === 1) hideUnsupported(this.scene);
    // Sonde de reflets et reflet du sol : partout sauf en WebGL brut (?raw).
    if (!RAW || WEBGPU) {
      this.environment.renderProbe();
      this.environment.renderReflection(this.renderer, this.camera);
    }
    this.post.render(wall);
  }
}

/**
 * Emprise au sol de l'ensemble, symétrique en x (le plateau l'est) : centre en z et
 * demi-étendues, estrades comprises. Le pont des projecteurs s'y ajuste.
 */
export function spreadOf(ensemble) {
  let halfX = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const inst of ensemble.instruments) {
    const f = inst.footprint;
    const [x, z] = f ? f.center : [inst.focus.center[0], inst.focus.center[2]];
    // Boîte de l'estrade tournée de son lacet (ou disque du foyer, sans estrade).
    const c = Math.abs(Math.cos(f?.yaw ?? 0));
    const s = Math.abs(Math.sin(f?.yaw ?? 0));
    const ex = f ? f.halfW * c + f.halfD * s : inst.focus.radius;
    const ez = f ? f.halfW * s + f.halfD * c : inst.focus.radius;
    halfX = Math.max(halfX, Math.abs(x) + ex);
    zMin = Math.min(zMin, z - ez);
    zMax = Math.max(zMax, z + ez);
  }
  if (!Number.isFinite(zMin)) return null;
  return { cz: (zMin + zMax) / 2, halfX, halfZ: (zMax - zMin) / 2 };
}

