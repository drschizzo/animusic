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
import { Environment } from './environment.js';
import { PostFX } from './postfx.js';
import { hitPulse } from './drums.js';
import { analyzeSong, deployAt, sectionAt } from './sections.js';
import { floorHalo } from './parts.js';
import { lowerBound } from './util.js';

/** Résolution interne par niveau : rapport maximal et nombre de pixels maximal. */
const PIXEL_BUDGET = {
  high: { cap: 2, budget: 2560 * 1440 },
  medium: { cap: 1.5, budget: 1920 * 1080 },
  low: { cap: 1, budget: 1920 * 1080 },
};

const VIEWS = { balls: BallsView, drums: DrumKitView, bass: StringsView, pads: PipesView, bells: BellsView, laser: LaserView, bowed: BowedView, keys: KeysView };

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

/** Scène Three.js : construit les objets à partir d'une chorégraphie et les pose à l'instant t. */
export class Stage {
  constructor(container) {
    this.container = container;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    // Tout ce qui passe sous le sol est découpé : les instruments en sortent à leur entrée.
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.001)];
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
    this.post = new PostFX(renderer, scene, this.camera);
    this.pulse = 0;

    this.content = new THREE.Group();
    scene.add(this.content);

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
   * Construit la vue de chaque instrument de l'ensemble (voir arranger.js).
   * @param ensemble { instruments: [{kind, model, ...}], radius }
   * @param trackColors tableau de THREE.Color indexé par piste
   */
  build(ensemble, trackColors) {
    this.clear();
    this.ensemble = ensemble;
    this.environment.setRadius(ensemble.radius);
    this.kick = ensemble.instruments.find((i) => i.kind === 'drums')?.model;
    this.song = analyzeSong(ensemble);
    // Chaque instrument est monté sur un élévateur (groupe déplacé verticalement).
    this.lifts = ensemble.instruments.map(() => {
      const lift = new THREE.Group();
      this.content.add(lift);
      return lift;
    });
    this.views = ensemble.instruments.map((inst, k) => new VIEWS[inst.kind](inst.model, trackColors, this.lifts[k]));
    // Hauteur de chaque instrument (pour le cacher entièrement sous le sol) et trappe
    // lumineuse au sol, qui s'allume pendant qu'il monte ou descend.
    this.hatches = this.views.map((view, k) => {
      const box = solidBox(this.lifts[k]);
      const height = Number.isFinite(box.max.y) ? box.max.y + 0.1 : 4;
      if (ensemble.instruments[k].kind === 'balls') return { height, halo: null };
      const root = view.group ?? view.content;
      const saved = [root.position.clone(), root.quaternion.clone()];
      root.position.set(0, 0, 0);
      root.quaternion.identity();
      root.updateMatrixWorld(true);
      const local = solidBox(root);
      root.position.copy(saved[0]);
      root.quaternion.copy(saved[1]);
      root.updateMatrixWorld(true);
      const halo = floorHalo((local.max.x - local.min.x) / 2 + 0.15, (local.max.z - local.min.z) / 2 + 0.15);
      // Centre de la boîte (repère de l'instrument) ramené dans la scène.
      local.getCenter(halo.position).applyQuaternion(root.quaternion).add(root.position).setY(0.006);
      halo.quaternion.copy(root.quaternion);
      this.content.add(halo);
      return { height, halo };
    });
    this.mood = sectionAt(this.song, 0);
    this.spots = ensemble.instruments.map((inst) => ({ center: new THREE.Vector3(...inst.focus.center), level: 0 }));

    this.resetView();
    this.controls.update();
    // Compile d'avance tous les shaders (y compris des objets encore vides, comme le
    // réservoir de billes) : sinon la première apparition fige l'image en pleine lecture.
    this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
  }

  /** Place la caméra (pose calculée par le réalisateur). */
  setCamera({ position, target }) {
    this.camera.position.set(...position);
    this.controls.target.set(...target);
  }

  /** Revient au plan d'ensemble initial. */
  resetView() {
    const R = this.ensemble?.radius ?? 8;
    this.controls.target.set(0, 1, -R * 0.3);
    this.camera.position.set(0, 4 + R * 0.6, R * 1.3 + 5);
  }

  /** Pose tous les objets à l'instant musical t. */
  update(t) {
    const instruments = this.ensemble?.instruments ?? [];
    (this.views ?? []).forEach((v, k) => {
      const d = deployAt(this.song, k, t);
      const lift = this.lifts[k];
      const { height, halo } = this.hatches[k];
      lift.visible = d > 0;
      lift.position.y = d < 1 ? -height * (1 - d) : Math.min(0.08, (d - 1) * 0.6);
      if (halo) {
        const glow = d > 0 && d < 1 ? Math.sin(Math.PI * Math.min(1, d)) : 0;
        halo.visible = glow > 0.01;
        halo.material.uniforms.uIntensity.value = 2.5 * glow;
      }
      if (d > 0) v.update(t);
      // Activité récente (pour les projecteurs qui suivent l'action).
      const on = instruments[k].onsets;
      const i = lowerBound(on, t + 1e-6) - 1;
      this.spots[k].level = d >= 1 && i >= 0 ? Math.exp(-(t - on[i]) * 1.5) : 0;
    });
    if (this.song) this.mood = sectionAt(this.song, t);
    // Battue du morceau (grosse caisse) : le décor respire avec elle.
    const kick = this.kick?.pieces.find((p) => p.name === 'kick');
    this.pulse = kick ? hitPulse(this.kick, kick, t).pulse : 0;
  }

  /**
   * Niveau de qualité : 'high' (tout : ombres 4K, reflets, lumière indirecte, occlusion ambiante, halo),
   * 'medium' (sans occlusion, reflets et ombres allégés), 'low' (rendu direct, résolution 1).
   */
  setQuality(level) {
    this.quality = level;
    this.renderer.shadowMap.enabled = level !== 'low';
    this.environment.setQuality(level);
    this.post.setQuality(level);
    // Les matériaux doivent être recompilés quand les ombres changent.
    this.scene.traverse((o) => {
      if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true));
    });
    this.resize();
  }

  /** Active ou coupe la lumière indirecte (SSGI), effective en qualité haute. */
  setIndirectLight(on) {
    this.post.setQuality(this.quality, on);
  }

  render() {
    this.controls.update();
    const wall = performance.now() / 1000;
    this.environment.update(wall, this.pulse, this.mood, this.spots);
    // Les ombres ne dépendent pas de la caméra : calculées au premier rendu de l'image
    // (sonde ou reflet), elles resservent pour tous les suivants.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.environment.renderProbe();
    this.environment.renderReflection(this.renderer, this.camera);
    this.post.render(wall);
  }
}
