// Réseau : une seule machine. Module pur (sans Three.js), en coordonnées de la scène.
//
// Du pied de la tourelle du marimba part un réseau de tuyaux de verre posés au sol, tracé
// comme un labyrinthe circulaire : des arcs concentriques et des segments radiaux, centrés
// sur la tourelle, rangés en faisceaux. Ils passent sous les billes du marimba, entre ses
// pieds, suivent les allées entre les gradins et plongent dans le sol au pied de l'estrade
// de leur instrument (ou au plus près, si le passage est pris). Le tuyau en ressort par une colonne de verre plantée dans l'estrade, qui
// monte jusqu'à la rampe (alimentation) ou descend du collecteur (retour). Les billes y
// roulent à vitesse constante, en avance sur la musique : chacune arrive au bout de sa
// rampe juste à temps pour être tirée, si bien que le rythme d'un instrument se lit
// d'avance dans son tuyau.

import { polyline, fillet } from './ballistics.js';
import { frameOf } from './passes.js';

export const TRUNK_DEFAULTS = {
  speed: 5, // vitesse des billes dans le réseau (m/s)
  radius: 0.058, // rayon extérieur des tuyaux
  axisY: 0.1, // hauteur de l'axe des tuyaux posés au sol
  cell: 0.16, // pas de la grille au sol : deux tuyaux voisins sont à 16 cm d'axe en axe
  margin: 0.11, // distance minimale de l'axe d'un tuyau à un obstacle
  ring: 2.6, // rayon du cercle des départs, au pied de la tourelle
  fan: 1.35, // demi-ouverture de l'éventail des départs (rad), vers le fond de scène
  pitch: 1.6, // écart entre deux départs, en cases
  lead: 3, // longueur (en cases) du tronçon radial de départ
  coarse: 1, // finesse angulaire : pas d'arc sur la couronne la plus grande, en cases
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
        for (const bar of ch.bars) if (0.028 + 0.65 * bar.u < o.axisY + o.radius + 0.1) disc(bar.position[0], bar.position[2], bar.width * 0.37 + o.margin);
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

/**
 * Grille polaire autour de la tourelle : des couronnes (rayon k·dr) et des rayons (angle
 * m·da, compté depuis le fond de scène, positif vers la droite). La scène est faite
 * d'anneaux (allées, gradins) : c'est dans ce repère que les tuyaux tracent des lignes
 * propres, des arcs le long des allées et des segments radiaux entre les estrades.
 */
function polarGrid(ensemble, o) {
  const floor = floorGrid(ensemble, { ...o, cell: o.cell / 2 });
  const nr = Math.floor((floor.half * floor.cell) / o.cell);
  const na = Math.round((2 * Math.PI * nr * o.cell) / (o.cell * o.coarse));
  const da = (2 * Math.PI) / na;
  const blocked = new Uint8Array(nr * na);
  const index = (k, m) => k * na + (((m % na) + na) % na);
  const world = (k, m) => [Math.sin(m * da) * k * o.cell, -Math.cos(m * da) * k * o.cell];
  for (let k = 0; k < nr; k++)
    for (let m = 0; m < na; m++) {
      const [x, z] = world(k, m);
      const [i, j] = floor.toCell(x, z);
      blocked[index(k, m)] = !floor.inside(i, j) || floor.blocked[floor.index(i, j)] ? 1 : 0;
    }
  const toCell = (x, z) => [Math.round(Math.hypot(x, z) / o.cell), Math.round(Math.atan2(x, -z) / da)];
  return { nr, na, da, dr: o.cell, blocked, index, world, toCell };
}

/** Case libre la plus proche de (x, z), dans un rayon de quelques cases. */
function freeCell(grid, x, z) {
  const [ck, cm] = grid.toCell(x, z);
  let best = null;
  const span = Math.ceil((6 * grid.dr) / Math.max(grid.dr, ck * grid.dr * grid.da));
  for (let k = Math.max(1, ck - 6); k <= Math.min(grid.nr - 1, ck + 6); k++)
    for (let m = cm - span; m <= cm + span; m++) {
      if (grid.blocked[grid.index(k, m)]) continue;
      const [wx, wz] = grid.world(k, m);
      const d = Math.hypot(wx - x, wz - z);
      if (d < 6 * grid.dr && (!best || d < best.d)) best = { k, m, d };
    }
  return best;
}

/**
 * Chemin d'une case à une autre sur la grille polaire : d'une couronne à la voisine le
 * long d'un rayon, ou d'un rayon au voisin le long d'une couronne (A* sur les états case
 * × direction). Un coude coûte cher : le chemin est fait de longs arcs et de longs
 * segments radiaux. Longer un tuyau déjà posé coûte un peu moins : les lignes qui vont au
 * même endroit se rangent en faisceau.
 * @param heading direction imposée au départ (indice dans STEPS), ou −1
 */
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // [couronne, rayon] : vers l'extérieur, l'intérieur, la droite, la gauche
function route(grid, from, to, heading, pipes, o) {
  const { nr, na, da, dr, blocked, index } = grid;
  const n = nr * na;
  const goal = index(to.k, to.m);
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
  const turn = (a) => Math.abs(((((a % na) + na + na / 2) % na) - na / 2));
  // Distance restante, en cases : l'écart de rayon, plus l'arc à parcourir sur la plus petite des deux couronnes.
  const ahead = (k, m) => (Math.abs(k - to.k) + turn(m - to.m) * da * Math.min(k, to.k)) * o.stepCost;
  const start = index(from.k, from.m);
  for (let d = 0; d < 4; d++) {
    if (heading >= 0 && d !== heading) continue;
    cost[start * 4 + d] = 0;
    push([0, start * 4 + d]);
  }
  const [tx, tz] = grid.world(to.k, to.m);
  let end = -1;
  let nearest = Infinity;
  let fallback = -1;
  while (heap.length) {
    const [f, state] = pop();
    const at = state >> 2;
    const dir = state & 3;
    const k = Math.floor(at / na);
    const m = at % na;
    if (f > cost[state] + ahead(k, m) + 1e-4) continue; // entrée périmée
    if (at === goal) {
      end = state;
      break;
    }
    // Arrivée hors d'atteinte : on retiendra la case atteinte la plus proche de l'instrument.
    const [x, z] = grid.world(k, m);
    const away = Math.hypot(x - tx, z - tz);
    if (away < nearest) {
      nearest = away;
      fallback = state;
    }
    for (let d = 0; d < 4; d++) {
      if ((d ^ 1) === dir) continue; // pas de demi-tour sur place
      const nk = k + STEPS[d][0];
      if (nk < 1 || nk >= nr) continue;
      const next = index(nk, m + STEPS[d][1]);
      if (blocked[next] && next !== goal) continue;
      const length = d < 2 ? 1 : nk * da; // un pas le long d'une couronne est d'autant plus long qu'elle est grande
      // Voisine d'un tuyau, de part ou d'autre du sens de marche : pas moins cher.
      const beside = d < 2 ? 0 : (nk + 1 < nr && pipes[index(nk + 1, m + STEPS[d][1])]) || pipes[index(nk - 1, m + STEPS[d][1])] ? o.bundle : 0;
      const c = cost[state] + length * (1 - beside) + (d !== dir ? o.turnCost : 0);
      const ns = next * 4 + d;
      if (c >= cost[ns]) continue;
      cost[ns] = c;
      prev[ns] = state;
      push([c + ahead(nk, (next % na)), ns]);
    }
  }
  if (end < 0) end = fallback;
  if (end < 0) return null;
  const cells = [];
  for (let state = end; state >= 0; state = prev[state]) cells.push([Math.floor((state >> 2) / na), (state >> 2) % na]);
  void dr;
  return cells.reverse();
}

/** Tracé d'une ligne : arcs et segments radiaux, de la tourelle au pied de l'estrade, entre deux plongées dans le sol. */
function trace(cells, grid, o) {
  const at = ([k, m], y = o.axisY) => {
    const [x, z] = grid.world(k, m);
    return [x, y, z];
  };
  // Les angles sont dépliés le long du chemin (le chemin peut faire le tour de la tourelle).
  const points = [at(cells[0], -0.14)];
  let turns = 0;
  for (let q = 0; q < cells.length; q++) {
    const c = cells[q];
    const before = cells[q - 1];
    const after = cells[q + 1];
    const radialIn = before && before[1] === c[1];
    const radialOut = after && after[1] === c[1];
    if (before && after && radialIn !== radialOut) turns++;
    // Segment radial : seuls ses bouts comptent ; arc : un point tous les 12 cm environ.
    const corner = !before || !after || radialIn !== radialOut;
    const stride = Math.max(1, Math.round(0.12 / Math.max(1e-6, c[0] * grid.dr * grid.da)));
    if (corner || (!radialIn && q % stride === 0)) points.push(at(c));
  }
  points.push(at(cells[cells.length - 1], -0.14));
  const ground = (c) => {
    const [x, z] = grid.world(c[0], c[1]);
    return [x, 0, z];
  };
  return { points: smoothJoints(points, Math.min(0.07, o.cell * 0.42)), ends: [ground(cells[0]), ground(cells[cells.length - 1])], turns };
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
function layout(ensemble, order, sequence, o) {
  const grid = polarGrid(ensemble, o);
  const pipes = new Uint8Array(grid.blocked.length); // cases occupées par un tuyau
  // Un tuyau occupe sa case, et sur sa couronne les cases trop proches pour un tuyau voisin.
  const mark = (cells) => {
    for (const [k, m] of cells) {
      const w = Math.max(0, Math.ceil(o.cell / (k * grid.dr * grid.da) - 1e-6) - 1);
      for (let q = -w; q <= w; q++) grid.blocked[grid.index(k, m + q)] = 1;
      pipes[grid.index(k, m)] = 1;
    }
  };
  // Départs : en éventail autour de la tourelle, à l'angle de leur instrument si la place le permet.
  const k0 = Math.round(o.ring / o.cell);
  const gap = (o.cell * o.pitch) / (k0 * o.cell); // écart angulaire minimal entre deux départs
  const angle = order.map((l) => Math.max(-o.fan, Math.min(o.fan, Math.atan2(l.foot[0], -l.foot[1]))));
  for (let i = 1; i < angle.length; i++) angle[i] = Math.max(angle[i], angle[i - 1] + gap);
  for (let i = angle.length - 2; i >= 0; i--) angle[i] = Math.min(angle[i], Math.min(o.fan + gap * (i - angle.length + 1) * 0 + o.fan, angle[i + 1] - gap));
  const stubs = new Map();
  order.forEach((l, i) => {
    const m = Math.round(angle[i] / grid.da);
    const stub = Array.from({ length: o.lead + 1 }, (_, q) => [k0 + q, m]);
    if (stub.every(([a, b]) => !grid.blocked[grid.index(a, b)])) stubs.set(l, stub);
    else o.debug?.(`départ bouché : ${ensemble.instruments[l.instrument].kind} ${l.kind}, angle ${angle[i].toFixed(2)}`);
  });
  for (const stub of stubs.values()) mark(stub);
  const lines = [];
  let arrived = 0;
  let length = 0;
  for (const l of sequence) {
    const stub = stubs.get(l);
    const to = stub && freeCell(grid, l.foot[0], l.foot[1]);
    const tip = stub?.[stub.length - 1];
    const rest = to && route(grid, { k: tip[0], m: tip[1] }, to, 0, pipes, o);
    if (!rest || rest.length < 2) continue;
    mark(rest);
    const end = rest[rest.length - 1];
    const ok = grid.index(end[0], end[1]) === grid.index(to.k, to.m);
    if (ok) arrived++;
    length += rest.length;
    lines.push({ ...l, port: l, cells: [...stub.slice(0, -1), ...rest], arrived: ok });
  }
  return { lines, grid, pipes, score: arrived * 1e6 - length };
}

/**
 * Trace le réseau : chaque ligne part du pied de la tourelle et rejoint le pied de
 * l'estrade de son instrument, en contournant tout ce qui est posé au sol. Une case de
 * la grille ne sert qu'à une ligne : deux tuyaux ne se croisent ni ne se touchent jamais.
 * Les lignes les plus longues sont tracées d'abord ; une ligne sans chemin libre est abandonnée.
 */
export function planTrunks(ensemble, options = {}) {
  const o = { ...TRUNK_DEFAULTS, ...options };
  const all = ports(ensemble, o).filter((l) => !o.only || o.only(ensemble.instruments[l.instrument], l));
  // Départs : alignés derrière la tourelle, dans l'ordre des arrivées (de gauche à droite).
  const order = [...all].sort((a, b) => Math.atan2(a.foot[0], -a.foot[1]) - Math.atan2(b.foot[0], -b.foot[1])); // foot = [x, z]
  const far = (l) => Math.hypot(...l.foot);
  // Un tuyau posé ne se franchit pas : l'ordre du tracé décide de qui passe. Tant qu'une ligne n'arrive pas au pied de son estrade, on
  // recommence en la traçant avant les autres, et on garde le meilleur essai.
  // Premier essai, des bords vers le centre : la ligne la plus à droite prend la couronne la plus
  // proche de la tourelle, sa voisine passe juste derrière, et ainsi de suite (idem à gauche).
  const edge = (l) => Math.min(order.indexOf(l), order.length - 1 - order.indexOf(l));
  let sequence = [...all].sort((a, b) => edge(a) - edge(b) || far(b) - far(a));
  let best = null;
  for (let round = 0; round < o.rounds; round++) {
    const attempt = layout(ensemble, order, sequence, o);
    if (!best || attempt.score > best.score) best = attempt;
    const done = new Set(attempt.lines.filter((l) => l.arrived).map((l) => l.port));
    if (done.size === all.length) break;
    const late = sequence.filter((l) => !done.has(l));
    const next = [...late, ...sequence.filter((l) => done.has(l))];
    if (next.every((l, k) => l === sequence[k])) break; // même ordre : rien de nouveau à essayer
    sequence = next;
  }
  const { lines, grid, pipes } = best;
  for (const l of lines) {
    const m = trace(l.cells, grid, o);
    // Alimentation : de la tourelle vers l'instrument ; retour : dans l'autre sens.
    l.maze = polyline(l.kind === 'feed' ? m.points : m.points.reverse());
    l.grommets = m.ends;
    l.turns = m.turns;
    l.balls = [];
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
  return { options: o, lines, dropped: all.length - lines.length, arrived: lines.filter((l) => l.arrived).length, segments, occupied };
}

/**
 * Horaires des billes du réseau, d'après les billes réellement tirées (à appeler après
 * le choix des passes). `ball.time` est l'instant où la bille arrive au bout de la rampe
 * (alimentation) ou quitte le bout du collecteur (retour). Deux billes d'une même ligne
 * ne se touchent pas.
 */
export function scheduleTrunks(trunks) {
  const o = trunks.options;
  for (const line of trunks.lines) {
    const gap = (2.4 * line.ballRadius) / o.speed;
    const balls = line.shots().sort((a, b) => a.time - b.time);
    if (line.kind === 'feed') for (let i = balls.length - 2; i >= 0; i--) balls[i].time = Math.min(balls[i].time, balls[i + 1].time - gap);
    else for (let i = 1; i < balls.length; i++) balls[i].time = Math.max(balls[i].time, balls[i - 1].time + gap);
    line.balls = balls;
    line.riserSpan = line.riser ? line.riser.length / o.speed : 0;
    line.mazeSpan = line.maze.length / o.speed;
    // Vie d'une bille autour de son instant de référence : [−before, +after].
    const total = line.riserSpan + (line.riser ? o.hidden : 0) + line.mazeSpan;
    line.before = line.kind === 'feed' ? total : 0;
    line.after = line.kind === 'feed' ? 0 : total;
  }
  return trunks;
}

/**
 * Position d'une bille du réseau à l'instant t : dans les lacets, ou dans la colonne de
 * son instrument. Renvoie false quand elle est sous le sol (ou hors de sa vie) ; sinon
 * écrit sa position dans `out` et sa direction dans `dir`.
 */
export function trunkBall(trunks, line, ball, t, out = [0, 0, 0], dir = null) {
  const v = trunks.options.speed;
  const gapT = line.riser ? trunks.options.hidden : 0;
  let path;
  let s;
  if (line.kind === 'feed') {
    const left = ball.time - t; // temps restant avant l'arrivée
    if (left < 0) return false;
    if (left <= line.riserSpan) {
      path = line.riser;
      s = path.length - v * left;
    } else {
      path = line.maze;
      s = path.length - v * (left - line.riserSpan - gapT);
    }
  } else {
    const since = t - ball.time;
    if (since < 0) return false;
    if (since <= line.riserSpan) {
      path = line.riser;
      s = v * since;
    } else {
      path = line.maze;
      s = v * (since - line.riserSpan - gapT);
    }
  }
  // Sous le sol : entre le labyrinthe et la colonne, et dans les plongées.
  if (!path || s < 0 || s > path.length) return false;
  path.pointAt(s, out);
  if (out[1] < trunks.options.axisY * 0.5 && path === line.maze) return false;
  if (dir) {
    const d = path.tangentAt(s);
    dir[0] = d[0];
    dir[1] = d[1];
    dir[2] = d[2];
  }
  return true;
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
