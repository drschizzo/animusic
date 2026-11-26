import * as THREE from 'three';
import { activeBallRange, ballPosition, ballScale, barPulse, launcherPose } from './choreography.js';
import { lowerBound, upperBound } from './util.js';
import { mat, fx } from './materials.js';
import { roundedBox, lathe, rod, ringOf, footShadow, channelGeometry, V } from './parts.js';

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
      // Le résonateur est suspendu à une traverse fixée aux deux rails (il ne flotte pas).
      const hangY = o.barTopY - 0.115 - 0.045;
      tube.position.set(bar.position[0], hangY - 0.012 - tubeLen, bar.position[2]);
      const dir = [Math.sin(bar.angle), -Math.cos(bar.angle)];
      const at = (r) => V(dir[0] * r, hangY, dir[1] * r);
      this.content.add(tube, rod(at(ch.radius - 0.3), at(ch.radius + 0.3), 0.014, dark, 8));
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
      this.content.add(footShadow(0, 0, R + 0.6, { spread: 0.9, strength: 0.8 }));
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
    this._h = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._q2 = new THREE.Quaternion();

    // --- Récupération : gouttière en arc, entonnoirs, tubes de verre jusqu'à la tourelle.
    if (ch.balls.length) this.buildReturns(ch, { steel, chrome, dark });

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

  buildReturns(ch, { steel, chrome, dark }) {
    const o = ch.options;
    // La bille repose au fond de la gouttière (rayon = bille + jeu) et roule au centre des tubes.
    const lift = 0.06;
    const rc = o.ballRadius + lift;
    const rt = o.ballRadius + 0.05; // rayon intérieur des tubes de verre
    const channelMat = mat.brass();
    channelMat.side = THREE.DoubleSide;
    const funnelMat = steel.clone();
    funnelMat.side = THREE.DoubleSide;
    const glass = mat.glass();
    this.portMats = [];
    for (const path of ch.returns) {
      const pts = path.points.map(([x, y, z]) => V(x, y, z));
      const trough = pts.slice(0, path.troughSteps + 1).map((p) => p.clone().setY(p.y + lift));
      const channel = new THREE.Mesh(channelGeometry(trough, rc), channelMat);
      channel.castShadow = channel.receiveShadow = true;
      this.content.add(channel);
      // Liseré lumineux le long des bords de la gouttière.
      const edgeMat = mat.glow(0xffc46b, 1.2);
      this.portMats.push(edgeMat);
      for (const side of [-1, 1]) {
        const edge = trough.map((p, i) => {
          const a = trough[Math.max(0, i - 1)];
          const b = trough[Math.min(trough.length - 1, i + 1)];
          const n = new THREE.Vector3().subVectors(b, a).cross(UP).normalize();
          return p.clone().addScaledVector(n, side * rc);
        });
        const lip = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), edge.length * 2, 0.012, 6), edgeMat);
        this.content.add(lip);
      }
      // Pieds de la gouttière.
      // (pas sous l'extrémité : la bille y bascule dans l'entonnoir)
      for (let i = 0; i <= path.troughSteps - 3; i += Math.max(4, Math.round(path.troughSteps / 6))) {
        const p = trough[i];
        this.content.add(rod(V(p.x, 0, p.z), V(p.x, p.y - rc, p.z), 0.025, dark, 10));
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.03, 14), dark);
        foot.position.set(p.x, 0.015, p.z);
        this.content.add(foot);
      }
      // Entonnoir : axe vertical sous l'arrivée de la gouttière ; son goulot coiffe le tube.
      const f = path.funnel;
      const h = f.top - f.neck;
      const funnel = lathe(
        [
          [rt + 0.015, -0.06],
          [rt + 0.015, 0.16],
          [rt + 0.04, 0.2],
          [0.47, h - 0.02],
          [0.5, h],
        ],
        40,
        funnelMat,
      );
      funnel.position.set(f.x, f.neck, f.z);
      funnel.castShadow = true;
      this.content.add(funnel);
      const rimMat = mat.glow(0xffc46b, 1.5);
      this.portMats.push(rimMat);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.014, 8, 40), rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(f.x, f.top, f.z);
      this.content.add(rim);
      // Trois pieds, tournés à l'opposé du tube (qui part vers la tourelle).
      const out = Math.atan2(f.x, -f.z); // direction radiale vers l'extérieur
      for (const da of [0, 1.3, -1.3]) {
        const a = out + da;
        const dir = [Math.sin(a), -Math.cos(a)];
        const top = V(f.x + dir[0] * 0.46, f.top - 0.05, f.z + dir[1] * 0.46);
        const bottom = V(f.x + dir[0] * 0.72, 0, f.z + dir[1] * 0.72);
        this.content.add(rod(bottom, top, 0.022, dark, 8));
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.065, 0.03, 12), dark);
        foot.position.set(bottom.x, 0.015, bottom.z);
        this.content.add(foot);
      }
      // Tube de verre : exactement le trajet des billes, du goulot jusqu'au chargeur.
      const L = path.loader;
      const out2 = V(Math.sin(L.angle), 0, -Math.cos(L.angle));
      const port = V(L.x, o.tubeY, L.z).addScaledVector(out2, L.radius);
      const tubePts = pts.slice(path.tubeStart).filter((p) => Math.hypot(p.x - L.x, p.z - L.z) > L.radius + 0.02);
      tubePts.push(port);
      const curve = new THREE.CatmullRomCurve3(tubePts);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, tubePts.length * 3, rt, 20), glass);
      tube.renderOrder = 2;
      this.content.add(tube);
      // Bagues chromées régulières sur le tube.
      const ringGeo = new THREE.TorusGeometry(rt + 0.012, 0.014, 8, 24);
      const len = curve.getLength();
      for (let d = 0.6; d < len - 0.3; d += 0.9) {
        const u = d / len;
        const ring = new THREE.Mesh(ringGeo, chrome);
        ring.position.copy(curve.getPointAt(u));
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangentAt(u));
        this.content.add(ring);
      }
      // Chargeur : boîtier opaque au pied de la tourelle, la bille y entre par un col lumineux.
      const loader = lathe(
        [
          [0, 0],
          [L.radius, 0],
          [L.radius, 0.5],
          [L.radius - 0.06, 0.56],
          [0, 0.56],
        ],
        32,
        dark,
      );
      loader.name = 'chargeur';
      loader.position.set(L.x, 0, L.z);
      loader.castShadow = loader.receiveShadow = true;
      this.content.add(loader);
      const mouthMat = mat.glow(0xffc46b, 2);
      this.portMats.push(mouthMat);
      const mouth = new THREE.Mesh(new THREE.TorusGeometry(rt + 0.02, 0.024, 8, 24), mouthMat);
      mouth.position.copy(port);
      mouth.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), out2);
      this.content.add(mouth);
      const capMat = mat.glow(0xffc46b, 1.5);
      this.portMats.push(capMat);
      const cap = new THREE.Mesh(new THREE.TorusGeometry(L.radius - 0.03, 0.012, 8, 32), capMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(L.x, 0.56, L.z);
      this.content.add(cap);
    }
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
    const first = lowerBound(ch.impacts, t - SPARK_LIFE, (b) => b.time);
    const last = upperBound(ch.impacts, t, (b) => b.time);
    for (let i = first; i < last; i++) {
      const b = ch.impacts[i];
      const dt = t - b.time;
      const color = this.trackColors[b.track];
      for (let j = 0; j < SPARKS && p < maxSparks; j++) {
        const life = SPARK_LIFE * (0.55 + 0.45 * hash(i, j));
        if (dt >= life) continue;
        const a = hash(i, j + 17) * Math.PI * 2;
        const speed = (0.9 + 1.6 * hash(i, j + 31)) * (0.6 + 0.6 * b.velocity);
        const up = 1.4 + 2.2 * hash(i, j + 47);
        const f = 1 - dt / life;
        this._v.set(
          b.position[0] + Math.cos(a) * speed * dt,
          Math.max(0.02, b.position[1] - o.ballRadius + up * dt - 4.9 * dt * dt),
          b.position[2] + Math.sin(a) * speed * dt,
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
      const { dir, recoil, shake } = launcherPose(ch, L, t);
      const part = this.launcherParts[i];
      this._dir.set(dir[0], dir[1], dir[2]);
      part.barrel.quaternion.setFromUnitVectors(UP, this._dir);
      // Tremblement après le tir : petite rotation autour de l'axe horizontal du fût.
      this._h.set(this._dir.x, 0, this._dir.z);
      if (this._h.lengthSq() < 1e-8) this._h.set(1, 0, 0);
      this._h.normalize();
      this._axis.set(-this._h.z, 0, this._h.x);
      part.barrel.quaternion.premultiply(this._q2.setFromAxisAngle(this._axis, shake));
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
