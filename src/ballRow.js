// Rangée de stations de billes : module pur (sans Three.js).
//
// Pour les instruments faits d'une rangée de cibles verticales alignées le long de x
// (cloches tubulaires, cordes) : devant chaque cible, une buse crache la bille presque à
// l'horizontale, elle frappe la face avant (+z), rebondit vers l'avant et tombe dans un
// cornet. Toutes les buses sortent d'une même rampe, tous les cornets se vident dans un
// même collecteur, et les deux sont reliés par un coude : un seul circuit.
// Les trajectoires sont dans des plans x = constante, donc parallèles : deux billes de
// cibles voisines ne peuvent pas se croiser.

import { planStrike, buildStation, assignShots, maxConcurrent, fallTime, fillet, stationBall } from './ballistics.js';

export const ROW_DEFAULTS = {
  vIn: [0, -1.5, -3.2], // vitesse à l'impact : vers la cible, en descendant
  flightIn: 0.26,
  restitution: 0.55,
  drop: 0.75, // hauteur du cornet sous le point de frappe
  reach: 0.34, // longueur d'une buse ou d'un cornet, jusqu'à l'axe de son tuyau
  hide: 0.2, // la bille naît et disparaît à cette profondeur
  pipeRadius: 0.058,
  maxBall: 0.04,
  margin: 0.35, // débord de la rampe au-delà des cibles extrêmes
};

const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const along = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];

/**
 * @param targets [{ x, hits }] cibles, de gauche à droite
 * @param face { y, z } hauteur du point de frappe et position de la surface frappée
 * @param spacing écart entre deux cibles voisines
 * @returns stations (une par cible, avec ses frappes servies `shots`), toutes les billes
 *   triées (`shots`), le tuyau du circuit (`loop`), ses supports et son encombrement
 */
export function buildBallRow(targets, face, spacing, options = {}) {
  const o = { ...ROW_DEFAULTS, ...options };
  // Bille et cornet à la mesure de l'écart entre cibles : deux cornets voisins ne se touchent pas.
  const ballRadius = Math.min(o.maxBall, spacing * 0.3);
  const tubeRadius = ballRadius + 0.016;
  const hornRadius = Math.max(tubeRadius, Math.min(0.12, spacing / 2 - 0.004));
  const flightOut = fallTime(o.vIn[1], o.drop);
  const stations = targets.map((target) => {
    const strike = planStrike({ hit: [target.x, face.y, face.z + ballRadius], normal: [0, 0, 1], vIn: o.vIn, flightIn: o.flightIn, restitution: o.restitution, flightOut });
    const n = unit(strike.v0);
    const m = unit(strike.vCatch);
    const station = buildStation(strike, { ballRadius, feed: [along(strike.mouth, n, -o.reach), strike.mouth], drain: [strike.catch, along(strike.catch, m, o.reach)], hide: o.hide });
    station.shots = assignShots(station, target.hits);
    station.target = target;
    return station;
  });
  const shots = stations.flatMap((station, index) => station.shots.map((h) => ({ time: h.time, track: h.track, velocity: h.velocity, station, index }))).sort((a, b) => a.time - b.time);

  // Circuit : collecteur sous les cornets, coude et montée à droite, rampe des buses.
  const first = stations[0];
  const [, yc, zc] = first.drain.points[1];
  const [, ym, zm] = first.feed.points[0];
  const W0 = targets[0].x - o.margin;
  const W1 = targets[targets.length - 1].x + o.margin;
  const loop = fillet(
    [
      [W0, yc, zc],
      [W1, yc, zc],
      [W1, yc, zm],
      [W1, ym, zm],
      [W0, ym, zm],
    ],
    0.15,
  );
  const R = o.pipeRadius;
  return {
    options: o,
    ballRadius,
    tubeRadius,
    hornRadius,
    stations,
    shots,
    maxBalls: maxConcurrent(shots),
    before: first.before,
    after: first.after,
    loop,
    // Poteaux (du sol jusque sous le tuyau) et entretoise du collecteur, côté gauche.
    posts: [
      [W0, ym - R, zm],
      [W1, yc - R, zm],
    ],
    strut: [
      [W0, yc, zm],
      [W0, yc, zc],
    ],
    extent: { minX: W0 - R, maxX: W1 + R, maxZ: zm + R, top: Math.max(ym, first.mouth[1]) + R + 0.05 },
  };
}

// --- Coupelles : notes tenues ---------------------------------------------------------
//
// Une bille ne peut pas tenir un son : elle tombe dans une coupelle montée sur un
// poussoir, son poids l'enfonce et ouvre la soupape (ou l'iris, ou la valve) de la note ;
// à la fin de la note le poussoir remonte d'un coup sec et éjecte la bille vers un
// cornet. Même circuit que les rangées à rebond : rampe de buses, collecteur de cornets.

export const CUP_DEFAULTS = {
  ...ROW_DEFAULTS,
  vIn: [0, -4, -0.8], // arrivée presque verticale dans la coupelle
  flightIn: 0.3,
  vExit: [0, 1.2, 0.9], // éjection : petit saut vers le cornet
  drop: 0.45,
  cupTravel: 0.035, // course du poussoir
  minGap: 0.24, // écart minimal entre deux billes d'une même coupelle
  exitMargin: 0.16, // la bille précédente est éjectée au moins ce délai avant la suivante
  minHold: 0.05,
};

/**
 * @param targets [{ x, notes: [{ start, end, velocity, track }] }] cibles, de gauche à droite
 * @param place { y, z } centre de la bille posée dans la coupelle ; sign = −1 : rangée
 *   derrière l'instrument (buses et cornets du côté −z)
 */
export function buildCupRow(targets, place, spacing, options = {}) {
  const o = { ...CUP_DEFAULTS, ...options };
  const sign = o.sign ?? 1;
  const ballRadius = Math.min(o.maxBall, spacing * 0.3);
  const tubeRadius = ballRadius + 0.016;
  const hornRadius = Math.max(tubeRadius, Math.min(0.12, spacing / 2 - 0.004));
  const vIn = [0, o.vIn[1], o.vIn[2] * sign];
  const vOut = [0, o.vExit[1], o.vExit[2] * sign];
  const lift = 0.4 * o.cupTravel;
  const flightOut = fallTime(vOut[1], o.drop + lift);
  const T = o.flightIn;
  const stations = targets.map((target) => {
    const hit = [target.x, place.y, place.z];
    const v0 = [vIn[0], vIn[1] + 9.8 * T, vIn[2]];
    const mouth = [hit[0] - v0[0] * T, hit[1] - v0[1] * T + 4.9 * T * T, hit[2] - v0[2] * T];
    const out0 = [hit[0], hit[1] + lift, hit[2]];
    const caught = [out0[0], out0[1] + vOut[1] * flightOut - 4.9 * flightOut * flightOut, out0[2] + vOut[2] * flightOut];
    const strike = { hit, normal: [0, 1, 0], vIn, v0, mouth, vOut, catch: caught, vCatch: [0, vOut[1] - 9.8 * flightOut, vOut[2]], flightIn: T, flightOut, restitution: 0 };
    const n = unit(strike.v0);
    const m = unit(strike.vCatch);
    const station = buildStation(strike, { ballRadius, feed: [along(mouth, n, -o.reach), mouth], drain: [caught, along(caught, m, o.reach)], hide: o.hide });
    Object.assign(station, { cup: true, cupTravel: o.cupTravel, out0, minGap: o.minGap, target });
    // Une bille par note, tenue jusqu'à la fin de la note ou jusqu'à l'arrivée de la suivante.
    station.shots = [];
    for (const note of target.notes) {
      const last = station.shots[station.shots.length - 1];
      if (last && note.start - last.time < o.minGap) continue;
      if (last) last.hold = Math.max(o.minHold, Math.min(last.hold, note.start - last.time - o.exitMargin));
      station.shots.push({ time: note.start, hold: Math.max(o.minHold, note.end - note.start), velocity: note.velocity, track: note.track });
    }
    return station;
  });
  const shots = stations.flatMap((station, index) => station.shots.map((h) => ({ ...h, station, index }))).sort((a, b) => a.time - b.time);
  const first = stations[0];
  return {
    kind: 'cups',
    options: o,
    sign,
    ballRadius,
    tubeRadius,
    hornRadius,
    stations,
    shots,
    maxBalls: maxConcurrent(shots),
    before: first.before,
    after: first.after + Math.max(0, ...shots.map((s) => s.hold)),
    ...circuit(first, targets[0].x - o.margin, targets[targets.length - 1].x + o.margin, o.pipeRadius),
  };
}

/** Circuit d'une rangée : collecteur, coude et montée à droite, rampe ; poteaux et entretoise. */
function circuit(first, W0, W1, R) {
  const [, yc, zc] = first.drain.points[first.drain.points.length - 1];
  const [, ym, zm] = first.feed.points[0];
  return {
    loop: fillet(
      [
        [W0, yc, zc],
        [W1, yc, zc],
        [W1, yc, zm],
        [W1, ym, zm],
        [W0, ym, zm],
      ],
      0.15,
    ),
    posts: [
      [W0, ym - R, zm],
      [W1, yc - R, zm],
    ],
    strut: [
      [W0, yc, zm],
      [W0, yc, zc],
    ],
    extent: { minX: W0 - R, maxX: W1 + R, maxZ: Math.max(Math.abs(zm), Math.abs(zc)) + R, top: Math.max(ym, first.mouth[1]) + R + 0.05 },
  };
}

// --- Touches : cibles horizontales alimentées par une même rampe -------------------------
//
// La bille tombe sur la touche, qui s'enfonce et actionne son marteau ; elle rebondit
// vers l'avant et tombe dans un cornet. Touches blanches et noires ne sont pas frappées
// à la même profondeur : chaque groupe a sa rangée de cornets et son collecteur, mais
// toutes les buses sortent de la même rampe (chaque buse est orientée pour cela).

export const KEYROW_DEFAULTS = { ...ROW_DEFAULTS, flightIn: 0.26, drop: 0.33, maxBall: 0.03 };

/**
 * @param groups [{ targets: [{ x, hits }], y, z, axis: { y, z } }] un groupe par profondeur de frappe
 *   (y, z : surface frappée) ; axis : axe de la rampe de ses buses. Deux groupes dont les cibles
 *   s'intercalent (blanches et noires) ont des rampes à des hauteurs différentes : leurs buses ne se gênent pas.
 * @param spacing écart entre deux cibles voisines d'un même groupe
 */
export function buildKeyRow(groups, spacing, options = {}) {
  const o = { ...KEYROW_DEFAULTS, ...options };
  const ballRadius = Math.min(o.maxBall, spacing * 0.27);
  const tubeRadius = ballRadius + 0.014;
  const hornRadius = Math.max(tubeRadius, Math.min(0.1, spacing / 2 - 0.004));
  const T = o.flightIn;
  const catchY = Math.min(...groups.map((g) => g.y)) + ballRadius - o.drop;
  const live = groups.filter((g) => g.targets.length);
  let collectorY = null;
  const sets = live.map((g) => {
    const axis = g.axis;
    const stations = g.targets.map((target) => {
      const hit = [target.x, g.y + ballRadius, g.z];
      // Vitesse de sortie : dans l'axe de la buse, qui part de la rampe (voir l'en-tête).
      const d = [0, hit[1] - axis.y + 4.9 * T * T, hit[2] - axis.z];
      const speed = (Math.hypot(d[1], d[2]) - o.reach) / T;
      const v0 = unit(d).map((c) => c * speed);
      const vIn = [0, v0[1] - 9.8 * T, v0[2]];
      const strike = planStrike({ hit, normal: [0, 1, 0], vIn, flightIn: T, restitution: o.restitution, flightOut: fallTime(-o.restitution * vIn[1], hit[1] - catchY) });
      const m = unit(strike.vCatch);
      // Tous les collecteurs à la même hauteur : ils se rejoignent au bout du clavier.
      collectorY ??= strike.catch[1] + m[1] * o.reach;
      const station = buildStation(strike, { ballRadius, feed: [[target.x, axis.y, axis.z], strike.mouth], drain: [strike.catch, along(strike.catch, m, (collectorY - strike.catch[1]) / m[1])], hide: o.hide });
      station.shots = assignShots(station, target.hits);
      station.target = target;
      return station;
    });
    return stations;
  });
  const stations = sets.flat();
  pruneConflicts(stations, 2 * ballRadius * 1.06);
  const shots = stations.flatMap((station, index) => station.shots.map((h) => ({ time: h.time, track: h.track, velocity: h.velocity, station, index }))).sort((a, b) => a.time - b.time);
  const xs = stations.map((st) => st.hit[0]);
  const [W0, W1] = o.span ?? [Math.min(...xs) - o.margin, Math.max(...xs) + o.margin];
  // Le circuit part du collecteur le plus en avant ; les autres s'y raccordent au coude.
  const ends = sets.map((set) => set[0].drain.points[1]);
  const front = sets[ends.indexOf(ends.reduce((a, b) => (b[2] > a[2] ? b : a)))][0];
  // … et monte jusqu'à la rampe la plus haute ; les autres rampes s'y raccordent de même.
  const ramps = sets.map((set) => set[0].feed.points[0]);
  const top = ramps.reduce((a, b) => (b[1] > a[1] ? b : a));
  const c = circuit({ drain: front.drain, feed: { points: [top] }, mouth: front.mouth }, W0, W1, o.pipeRadius);
  const extra = [...ends.filter((e) => e !== front.drain.points[1]), ...ramps.filter((e) => e !== top)].map((e) => [
    [W0, e[1], e[2]],
    [W1, e[1], e[2]],
  ]);
  return {
    kind: 'keys',
    options: o,
    ballRadius,
    tubeRadius,
    hornRadius,
    stations,
    shots,
    maxBalls: maxConcurrent(shots),
    before: Math.max(...stations.map((st) => st.before)),
    after: Math.max(...stations.map((st) => st.after)),
    ...c,
    pipes: extra,
  };
}

/**
 * Retire les billes qui toucheraient celle d'une cible voisine (demi-tons joués presque
 * ensemble sur deux rangées qui s'intercalent) : la première arrivée garde la sienne.
 */
function pruneConflicts(stations, need) {
  const all = stations.flatMap((station) => station.shots.map((shot) => ({ shot, station }))).sort((a, b) => a.shot.time - b.shot.time);
  const kept = [];
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  for (const cand of all) {
    const st = cand.station;
    let clash = false;
    for (let i = kept.length - 1; i >= 0 && !clash; i--) {
      const other = kept[i];
      const gap = cand.shot.time - other.shot.time;
      if (gap > st.before + other.station.after) break;
      if (other.station === st || Math.abs(other.station.hit[0] - st.hit[0]) >= need) continue;
      for (let dt = -st.before; dt < st.after && !clash; dt += 1 / 240) {
        if (!stationBall(st, dt, p) || !stationBall(other.station, dt + gap, q)) continue;
        clash = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < need;
      }
    }
    if (clash) st.shots.splice(st.shots.indexOf(cand.shot), 1);
    else kept.push(cand);
  }
}
