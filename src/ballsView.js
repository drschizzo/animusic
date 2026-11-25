import * as THREE from 'three';
import { activeBallRange, ballPosition, ballScale, barPulse, launcherPose } from './choreography.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Rendu des canons, des billes et de l'arc de lames de marimba. */
export class BallsView {
  constructor(ch, trackColors, parent) {
    this.ch = ch;
    this.trackColors = trackColors;
    this.content = new THREE.Group();
    parent.add(this.content);
    const o = ch.options;
    this._tmp = [0, 0, 0];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._dir = new THREE.Vector3();

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
  }

  update(t) {
    const ch = this.ch;
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
}
