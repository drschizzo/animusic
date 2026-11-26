// Fusion des pièces fixes : un instrument compte des centaines de petites pièces
// (tiges, pieds, bagues, boulons) qui ne bougent jamais. Dessinées une à une, elles
// coûtent un appel de rendu chacune, à chaque passe (ombres, reflet du sol, sonde,
// image, tampon de profondeur). On les fusionne en un maillage par matériau.
//
// Une pièce est fixe si la vue ne garde aucune référence vers elle, vers l'un de ses
// parents (hors racine de la vue) ni vers son matériau : tout ce qu'une vue anime, elle
// le garde dans ses propriétés. Par sécurité, on vérifie aussi qu'elle n'a pas bougé
// pendant quelques poses d'essai.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Objets Three (maillages, groupes, matériaux) référencés par les propriétés d'une vue. */
function referenced(view) {
  const found = new Set();
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 6) return;
    seen.add(v);
    if (v.isObject3D || v.isMaterial) {
      found.add(v);
      return;
    }
    if (v.isColor || v.isVector3 || v.isMatrix4 || v.isQuaternion || ArrayBuffer.isView(v)) return;
    const values = Array.isArray(v) ? v : v instanceof Map ? [...v.values()] : Object.values(v);
    for (const x of values) walk(x, depth + 1);
  };
  for (const [key, value] of Object.entries(view)) {
    // Modèle et couleurs : données, pas d'objets de scène.
    if (key === 'model' || key === 'ch' || key === 'kit' || key === 'trackColors') continue;
    walk(value, 0);
  }
  return found;
}

/**
 * Fusionne les pièces fixes d'un instrument (sous `lift`), en coordonnées de `lift`.
 * @param view la vue (ses propriétés désignent les pièces animées)
 * @param root racine de la vue (fixe après construction)
 * @param probe(t) pose la vue à l'instant t (vérification d'immobilité)
 * @param times instants d'essai
 * @returns nombre de maillages fusionnés
 */
export function freezeStatic(lift, view, root, probe, times = []) {
  const refs = referenced(view);
  refs.delete(root);
  lift.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(lift.matrixWorld).invert();
  const local = (o) => new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);

  // Candidats : maillages ordinaires, ni effet ni objet transparent trié, ni shader maison.
  const candidates = [];
  lift.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.userData.fx || !o.visible) return;
    const m = o.material;
    if (Array.isArray(m) || m.isShaderMaterial || (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile && !m.userData.freezable)) return;
    if (o.name || o.renderOrder !== 0 || o.morphTargetInfluences || refs.has(m)) return; // pièce nommée : gardée telle quelle
    for (let p = o; p && p !== lift; p = p.parent) if (refs.has(p) || !p.visible) return;
    candidates.push({ o, m: local(o) });
  });
  // Immobiles pendant les poses d'essai.
  const moved = new Set();
  for (const t of times) {
    probe(t);
    lift.updateMatrixWorld(true);
    for (const c of candidates) if (!moved.has(c) && !local(c.o).equals(c.m)) moved.add(c);
  }
  probe(-1e6);
  lift.updateMatrixWorld(true);

  // Regroupement par matériau, ombres et jeu d'attributs.
  const groups = new Map();
  for (const c of candidates) {
    if (moved.has(c)) continue;
    const g = c.o.geometry;
    const attrs = Object.keys(g.attributes).sort().join(',');
    const key = `${c.o.material.uuid}|${c.o.castShadow}|${c.o.receiveShadow}|${c.o.layers.mask}|${attrs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const geos = list.map(({ o, m }) => {
      let g = o.geometry.clone();
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      for (const name of Object.keys(g.morphAttributes)) delete g.morphAttributes[name];
      g.applyMatrix4(m);
      return g;
    });
    const geometry = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!geometry) continue;
    const first = list[0].o;
    const mesh = new THREE.Mesh(geometry, first.material);
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.layers.mask = first.layers.mask;
    mesh.name = 'pièces fixes';
    lift.add(mesh);
    for (const { o } of list) o.removeFromParent();
    merged += list.length;
  }
  return merged;
}
