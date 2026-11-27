// Réseau : une seule machine. Module pur (sans Three.js), en coordonnées de la scène.
//
// Derrière la tourelle du marimba part un réseau de tuyaux de verre posés au sol, tracé
// sur une grille comme un circuit imprimé : de longs tronçons droits, parallèles ou
// perpendiculaires au bord de scène, des coudes à angle droit, des faisceaux. Ils passent
// sous les billes du marimba, entre ses pieds, suivent les allées entre les estrades et
// plongent dans le sol au pied de celle de leur instrument (ou au plus près, si le
// passage est pris). Le tuyau en ressort par une colonne de verre plantée dans l'estrade, qui
// monte jusqu'à la rampe (alimentation) ou descend du collecteur (retour). Les billes y
// roulent à vitesse constante, en avance sur la musique : chacune arrive au bout de sa
// rampe juste à temps pour être tirée, si bien que le rythme d'un instrument se lit
// d'avance dans son tuyau.

import { polyline, fillet } from './ballistics.js';
import { lowerBound, upperBound, drain } from './util.js';
import { frameOf } from './passes.js';

export const TRUNK_DEFAULTS = {
  speed: 2, // vitesse des tapis (m/s)
  riserSpeed: 1.2, // vitesse de montée dans les colonnes de verre des estrades (vis d'Archimède)
  radius: 0.058, // demi-largeur du bâti d'un tapis
  beltWidth: 0.1, // largeur de la bande
  beltY: 0.13, // hauteur du dessus de la bande
  slack: 0.6, // avance (s) d'une bille sur sa porte : elle attend dans la file au bout du tapis
  gateSetback: 0.16, // la porte d'échappement est à cette distance du bout du tapis
  spacing: 2.2, // écart d'axe en axe de deux billes dans la file, en rayons
  paintAt: 0.36, // abscisse de la cabine de peinture le long d'un tapis d'alimentation
  paintLength: 0.26,
  grindAt: 0.17, // abscisse de la calibreuse (avant la peinture)
  rawScale: 1.15, // une bille brute est un peu trop grosse : la calibreuse la ramène à la bonne taille
  tankAhead: 0.07, // le bac de décapage est devant le bout du tapis de retour, sous l'arbre
  liftZ: 0.12, // colonne de la vis qui sort les billes du bac (en avant du bout du tapis)
  liftTop: 0.78, // haut de cette colonne
  stackBase: 0.26, // bas de la colonne de réserve, au-dessus du distributeur
  stackTop: 0.66,
  cell: 0.16, // pas de la grille au sol : deux tapis voisins sont à 16 cm d'axe en axe
  margin: 0.11, // distance minimale de l'axe d'un tuyau à un obstacle
  manifold: 2.6, // les lignes partent alignées à cette distance derrière l'axe de la tourelle
  pitch: 2, // écart entre deux départs, en cases
  shaftAhead: 0.2, // l'arbre de transmission court à cette distance devant la rangée des départs
  shaftY: 0.4, // hauteur de l'arbre
  shaftSpin: 2, // tours par seconde de l'arbre et du volant
  lead: 4, // longueur (en cases) du tronçon droit de départ (distributeur, cabine de peinture)
  turnCost: 14, // coût d'un coude, en cases : de longs tronçons droits, peu de coudes
  bundle: 0.3, // rabais d'une case le long d'un tuyau déjà posé : les lignes se rangent en faisceaux
  rounds: 4, // nombre maximal d'essais de tracé
  stepCost: 0.7, // poids de la distance restante (inférieur au coût minimal d'une case)
  reach: 0.25, // la ligne plonge à cette distance du bord de l'estrade
  hidden: 1.2, // durée (s) du trajet sous le sol, entre le labyrinthe et l'estrade
  drumHidden: 0.5,
};

/** Pseudo-aléatoire déterministe (0..1) : le même labyrinthe à chaque fois. */
const hash = (a, b) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Lignes de l'ensemble : pour chaque instrument à rangée, une alimentation et un retour
 * (avec leurs colonnes, tracées par la rangée dans son repère) ; pour la batterie, une
 * alimentation par fût, dont le tuyau repose déjà au sol.
 */
function ports(ensemble, o) {
  const out = [];
  ensemble.instruments.forEach((ins, k) => {
    const f = frameOf(ins);
    const g = ins.footprint;
    const row = ins.model.row;
    // Pied de l'estrade, au droit du point local (x, z) : sur le bord avant, ou arrière si le point est derrière.
    const footOf = (x, z) => {
      const c = Math.cos(g.yaw);
      const s = Math.sin(g.yaw);
      const [wx, , wz] = f.toWorld([x, 0, z]);
      const lx = c * (wx - g.center[0]) - s * (wz - g.center[1]);
      const lz = (z >= 0 ? 1 : -1) * (g.halfD + o.reach);
      return [g.center[0] + c * lx + s * lz, g.center[1] - s * lx + c * lz];
    };
    if (row && g) {
      const W0 = row.loop[0][0];
      const along = (s) => Math.abs(s.station.hit[0] - W0) / o.speed;
      const base = { instrument: k, ballRadius: row.ballRadius };
      const [feedFoot, backFoot] = [row.risers.feed[0], row.risers.back[row.risers.back.length - 1]];
      // Arrivée : à temps pour parcourir la rampe jusqu'à la buse ; départ : une fois le collecteur parcouru.
      out.push({ ...base, kind: 'feed', foot: footOf(feedFoot[0], feedFoot[2]), riser: polyline(row.risers.feed.map(f.toWorld)), shots: () => row.shots.map((s) => ({ time: s.time - s.station.before - along(s) - 0.03, track: s.track })) });
      out.push({ ...base, kind: 'back', foot: footOf(backFoot[0], backFoot[2]), riser: polyline(row.risers.back.map(f.toWorld)), shots: () => row.shots.map((s) => ({ time: s.time + (s.hold ?? 0) + s.station.after + along(s) + 0.03, track: s.track })) });
    } else if (ins.kind === 'drums' && ins.model.player === 'balls' && g) {
      // Batterie : une seule ligne pour tout le kit (les tuyaux des fûts reposent déjà sur l'estrade),
      // où passent les billes de tous les fûts.
      const kit = ins.model;
      out.push({ instrument: k, kit: true, kind: 'feed', foot: footOf(g.center[0], 1), ballRadius: kit.options.ballRadius, riser: null, shots: () => kit.shots.map((s) => ({ time: s.time - s.station.before - o.drumHidden, track: s.track })) });
    }
  });
  return out;
}

/** Obstacles au sol de l'ensemble, peints sur une grille : estrades, tourelle, pieds et tubes du marimba. */
export function floorGrid(ensemble, o) {
  const cell = o.cell;
  // Pas plus loin que l'estrade la plus éloignée (et jamais hors de la scène).
  const reach = Math.max(8, ...ensemble.instruments.filter((i) => i.footprint).map((i) => Math.hypot(...i.footprint.center) + Math.hypot(i.footprint.halfW, i.footprint.halfD) + 1.5));
  const half = Math.ceil(Math.min(ensemble.stageRadius - 0.6, reach) / cell);
  const size = 2 * half + 1;
  const blocked = new Uint8Array(size * size);
  const index = (i, j) => (j + half) * size + (i + half);
  const inside = (i, j) => Math.abs(i) <= half && Math.abs(j) <= half && Math.hypot(i, j) <= half;
  const toCell = (x, z) => [Math.round(x / cell), Math.round(z / cell)];
  const disc = (x, z, r) => {
    const [ci, cj] = toCell(x, z);
    const n = Math.ceil(r / cell) + 1;
    for (let i = ci - n; i <= ci + n; i++) for (let j = cj - n; j <= cj + n; j++) if (inside(i, j) && Math.hypot(i * cell - x, j * cell - z) <= r) blocked[index(i, j)] = 1;
  };
  for (const ins of ensemble.instruments) {
    const g = ins.footprint;
    if (g) {
      // Estrade : tout son encombrement déclaré, et une marge d'un demi-tuyau.
      const c = Math.cos(g.yaw);
      const s = Math.sin(g.yaw);
      const reach = Math.ceil((Math.hypot(g.halfW, g.halfD) + 0.3) / cell);
      const [ci, cj] = toCell(g.center[0], g.center[1]);
      for (let i = ci - reach; i <= ci + reach; i++)
        for (let j = cj - reach; j <= cj + reach; j++) {
          const dx = i * cell - g.center[0];
          const dz = j * cell - g.center[1];
          if (inside(i, j) && Math.abs(c * dx - s * dz) <= g.halfW + o.margin && Math.abs(s * dx + c * dz) <= g.halfD + o.margin) blocked[index(i, j)] = 1;
        }
    } else if (ins.kind === 'balls') {
      const ch = ins.model;
      const co = ch.options;
      disc(0, 0, co.launcherRadius + 0.62 + 0.2); // plateau de la tourelle
      if (ch.bars.length) {
        // Pieds du châssis des lames, sur ses deux rails.
        const span = ch.arc / 2 + 0.06;
        const legs = Math.max(2, Math.round((2 * span * ch.radius) / 2.6));
        for (let i = 0; i <= legs; i++) {
          const a = -span + (2 * span * i) / legs;
          for (const r of [ch.radius - 0.3, ch.radius + 0.3]) disc(Math.sin(a) * r, -Math.cos(a) * r, 0.1 + o.margin);
        }
        // Résonateurs des lames graves : ils descendent presque jusqu'au sol.
        for (const bar of ch.bars) if (0.028 + 0.65 * bar.u < o.beltY + 0.15) disc(bar.position[0], bar.position[2], bar.width * 0.37 + o.margin);
      }
      for (const path of ch.returns ?? []) {
        if (!ch.balls.length) break;
        // Pieds de la gouttière, entonnoir et son trépied, tube de retour au sol, chargeur.
        for (let i = 0; i <= path.troughSteps - 3; i += Math.max(4, Math.round(path.troughSteps / 6))) disc(path.points[i][0], path.points[i][2], 0.08 + o.margin);
        disc(path.funnel.x, path.funnel.z, 0.8 + o.margin);
        for (let i = path.tubeStart; i < path.points.length; i++) disc(path.points[i][0], path.points[i][2], 0.12 + o.margin);
        for (let k = path.tubeStart + 1; k < path.points.length; k++) {
          const [a, b] = [path.points[k - 1], path.points[k]];
          const n = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / (cell / 2));
          for (let q = 0; q <= n; q++) disc(a[0] + ((b[0] - a[0]) * q) / n, a[2] + ((b[2] - a[2]) * q) / n, 0.12 + o.margin);
        }
        disc(path.loader.x, path.loader.z, path.loader.radius + 0.1 + o.margin);
      }
    }
  }
  return { cell, half, size, blocked, index, inside, toCell };
}

/** Case libre la plus proche de (x, z), dans un rayon de quelques cases. */
function freeCell(grid, x, z) {
  const [ci, cj] = grid.toCell(x, z);
  let best = null;
  for (let i = ci - 6; i <= ci + 6; i++)
    for (let j = cj - 6; j <= cj + 6; j++) {
      if (!grid.inside(i, j) || grid.blocked[grid.index(i, j)]) continue;
      const d = Math.hypot(i * grid.cell - x, j * grid.cell - z);
      if (!best || d < best.d) best = { i, j, d };
    }
  return best;
}

/**
 * Chemin d'une case à une autre sur la grille, par pas d'une case le long de x ou de z
 * (A* sur les états case × direction). Un coude coûte cher : le chemin est fait de longs
 * tronçons droits. Longer un tuyau déjà posé coûte un peu moins : les lignes qui vont au
 * même endroit se rangent en faisceau, comme les pistes d'un circuit imprimé.
 * @param heading direction imposée au départ (indice dans STEPS), ou −1
 */
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // vers la droite, la gauche, le public, le fond de scène
function route(grid, from, to, heading, pipes, o) {
  const { size, half, blocked, index } = grid;
  const n = size * size;
  const goal = index(to.i, to.j);
  const cost = new Float32Array(n * 4).fill(Infinity);
  const prev = new Int32Array(n * 4).fill(-1);
  const heap = [];
  const push = (item) => {
    heap.push(item);
    for (let q = heap.length - 1; q > 0; ) {
      const parent = (q - 1) >> 1;
      if (heap[parent][0] <= heap[q][0]) break;
      [heap[parent], heap[q]] = [heap[q], heap[parent]];
      q = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let q = 0; ; ) {
        let m = q;
        for (const c of [2 * q + 1, 2 * q + 2]) if (c < heap.length && heap[c][0] < heap[m][0]) m = c;
        if (m === q) break;
        [heap[m], heap[q]] = [heap[q], heap[m]];
        q = m;
      }
    }
    return top;
  };
  const ahead = (i, j) => (Math.abs(i - to.i) + Math.abs(j - to.j)) * o.stepCost;
  const start = index(from.i, from.j);
  for (let d = 0; d < 4; d++) {
    if (heading >= 0 && d !== heading) continue;
    cost[start * 4 + d] = 0;
    push([0, start * 4 + d]);
  }
  let end = -1;
  let nearest = Infinity;
  let fallback = -1;
  while (heap.length) {
    const [f, state] = pop();
    const at = state >> 2;
    const dir = state & 3;
    const i = (at % size) - half;
    const j = Math.floor(at / size) - half;
    if (f > cost[state] + ahead(i, j) + 1e-4) continue; // entrée périmée
    if (at === goal) {
      end = state;
      break;
    }
    // Arrivée hors d'atteinte : on retiendra la case atteinte la plus proche de l'instrument.
    const away = Math.hypot(i - to.i, j - to.j);
    if (away < nearest) {
      nearest = away;
      fallback = state;
    }
    for (let d = 0; d < 4; d++) {
      if ((d ^ 1) === dir) continue; // pas de demi-tour sur place
      const ni = i + STEPS[d][0];
      const nj = j + STEPS[d][1];
      if (!grid.inside(ni, nj)) continue;
      const next = index(ni, nj);
      if (blocked[next] && next !== goal) continue;
      // Voisine d'un tuyau, de part ou d'autre du sens de marche : pas moins cher.
      const [a, b] = d < 2 ? [[ni, nj + 1], [ni, nj - 1]] : [[ni + 1, nj], [ni - 1, nj]];
      const beside = (grid.inside(a[0], a[1]) && pipes[index(a[0], a[1])]) || (grid.inside(b[0], b[1]) && pipes[index(b[0], b[1])]) ? o.bundle : 0;
      const c = cost[state] + 1 - beside + (d !== dir ? o.turnCost : 0);
      const ns = next * 4 + d;
      if (c >= cost[ns]) continue;
      cost[ns] = c;
      prev[ns] = state;
      push([c + ahead(ni, nj), ns]);
    }
  }
  if (end < 0) end = fallback;
  if (end < 0) return null;
  const cells = [];
  for (let state = end; state >= 0; state = prev[state]) cells.push([((state >> 2) % size) - half, Math.floor((state >> 2) / size) - half]);
  return cells.reverse();
}

/** Tracé d'une ligne : ses tronçons droits, de la tourelle au pied de l'estrade, à hauteur de la bande. */
function trace(cells, grid, o) {
  // Seuls les coins comptent : les cases alignées forment un tronçon droit.
  const corners = cells.filter((c, q) => q === 0 || q === cells.length - 1 || (c[0] - cells[q - 1][0]) * (cells[q + 1][1] - c[1]) !== (c[1] - cells[q - 1][1]) * (cells[q + 1][0] - c[0]));
  const at = ([i, j]) => [i * grid.cell, o.beltY, j * grid.cell];
  return { points: smoothJoints(corners.map((c) => at(c)), Math.min(0.07, o.cell * 0.42)), turns: corners.length - 2 };
}

/** Arrondit les coudes d'une polyligne. */
function smoothJoints(points, radius) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [A, B, C] = [out[out.length - 1], points[i], points[i + 1]];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const w = [C[0] - B[0], C[1] - B[1], C[2] - B[2]];
    const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w) || 1);
    if (cos > 0.9) out.push(B);
    else out.push(...fillet([A, B, C], radius, 0.025).slice(1, -1));
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Un essai de tracé, dans l'ordre donné. Chaque ligne commence par un tronçon droit vers
 * le fond de scène, réservé d'avance : aucune ne peut boucher la sortie de sa voisine.
 * @returns les lignes tracées (avec leurs cases), et une note : le nombre de lignes
 *   arrivées au pied de leur estrade, puis la brièveté de l'ensemble
 */
function* layoutSteps(ensemble, order, sequence, o) {
  const grid = floorGrid(ensemble, o);
  const pipes = new Uint8Array(grid.blocked.length); // cases occupées par un tuyau
  const mark = (cells) => {
    for (const [i, j] of cells) grid.blocked[grid.index(i, j)] = pipes[grid.index(i, j)] = 1;
  };
  // Départs : alignés derrière la tourelle, dans l'ordre des arrivées (de gauche à droite).
  const j0 = -Math.round(o.manifold / o.cell);
  const hubs = order.map((_, k) => Math.round((k - (order.length - 1) / 2) * o.pitch));
  const engine = hubs.length ? placeEngine(grid, Math.min(...hubs), Math.max(...hubs), j0, o) : null;
  const stubs = new Map();
  order.forEach((l, k) => {
    const i = Math.round((k - (order.length - 1) / 2) * o.pitch);
    const stub = Array.from({ length: o.lead + 1 }, (_, q) => [i, j0 - q]);
    if (stub.every(([a, b]) => grid.inside(a, b) && !grid.blocked[grid.index(a, b)])) stubs.set(l, stub);
    else o.debug?.(`départ bouché : ${ensemble.instruments[l.instrument].kind} ${l.kind}`);
  });
  for (const stub of stubs.values()) mark(stub);
  const lines = [];
  let arrived = 0;
  let length = 0;
  for (const l of sequence) {
    const stub = stubs.get(l);
    const to = stub && freeCell(grid, l.foot[0], l.foot[1]);
    const tip = stub?.[stub.length - 1];
    const rest = to && route(grid, { i: tip[0], j: tip[1] }, to, 3, pipes, o);
    if (!rest || rest.length < 2) continue;
    mark(rest);
    const end = rest[rest.length - 1];
    const ok = end[0] === to.i && end[1] === to.j;
    if (ok) arrived++;
    length += rest.length;
    lines.push({ ...l, port: l, cells: [...stub.slice(0, -1), ...rest], arrived: ok });
    yield;
  }
  return { lines, grid, pipes, engine, score: arrived * 1e6 - length };
}

/**
 * Salle des machines : un arbre de transmission court le long de la rangée des départs,
 * côté tourelle, et entraîne par courroie la tête de chaque tapis ; à l'un de ses bouts,
 * une machine à vapeur (volant, bielle, cylindre, régulateur à boules) le fait tourner.
 * Les cases occupées sont réservées avant le tracé des lignes.
 * @returns null si la place manque (les tapis tournent alors sans arbre visible)
 */
function placeEngine(grid, iMin, iMax, j0, o) {
  const cell = o.cell;
  const cells = (x0, x1, z0, z1) => {
    const out = [];
    for (let i = Math.floor(x0 / cell); i <= Math.ceil(x1 / cell); i++)
      for (let j = Math.floor(z0 / cell); j <= Math.ceil(z1 / cell); j++) if (Math.abs(i * cell - (x0 + x1) / 2) <= (x1 - x0) / 2 + cell / 2 && Math.abs(j * cell - (z0 + z1) / 2) <= (z1 - z0) / 2 + cell / 2) out.push([i, j]);
    return out;
  };
  const free = (list) => list.every(([i, j]) => grid.inside(i, j) && !grid.blocked[grid.index(i, j)]);
  const z0 = j0 * cell;
  const z = z0 + o.shaftAhead;
  // L'arbre couvre juste la rangée (les poulies sont du côté +x de chaque tapis) ; ses chevalets se
  // logent entre deux départs, au bout de la rangée.
  const xa = iMin * cell - 0.06;
  const xb = iMax * cell + 0.12;
  const wide = iMax - iMin >= 2 * o.pitch;
  const supports = wide ? [(iMin + o.pitch / 2) * cell, (iMax - o.pitch / 2) * cell] : [xa - 0.05, xb + 0.05];
  // Bande de l'arbre (entre la rangée des départs et la tourelle) et ses deux chevalets.
  const strip = [];
  for (let i = wide ? iMin : iMin - 1; i <= iMax + (wide ? 0 : 1); i++) for (let j = j0 + 1; j <= j0 + 2; j++) strip.push([i, j]);
  if (!free(strip)) {
    o.debug?.('arbre de transmission : pas de place');
    return null;
  }
  // Machine à vapeur complète si la place le permet.
  const options = [
    ...[1, -1].flatMap((side) => [1, -1].map((dir) => ({ kind: 'steam', side, dir, u: [0.05, 0.55], z: [-0.4, 1.1] }))),
  ];
  for (const { kind, side, dir, u, z: zr } of options) {
    const xe = side > 0 ? xb : xa;
    const us = u.map((k) => xe + side * k);
    const zs = zr.map((k) => z + dir * k);
    const room = cells(Math.min(...us), Math.max(...us), Math.min(...zs), Math.max(...zs));
    if (!free(room)) {
      o.debug?.(`machine : pas de place (${kind}, côté ${side}, sens ${dir})`);
      continue;
    }
    for (const [i, j] of [...strip, ...room]) grid.blocked[grid.index(i, j)] = 1;
    return { kind, y: o.shaftY, z, z0, xa, xb, xe, side, dir, supports };
  }
  // Sinon un moteur électrique, posé devant l'arbre (côté tourelle) et relié à lui par une courroie.
  for (const di of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const i = Math.round((iMin + iMax) / 2) + di;
    const room = [[i, j0 + 3], [i + 1, j0 + 3]];
    if (i + 1 > iMax || !free(room)) continue;
    for (const [a, b] of [...strip, ...room]) grid.blocked[grid.index(a, b)] = 1;
    return { kind: 'motor', y: o.shaftY, z, z0, xa, xb, xe: xb, side: 1, dir: 1, supports, motor: [(i + 0.5) * cell, (j0 + 3) * cell] };
  }
  o.debug?.('moteur : pas de place');
  return null;
}

/**
 * Trace le réseau : chaque ligne part du pied de la tourelle et rejoint le pied de
 * l'estrade de son instrument, en contournant tout ce qui est posé au sol. Une case de
 * la grille ne sert qu'à une ligne : deux tuyaux ne se croisent ni ne se touchent jamais.
 * Les lignes les plus longues sont tracées d'abord ; une ligne sans chemin libre est abandonnée.
 */
export function planTrunks(ensemble, options = {}) {
  return drain(planTrunkSteps(ensemble, options));
}

/** Le même tracé, par étapes (voir `sliced` dans util.js) : une ligne à la fois. */
export function* planTrunkSteps(ensemble, options = {}) {
  const o = { ...TRUNK_DEFAULTS, ...options };
  const all = ports(ensemble, o).filter((l) => !o.only || o.only(ensemble.instruments[l.instrument], l));
  // Départs : alignés derrière la tourelle, dans l'ordre des arrivées (de gauche à droite).
  const order = [...all].sort((a, b) => Math.atan2(a.foot[0], -a.foot[1]) - Math.atan2(b.foot[0], -b.foot[1])); // foot = [x, z]
  const far = (l) => Math.hypot(...l.foot);
  // Un tuyau posé ne se franchit pas : l'ordre du tracé décide de qui passe. Tant qu'une ligne n'arrive pas au pied de son estrade, on
  // recommence en la traçant avant les autres, et on garde le meilleur essai.
  // Premier essai, des bords vers le centre : la ligne la plus à droite tourne la première, sa
  // voisine la contourne par l'extérieur, et ainsi de suite (idem à gauche).
  const edge = (l) => Math.min(order.indexOf(l), order.length - 1 - order.indexOf(l));
  let sequence = [...all].sort((a, b) => edge(a) - edge(b) || far(b) - far(a));
  let best = null;
  for (let round = 0; round < o.rounds; round++) {
    const attempt = yield* layoutSteps(ensemble, order, sequence, o);
    if (!best || attempt.score > best.score) best = attempt;
    const done = new Set(attempt.lines.filter((l) => l.arrived).map((l) => l.port));
    if (done.size === all.length) break;
    const late = sequence.filter((l) => !done.has(l));
    const next = [...late, ...sequence.filter((l) => done.has(l))];
    if (next.every((l, k) => l === sequence[k])) break; // même ordre : rien de nouveau à essayer
    sequence = next;
  }
  const { lines, grid, pipes, engine } = best;
  for (const l of lines) {
    const m = trace(l.cells, grid, o);
    // Alimentation : de la tourelle vers l'instrument ; retour : dans l'autre sens. La bande
    // avance toujours dans le sens de l'abscisse.
    l.maze = polyline(l.kind === 'feed' ? m.points : m.points.reverse());
    l.turns = m.turns;
    l.balls = [];
    yield;
  }
  const segments = [];
  for (const l of lines) {
    if (!l.riser) continue;
    const pts = l.riser.points;
    for (let i = 3; i < pts.length; i += 3) {
      const a = pts[i - 3];
      const b = pts[Math.min(pts.length - 1, i)];
      segments.push({ a, b, min: [0, 1, 2].map((c) => Math.min(a[c], b[c])), max: [0, 1, 2].map((c) => Math.max(a[c], b[c])) });
    }
  }
  /** Vrai si un tuyau du réseau passe au point (x, z), à `r` près. */
  const occupied = (x, z, r = 0) => lines.some((l) => l.maze.points.some((p) => Math.hypot(p[0] - x, p[2] - z) <= r + 0.12));
  void pipes;
  return { options: o, lines, engine, dropped: all.length - lines.length, arrived: lines.filter((l) => l.arrived).length, segments, occupied };
}

/**
 * Horaires des billes du réseau, d'après les billes réellement tirées (à appeler après
 * le choix des passes). `ball.time` est l'instant où la bille arrive au bout de la rampe
 * (alimentation) ou quitte le bout du collecteur (retour). Deux billes d'une même ligne
 * ne se touchent pas.
 *
 * Alimentation : la bille, encore brute, tombe du distributeur sur le tapis (`born`), passe
 * dans la cabine de peinture, puis attend dans la file au bout du tapis, contre la porte
 * d'échappement, qui la lâche à l'instant `gate`. Retour : elle tombe du collecteur sur le
 * tapis et roule jusqu'à la tourelle.
 */
export function scheduleTrunks(trunks) {
  const o = trunks.options;
  for (const line of trunks.lines) {
    const gap = (2.4 * line.ballRadius) / o.speed;
    const balls = line.shots().sort((a, b) => a.time - b.time);
    if (line.kind === 'feed') for (let i = balls.length - 2; i >= 0; i--) balls[i].time = Math.min(balls[i].time, balls[i + 1].time - gap);
    else for (let i = 1; i < balls.length; i++) balls[i].time = Math.max(balls[i].time, balls[i - 1].time + gap);
    line.balls = balls;
    line.riserSpan = line.riser ? line.riser.length / o.riserSpeed : 0;
    line.hidden = line.riser ? o.hidden : 0; // sous le sol, entre le bout du tapis et la colonne
    line.mazeSpan = line.maze.length / o.speed;
    line.gateAt = Math.max(0.2, line.maze.length - o.gateSetback);
    line.paintAt = Math.min(o.paintAt, line.gateAt / 2);
    line.grindAt = Math.min(o.grindAt, line.paintAt / 2);
    if (line.kind === 'feed') {
      for (const b of balls) {
        b.gate = b.time - line.riserSpan - line.hidden;
        b.born = b.gate - line.gateAt / o.speed - o.slack;
      }
      line.before = line.riserSpan + line.hidden + line.gateAt / o.speed + o.slack;
      line.after = 0;
    } else {
      line.before = 0;
      line.after = line.riserSpan + line.hidden + line.mazeSpan;
    }
  }
  recycle(trunks);
  trunks.gates = trunks.lines.flatMap((l) => (l.kind === 'feed' ? l.balls.map((b) => b.gate) : [])).sort((a, b) => a - b);
  return trunks;
}

/** Pied d'une ligne à la rangée des départs (début d'une alimentation, bout d'un retour). */
export const hubOf = (line) => (line.kind === 'feed' ? line.maze.pointAt(0) : line.maze.pointAt(line.maze.length));

/**
 * Recyclage : au bout d'un tapis de retour, la bille tombe dans un bac de décapage, y
 * perd sa couleur en coulant, puis une vis la sort du bac et une goulotte de verre la
 * porte jusqu'à la colonne de réserve du distributeur voisin (l'alimentation du même
 * instrument). La réserve se lit dans la colonne : billes rentrées moins billes servies,
 * plus un stock de départ juste suffisant pour ne jamais manquer.
 */
function recycle(trunks) {
  const o = trunks.options;
  for (const back of trunks.lines) {
    if (back.kind !== 'back') continue;
    const [xr, , z0] = hubOf(back);
    const feed = trunks.lines.find((l) => l.kind === 'feed' && l.instrument === back.instrument && Math.abs(hubOf(l)[0] - xr) < 0.33 && Math.abs(hubOf(l)[2] - z0) < 0.01);
    if (!feed) continue;
    const r = back.ballRadius;
    const xf = hubOf(feed)[0];
    // Images clés du trajet : [position, durée depuis la précédente].
    const keys = [
      [[xr, o.beltY + r, z0], 0],
      [[xr, 0.1, z0 + o.tankAhead - 0.01], 0.12], // plongeon
      [[xr, 0.008 + r, z0 + o.tankAhead], 0.45], // elle coule en perdant sa couleur
      [[xr, 0.008 + r, z0 + o.liftZ], 0.1],
      [[xr, o.liftTop, z0 + o.liftZ], (o.liftTop - r) / o.riserSpeed], // vis
      [[xf, o.liftTop - 0.06, z0], Math.hypot(xf - xr, o.liftZ) / 1.2 + 0.05], // goulotte
      [[xf, o.stackTop, z0], 0.08],
    ];
    let acc = 0;
    back.recycle = keys.map(([p, d]) => ({ p, t: (acc += d) }));
    back.recycleSpan = acc;
    back.decap = [keys[1][1], keys[1][1] + keys[2][1]];
    back.pair = feed;
    feed.pair = back;
    back.after += acc;
    const tail = back.riserSpan + back.hidden + back.mazeSpan;
    // Réserve : arrivées et départs triés, stock de départ.
    const arrivals = back.balls.map((b) => b.time + tail + acc).sort((a, b) => a - b);
    const departures = feed.balls.map((b) => b.born);
    let need = 0;
    for (let i = 0, j = 0; i < departures.length; i++) {
      while (j < arrivals.length && arrivals[j] <= departures[i]) j++;
      need = Math.max(need, i + 1 - j);
    }
    feed.stock = { arrivals, departures, initial: need + 2, slots: Math.max(1, Math.floor((o.stackTop - o.stackBase) / (2 * o.rawScale * feed.ballRadius))) };
  }
}

/** Nombre de billes dans la colonne de réserve d'une alimentation à l'instant t. */
export function stockAt(line, t) {
  const s = line.stock;
  return s ? s.initial + upperBound(s.arrivals, t) - upperBound(s.departures, t) : 0;
}

/**
 * Billes visibles de la colonne de réserve (brutes, empilées) : emit(position). Quand le
 * distributeur en prend une par le bas, la pile descend d'un cran en un dixième de seconde.
 */
export function stackBalls(trunks, line, t, emit) {
  const s = line.stock;
  if (!s) return;
  const o = trunks.options;
  const [x, , z] = hubOf(line);
  const d = 2 * o.rawScale * line.ballRadius;
  const n = Math.min(s.slots, stockAt(line, t));
  const k = upperBound(s.departures, t) - 1;
  const drop = k >= 0 ? Math.max(0, 1 - (t - s.departures[k]) / 0.1) * d : 0;
  const p = [x, 0, z];
  for (let i = 0; i < n; i++) {
    p[1] = o.stackBase + d / 2 + i * d + drop;
    emit(p);
  }
}

/**
 * Pression du réservoir d'air (0..1) qui alimente les canons de la tourelle : chaque tir
 * en prend un peu, le compresseur la refait.
 */
export function airPressure(trunks, t) {
  const shots = trunks.shotTimes ?? [];
  let drawn = 0;
  for (let i = upperBound(shots, t) - 1; i >= 0 && t - shots[i] < 6; i--) drawn += 0.07 * Math.exp(-(t - shots[i]) / 1.5);
  return Math.max(0.15, 1 - drawn);
}

/**
 * Charge de la machine à l'instant t : somme des billes lâchées récemment par les portes,
 * chacune comptant de moins en moins. Le régulateur à boules s'affaisse quand elle monte,
 * puis se relève quand la machine reprend son souffle.
 */
export function engineLoad(trunks, t) {
  const g = trunks.gates ?? [];
  let load = 0;
  for (let i = upperBound(g, t) - 1; i >= 0 && t - g[i] < 3; i--) load += Math.exp(-(t - g[i]) / 0.6);
  return load;
}

/**
 * Billes d'une ligne à l'instant t. Pour chacune, appelle
 * `emit(ball, position, vitesse, peinture, surTapis, échelle)` (peinture : 1 aux couleurs de la
 * piste, 0 brute ; échelle : taille relative, plus grosse avant la calibreuse)
 * (les tableaux sont réutilisés d'un appel à l'autre). Sur un tapis d'alimentation, une
 * bille avance avec la bande tant que rien ne l'arrête ; arrêtée par la porte ou par la
 * bille de devant, elle glisse sur la bande (tapis d'accumulation) : la file se resserre
 * contre la porte, qui lâche ses billes une à une, chacune à son instant. Rien n'est
 * simulé : la position de chaque bille ne dépend que de t et de celle de devant.
 */
export function lineBalls(trunks, line, t, emit) {
  const o = trunks.options;
  const v = o.speed;
  const r = line.ballRadius;
  const balls = line.balls;
  const p = [0, 0, 0];
  const vel = [0, 0, 0];
  const onBelt = (x, moving) => {
    line.maze.pointAt(x, p);
    p[1] += r;
    const d = line.maze.tangentAt(x);
    for (let c = 0; c < 3; c++) vel[c] = moving ? d[c] * v : 0;
  };
  const inRiser = (s, sign) => {
    line.riser.pointAt(s, p);
    const d = line.riser.tangentAt(s);
    for (let c = 0; c < 3; c++) vel[c] = d[c] * o.riserSpeed * sign;
  };
  if (line.kind === 'feed') {
    const G = line.gateAt;
    const d = o.spacing * r;
    const lo = upperBound(balls, t, (b) => b.time);
    // La bille de devant (déjà passée) : elle a franchi la porte à vitesse de bande.
    let prevX = lo > 0 ? G + v * (t - balls[lo - 1].gate) : Infinity;
    let prevMoving = true;
    for (let i = lo; i < balls.length; i++) {
      const b = balls[i];
      if (t < b.born) break;
      let x;
      let moving;
      if (t >= b.gate) {
        x = G + v * (t - b.gate);
        moving = true;
      } else {
        const free = v * (t - b.born);
        x = Math.min(free, G, prevX - d);
        moving = x === free || (x === prevX - d && prevMoving && x < G);
      }
      prevX = x;
      prevMoving = moving;
      if (x <= line.maze.length) {
        onBelt(x, moving);
        emit(b, p, vel, x >= line.paintAt ? 1 : 0, true, x < line.grindAt ? o.rawScale : 1);
        continue;
      }
      // Passée la porte : sous le sol, puis dans la colonne de son instrument.
      const left = b.time - t;
      if (line.riser && left <= line.riserSpan) {
        inRiser(line.riser.length - o.riserSpeed * left, 1);
        emit(b, p, vel, 1, false, 1);
      }
    }
    return;
  }
  const lo = lowerBound(balls, t - line.after, (b) => b.time);
  for (let i = lo; i < balls.length; i++) {
    const b = balls[i];
    const since = t - b.time;
    if (since < 0) break;
    if (line.riser && since <= line.riserSpan) {
      inRiser(o.riserSpeed * since, 1);
      emit(b, p, vel, 1, false, 1);
      continue;
    }
    const x = v * (since - line.riserSpan - line.hidden);
    if (x < 0) continue;
    if (x <= line.maze.length) {
      onBelt(x, true);
      emit(b, p, vel, 1, true, 1);
      continue;
    }
    // Recyclage : bac de décapage, vis, goulotte (images clés, à vitesse constante entre deux).
    if (!line.recycle) continue;
    const u = since - line.riserSpan - line.hidden - line.mazeSpan;
    const keys = line.recycle;
    if (u >= keys[keys.length - 1].t) continue;
    let k = 1;
    while (keys[k].t < u) k++;
    const [A, B] = [keys[k - 1], keys[k]];
    const f = (u - A.t) / (B.t - A.t);
    for (let c = 0; c < 3; c++) {
      p[c] = A.p[c] + (B.p[c] - A.p[c]) * f;
      vel[c] = (B.p[c] - A.p[c]) / (B.t - A.t);
    }
    const [d0, d1] = line.decap;
    emit(b, p, vel, Math.min(1, Math.max(0, (d1 - u) / (d1 - d0))), false, 1);
  }
}

/** Ouverture (0..1) de la porte d'échappement d'un tapis d'alimentation à l'instant t. */
export function gateOpening(line, t) {
  const i = lowerBound(line.balls, t - 0.12, (b) => b.gate);
  let open = 0;
  for (let k = i; k < line.balls.length; k++) {
    const dt = t - line.balls[k].gate;
    if (dt < -0.05) break;
    // Le cliquet se lève juste avant le lâcher et retombe aussitôt la bille passée.
    open = Math.max(open, dt < 0 ? 1 + dt / 0.05 : Math.max(0, 1 - dt / 0.12));
  }
  return open;
}

/** Dernière bille peinte à l'instant t sur un tapis d'alimentation, et depuis combien de temps (s). */
export function lastPainted(trunks, line, t) {
  const tPaint = (b) => b.born + line.paintAt / trunks.options.speed;
  let lo = 0;
  let hi = line.balls.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tPaint(line.balls[m]) <= t) lo = m + 1;
    else hi = m;
  }
  if (!lo) return null;
  const b = line.balls[lo - 1];
  return { ball: b, since: t - tPaint(b) };
}

/** Distance d'un point aux colonnes de verre des instruments (au-delà de 1 m : simplement « loin »). */
export function trunkDistance(trunks, p) {
  let min = Infinity;
  for (const { a, b, min: lo, max: hi } of trunks.segments) {
    if (p[0] < lo[0] - 1 || p[0] > hi[0] + 1 || p[1] < lo[1] - 1 || p[1] > hi[1] + 1 || p[2] < lo[2] - 1 || p[2] > hi[2] + 1) continue;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1)));
    min = Math.min(min, Math.hypot(p[0] - a[0] - d[0] * u, p[1] - a[1] - d[1] * u, p[2] - a[2] - d[2] * u));
  }
  return min;
}
