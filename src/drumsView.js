import * as THREE from 'three';
import { armAngles, hitPulse } from './drums.js';

/** Cylindre orienté le long de +x, de 0 à length (pour les segments de bras). */
function linkGeometry(length, r0, r1) {
  const g = new THREE.CylinderGeometry(r1, r0, length, 14);
  g.rotateZ(-Math.PI / 2);
  g.translate(length / 2, 0, 0);
  return g;
}

/** Rendu de la batterie robotisée ; posée à l'instant t par update(t). */
export class DrumKitView {
  constructor(kit, trackColors, parent) {
    this.kit = kit;
    this.trackColors = trackColors;
    this.group = new THREE.Group();
    parent.add(this.group);

    const m = (this.mats = {
      shell: new THREE.MeshStandardMaterial({ color: 0x8a1c2b, roughness: 0.25, metalness: 0.6 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.15, metalness: 1 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xd8a84a, roughness: 0.22, metalness: 1, side: THREE.DoubleSide }),
      robot: new THREE.MeshStandardMaterial({ color: 0xd9dde6, roughness: 0.35, metalness: 0.3 }),
      joint: new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.3, metalness: 0.9 }),
      stick: new THREE.MeshStandardMaterial({ color: 0xe0c08a, roughness: 0.6 }),
      block: new THREE.MeshStandardMaterial({ color: 0x5a3418, roughness: 0.5 }),
    });

    this.views = kit.pieces.map((p) => {
      const v = { piece: p };
      const [x, y, z] = p.position;

      if (p.kind === 'drum' || p.kind === 'kick') {
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, p.depth, 40, 1, true), m.shell);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xeeeae0, roughness: 0.7, emissive: 0x000000 });
        const head = new THREE.Mesh(new THREE.CircleGeometry(p.radius * 0.98, 40), headMat);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(p.radius, 0.018, 8, 40), m.chrome);
        const drum = new THREE.Group();
        shell.castShadow = true;
        if (p.kind === 'drum') {
          shell.position.y = -p.depth / 2;
          head.rotation.x = -Math.PI / 2;
          rim.rotation.x = Math.PI / 2;
          drum.add(shell, head, rim);
          drum.position.set(x, y, z);
          const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, y - p.depth, 8), m.chrome);
          stand.position.set(x, (y - p.depth) / 2, z);
          this.group.add(stand);
        } else {
          // Grosse caisse couchée, peaux vers ±z ; la peau arrière reçoit le batteur.
          shell.rotation.x = Math.PI / 2;
          head.position.z = -p.depth / 2;
          head.rotation.y = Math.PI;
          rim.position.z = -p.depth / 2;
          const front = new THREE.Mesh(new THREE.CircleGeometry(p.radius * 0.98, 40), headMat);
          front.position.z = p.depth / 2;
          const frontRim = rim.clone();
          frontRim.position.z = p.depth / 2;
          drum.add(shell, head, rim, front, frontRim);
          drum.position.set(x, y, z);
        }
        this.group.add(drum);
        v.drum = drum;
        v.headMat = headMat;
      } else if (p.kind === 'cymbal') {
        const pivot = new THREE.Group();
        pivot.position.set(x, y, z);
        const cymbal = new THREE.Mesh(new THREE.CylinderGeometry(0.03, p.radius, 0.04, 48, 1, true), m.brass);
        cymbal.castShadow = true;
        pivot.add(cymbal);
        if (p.name === 'hihat') {
          const lower = cymbal.clone();
          lower.rotation.x = Math.PI;
          lower.position.y = -0.06;
          this.group.add(lower);
          lower.position.add(pivot.position);
        }
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, y, 8), m.chrome);
        stand.position.set(x, y / 2, z);
        this.group.add(pivot, stand);
        v.pivot = pivot;
        v.glowMat = m.brass;
      } else {
        const headMat = new THREE.MeshStandardMaterial({ color: 0x5a3418, roughness: 0.5, emissive: 0x000000 });
        const block = new THREE.Mesh(new THREE.BoxGeometry(p.radius * 2, p.depth, p.radius), headMat);
        block.position.set(x, y - p.depth / 2, z);
        block.castShadow = true;
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, y - p.depth, 8), m.chrome);
        stand.position.set(x, (y - p.depth) / 2, z);
        this.group.add(block, stand);
        v.drum = block;
        v.headMat = headMat;
      }

      v.arm = this.buildArm(p);
      return v;
    });
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
      const rod = new THREE.Mesh(linkGeometry(links[0].length - 0.06, 0.015, 0.015), m.chrome);
      const felt = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), m.robot);
      felt.position.x = links[0].length - 0.06;
      beater.add(rod, felt);
      rootGroup.add(beater);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.4), m.joint);
      plate.position.set(root[0], 0.02, root[2] + 0.05);
      this.group.add(plate);
      return { segments: [beater] };
    }

    // Socle + bras à deux segments.
    const base = p.arm.base;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, root[1], 16), m.joint);
    pillar.position.set(base[0], root[1] / 2, base[2]);
    pillar.castShadow = true;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.06, 24), m.joint);
    foot.position.set(base[0], 0.03, base[2]);
    this.group.add(pillar, foot);

    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), m.joint);
    rootGroup.add(shoulder);

    const upper = new THREE.Group();
    const upperMesh = new THREE.Mesh(linkGeometry(links[0].length, 0.07, 0.05), m.robot);
    upperMesh.castShadow = true;
    upper.add(upperMesh);
    rootGroup.add(upper);

    const fore = new THREE.Group();
    fore.position.x = links[0].length;
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), m.joint);
    const metal = 0.4;
    const foreMesh = new THREE.Mesh(linkGeometry(metal, 0.05, 0.035), m.robot);
    const stick = new THREE.Mesh(linkGeometry(links[1].length - metal, 0.014, 0.009), m.stick);
    stick.position.x = metal;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 12), m.joint);
    grip.rotation.z = Math.PI / 2;
    grip.position.x = metal;
    foreMesh.castShadow = stick.castShadow = true;
    fore.add(elbow, foreMesh, grip, stick);
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
      if (v.headMat) {
        if (track >= 0) v.headMat.emissive.copy(this.trackColors[track]);
        v.headMat.emissiveIntensity = pulse * 0.9;
        const squash = pulse > 0.001 ? 0.03 * pulse * Math.sin(since * 50) : 0;
        if (p.kind === 'kick') v.drum.scale.set(1 + squash, 1 + squash, 1);
        else v.drum.scale.set(1 + squash, 1, 1 + squash);
      }
      if (v.pivot) {
        const wobble = pulse > 0.001 ? 0.25 * pulse * Math.sin(since * 16) : 0;
        v.pivot.rotation.set(wobble * 0.6, 0, wobble);
      }
    }
  }
}
