import * as THREE from 'three';
import { activeBallRange, ballPosition, ballScale, barPulse, launcherPose } from './choreography.js';
import { lowerBound, upperBound } from './util.js';
import { mat, fx } from './materials.js';
import { roundedBox, lathe, rod, ringOf, V } from './parts.js';

const UP = new THREE.Vector3(0, 1, 0);
const TRAIL = 6; // fantômes lumineux derrière chaque bille
const TRAIL_STEP = 0.016; // écart (s) entre deux fantômes
const SPARKS = 9; // étincelles par impact
const SPARK_LIFE = 0.55;

/** Pseudo-aléatoire déterministe (0..1) : mêmes étincelles à chaque passage. */
const hash = (a, b) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

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
    this._c = new THREE.Color();

    const chrome = mat.chrome();
    const dark = mat.gunmetal();
    const steel = mat.steel();
    const brass = mat.brass();
    const gold = mat.gold();

    // --- Lames de marimba (palissandre verni) + résonateurs en laiton
    this.barMeshes = ch.bars.map((bar) => {
      const material = mat.wood();
      material.emissive = new THREE.Color(0x000000);
      const mesh = roundedBox(bar.length, o.barThickness, bar.width, 0.028, material);
      mesh.position.set(...bar.position);
      mesh.rotation.y = Math.PI / 2 - bar.angle;
      this.content.add(mesh);

      const tubeLen = 1.0 - 0.65 * bar.u;
      const r = bar.width * 0.34;
      const tube = lathe(
        [
          [r * 0.92, 0],
          [r, 0.02],
          [r, tubeLen - 0.03],
          [r * 1.08, tubeLen - 0.03],
          [r * 1.08, tubeLen],
          [r * 0.9, tubeLen],
          [r * 0.9, tubeLen - 0.08],
        ],
        24,
        brass,
      );
      tube.position.set(bar.position[0], o.barTopY - 0.2 - tubeLen, bar.position[2]);
      this.content.add(tube);
      return mesh;
    });

    // --- Châssis : deux rails chromés en arc sous les lames, pieds et traverses
    const half = ch.arc / 2 + 0.06;
    const railY = o.barTopY - 0.115;
    const radii = ch.bars.length ? [ch.radius - 0.3, ch.radius + 0.3] : [];
    for (const r of radii) {
      const pts = [];
      for (let i = 0; i <= 64; i++) {
        const a = -half + (2 * half * i) / 64;
        pts.push(new THREE.Vector3(Math.sin(a) * r, railY, -Math.cos(a) * r));
      }
      const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.04, 12), steel);
      rail.castShadow = rail.receiveShadow = true;
      this.content.add(rail);
    }
    if (radii.length) {
      const legs = Math.max(2, Math.round((2 * half * ch.radius) / 2.6));
      for (let i = 0; i <= legs; i++) {
        const a = -half + (2 * half * i) / legs;
        const at = (r, y) => V(Math.sin(a) * r, y, -Math.cos(a) * r);
        this.content.add(rod(at(radii[0], 0), at(radii[0], railY), 0.035, dark));
        this.content.add(rod(at(radii[1], 0), at(radii[1], railY), 0.035, dark));
        this.content.add(rod(at(radii[0], railY * 0.45), at(radii[1], railY * 0.45), 0.022, dark));
        for (const r of radii) {
          const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.04, 16), dark);
          foot.position.copy(at(r, 0.02));
          foot.receiveShadow = true;
          this.content.add(foot);
        }
      }
    }

    // --- Tourelle centrale et canons
    const R = o.launcherRadius;
    if (ch.launchers.length) {
      const hub = lathe(
        [
          [0, 0],
          [R + 0.62, 0],
          [R + 0.62, 0.07],
          [R + 0.52, 0.13],
          [R + 0.52, 0.2],
          [R + 0.4, 0.27],
          [R - 0.5, 0.27],
          [R - 0.6, 0.2],
          [0, 0.2],
        ],
        72,
        // Plateau mat et assez clair : les ombres et l'occlusion des canons s'y lisent.
        new THREE.MeshStandardMaterial({ color: 0x30343e, roughness: 0.68, metalness: 0.4 }),
      );
      // Ombre de contact au sol : le plateau ne « flotte » plus sur son reflet.
      const shade = new THREE.Mesh(
        new THREE.RingGeometry(R + 0.3, R + 1.5, 72, 1),
        new THREE.ShaderMaterial({
          uniforms: { uInner: { value: R + 0.6 }, uOuter: { value: R + 1.5 } },
          vertexShader: 'varying float vR; void main(){ vR = length(position.xy); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader:
            'uniform float uInner; uniform float uOuter; varying float vR; void main(){ float a = 1.0 - smoothstep(uInner, uOuter, vR); gl_FragColor = vec4(0.0, 0.0, 0.0, 0.8 * a * a); }',
          transparent: true,
          depthWrite: false,
        }),
      );
      shade.rotation.x = -Math.PI / 2;
      shade.position.y = 0.004;
      shade.renderOrder = -1;
      this.content.add(fx(shade));
      this.hubMat = mat.glow(0xffc46b, 1.6);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R + 0.53, 0.018, 8, 96), this.hubMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.165;
      const inner = new THREE.Mesh(new THREE.TorusGeometry(R - 0.55, 0.012, 8, 72), this.hubMat);
      inner.rotation.x = Math.PI / 2;
      inner.position.y = 0.215;
      this.content.add(hub, ring, inner);
    }

    const L = o.barrelLength;
    const barrelProfile = [
      [0, -0.2],
      [0.12, -0.2],
      [0.155, -0.15],
      [0.155, 0.0],
      [0.13, 0.04],
      [0.118, 0.08],
      [0.105, L - 0.2],
      [0.135, L - 0.17],
      [0.135, L - 0.02],
      [0.118, L],
      [0.085, L],
      [0.085, L - 0.45],
    ];
    const barrelGeo = new THREE.LatheGeometry(barrelProfile.map(([r, y]) => new THREE.Vector2(r, y)), 28);
    const bandGeo = new THREE.TorusGeometry(0.125, 0.018, 8, 28);
    const muzzleGeo = new THREE.TorusGeometry(0.112, 0.022, 10, 28);
    const bore = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const flangeGeo = new THREE.CylinderGeometry(0.27, 0.29, 0.04, 28);
    const boltGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8);
    const seatGeo = new THREE.TorusGeometry(0.3, 0.008, 6, 40);
    const boreGeo = new THREE.CircleGeometry(0.085, 20);
    this.launcherParts = ch.launchers.map((launcher) => {
      const pivot = new THREE.Vector3(...launcher.pivot);
      // Colonne et rotule.
      const post = lathe(
        [
          [0.2, 0],
          [0.2, 0.05],
          [0.11, 0.1],
          [0.09, pivot.y - 0.27 - 0.12],
        ],
        20,
        steel,
      );
      post.position.set(pivot.x, 0.27, pivot.z);
      // Embase boulonnée sur le plateau, soulignée d'un filet lumineux.
      const flange = new THREE.Mesh(flangeGeo, dark);
      flange.position.set(pivot.x, 0.27 + 0.02, pivot.z);
      flange.castShadow = flange.receiveShadow = true;
      const bolts = ringOf(6, 0.235, boltGeo, chrome, 0.05);
      bolts.position.set(pivot.x, 0.27, pivot.z);
      const seat = new THREE.Mesh(seatGeo, this.hubMat);
      seat.rotation.x = Math.PI / 2;
      seat.position.set(pivot.x, 0.275, pivot.z);
      this.content.add(flange, bolts, seat);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.19, 28, 18), chrome);
      joint.position.copy(pivot);
      joint.castShadow = true;
      this.content.add(post, joint);

      const barrel = new THREE.Group();
      const tube = new THREE.Mesh(barrelGeo, steel);
      tube.castShadow = tube.receiveShadow = true;
      const band = new THREE.Mesh(bandGeo, gold);
      band.rotation.x = Math.PI / 2;
      band.position.y = 0.3;
      const ringMat = mat.glow(0xffffff, 0);
      const ring = new THREE.Mesh(muzzleGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = L - 0.095;
      const hole = new THREE.Mesh(boreGeo, bore);
      hole.rotation.x = -Math.PI / 2;
      hole.position.y = L - 0.44;
      const flashMat = mat.light(0x000000);
      const flash = fx(new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), flashMat));
      flash.position.y = L + 0.05;
      barrel.add(tube, band, ring, hole, flash);
      barrel.position.copy(pivot);
      this.content.add(barrel);
      return { barrel, ringMat, flashMat, flash, pivot };
    });

    // --- Billes (pool instancié) : chrome teinté, légèrement lumineux
    const pool = Math.max(1, ch.maxConcurrent);
    const ballMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.14, envMapIntensity: 1.6 });
    ballMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor * 0.4;\n#endif',
      );
    };
    const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(o.ballRadius, 32, 20), ballMat, pool);
    balls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pool * 3), 3);
    balls.castShadow = true;
    balls.frustumCulled = false;
    balls.count = 0;
    this.balls = balls;
    this.content.add(balls);

    // --- Effets : traînées des billes, étincelles d'impact, éclairage des frappes
    const instanced = (geometry, count) => {
      const mesh = fx(new THREE.InstancedMesh(geometry, mat.light(0xffffff), Math.max(1, count)));
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.content.add(mesh);
      return mesh;
    };
    this.trails = instanced(new THREE.SphereGeometry(o.ballRadius * 0.9, 12, 8), pool * TRAIL);
    this.sparks = instanced(new THREE.SphereGeometry(0.022, 6, 4), pool * SPARKS);
    this.hitLights = [0, 1].map(() => {
      const light = fx(new THREE.PointLight(0xffffff, 0, 6, 1.8));
      this.content.add(light);
      return light;
    });
  }

  update(t) {
    const ch = this.ch;
    const o = ch.options;
    // Billes et traînées
    const [s, e] = activeBallRange(ch, t);
    let n = 0;
    let k = 0;
    const maxBalls = this.balls.instanceMatrix.count;
    const maxTrail = this.trails.instanceMatrix.count;
    this._q.identity();
    for (let i = s; i < e && n < maxBalls; i++) {
      const b = ch.balls[i];
      const sc = ballScale(b, t);
      if (sc <= 0) continue;
      const color = this.trackColors[b.track];
      ballPosition(ch, b, t, this._tmp);
      this._v.set(this._tmp[0], this._tmp[1], this._tmp[2]);
      this._s.setScalar(sc);
      this._m.compose(this._v, this._q, this._s);
      this.balls.setMatrixAt(n, this._m);
      this.balls.setColorAt(n, color);
      n++;
      for (let j = 1; j <= TRAIL && k < maxTrail; j++) {
        const tj = t - j * TRAIL_STEP;
        if (tj < b.launch) break;
        const f = 1 - j / (TRAIL + 1);
        ballPosition(ch, b, tj, this._tmp);
        this._v.set(this._tmp[0], this._tmp[1], this._tmp[2]);
        this._s.setScalar(sc * f);
        this._m.compose(this._v, this._q, this._s);
        this.trails.setMatrixAt(k, this._m);
        this.trails.setColorAt(k, this._c.copy(color).multiplyScalar(0.22 * f * f));
        k++;
      }
    }
    this.balls.count = n;
    this.balls.instanceMatrix.needsUpdate = true;
    this.balls.instanceColor.needsUpdate = true;
    this.trails.count = k;
    this.trails.instanceMatrix.needsUpdate = true;
    this.trails.instanceColor.needsUpdate = true;

    // Étincelles : gerbe balistique à chaque impact, identique à chaque passage.
    let p = 0;
    const maxSparks = this.sparks.instanceMatrix.count;
    const first = lowerBound(ch.balls, t - SPARK_LIFE, (b) => b.impact);
    const last = upperBound(ch.balls, t, (b) => b.impact);
    for (let i = first; i < last; i++) {
      const b = ch.balls[i];
      const dt = t - b.impact;
      const color = this.trackColors[b.track];
      for (let j = 0; j < SPARKS && p < maxSparks; j++) {
        const life = SPARK_LIFE * (0.55 + 0.45 * hash(i, j));
        if (dt >= life) continue;
        const a = hash(i, j + 17) * Math.PI * 2;
        const speed = (0.9 + 1.6 * hash(i, j + 31)) * (0.6 + 0.6 * b.velocity);
        const up = 1.4 + 2.2 * hash(i, j + 47);
        const f = 1 - dt / life;
        this._v.set(
          b.target[0] + Math.cos(a) * speed * dt,
          Math.max(0.02, b.target[1] - o.ballRadius + up * dt - 4.9 * dt * dt),
          b.target[2] + Math.sin(a) * speed * dt,
        );
        this._s.setScalar(0.5 + f);
        this._m.compose(this._v, this._q, this._s);
        this.sparks.setMatrixAt(p, this._m);
        this.sparks.setColorAt(p, this._c.copy(color).lerp(WHITE, 0.35).multiplyScalar(6 * f * f));
        p++;
      }
    }
    this.sparks.count = p;
    this.sparks.instanceMatrix.needsUpdate = true;
    this.sparks.instanceColor.needsUpdate = true;

    // Canons : visée + recul + éclat de la bouche
    let fire = 0;
    ch.launchers.forEach((L, i) => {
      const { dir, recoil } = launcherPose(ch, L, t);
      const part = this.launcherParts[i];
      this._dir.set(dir[0], dir[1], dir[2]);
      part.barrel.quaternion.setFromUnitVectors(UP, this._dir);
      part.barrel.position.copy(part.pivot).addScaledVector(this._dir, -0.2 * recoil);
      part.ringMat.emissiveIntensity = 0.25 + 5 * recoil;
      part.flash.visible = recoil > 0.02;
      part.flashMat.color.setRGB(1, 0.8, 0.5).multiplyScalar(1.6 * recoil * recoil);
      part.flash.scale.setScalar(0.5 + recoil);
      fire = Math.max(fire, recoil);
    });
    if (this.hubMat) this.hubMat.emissiveIntensity = 2.5 + 5 * fire;

    // Lames : éclat coloré + léger enfoncement ; les deux frappes les plus vives éclairent alentour.
    const lit = [null, null];
    ch.bars.forEach((bar, i) => {
      const { pulse, track, since } = barPulse(ch, bar, t);
      const mesh = this.barMeshes[i];
      if (track >= 0) mesh.material.emissive.copy(this.trackColors[track]);
      mesh.material.emissiveIntensity = pulse * 3.2;
      const wobble = pulse > 0.001 ? Math.sin(since * 60) * pulse : 0;
      mesh.position.y = bar.position[1] - 0.04 * pulse;
      mesh.rotation.z = 0.02 * wobble;
      if (track < 0) return;
      const hit = { bar, pulse, track };
      if (!lit[0] || pulse > lit[0].pulse) {
        lit[1] = lit[0];
        lit[0] = hit;
      } else if (!lit[1] || pulse > lit[1].pulse) lit[1] = hit;
    });
    this.hitLights.forEach((light, i) => {
      const hit = lit[i];
      light.intensity = hit ? 6 * hit.pulse : 0;
      if (!hit) return;
      light.color.copy(this.trackColors[hit.track]);
      light.position.set(hit.bar.position[0], hit.bar.position[1] + 0.55, hit.bar.position[2]);
    });
  }
}

const WHITE = new THREE.Color(1, 1, 1);
