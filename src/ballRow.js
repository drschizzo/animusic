// Rangée de stations de billes : module pur (sans Three.js).
//
// Pour les instruments faits d'une rangée de cibles verticales alignées le long de x
// (cloches tubulaires, cordes) : devant chaque cible, une buse crache la bille presque à
// l'horizontale, elle frappe la face avant (+z), rebondit vers l'avant et tombe dans un
// cornet. Toutes les buses sortent d'une même rampe, tous les cornets se vident dans un
// même collecteur, et les deux sont reliés par un coude : un seul circuit.
// Les trajectoires sont dans des plans x = constante, donc parallèles : deux billes de
// cibles voisines ne peuvent pas se croiser.

import { planStrike, buildStation, assignShots, maxConcurrent, fallTime, fillet } from './ballistics.js';

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
