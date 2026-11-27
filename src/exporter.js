// Export glTF (.glb) de l'animation complète, pour Blender ou tout autre logiciel 3D.
//
// L'animation est « cuite » : la scène est posée image par image (comme à l'écran)
// et les transformations de chaque objet qui bouge sont enregistrées en images clés.
// Les billes, dessinées en instanciation à l'écran (non animable en glTF), sont
// remplacées le temps de l'export par une réserve de sphères par piste.
// La caméra du réalisateur est exportée aussi. Les éclats lumineux (émission)
// ne sont pas représentables en glTF standard et ne sont donc pas exportés.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { activeBallRange, ballPosition, ballScale } from './choreography.js';
import { BallsView } from './ballsView.js';
import { cameraAt } from './director.js';

const EPS = 1e-5;

/** Réserves de sphères par piste : chaque bille reçoit un emplacement libre pendant toute sa vie. */
function makeBallPools(view, trackColors, parent) {
  const ch = view.ch;
  const byTrack = new Map();
  ch.balls.forEach((b) => {
    if (!byTrack.has(b.track)) byTrack.set(b.track, []);
    byTrack.get(b.track).push(b);
  });
  const pools = [];
  for (const [track, balls] of byTrack) {
    // Attribution gloutonne (billes triées par tir) : un emplacement se libère à la fin d'une bille.
    const freeAt = [];
    const slots = balls.map((b) => {
      let k = freeAt.findIndex((end) => end < b.launch);
      if (k < 0) k = freeAt.push(0) - 1;
      freeAt[k] = b.end;
      return k;
    });
    const material = new THREE.MeshStandardMaterial({ color: trackColors[track], metalness: 1, roughness: 0.12 });
    const meshes = freeAt.map((_, k) => {
      const m = new THREE.Mesh(view.balls.geometry, material);
      m.name = `bille_piste${track}_${k}`;
      m.scale.setScalar(0);
      parent.add(m);
      return m;
    });
    pools.push({ balls, slots, meshes, maxLife: ch.maxLife });
  }
  return pools;
}

function poseBalls(ch, pools, t, tmp) {
  for (const { balls, slots, meshes, maxLife } of pools) {
    for (const m of meshes) m.scale.setScalar(0);
    const [s, e] = activeBallRange({ balls, maxLife }, t);
    for (let i = s; i < e; i++) {
      const b = balls[i];
      const sc = ballScale(b, t);
      if (sc <= 0) continue;
      const m = meshes[slots[i]];
      ballPosition(ch, b, t, tmp);
      m.position.set(tmp[0], tmp[1], tmp[2]);
      m.scale.setScalar(sc);
    }
  }
}

/**
 * @param stage la scène (scene.js), déjà construite
 * @param ensemble l'ensemble d'instruments (arranger.js)
 * @param plan les plans du réalisateur (director.js)
 * @param options { fps, trackColors, name, onProgress(fraction) }
 * @returns Promise<ArrayBuffer> fichier .glb
 */
export async function exportGLTF(stage, ensemble, plan, options) {
  const { fps = 30, trackColors, name = 'animusic', onProgress = () => {} } = options;
  const root = stage.content;
  const t0 = ensemble.start;
  const t1 = ensemble.end;
  const frames = Math.ceil((t1 - t0) * fps) + 1;

  // Préparation : billes en sphères, caméra animée.
  const ballsView = stage.views.find((v) => v instanceof BallsView);
  const pools = ballsView ? makeBallPools(ballsView, trackColors, root) : [];
  if (ballsView) ballsView.balls.visible = false;
  // Billes des stations (batterie à billes) : pas encore exportées ; masquées plutôt que figées en l'air.
  const stationBalls = [...stage.views.filter((v) => v.pool || v.rowView).map((v) => (v.pool ?? v.rowView.pool).balls), ...(stage.passView?.pools ?? []).map((p) => p.pool.balls), ...(stage.trunkView?.pools ?? []).map((p) => p.balls)];
  for (const b of stationBalls) b.visible = false;
  // Les purs effets lumineux (halos, étincelles, traînées, rayons) ne sont pas exportés.
  const effects = [];
  root.traverse((o) => o.userData.fx && o.visible && effects.push(o));
  const camera = new THREE.PerspectiveCamera(stage.camera.fov, 16 / 9, 0.1, 200);
  camera.name = 'camera_realisateur';
  root.add(camera);
  // Pièces instanciées (touches, marteaux…) : une pièce par instance, posée image par image
  // d'après la matrice de son instance. Le glTF animé ne connaît pas l'instanciation.
  const unfolded = [];
  root.traverse((o) => o.isInstancedMesh && o.userData.unfold && o.visible && unfolded.push(o));
  const proxies = unfolded.map((im) => {
    const geometry = im.geometry.clone();
    for (const name of Object.keys(geometry.attributes)) if (geometry.attributes[name].isInstancedBufferAttribute) geometry.deleteAttribute(name);
    const meshes = Array.from({ length: im.count }, () => {
      const m = new THREE.Mesh(geometry, im.material);
      im.parent.add(m);
      return m;
    });
    im.visible = false;
    return { im, geometry, meshes };
  });
  const instanceMatrix = new THREE.Matrix4();
  const lookTarget = new THREE.Vector3();
  const tmp = [0, 0, 0];
  const pose = (t) => {
    stage.update(t);
    for (const { im, meshes } of proxies)
      meshes.forEach((m, i) => {
        im.getMatrixAt(i, instanceMatrix);
        instanceMatrix.decompose(m.position, m.quaternion, m.scale);
      });
    for (const o of effects) o.visible = false;
    if (ballsView) poseBalls(ballsView.ch, pools, t, tmp);
    const cam = cameraAt(plan, t);
    camera.position.set(...cam.position);
    camera.lookAt(lookTarget.set(...cam.target));
  };

  // Noms lisibles dans Blender : préfixe de l'instrument (billes, batterie, basse, orgue).
  const LABELS = { balls: 'billes', drums: 'batterie', bass: 'basse', pads: 'orgue', bells: 'carillon', laser: 'harpe_laser', bowed: 'cordes_frottees', winds: 'vents', plucked: 'cordes_pincees', keys: 'clavier' };
  let counter = 0;
  stage.views.forEach((v, k) => {
    const viewRoot = v.group ?? v.content;
    const label = LABELS[ensemble.instruments[k].kind];
    viewRoot.name ||= label;
    viewRoot.traverse((o) => {
      if (!o.name) o.name = `${label}_${o.type === 'Mesh' ? 'piece' : 'pivot'}_${counter++}`;
    });
  });
  root.traverse((o) => {
    if (!o.name) o.name = `objet_${counter++}`;
  });

  // 1re passe (grossière) : quels objets, et quelles propriétés, bougent ?
  const objects = [];
  root.traverse((o) => o !== root && objects.push(o));
  const props = ['position', 'quaternion', 'scale'];
  pose(t0);
  const initial = objects.map((o) => props.map((p) => o[p].toArray()));
  const moving = objects.map(() => [false, false, false]);
  for (let t = t0; t <= t1; t += 0.1) {
    pose(t);
    objects.forEach((o, i) =>
      props.forEach((p, k) => {
        if (!moving[i][k] && o[p].toArray().some((v, c) => Math.abs(v - initial[i][k][c]) > EPS)) moving[i][k] = true;
      }),
    );
  }
  // Billes et caméra : toujours animées.
  for (const { meshes } of pools) for (const m of meshes) moving[objects.indexOf(m)] = [true, false, true];
  moving[objects.indexOf(camera)] = [true, true, false];

  // 2e passe : enregistrement image par image.
  const channels = [];
  objects.forEach((o, i) =>
    props.forEach((p, k) => {
      if (moving[i][k]) channels.push({ o, p, size: p === 'quaternion' ? 4 : 3, values: new Float32Array(frames * (p === 'quaternion' ? 4 : 3)) });
    }),
  );
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const t = t0 + f / fps;
    times[f] = f / fps;
    pose(t);
    for (const c of channels) c.o[c.p].toArray(c.values, f * c.size);
    if (f % 300 === 0) {
      onProgress(f / frames);
      await new Promise((r) => setTimeout(r)); // laisse respirer l'interface
    }
  }
  const tracks = channels.map((c) => {
    const Track = c.p === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    return new Track(`${c.o.uuid}.${c.p}`, times, c.values);
  });
  const clip = new THREE.AnimationClip(name, (frames - 1) / fps, tracks);

  // État de repos (aucun éclat) pour les matériaux exportés, puis export.
  pose(t0);
  root.userData.animusic = {
    morceau: name,
    fps,
    // Le son commence à t = 0 du morceau, soit après ce décalage dans l'animation.
    decalageAudioSecondes: -t0,
  };
  try {
    return await new GLTFExporter().parseAsync(root, { binary: true, animations: [clip] });
  } finally {
    // Remise en état de la scène affichée.
    delete root.userData.animusic;
    for (const { meshes } of pools) for (const m of meshes) root.remove(m);
    for (const { meshes } of pools) meshes[0]?.material.dispose();
    root.remove(camera);
    for (const { im, geometry, meshes } of proxies) {
      for (const m of meshes) m.removeFromParent();
      geometry.dispose();
      im.visible = true;
    }
    if (ballsView) ballsView.balls.visible = true;
    for (const b of stationBalls) b.visible = true;
    for (const o of effects) o.visible = true;
    onProgress(1);
  }
}
