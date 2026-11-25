import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BallsView } from './ballsView.js';
import { DrumKitView } from './drumsView.js';
import { StringsView } from './stringsView.js';
import { PipesView } from './pipesView.js';
import { BellsView } from './bellsView.js';
import { LaserView } from './laserView.js';
import { KeysView } from './keysView.js';
import { Environment } from './environment.js';
import { PostFX } from './postfx.js';
import { hitPulse } from './drums.js';

const VIEWS = { balls: BallsView, drums: DrumKitView, bass: StringsView, pads: PipesView, bells: BellsView, laser: LaserView, keys: KeysView };

/** Scène Three.js : construit les objets à partir d'une chorégraphie et les pose à l'instant t. */
export class Stage {
  constructor(container) {
    this.container = container;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
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

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
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
    this.views = ensemble.instruments.map((inst) => new VIEWS[inst.kind](inst.model, trackColors, this.content));

    this.resetView();
    this.controls.update();
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
    for (const v of this.views ?? []) v.update(t);
    // Battue du morceau (grosse caisse) : le décor respire avec elle.
    const kick = this.kick?.pieces.find((p) => p.name === 'kick');
    this.pulse = kick ? hitPulse(this.kick, kick, t).pulse : 0;
  }

  /**
   * Niveau de qualité : 'high' (tout : ombres 4K, reflets, occlusion ambiante, halo),
   * 'medium' (sans occlusion, reflets et ombres allégés), 'low' (rendu direct, résolution 1).
   */
  setQuality(level) {
    this.quality = level;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(level === 'high' ? Math.min(dpr, 2) : level === 'medium' ? Math.min(dpr, 1.5) : 1);
    this.renderer.shadowMap.enabled = level !== 'low';
    this.environment.setQuality(level);
    this.post.setQuality(level);
    // Les matériaux doivent être recompilés quand les ombres changent.
    this.scene.traverse((o) => {
      if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true));
    });
    this.resize();
  }

  render() {
    this.controls.update();
    const wall = performance.now() / 1000;
    this.environment.update(wall, this.pulse);
    // Les ombres ne dépendent pas de la caméra : calculées une fois (pendant le rendu
    // du reflet), elles resservent pour le rendu principal.
    this.renderer.shadowMap.autoUpdate = true;
    this.environment.renderReflection(this.renderer, this.camera);
    if (this.environment.reflections) this.renderer.shadowMap.autoUpdate = false;
    this.post.render(wall);
  }
}
