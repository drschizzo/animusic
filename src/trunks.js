// Réseau : une seule machine. Module pur (sans Three.js), en coordonnées de la scène.
//
// Près de la tourelle du marimba se dresse une tour de colonnes de verre. De chaque
// colonne part, en hauteur, un tuyau d'alimentation qui redescend dans la rampe d'un
// instrument ; un tuyau de retour remonte de son collecteur et revient à la tour. Les
// billes y circulent à vitesse constante, en avance sur la musique : chacune arrive au
// bout de sa rampe juste à temps pour être tirée, si bien que le rythme d'un instrument
// se lit d'avance dans son tuyau, et qu'une bille en repart après chaque note.

import { fillet, polyline } from './ballistics.js';
import { frameOf } from './passes.js';

export const TRUNK_DEFAULTS = {
  speed: 5, // vitesse des billes dans le réseau (m/s)
  radius: 0.058, // rayon extérieur des tuyaux
  towerZ: 1.85, // rangée des colonnes d'alimentation : entre le plateau de la tourelle (rayon 1,72) et les claviers
  towerDepth: 0.35, // la rangée des colonnes de retour est derrière elle
  columnGap: 0.3, // écart entre deux colonnes
  levelGap: 0.2, // écart de hauteur entre deux tuyaux
  clearance: 1.3, // hauteur du réseau au-dessus de l'instrument le plus haut
  minHeight: 7.2,
  stub: 0.3, // le retour quitte le collecteur de côté avant de monter
  baseY: 0.3, // dessus du socle de la tour
  maxLines: 9,
};

/**
 * Trace le réseau : une ligne (alimentation + retour) par instrument joué par une rangée
 * de billes. Les colonnes sont rangées de gauche à droite comme les instruments, et les
 * tuyaux étagés du bord vers le centre : un tuyau ne passe qu'au-dessus de colonnes plus
 * basses que lui, et deux tuyaux ne sont jamais à la même hauteur.
 */
export function planTrunks(ensemble, options = {}) {
  const o = { ...TRUNK_DEFAULTS, ...options };
  const inst = ensemble.instruments;
  const tops = inst.filter((i) => i.footprint).map((i) => i.footprint.top);
  const H = Math.max(o.minHeight, ...tops.map((t) => t + o.clearance));
  const rows = inst
    .map((ins, k) => ({ ins, k }))
    .filter(({ ins }) => ins.model.row)
    .map(({ ins, k }) => {
      const f = frameOf(ins);
      const loop = ins.model.row.loop;
      const [W0, yc, zc] = loop[0];
      const [, ym, zm] = loop[loop.length - 1];
      // Les tuyaux se posent contre les bouts de la rampe et du collecteur, sans y entrer.
      const lip = o.radius + 0.012;
      const joint = f.toWorld([W0, ym + lip, zm]); // au-dessus du bout de la rampe
      const drain = f.toWorld([W0 - lip, yc, zc]); // contre le bout du collecteur
      return { k, f, W0, joint, drain, out: f.toWorld([W0 - o.stub, yc, zc]), azimuth: Math.atan2(joint[0], -(joint[2] - o.towerZ)) };
    })
    .sort((a, b) => a.azimuth - b.azimuth)
    .slice(0, o.maxLines);
  const n = rows.length;
  // Hauteurs : la colonne la plus à gauche et la plus à droite sont les plus basses.
  const rank = rows.map((_, i) => Math.min(2 * i, 2 * (n - 1 - i) + 1));
  const order = [...rank].sort((a, b) => a - b);
  const lines = rows.map((r, i) => {
    const level = order.indexOf(rank[i]);
    const x = (i - (n - 1) / 2) * o.columnGap;
    const hf = H + level * o.levelGap;
    const hr = H + (n + level) * o.levelGap;
    const zf = o.towerZ;
    const zr = o.towerZ + o.towerDepth;
    const feedCorners = [[x, o.baseY, zf], [x, hf, zf], [r.joint[0], hf, r.joint[2]], r.joint];
    const returnCorners = [r.drain, r.out, [r.out[0], hr, r.out[2]], [x, hr, zr], [x, o.baseY, zr]];
    return {
      instrument: r.k,
      W0: r.W0,
      ballRadius: inst[r.k].model.row.ballRadius,
      feedCorners,
      returnCorners,
      feed: polyline(fillet(feedCorners, 0.3, 0.08)),
      back: polyline(fillet(returnCorners, 0.3, 0.08)),
      feedBalls: [],
      backBalls: [],
    };
  });
  const half = ((n - 1) / 2) * o.columnGap + 0.25;
  return { options: o, height: H, lines, base: n ? { minX: -half, maxX: half, minZ: o.towerZ - 0.1, maxZ: o.towerZ + o.towerDepth + 0.1, top: o.baseY } : null };
}

/**
 * Horaires des billes du réseau, d'après les billes que tire réellement chaque rangée
 * (à appeler après le choix des passes). Une bille d'alimentation par tir de buse : elle
 * arrive au bout de la rampe assez tôt pour la parcourir jusqu'à sa buse ; une bille de
 * retour par bille tombée dans un cornet. Deux billes d'un même tuyau ne se touchent pas.
 */
export function scheduleTrunks(trunks, ensemble) {
  const o = trunks.options;
  for (const line of trunks.lines) {
    const row = ensemble.instruments[line.instrument].model.row;
    const gap = (2.4 * line.ballRadius) / o.speed;
    const along = (shot) => Math.abs(shot.station.hit[0] - line.W0) / o.speed;
    const feed = row.shots.map((s) => ({ time: s.time - s.station.before - along(s) - 0.03, track: s.track })).sort((a, b) => a.time - b.time);
    for (let i = feed.length - 2; i >= 0; i--) feed[i].time = Math.min(feed[i].time, feed[i + 1].time - gap);
    const back = row.shots.map((s) => ({ time: s.time + (s.hold ?? 0) + s.station.after + along(s) + 0.03, track: s.track })).sort((a, b) => a.time - b.time);
    for (let i = 1; i < back.length; i++) back[i].time = Math.max(back[i].time, back[i - 1].time + gap);
    line.feedBalls = feed; // time = arrivée au bout de la rampe
    line.backBalls = back; // time = départ du bout du collecteur
    line.feedSpan = line.feed.length / o.speed;
    line.backSpan = line.back.length / o.speed;
  }
  const lines = trunks.lines;
  trunks.start = Math.min(Infinity, ...lines.filter((l) => l.feedBalls.length).map((l) => l.feedBalls[0].time - l.feedSpan));
  return trunks;
}

/** Position d'une bille d'alimentation (arrivée à `ball.time`) à l'instant t, ou false hors du tuyau. */
export function feedBall(trunks, line, ball, t, out = [0, 0, 0]) {
  const s = line.feed.length - trunks.options.speed * (ball.time - t);
  if (s < 0 || s > line.feed.length) return false;
  line.feed.pointAt(s, out);
  return true;
}

/** Position d'une bille de retour (partie à `ball.time`) à l'instant t, ou false hors du tuyau. */
export function backBall(trunks, line, ball, t, out = [0, 0, 0]) {
  const s = trunks.options.speed * (t - ball.time);
  if (s < 0 || s > line.back.length) return false;
  line.back.pointAt(s, out);
  return true;
}

/** Distance d'un point aux axes des tuyaux du réseau (segments entre coudes). */
export function trunkDistance(trunks, p) {
  let min = Infinity;
  for (const line of trunks.lines)
    for (const corners of [line.feedCorners, line.returnCorners])
      for (let i = 1; i < corners.length; i++) {
        const a = corners[i - 1];
        const b = corners[i];
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2));
        min = Math.min(min, Math.hypot(p[0] - a[0] - d[0] * u, p[1] - a[1] - d[1] * u, p[2] - a[2] - d[2] * u));
      }
  return min;
}
