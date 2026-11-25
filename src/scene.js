import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { activeBallRange, ballPosition, ballScale, barPulse, launcherPose } from './choreography.js';
import { DrumKitView } from './drumsView.js';

const UP = new THREE.Vector3(0, 1, 0);

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
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    scene.add(new THREE.HemisphereLight(0x8090ff, 0x20160c, 0.25));
    const key = new THREE.DirectionalLight(0xfff1dd, 2.2);
    key.position.set(6, 14, 8);
    key.castShadow = true;
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

    this._tmp = [0, 0, 0];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._dir = new THREE.Vector3();

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
   * @param ch chorégraphie des billes
   * @param trackColors tableau de THREE.Color indexé par piste
   * @param kit batterie (drums.js), facultative
   */
  build(ch, trackColors, kit = null) {
    this.clear();
    this.ch = ch;
    this.trackColors = trackColors;
    const o = ch.options;

    // --- Lames de marimba + résonateurs
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a3e1d, roughness: 0.5, metalness: 0.05 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a35a, roughness: 0.25, metalness: 1 });
    this.barMeshes = ch.bars.map((bar) => {
      const mat = wood.clone();
      mat.emissive = new THREE.Color(0x000000);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bar.length, o.barThickness, bar.width), mat);
      mesh.position.set(...bar.position);
      mesh.rotation.y = Math.PI / 2 - bar.angle;
      mesh.castShadow = mesh.receiveShadow = true;
      this.content.add(mesh);

      const tubeLen = 1.0 - 0.65 * bar.u;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(bar.width * 0.32, bar.width * 0.32, tubeLen, 20), brass);
      tube.position.set(bar.position[0], o.barTopY - 0.25 - tubeLen / 2, bar.position[2]);
      tube.castShadow = true;
      this.content.add(tube);
      return mesh;
    });

    // --- Châssis : deux rails en arc sous les lames, plus des pieds
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2d38, roughness: 0.3, metalness: 0.9 });
    const half = ch.arc / 2 + 0.06;
    for (const r of ch.bars.length ? [ch.radius - 0.3, ch.radius + 0.3] : []) {
      const pts = [];
      for (let i = 0; i <= 64; i++) {
        const a = -half + (2 * half * i) / 64;
        pts.push(new THREE.Vector3(Math.sin(a) * r, o.barTopY - 0.13, -Math.cos(a) * r));
      }
      const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 128, 0.05, 8), frameMat);
      rail.castShadow = true;
      this.content.add(rail);
      const legs = Math.max(2, Math.round((2 * half * r) / 3));
      for (let i = 0; i <= legs; i++) {
        const a = -half + (2 * half * i) / legs;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, o.barTopY - 0.13, 8), frameMat);
        leg.position.set(Math.sin(a) * r, (o.barTopY - 0.13) / 2, -Math.cos(a) * r);
        this.content.add(leg);
      }
    }

    // --- Canons
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(o.launcherRadius + 0.6, o.launcherRadius + 0.8, 0.3, 48),
      frameMat,
    );
    hub.position.y = 0.15;
    hub.castShadow = hub.receiveShadow = true;
    if (ch.launchers.length) this.content.add(hub);

    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x6b7385, roughness: 0.35, metalness: 1 });
    const barrelGeo = new THREE.CylinderGeometry(0.11, 0.14, o.barrelLength, 24, 1, true);
    barrelGeo.translate(0, o.barrelLength / 2, 0);
    this.launcherParts = ch.launchers.map((L) => {
      const base = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), frameMat);
      base.position.set(...L.pivot);
      base.castShadow = true;
      this.content.add(base);

      const barrel = new THREE.Group();
      const tube = new THREE.Mesh(barrelGeo, barrelMat);
      tube.castShadow = true;
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.03, 8, 24), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = o.barrelLength;
      barrel.add(tube, ring);
      barrel.position.set(...L.pivot);
      this.content.add(barrel);
      return { barrel, ringMat, pivot: new THREE.Vector3(...L.pivot) };
    });

    // --- Billes (pool instancié)
    const pool = Math.max(1, ch.maxConcurrent);
    const balls = new THREE.InstancedMesh(
      new THREE.SphereGeometry(o.ballRadius, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.12 }),
      pool,
    );
    balls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pool * 3), 3);
    balls.castShadow = true;
    balls.frustumCulled = false;
    balls.count = 0;
    this.balls = balls;
    this.content.add(balls);

    // --- Batterie robotisée
    this.drums = kit && kit.pieces.length ? new DrumKitView(kit, trackColors, this.content) : null;

    // Cadrage initial
    this.controls.target.set(0, 1, -ch.radius * 0.45);
    this.camera.position.set(0, 4 + ch.radius * 0.5, ch.radius * 0.9 + 4);
    this.controls.update();
  }

  /** Pose tous les objets à l'instant musical t. */
  update(t) {
    const ch = this.ch;
    if (!ch) return;
    this.drums?.update(t);

    // Billes
    const [s, e] = activeBallRange(ch, t);
    let n = 0;
    for (let i = s; i < e && n < this.balls.instanceMatrix.count; i++) {
      const b = ch.balls[i];
      const sc = ballScale(b, t);
      if (sc <= 0) continue;
      ballPosition(ch, b, t, this._tmp);
      this._v.set(this._tmp[0], this._tmp[1], this._tmp[2]);
      this._s.setScalar(sc);
      this._q.identity();
      this._m.compose(this._v, this._q, this._s);
      this.balls.setMatrixAt(n, this._m);
      this.balls.setColorAt(n, this.trackColors[b.track]);
      n++;
    }
    this.balls.count = n;
    this.balls.instanceMatrix.needsUpdate = true;
    this.balls.instanceColor.needsUpdate = true;

    // Canons : visée + recul + éclat du bout du canon
    ch.launchers.forEach((L, i) => {
      const { dir, recoil } = launcherPose(ch, L, t);
      const part = this.launcherParts[i];
      this._dir.set(dir[0], dir[1], dir[2]);
      part.barrel.quaternion.setFromUnitVectors(UP, this._dir);
      part.barrel.position.copy(part.pivot).addScaledVector(this._dir, -0.18 * recoil);
      part.ringMat.emissiveIntensity = 3 * recoil;
    });

    // Lames : éclat coloré + léger enfoncement
    ch.bars.forEach((bar, i) => {
      const { pulse, track, since } = barPulse(ch, bar, t);
      const mesh = this.barMeshes[i];
      if (track >= 0) mesh.material.emissive.copy(this.trackColors[track]);
      mesh.material.emissiveIntensity = pulse * 2.2;
      const wobble = pulse > 0.001 ? Math.sin(since * 60) * pulse : 0;
      mesh.position.y = bar.position[1] - 0.04 * pulse;
      mesh.rotation.z = 0.02 * wobble;
    });
  }

  render() {
    this.controls.update();
    this.composer.render();
  }
}
