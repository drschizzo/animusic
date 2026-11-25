import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BallsView } from './ballsView.js';
import { DrumKitView } from './drumsView.js';
import { StringsView } from './stringsView.js';
import { PipesView } from './pipesView.js';

const VIEWS = { balls: BallsView, drums: DrumKitView, bass: StringsView, pads: PipesView };

/** Scène Three.js : construit les objets à partir d'une chorégraphie et les pose à l'instant t. */
export class Stage {
  constructor(container) {
    this.container = container;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x07080d);
    scene.fog = new THREE.Fog(0x07080d, 25, 60);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(0, 7, 12);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    scene.add(new THREE.HemisphereLight(0x8090ff, 0x20160c, 0.25));
    const key = new THREE.DirectionalLight(0xfff1dd, 2.2);
    key.position.set(6, 14, 8);
    key.castShadow = true;
    this.keyLight = key;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 50 });
    key.shadow.bias = -0.0005;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6688ff, 0.5);
    rim.position.set(-8, 6, -12);
    scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(60, 96),
      new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.3, metalness: 0.5 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.content = new THREE.Group();
    scene.add(this.content);


    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
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
    this.camera.position.set(0, 4 + R * 0.6, R * 1.1 + 4);
  }

  /** Pose tous les objets à l'instant musical t. */
  update(t) {
    for (const v of this.views ?? []) v.update(t);
  }

  /**
   * Niveau de qualité : 'high' (ombres, bloom, haute résolution), 'medium' (bloom
   * sans ombres), 'low' (ni l'un ni l'autre, résolution 1).
   */
  setQuality(level) {
    this.quality = level;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(level === 'high' ? Math.min(dpr, 2) : level === 'medium' ? Math.min(dpr, 1.5) : 1);
    this.renderer.shadowMap.enabled = level === 'high';
    this.keyLight.castShadow = level === 'high';
    this.bloom.enabled = level !== 'low';
    // Les matériaux doivent être recompilés quand les ombres changent.
    this.scene.traverse((o) => {
      if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true));
    });
    this.resize();
  }

  render() {
    this.controls.update();
    this.composer.render();
  }
}
