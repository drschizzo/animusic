import * as THREE from 'three';
import { armAngles, hitPulse } from './drums.js';
import { mat } from './materials.js';
import { lathe, ringOf, rod, V } from './parts.js';

/** Boulon d'ancrage des colonnes. */
const anchorGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.01, 6);

/** Tête de vis des flasques d'articulation. */
const boltGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.006, 6);

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
 * Peau percée d'un évent : disque avec un vrai trou (toutes les passes de rendu le voient,
 * ombres et profondeur comprises). UV comme ceux d'un disque plein.
 * @param port [x, y, rayon] de l'évent
 */
function portedHeadGeometry(radius, [px, py, pr]) {
  const shape = new THREE.Shape().absarc(0, 0, radius, 0, Math.PI * 2, false);
  shape.holes.push(new THREE.Path().absarc(px, py, pr, 0, Math.PI * 2, true));
  const geo = new THREE.ShapeGeometry(shape, 64);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / (2 * radius) + 0.5, pos.getY(i) / (2 * radius) + 0.5);
  return geo;
}

/**
 * Peau qui vibre selon ses premiers modes propres (fondamental, puis modes à un et
 * deux diamètres nodaux orientés par le point de frappe), excitée à chaque coup.
 * Le déplacement et l'inclinaison des normales sont calculés dans le shader.
 *
 * @param shared uniformes d'une autre membrane : la pièce (cerclage d'évent collé sur la
 *   peau) suit exactement la même déformation
 */
function membrane(material, radius, angle, { shared = null } = {}) {
  const u = (material.userData.membrane = shared ?? {
    uAmp: { value: 0 },
    uSince: { value: 10 },
    uRadius: { value: radius },
    uAngle: { value: angle },
  });
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
        objectNormal = normalize(objectNormal + vec3(dx, dy, 0.0) * envN * 9.0);`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z -= uAmp * exp(-uSince * 7.0) * drumModes(position.xy, uSince);');
  };
  material.customProgramCacheKey = () => 'drum-membrane';
  // Déformée dans le repère de la peau : jamais fusionnée avec les pièces fixes.
  material.userData.freezable = false;
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
      // Cuivre martelé pour les fûts, laiton pour la caisse claire, érable pour les
      // cercles de la grosse caisse : les matières du reste de l'orchestre, pas la laque
      // rouge d'un kit de rock.
      copper: mat.hammered(),
      brass: mat.brass(),
      maple: mat.paleWood(),
      chrome: mat.chrome(),
      robot: mat.shell(),
      joint: mat.gunmetal(),
      rubber: mat.rubber(),
      stick: mat.paleWood(),
      collar: mat.steel(),
    });
    const lugGeo = new THREE.CapsuleGeometry(0.012, 0.05, 4, 8);

    this.views = kit.pieces.map((p) => {
      const v = { piece: p };
      const [x, y, z] = p.position;

      if (p.kind === 'drum' || p.kind === 'kick') {
        const R = p.radius;
        const kettle = p.kind === 'drum' && p.name !== 'snare';
        const headMat = membrane(mat.skin(), R * 0.985, p.armDir ? Math.atan2(p.armDir[1], p.armDir[0]) : 0);
        const head = new THREE.Mesh(headGeometry(R * 0.985), headMat);
        const hoopGeo = new THREE.TorusGeometry(R + 0.004, 0.016, 10, 56);
        const hoop = new THREE.Mesh(hoopGeo, m.chrome);
        const hoop2 = new THREE.Mesh(hoopGeo, m.chrome);
        const drum = new THREE.Group();
        head.receiveShadow = true;
        if (kettle) {
          // Tom : petite timbale, cuve de cuivre martelé sous la peau. Le pied s'emboîte
          // dans l'ouverture du fond.
          const d = p.depth;
          const bowl = lathe(
            [
              [0.03, -d],
              [R * 0.34, -d * 0.97],
              [R * 0.62, -d * 0.84],
              [R * 0.84, -d * 0.6],
              [R * 0.96, -d * 0.3],
              [R, -0.05],
              [R, 0],
            ],
            56,
            m.copper,
          );
          head.rotation.x = -Math.PI / 2;
          hoop.rotation.x = Math.PI / 2;
          // Tirants courts sous le cercle, là où la cuve est encore droite.
          const lugs = ringOf(6, R + 0.014, lugGeo, m.chrome, -0.045);
          drum.add(bowl, head, hoop, lugs);
          drum.position.set(x, y, z);
          stand(this.group, x, z, y - d, m.chrome, m.joint);
        } else if (p.kind === 'drum') {
          // Caisse claire : fût de laiton, deux cercles, tirants, déclencheur du timbre.
          const shell = new THREE.Mesh(new THREE.CylinderGeometry(R, R, p.depth, 56, 1, true), m.brass);
          shell.castShadow = shell.receiveShadow = true;
          shell.position.y = -p.depth / 2;
          head.rotation.x = -Math.PI / 2;
          hoop.rotation.x = hoop2.rotation.x = Math.PI / 2;
          hoop2.position.y = -p.depth;
          const lugs = ringOf(8, R + 0.014, lugGeo, m.chrome, -p.depth / 2);
          // Fond du fût : sombre, pour ne pas voir à travers.
          const bottom = new THREE.Mesh(new THREE.CircleGeometry(R * 0.985, 40), m.rubber);
          bottom.rotation.x = Math.PI / 2;
          bottom.position.y = -p.depth;
          // Déclencheur : boîtier posé contre le fût, entre deux tirants, côté opposé au bras.
          const step = Math.PI / 4; // un tirant tous les 45° : le boîtier se cale à mi-chemin
          const away = (Math.round((Math.atan2(p.armDir[1], p.armDir[0]) + Math.PI) / step - 0.5) + 0.5) * step;
          const strainer = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.05), m.chrome);
          strainer.position.set(Math.cos(away) * (R + 0.015), -p.depth / 2, Math.sin(away) * (R + 0.015));
          strainer.rotation.y = -away;
          strainer.castShadow = true;
          drum.add(shell, head, hoop, hoop2, lugs, bottom, strainer);
          drum.position.set(x, y, z);
          stand(this.group, x, z, y - p.depth, m.chrome, m.joint);
        } else {
          const shell = new THREE.Mesh(new THREE.CylinderGeometry(R, R, p.depth, 56, 1, true), m.copper);
          shell.castShadow = shell.receiveShadow = true;
          const lugs = ringOf(10, R + 0.014, lugGeo, m.chrome);
          // Cercles en érable, plus épais que ceux des autres fûts.
          const woodHoop = new THREE.TorusGeometry(R + 0.006, 0.022, 10, 56);
          hoop.geometry = hoop2.geometry = woodHoop;
          hoop.material = hoop2.material = m.maple;
          // Grosse caisse couchée, peaux vers ±z ; la peau arrière reçoit le batteur.
          shell.rotation.x = Math.PI / 2;
          lugs.rotation.x = Math.PI / 2;
          head.position.z = -p.depth / 2;
          head.rotation.y = Math.PI;
          hoop.position.z = -p.depth / 2;
          hoop2.position.z = p.depth / 2;
          // Peau avant (de résonance) : un vrai évent y est découpé. Elle vibre moins que
          // la peau frappée ; son cerclage chromé, collé dessus, suit la même déformation.
          const port = [R * 0.38, -R * 0.3, R * 0.26];
          const frontMat = membrane(mat.skin(), R * 0.985, 0);
          const front = new THREE.Mesh(portedHeadGeometry(R * 0.985, port), frontMat);
          front.position.z = p.depth / 2;
          const ringGeo = new THREE.TorusGeometry(port[2] + 0.008, 0.008, 8, 40);
          ringGeo.translate(port[0], port[1], 0);
          const portRing = new THREE.Mesh(ringGeo, membrane(mat.chrome(), R * 0.985, 0, { shared: frontMat.userData.membrane }));
          portRing.position.z = p.depth / 2 + 0.008;
          // Intérieur du fût, visible par l'évent : paroi et cloison sombres. La cloison
          // est à 6 cm de la peau frappée, hors de portée de sa vibration.
          const liner = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.97, R * 0.97, p.depth, 40, 1, true), new THREE.MeshStandardMaterial({ color: 0x0b0a09, roughness: 0.9, side: THREE.BackSide }));
          liner.rotation.x = Math.PI / 2;
          const baffle = new THREE.Mesh(new THREE.CircleGeometry(R * 0.97, 40), m.rubber);
          baffle.position.z = -p.depth / 2 + 0.06;
          drum.add(shell, head, hoop, hoop2, lugs, front, portRing, liner, baffle);
          drum.position.set(x, y, z);
          v.frontMat = frontMat;
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
        const cymbalMat = mat.cymbal();
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

    // Colonne + bras à deux segments ; articulations : moyeu serré entre deux colliers
    // d'acier, flasques boulonnés.
    const base = p.arm.base;
    const pillar = lathe(
      [
        [0.26, 0],
        [0.26, 0.035],
        [0.19, 0.035],
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
    // Bride de la colonne boulonnée au plateau : six têtes posées sur son rebord plat.
    const anchors = ringOf(6, 0.225, anchorGeo, m.chrome, 0.035 + 0.005);
    anchors.position.set(base[0], 0, base[2]);
    this.group.add(anchors);

    const jointRing = (radius) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.012, 8, 28), m.collar);
      const hubCap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius * 0.8, radius * 2.3, 20), m.joint);
      hubCap.rotation.x = Math.PI / 2;
      const group = new THREE.Group();
      const ring2 = ring.clone();
      ring.position.z = radius * 1.15;
      ring2.position.z = -radius * 1.15;
      hubCap.castShadow = true;
      group.add(hubCap, ring, ring2);
      // Six têtes de vis posées sur chaque flasque du moyeu.
      for (const side of [-1, 1]) {
        const bolts = ringOf(6, radius * 0.52, boltGeo, m.chrome);
        bolts.rotation.x = Math.PI / 2;
        bolts.position.z = side * (radius * 1.15 + 0.003);
        group.add(bolts);
      }
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
        // La peau prend la couleur de la piste à l'impact, sans blanchir.
        v.headMat.emissiveIntensity = pulse * 0.45;
        const mem = v.headMat.userData.membrane;
        if (mem) {
          // Seule la peau bouge (le fût ne se déforme pas) : 2 % du rayon au plus fort,
          // assez pour se voir, pas au point de faire une gelée.
          const h = p.hits[Math.max(0, upperHit(p.hits, t) - 1)];
          const s = Number.isFinite(since) ? since : 10;
          const amp = h ? 0.02 * p.radius * h.velocity : 0;
          mem.uSince.value = s;
          mem.uAmp.value = amp;
          const front = v.frontMat?.userData.membrane;
          if (front) {
            // La peau de résonance répond à l'air du fût : plus faiblement, un peu après.
            front.uSince.value = Math.max(0, s - 0.012);
            front.uAmp.value = s > 0.012 ? amp * 0.35 : 0;
            if (color) v.frontMat.emissive.copy(color);
            v.frontMat.emissiveIntensity = pulse * 0.2;
          }
        }
      }
      if (v.pivot) {
        // Une charleston fermée bouge à peine (ses deux cymbales sont à 2,5 cm l'une de
        // l'autre) ; une cymbale libre se balance franchement.
        const swing = p.name === 'hihat' ? 0.03 : 0.25;
        const wobble = pulse > 0.001 ? swing * pulse * Math.sin(since * 16) : 0;
        v.pivot.rotation.set(wobble * 0.6, 0, wobble);
        // La vibration se lit dans les reflets qui courent sur le bronze, pas dans une
        // lueur : une cymbale qui s'allume devient blanche.
        const lathe = v.glowMat.userData.lathe;
        lathe.uShimmer.value.set(Math.min(1, pulse * 1.4), since * 55);
        if (color) v.glowMat.emissive.copy(color);
        v.glowMat.emissiveIntensity = pulse * 0.08;
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
