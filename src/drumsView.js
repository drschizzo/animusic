import * as THREE from 'three';
import { armAngles, hitPulse } from './drums.js';
import { mat } from './materials.js';
import { lathe, ringOf, rod, V } from './parts.js';

/** Segment de bras caréné le long de +x, de 0 à length. */
function linkGeometry(length, r0, r1) {
  const g = new THREE.CylinderGeometry(r1, r0, length, 20);
  g.rotateZ(-Math.PI / 2);
  g.translate(length / 2, 0, 0);
  return g;
}

/** Peau de fût : disque subdivisé en anneaux (pour pouvoir onduler). */
function headGeometry(radius) {
  return new THREE.RingGeometry(radius * 0.002, radius, 56, 10);
}

/**
 * Peau qui vibre selon ses premiers modes propres (fondamental, puis modes à un et
 * deux diamètres nodaux orientés par le point de frappe), excitée à chaque coup.
 * Le déplacement et l'inclinaison des normales sont calculés dans le shader.
 */
function membrane(material, radius, angle) {
  const u = (material.userData.membrane = { uAmp: { value: 0 }, uSince: { value: 10 }, uRadius: { value: radius }, uAngle: { value: angle } });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uAmp; uniform float uSince; uniform float uRadius; uniform float uAngle;
        float drumModes(vec2 p, float s) {
          float r = clamp(length(p) / uRadius, 0.0, 1.0);
          float th = atan(p.y, p.x) - uAngle;
          float edge = 1.0 - r * r;
          return edge * (cos(s * 95.0) + 1.3 * r * cos(th) * sin(s * 151.0) + 0.9 * r * r * cos(2.0 * th) * sin(s * 204.0));
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float envN = uAmp * exp(-uSince * 7.0);
        float eps = uRadius * 0.02;
        float dx = (drumModes(position.xy + vec2(eps, 0.0), uSince) - drumModes(position.xy - vec2(eps, 0.0), uSince)) / (2.0 * eps);
        float dy = (drumModes(position.xy + vec2(0.0, eps), uSince) - drumModes(position.xy - vec2(0.0, eps), uSince)) / (2.0 * eps);
        objectNormal = normalize(objectNormal + vec3(dx, dy, 0.0) * envN * 5.0);`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z -= uAmp * exp(-uSince * 7.0) * drumModes(position.xy, uSince);');
  };
  material.customProgramCacheKey = () => 'drum-membrane';
  return material;
}

/** Pied de cymbale ou de fût : tube chromé sur trépied. */
function stand(group, x, z, height, chrome, dark) {
  group.add(rod(V(x, 0.02, z), V(x, height, z), 0.018, chrome, 10));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const foot = V(x + Math.cos(a) * 0.3, 0.02, z + Math.sin(a) * 0.3);
    group.add(rod(V(x, Math.min(0.32, height * 0.5), z), foot, 0.012, chrome, 8));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), dark);
    tip.position.copy(foot);
    group.add(tip);
  }
}

/** Rendu de la batterie robotisée ; posée à l'instant t par update(t). */
export class DrumKitView {
  constructor(kit, trackColors, parent) {
    this.kit = kit;
    this.trackColors = trackColors;
    this.group = new THREE.Group();
    parent.add(this.group);

    const m = (this.mats = {
      shell: mat.lacquer(0x8f0f1f, 0.65),
      chrome: mat.chrome(),
      robot: mat.shell(),
      joint: mat.gunmetal(),
      rubber: mat.rubber(),
      stick: mat.paleWood(),
      accent: mat.glow(0x49d8ff, 3.2),
    });
    const lugGeo = new THREE.CapsuleGeometry(0.012, 0.05, 4, 8);

    this.views = kit.pieces.map((p) => {
      const v = { piece: p };
      const [x, y, z] = p.position;

      if (p.kind === 'drum' || p.kind === 'kick') {
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, p.depth, 56, 1, true), m.shell);
        const headMat = membrane(mat.skin(), p.radius * 0.985, p.armDir ? Math.atan2(p.armDir[1], p.armDir[0]) : 0);
        const head = new THREE.Mesh(headGeometry(p.radius * 0.985), headMat);
        const hoopGeo = new THREE.TorusGeometry(p.radius + 0.004, 0.016, 10, 56);
        const hoop = new THREE.Mesh(hoopGeo, m.chrome);
        const hoop2 = new THREE.Mesh(hoopGeo, m.chrome);
        const lugs = ringOf(p.kind === 'kick' ? 10 : 8, p.radius + 0.014, lugGeo, m.chrome);
        const drum = new THREE.Group();
        shell.castShadow = shell.receiveShadow = true;
        head.receiveShadow = true;
        if (p.kind === 'drum') {
          shell.position.y = -p.depth / 2;
          head.rotation.x = -Math.PI / 2;
          hoop.rotation.x = hoop2.rotation.x = Math.PI / 2;
          hoop2.position.y = -p.depth;
          lugs.position.y = -p.depth / 2;
          // Fond du fût : sombre, pour ne pas voir à travers.
          const bottom = new THREE.Mesh(new THREE.CircleGeometry(p.radius * 0.985, 40), m.rubber);
          bottom.rotation.x = Math.PI / 2;
          bottom.position.y = -p.depth;
          drum.add(shell, head, hoop, hoop2, lugs, bottom);
          drum.position.set(x, y, z);
          stand(this.group, x, z, y - p.depth, m.chrome, m.joint);
        } else {
          // Grosse caisse couchée, peaux vers ±z ; la peau arrière reçoit le batteur.
          shell.rotation.x = Math.PI / 2;
          lugs.rotation.x = Math.PI / 2;
          head.position.z = -p.depth / 2;
          head.rotation.y = Math.PI;
          hoop.position.z = -p.depth / 2;
          hoop2.position.z = p.depth / 2;
          const front = new THREE.Mesh(headGeometry(p.radius * 0.985), headMat);
          front.position.z = p.depth / 2;
          // Évent de la peau avant, cerclé de lumière.
          const port = new THREE.Mesh(new THREE.CircleGeometry(p.radius * 0.26, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
          port.position.set(p.radius * 0.38, -p.radius * 0.3, p.depth / 2 + 0.002);
          v.portMat = mat.glow(0xffffff, 0);
          const portRing = new THREE.Mesh(new THREE.TorusGeometry(p.radius * 0.26, 0.012, 8, 32), v.portMat);
          portRing.position.copy(port.position);
          drum.add(shell, head, hoop, hoop2, lugs, front, port, portRing);
          drum.position.set(x, y, z);
          // Béquilles.
          for (const sx of [-1, 1]) {
            this.group.add(rod(V(x + sx * p.radius * 0.75, y - p.radius * 0.6, z + p.depth * 0.3), V(x + sx * (p.radius + 0.12), 0.01, z + p.depth * 0.3 + 0.2), 0.014, m.chrome, 8));
          }
        }
        this.group.add(drum);
        v.drum = drum;
        v.headMat = headMat;
      } else if (p.kind === 'cymbal') {
        const pivot = new THREE.Group();
        pivot.position.set(x, y, z);
        const r = p.radius;
        // Profil d'une vraie cymbale : cloche centrale, puis corps légèrement conique.
        const profile = [
          [0.012, 0.062],
          [r * 0.1, 0.06],
          [r * 0.2, 0.038],
          [r * 0.26, 0.028],
          [r * 0.6, 0.013],
          [r, 0],
        ];
        const cymbalMat = mat.brass();
        cymbalMat.side = THREE.DoubleSide;
        cymbalMat.roughness = 0.5;
        cymbalMat.emissive = new THREE.Color(0x000000);
        const cymbal = lathe(profile, 72, cymbalMat);
        cymbal.position.y = -0.02;
        const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), m.chrome);
        nut.position.y = 0.06;
        pivot.add(cymbal, nut);
        if (p.name === 'hihat') {
          const lower = lathe(profile, 72, cymbalMat);
          lower.rotation.x = Math.PI;
          lower.position.set(x, y - 0.045, z);
          this.group.add(lower);
        }
        stand(this.group, x, z, y, m.chrome, m.joint);
        this.group.add(pivot);
        v.pivot = pivot;
        v.glowMat = cymbalMat;
      } else {
        const headMat = mat.wood(0x8a4a22);
        headMat.emissive = new THREE.Color(0x000000);
        const block = new THREE.Mesh(new THREE.BoxGeometry(p.radius * 2, p.depth, p.radius), headMat);
        block.position.set(x, y - p.depth / 2, z);
        block.castShadow = true;
        stand(this.group, x, z, y - p.depth, m.chrome, m.joint);
        this.group.add(block);
        v.drum = block;
        v.headMat = headMat;
      }

      v.arm = this.buildArm(p);
      return v;
    });
    // Matériaux de construction : jamais modifiés ensuite (les pièces fixes peuvent être fusionnées).
    delete this.mats;
  }

  buildArm(p) {
    const m = this.mats;
    const { root, dir, links } = p.arm;
    const rootGroup = new THREE.Group();
    rootGroup.position.set(...root);
    rootGroup.rotation.y = Math.atan2(-dir[1], dir[0]);
    this.group.add(rootGroup);

    if (links.length === 1) {
      // Pédale de grosse caisse : tige + mailloche.
      const beater = new THREE.Group();
      const rodMesh = new THREE.Mesh(linkGeometry(links[0].length - 0.06, 0.012, 0.012), m.chrome);
      const felt = new THREE.Mesh(new THREE.SphereGeometry(0.065, 20, 14), m.robot);
      felt.position.x = links[0].length - 0.06;
      felt.castShadow = true;
      beater.add(rodMesh, felt);
      rootGroup.add(beater);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.46), m.joint);
      plate.position.set(root[0], 0.018, root[2] + 0.02);
      plate.castShadow = plate.receiveShadow = true;
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 12), m.chrome);
      axle.rotation.z = Math.PI / 2;
      axle.position.set(root[0], root[1], root[2]);
      this.group.add(plate, axle);
      return { segments: [beater] };
    }

    // Colonne + bras à deux segments, articulations soulignées d'un anneau lumineux.
    const base = p.arm.base;
    const pillar = lathe(
      [
        [0.26, 0],
        [0.26, 0.04],
        [0.14, 0.09],
        [0.1, 0.16],
        [0.08, root[1] - 0.08],
        [0.1, root[1] - 0.04],
      ],
      24,
      m.joint,
    );
    pillar.position.set(base[0], 0, base[2]);
    this.group.add(pillar);

    const jointRing = (radius) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.012, 8, 28), m.accent);
      const hubCap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius * 0.8, radius * 2.3, 20), m.joint);
      hubCap.rotation.x = Math.PI / 2;
      const group = new THREE.Group();
      const ring2 = ring.clone();
      ring.position.z = radius * 1.15;
      ring2.position.z = -radius * 1.15;
      hubCap.castShadow = true;
      group.add(hubCap, ring, ring2);
      return group;
    };
    rootGroup.add(jointRing(0.1));

    const upper = new THREE.Group();
    const upperMesh = new THREE.Mesh(linkGeometry(links[0].length, 0.075, 0.055), m.robot);
    upperMesh.castShadow = upperMesh.receiveShadow = true;
    upper.add(upperMesh);
    rootGroup.add(upper);

    const fore = new THREE.Group();
    fore.position.x = links[0].length;
    const metal = 0.4;
    const foreMesh = new THREE.Mesh(linkGeometry(metal, 0.052, 0.036), m.robot);
    const stick = new THREE.Mesh(linkGeometry(links[1].length - metal - 0.012, 0.014, 0.008), m.stick);
    stick.position.x = metal;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), m.stick);
    tip.scale.x = 1.5;
    tip.position.x = links[1].length - 0.014;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.09, 16), m.joint);
    grip.rotation.z = Math.PI / 2;
    grip.position.x = metal;
    foreMesh.castShadow = stick.castShadow = true;
    fore.add(jointRing(0.07), foreMesh, grip, stick, tip);
    upper.add(fore);

    return { segments: [upper, fore] };
  }

  update(t) {
    for (const v of this.views) {
      const p = v.piece;
      const a = armAngles(this.kit, p, t);
      const [s0, s1] = v.arm.segments;
      s0.rotation.z = a[0];
      if (s1) s1.rotation.z = a[1] - a[0];

      const { pulse, since, track } = hitPulse(this.kit, p, t);
      const color = track >= 0 ? this.trackColors[track] : null;
      if (v.headMat) {
        if (color) v.headMat.emissive.copy(color);
        v.headMat.emissiveIntensity = pulse * 1.3;
        const mem = v.headMat.userData.membrane;
        if (mem) {
          const h = p.hits[Math.max(0, upperHit(p.hits, t) - 1)];
          mem.uSince.value = Number.isFinite(since) ? since : 10;
          mem.uAmp.value = h ? 0.08 * p.radius * h.velocity : 0;
        }
        const squash = pulse > 0.001 ? 0.03 * pulse * Math.sin(since * 50) : 0;
        if (p.kind === 'kick') v.drum.scale.set(1 + squash, 1 + squash, 1);
        else v.drum.scale.set(1 + squash, 1, 1 + squash);
      }
      if (v.portMat) {
        if (color) v.portMat.emissive.copy(color);
        v.portMat.emissiveIntensity = 0.3 + 5 * pulse;
      }
      if (v.pivot) {
        const wobble = pulse > 0.001 ? 0.25 * pulse * Math.sin(since * 16) : 0;
        v.pivot.rotation.set(wobble * 0.6, 0, wobble);
        if (color) v.glowMat.emissive.copy(color);
        v.glowMat.emissiveIntensity = pulse * 0.5;
      }
    }
  }
}

/** Nombre de frappes antérieures ou égales à t. */
function upperHit(hits, t) {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
