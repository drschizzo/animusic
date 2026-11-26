// Moteur de billes générique : module pur (aucune dépendance à Three.js).
//
// Une « station » joue une cible fixe (peau, cymbale, lame, corde…) : un tuyau crache la
// bille, elle vole en parabole, frappe la cible à l'instant exact de la note, rebondit
// (loi de réflexion, restitution e) et tombe dans un cornet qui l'avale. Toutes les
// billes d'une station suivent la même trajectoire, décalée dans le temps : tuyau et
// cornet sont donc fixes, et la position d'une bille ne dépend que de (t − instant de
// frappe). Rien n'est simulé : tout se calcule à n'importe quel instant.

export const GRAVITY = 9.8;

const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Point d'une parabole partie de p à la vitesse v, dt secondes plus tard. */
export function ballistic(p, v, dt, out = [0, 0, 0]) {
  out[0] = p[0] + v[0] * dt;
  out[1] = p[1] + v[1] * dt - 0.5 * GRAVITY * dt * dt;
  out[2] = p[2] + v[2] * dt;
  return out;
}

/** Vitesse après rebond sur une surface de normale n : composante normale inversée × e. */
export function bounce(v, n, e) {
  return add(v, n, -(1 + e) * dot(v, n));
}

/** Durée pour descendre de `drop` (m, négatif = monter) en partant à la vitesse verticale vy (phase descendante). */
export function fallTime(vy, drop) {
  const disc = vy * vy + 2 * GRAVITY * drop;
  if (disc < 0) throw new Error('Hauteur jamais atteinte');
  return (vy + Math.sqrt(disc)) / GRAVITY;
}

/**
 * Polyligne aux angles arrondis en arcs de cercle de rayon `radius` (réduit si un
 * segment est trop court). Les extrémités et leurs directions sont conservées.
 */
export function fillet(corners, radius, step = 0.03) {
  const out = [corners[0]];
  for (let i = 1; i < corners.length - 1; i++) {
    const [A, B, C] = [corners[i - 1], corners[i], corners[i + 1]];
    const u = unit(sub(B, A));
    const w = unit(sub(C, B));
    const theta = Math.acos(Math.min(1, Math.max(-1, dot(u, w))));
    if (theta < 1e-3) {
      out.push(B);
      continue;
    }
    const room = 0.48 * Math.min(len(sub(B, A)), len(sub(C, B)));
    const tl = Math.min(radius * Math.tan(theta / 2), room);
    const r = tl / Math.tan(theta / 2);
    const P1 = add(B, u, -tl);
    const nrm = unit(add(w, u, -dot(w, u)));
    const O = add(P1, nrm, r);
    const n = Math.max(2, Math.ceil((r * theta) / step));
    for (let k = 0; k <= n; k++) {
      const phi = (theta * k) / n;
      out.push(add(add(O, nrm, -r * Math.cos(phi)), u, r * Math.sin(phi)));
    }
  }
  out.push(corners[corners.length - 1]);
  return out;
}

/** Polyligne paramétrée par l'abscisse curviligne. */
export function polyline(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + len(sub(points[i], points[i - 1])));
  const length = cum[cum.length - 1];
  return {
    points,
    cum,
    length,
    pointAt(s, out = [0, 0, 0]) {
      s = Math.min(length, Math.max(0, s));
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid;
      }
      const f = (s - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
      const a = points[lo];
      const b = points[hi];
      out[0] = a[0] + (b[0] - a[0]) * f;
      out[1] = a[1] + (b[1] - a[1]) * f;
      out[2] = a[2] + (b[2] - a[2]) * f;
      return out;
    },
    /** Direction (unitaire) de la polyligne à l'abscisse s. */
    tangentAt(s) {
      const a = this.pointAt(Math.max(0, s - 1e-3));
      const b = this.pointAt(Math.min(length, s + 1e-3));
      return unit(sub(b, a));
    },
  };
}

/**
 * Frappe par une bille, calculée à l'envers depuis l'impact.
 * @param hit centre de la bille à l'impact
 * @param normal normale (unitaire) de la surface frappée, vers la bille
 * @param vIn vitesse de la bille juste avant l'impact
 * @param flightIn durée du vol entre la bouche du tuyau et l'impact
 * @param restitution part de la vitesse normale rendue par le rebond
 * @param flightOut durée du vol entre l'impact et le cornet
 * @returns bouche du tuyau (mouth, v0), rebond (vOut), cornet (catch, vCatch)
 */
export function planStrike({ hit, normal, vIn, flightIn, restitution, flightOut }) {
  const v0 = [vIn[0], vIn[1] + GRAVITY * flightIn, vIn[2]];
  const mouth = [hit[0] - v0[0] * flightIn, hit[1] - v0[1] * flightIn + 0.5 * GRAVITY * flightIn * flightIn, hit[2] - v0[2] * flightIn];
  const vOut = bounce(vIn, normal, restitution);
  const caught = ballistic(hit, vOut, flightOut);
  const vCatch = [vOut[0], vOut[1] - GRAVITY * flightOut, vOut[2]];
  return { hit, normal, vIn, v0, mouth, vOut, catch: caught, vCatch, flightIn, flightOut, restitution };
}

/**
 * Station complète : une frappe, plus le trajet de la bille dans le tuyau avant la
 * bouche (`feed`, polyligne qui finit à la bouche, dans l'axe de v0) et dans le cornet
 * après la capture (`drain`, polyligne qui part du cornet, dans l'axe de vCatch). La
 * bille naît cachée à `hide` m de la bouche et disparaît à `hide` m dans le cornet.
 */
export function buildStation(strike, { ballRadius, feed, drain, hide = 0.3, hideOut = hide }) {
  const feedPath = polyline(feed);
  const drainPath = polyline(drain);
  const speedIn = len(strike.v0);
  const speedOut = len(strike.vCatch);
  const hideIn = Math.min(hide, feedPath.length);
  hideOut = Math.min(hideOut, drainPath.length);
  const station = {
    ...strike,
    ballRadius,
    feed: feedPath,
    drain: drainPath,
    speedIn,
    speedOut,
    hideIn,
    hideOut,
    /** Vie d'une bille autour de l'instant de frappe : de −before à +after. */
    before: strike.flightIn + hideIn / speedIn,
    after: strike.flightOut + hideOut / speedOut,
  };
  station.minGap = minShotGap(station);
  return station;
}

/**
 * Centre de la bille d'une station, dt secondes après (ou avant, dt < 0) sa frappe.
 * @returns false hors de sa vie (bille cachée dans le tuyau ou le cornet)
 */
export function stationBall(station, dt, out = [0, 0, 0]) {
  if (dt < -station.before || dt >= station.after) return false;
  if (dt < -station.flightIn) {
    // Dans le tuyau : vitesse de sortie constante, le long de son axe.
    station.feed.pointAt(station.feed.length - (-station.flightIn - dt) * station.speedIn, out);
  } else if (dt < 0) ballistic(station.mouth, station.v0, dt + station.flightIn, out);
  else if (dt < station.flightOut) ballistic(station.hit, station.vOut, dt, out);
  else station.drain.pointAt((dt - station.flightOut) * station.speedOut, out);
  return true;
}

/** Plus petite distance entre deux billes d'une même station frappant à `gap` s d'écart. */
export function shotClearance(station, gap, step = 1 / 480) {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  let min = Infinity;
  for (let dt = -station.before; dt < station.after + gap; dt += step) {
    if (!stationBall(station, dt, a) || !stationBall(station, dt - gap, b)) continue;
    min = Math.min(min, len(sub(a, b)));
  }
  return min;
}

/** Plus petit écart entre deux frappes pour que leurs billes ne se touchent jamais. */
function minShotGap(station) {
  const need = 2 * station.ballRadius * 1.08;
  for (let gap = 0.02; gap < 1; gap += 0.004) if (shotClearance(station, gap) >= need) return gap;
  return 1;
}

/**
 * Frappes servies par une bille : toutes, sauf celles qui suivent la précédente de trop
 * près pour que deux billes passent sans se toucher (fla, notes doublées).
 */
export function assignShots(station, hits) {
  const shots = [];
  let last = -Infinity;
  for (const h of hits) {
    if (h.time - last < station.minGap) continue;
    shots.push(h);
    last = h.time;
  }
  return shots;
}

/** Nombre maximal de billes en vie en même temps, pour des listes de { time, station }. */
export function maxConcurrent(shots) {
  const events = [];
  for (const s of shots) events.push([s.time - s.station.before, 1], [s.time + s.station.after, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let alive = 0;
  let max = 0;
  for (const [, d] of events) max = Math.max(max, (alive += d));
  return max;
}
