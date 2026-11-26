// Détecteur d'interpénétrations : construit la scène Three.js hors navigateur (mêmes
// vues que l'application) puis vérifie
//   1. qu'aucune bille ne traverse une pièce solide, sur tout son parcours (vol, rebond
//      vers la gouttière, gouttière, entonnoir, tube de retour) ;
//   2. qu'aucun instrument n'en chevauche un autre (boîtes englobantes de leurs pièces).
//
//   node tools/collide.mjs [fichier.mid ...]     (sans argument : morceau de démonstration)
//
// Code de sortie 1 s'il reste une collision.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as THREE from 'three';

// Les matériaux dessinent leurs textures dans des canvas : un faux canvas suffit ici.
globalThis.document ??= {
  createElement: () => ({
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
  }),
};

const { parseMidi, demoSong } = await import('../src/midi.js');
const { assignRoles, buildEnsemble, groupParts } = await import('../src/arranger.js');
const { ballPosition, ballScale } = await import('../src/choreography.js');
const { mountInstruments } = await import('../src/scene.js');

const CELL = 0.5;

/** Triangles monde des pièces solides d'un groupe, rangés dans une grille. */
function collectTriangles(root, label, grid, list) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.userData.fx || !o.visible) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    const name = `${label}/${o.name || g.type}@${fmt(new THREE.Vector3().setFromMatrixPosition(o.matrixWorld))}`;
    for (let i = 0; i < n; i += 3) {
      const tri = new THREE.Triangle();
      const ids = [0, 1, 2].map((k) => (idx ? idx.getX(i + k) : i + k));
      [tri.a, tri.b, tri.c].forEach((v, k) => v.fromBufferAttribute(pos, ids[k]).applyMatrix4(o.matrixWorld));
      const box = new THREE.Box3().setFromPoints([tri.a, tri.b, tri.c]);
      const entry = { tri, name, mesh: o };
      list.push(entry);
      for (let x = Math.floor(box.min.x / CELL); x <= Math.floor(box.max.x / CELL); x++)
        for (let y = Math.floor(box.min.y / CELL); y <= Math.floor(box.max.y / CELL); y++)
          for (let z = Math.floor(box.min.z / CELL); z <= Math.floor(box.max.z / CELL); z++) {
            const key = `${x},${y},${z}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(entry);
          }
    }
  });
}

const fmt = (v) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/** Triangle le plus profondément pénétré par la sphère (centre c, rayon r), ou null. */
function sphereHit(grid, c, r, skip) {
  let worst = null;
  const seen = new Set();
  for (let x = Math.floor((c.x - r) / CELL); x <= Math.floor((c.x + r) / CELL); x++)
    for (let y = Math.floor((c.y - r) / CELL); y <= Math.floor((c.y + r) / CELL); y++)
      for (let z = Math.floor((c.z - r) / CELL); z <= Math.floor((c.z + r) / CELL); z++) {
        for (const e of grid.get(`${x},${y},${z}`) ?? []) {
          if (seen.has(e) || skip?.(e)) continue;
          seen.add(e);
          e.tri.closestPointToPoint(c, _q);
          const d = _q.distanceTo(c);
          if (d < r && (!worst || d < worst.d)) worst = { d, e, q: _q.clone() };
        }
      }
  return worst;
}

function check(name, song) {
  const roles = assignRoles(song.tracks);
  song.tracks.forEach((t, i) => (t.role = roles[i]));
  const parts = groupParts(song.tracks);
  const controls = song.tracks.map((t) => ({ sustain: t.sustain, bends: t.bends, mod: t.mod }));
  const ens = buildEnsemble(parts, controls, song.tracks.map((t) => t.program ?? -1));
  const colors = song.tracks.map(() => new THREE.Color(1, 1, 1));
  const scene = new THREE.Group();
  const mounted = mountInstruments(ens, colors, scene);
  const views = ens.instruments.map((inst, k) => {
    const view = mounted.views[k];
    view.update(-100); // pose de repos
    return { inst, lift: mounted.lifts[k], view };
  });

  const problems = [];

  // 1. Billes contre pièces solides (canons exclus : la bille en sort).
  const balls = views.find((v) => v.inst.kind === 'balls');
  if (balls) {
    const grid = new Map();
    const list = [];
    for (const v of views) collectTriangles(v.lift, v.inst.kind, grid, list);
    const barrels = new Set();
    for (const part of balls.view.launcherParts) part.barrel.traverse((o) => barrels.add(o));
    const ch = balls.inst.model;
    const r0 = ch.options.ballRadius;
    const hits = new Map();
    const c = new THREE.Vector3();
    const tmp = [0, 0, 0];
    for (const b of ch.balls) {
      for (let t = b.launch; t <= b.end; t += 1 / 120) {
        const s = ballScale(b, t);
        if (s <= 0.05) continue;
        ballPosition(ch, b, t, tmp);
        c.set(...tmp);
        const near = t - b.launch < 0.25; // sortie du fût
        // Le chargeur est la destination : la bille y entre par son col.
        const home = b.path && t >= b.path.t0 && b.end - t < 0.3;
        const hit = sphereHit(grid, c, r0 * s * 0.97, (e) => barrels.has(e.mesh) || (near && e.name.includes('balls/')) || (home && e.name.includes('chargeur')));
        if (!hit) continue;
        const phase = t < b.impact ? 'vol' : b.path && t >= b.path.t0 ? 'retour' : 'saut vers la gouttière';
        const key = `${hit.e.name} [${phase}]`;
        const h = hits.get(key) ?? { count: 0, depth: 0, at: fmt(c) + " → " + fmt(hit.q), t };
        h.count++;
        h.depth = Math.max(h.depth, r0 * s - hit.d);
        hits.set(key, h);
      }
    }
    for (const [key, h] of hits) problems.push(`bille ↔ ${key} : ${h.count} échantillons, pénétration ${(h.depth * 100).toFixed(1)} cm, ex. t=${h.t.toFixed(2)} ${h.at}`);
  }

  // 2. Instruments entre eux : une surface de l'un passe-t-elle par une surface de
  // l'autre ? (points semés tous les 5 cm sur les triangles de l'un, distance à l'autre.)
  const solids = views.map((v) => {
    const grid = new Map();
    const list = [];
    collectTriangles(v.lift, v.inst.kind, grid, list);
    const box = new THREE.Box3();
    for (const e of list) box.expandByPoint(e.tri.a).expandByPoint(e.tri.b).expandByPoint(e.tri.c);
    return { grid, list, box };
  });
  const p = new THREE.Vector3();
  for (let a = 0; a < views.length; a++)
    for (let b = 0; b < views.length; b++) {
      if (a === b) continue;
      const A = solids[a];
      const B = solids[b];
      const zone = B.box.clone().expandByScalar(0.02);
      const found = new Map();
      for (const e of A.list) {
        const { a: v0, b: v1, c: v2 } = e.tri;
        if (!zone.intersectsBox(new THREE.Box3().setFromPoints([v0, v1, v2]))) continue;
        const L = Math.max(v0.distanceTo(v1), v1.distanceTo(v2), v2.distanceTo(v0));
        const n = Math.min(40, Math.max(1, Math.ceil(L / 0.05)));
        for (let i = 0; i <= n; i++)
          for (let j = 0; j <= n - i; j++) {
            const k = n - i - j;
            p.set(0, 0, 0).addScaledVector(v0, i / n).addScaledVector(v1, j / n).addScaledVector(v2, k / n);
            if (!zone.containsPoint(p)) continue;
            const hit = sphereHit(B.grid, p, 0.008);
            if (!hit) continue;
            const key = `${e.name} ↔ ${hit.e.name}`;
            if (!found.has(key)) found.set(key, fmt(p));
          }
      }
      if (b > a || !problems.some((x) => x.startsWith(`${views[b].inst.kind}#${b}`)))
        for (const [key, at] of found) problems.push(`${views[a].inst.kind}#${a} ↔ ${views[b].inst.kind}#${b} : ${key}, ex. ${at}`);
    }

  // 3. Encombrement déclaré (footprint, utilisé par le réalisateur) ≥ encombrement réel,
  // pièces mobiles comprises : vérifié au repos et à 40 instants répartis sur le morceau.
  const over = views.map(() => ({ w: 0, d: 0, h: 0 }));
  const measure = () =>
    views.forEach((v, k) => {
      const f = v.inst.footprint;
      if (!f) return;
      const c = Math.cos(f.yaw);
      const sn = Math.sin(f.yaw);
      v.lift.updateMatrixWorld(true);
      v.lift.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || o.userData.fx || !o.visible) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          const dx = p.x - f.center[0];
          const dz = p.z - f.center[1];
          // Repère de l'instrument : x le long de sa largeur, z vers le public.
          const lx = c * dx - sn * dz;
          const lz = sn * dx + c * dz;
          over[k].w = Math.max(over[k].w, Math.abs(lx) - f.halfW);
          over[k].d = Math.max(over[k].d, Math.abs(lz) - f.halfD);
          over[k].h = Math.max(over[k].h, p.y - f.top);
        }
      });
    });
  measure();
  for (let i = 0; i < 40; i++) {
    const t = ens.start + ((i + 0.5) / 40) * (ens.end - ens.start);
    for (const v of views) v.view.update(t);
    measure();
  }
  views.forEach((v, k) => {
    const e = over[k];
    if (e.w > 0.02 || e.d > 0.02 || e.h > 0.02)
      problems.push(`${v.inst.kind} dépasse son encombrement déclaré : largeur +${e.w.toFixed(2)}, profondeur +${e.d.toFixed(2)}, hauteur +${e.h.toFixed(2)} m`);
  });

  console.log(`\n== ${name} : ${ens.instruments.map((i) => i.kind).join(', ')}`);
  if (!problems.length) console.log('  aucune interpénétration');
  for (const p of problems) console.log(`  ✗ ${p}`);
  return problems.length;
}

const files = process.argv.slice(2);
let total = 0;
if (!files.length) total += check('démo', demoSong());
for (const file of files) {
  const buf = readFileSync(file);
  total += check(basename(file), parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), basename(file)));
}
process.exitCode = total ? 1 : 0;
