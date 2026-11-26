// Chorégraphie : transforme une liste de notes en mouvements calculés à l'avance.
// Module pur (aucune dépendance à Three.js) pour pouvoir être testé et réutilisé
// (ex. export futur vers Blender).
//
// Principe « animation à l'envers » : pour chaque note on connaît l'instant
// d'impact et la position de la lame ciblée ; on en déduit l'instant de
// lancement et la vitesse initiale de la bille pour une parabole exacte.

import { easeBack, springSum, steppedTotal } from './util.js';

export const DEFAULTS = {
  gravity: 9.8,
  flightTime: 1.2, // secondes entre le tir et l'impact
  postImpact: 1.4, // durée de vie de la bille après l'impact
  ballRadius: 0.12,

  radius: 8, // rayon minimal de l'arc de lames
  arcDeg: 160, // ouverture maximale de l'arc
  minBarSpacing: 0.42,
  maxBarWidth: 0.5,
  barTopY: 1.2,
  barThickness: 0.12,
  barLengthMax: 1.8, // note la plus grave
  barLengthMin: 0.7, // note la plus aiguë
  barDecay: 6, // vitesse d'extinction de l'éclat d'une lame

  launcherCount: 6,
  launcherRadius: 1.1,
  launcherY: 0.7,
  barrelLength: 0.9,
  minLauncherGap: 0.09, // délai minimal entre deux tirs d'un même canon
  aimWindow: 0.35, // durée de la visée avant un tir

  restitution: 0.4,
  reboundHorizontal: 0.55,
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Premier index i tel que key(arr[i]) > value (arr trié). */
function upperBound(arr, value, key) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Premier index i tel que key(arr[i]) >= value (arr trié). */
function lowerBound(arr, value, key) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * @param {Array<{midi:number,time:number,velocity:number,track:number}>} notes
 * @param {Partial<typeof DEFAULTS>} options
 */
export function buildChoreography(notes, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = [...new Set(sorted.map((n) => n.midi))].sort((a, b) => a - b);
  const count = pitches.length;

  // --- Disposition des lames : un arc derrière les canons, grave à gauche.
  const arc = (Math.min(o.arcDeg, Math.max(30, count * 10)) * Math.PI) / 180;
  const radius = Math.max(o.radius, count > 1 ? ((count - 1) * o.minBarSpacing) / arc : 0);
  const spacing = count > 1 ? (radius * arc) / (count - 1) : 1;
  const barWidth = Math.min(o.maxBarWidth, spacing * 0.8);

  const bars = pitches.map((midi, i) => {
    const u = count > 1 ? i / (count - 1) : 0.5;
    const angle = (u - 0.5) * arc;
    const dir = [Math.sin(angle), 0, -Math.cos(angle)];
    const position = [dir[0] * radius, o.barTopY, dir[2] * radius];
    return {
      index: i,
      midi,
      angle,
      u,
      length: o.barLengthMax + (o.barLengthMin - o.barLengthMax) * u,
      width: barWidth,
      position,
      target: [position[0], o.barTopY + o.barThickness / 2 + o.ballRadius, position[2]],
      hits: [],
    };
  });
  const barByMidi = new Map(bars.map((b) => [b.midi, b]));

  // --- Canons : répartis en éventail au centre de la scène.
  const k = Math.min(o.launcherCount, count);
  const launchers = Array.from({ length: k }, (_, i) => {
    const u = k > 1 ? i / (k - 1) : 0.5;
    const angle = (u - 0.5) * arc * 0.8;
    return {
      index: i,
      angle,
      pivot: [Math.sin(angle) * o.launcherRadius, o.launcherY, -Math.cos(angle) * o.launcherRadius],
      restDir: norm([Math.sin(angle), 1.2, -Math.cos(angle)]),
      shots: [],
      lastLaunch: -Infinity,
    };
  });

  // --- Billes : calcul inverse de chaque trajectoire.
  const T = o.flightTime;
  const g = o.gravity;
  const balls = sorted.map((note) => {
    const bar = barByMidi.get(note.midi);
    const launch = note.time - T;

    // Choix du canon : le plus proche angulairement parmi les canons libres,
    // sinon celui qui a tiré le moins récemment.
    let L = launchers[0];
    let best = Infinity;
    for (const c of launchers) {
      const free = c.lastLaunch <= launch - o.minLauncherGap;
      const score = free ? Math.abs(c.angle - bar.angle) : 1000 + c.lastLaunch;
      if (score < best) {
        best = score;
        L = c;
      }
    }

    // La sortie du canon dépend de son orientation, qui dépend de la vitesse :
    // quelques itérations suffisent à converger.
    let dir = norm(sub(bar.target, L.pivot));
    dir = norm([dir[0], dir[1] + 1, dir[2]]);
    let p0;
    let v0;
    for (let it = 0; it < 3; it++) {
      p0 = add(L.pivot, scale(dir, o.barrelLength));
      const d = sub(bar.target, p0);
      v0 = [d[0] / T, (d[1] + 0.5 * g * T * T) / T, d[2] / T];
      dir = norm(v0);
    }

    L.shots.push({ time: launch, dir, velocity: note.velocity });
    L.lastLaunch = launch;
    bar.hits.push({ time: note.time, velocity: note.velocity, track: note.track });

    const vImpactY = v0[1] - g * T;
    return {
      launch,
      impact: note.time,
      end: note.time + o.postImpact,
      p0,
      v0,
      target: bar.target,
      vr: [v0[0] * o.reboundHorizontal, -vImpactY * o.restitution, v0[2] * o.reboundHorizontal],
      launcher: L.index,
      bar: bar.index,
      track: note.track,
      midi: note.midi,
      velocity: note.velocity,
    };
  });

  // Nombre maximal de billes simultanées (taille du pool de rendu).
  let maxConcurrent = 0;
  for (let i = 0, j = 0; i < balls.length; i++) {
    while (balls[j].end < balls[i].launch) j++;
    maxConcurrent = Math.max(maxConcurrent, i - j + 1);
  }

  const first = balls.length ? balls[0].launch : 0;
  const last = balls.length ? balls[balls.length - 1].end : 0;

  const shotTimes = balls.map((b) => ({ time: b.launch })).sort((a, b) => a.time - b.time);
  return { options: o, bars, launchers, balls, radius, arc, maxConcurrent, start: first, duration: last, shotTimes };
}

/** Position d'une bille à l'instant t (écrite dans out). */
export function ballPosition(ch, ball, t, out = [0, 0, 0]) {
  const g = ch.options.gravity;
  let p;
  let v;
  let dt;
  if (t < ball.impact) {
    p = ball.p0;
    v = ball.v0;
    dt = t - ball.launch;
  } else {
    p = ball.target;
    v = ball.vr;
    dt = t - ball.impact;
  }
  out[0] = p[0] + v[0] * dt;
  out[1] = Math.max(ch.options.ballRadius, p[1] + v[1] * dt - 0.5 * g * dt * dt);
  out[2] = p[2] + v[2] * dt;
  return out;
}

/** Échelle d'une bille (disparition progressive en fin de vie). */
export function ballScale(ball, t) {
  const fadeOut = 0.3;
  if (t < ball.launch || t > ball.end) return 0;
  return Math.min(1, (ball.end - t) / fadeOut);
}

/** Intervalle [start, end) des billes potentiellement visibles à t. */
export function activeBallRange(ch, t) {
  const start = lowerBound(ch.balls, t, (b) => b.end);
  const end = upperBound(ch.balls, t, (b) => b.launch);
  return [start, Math.max(start, end)];
}

/**
 * Orientation, recul et tremblement d'un canon à l'instant t. La visée part avec un
 * léger recul et dépasse un peu la cible avant de s'y caler (pile alignée au tir) ;
 * après le coup, le fût tremble (ressort amorti), d'autant plus que la note est forte.
 */
export function launcherPose(ch, launcher, t) {
  const shots = launcher.shots;
  const i = upperBound(shots, t, (s) => s.time) - 1;
  const prev = i >= 0 ? shots[i] : null;
  const next = shots[i + 1];
  let dir = prev ? prev.dir : launcher.restDir;

  if (next) {
    const window = Math.min(ch.options.aimWindow, prev ? next.time - prev.time : Infinity);
    const s = easeBack((t - (next.time - window)) / window, 0.7);
    if (s !== 0) {
      dir = norm([
        dir[0] + (next.dir[0] - dir[0]) * s,
        dir[1] + (next.dir[1] - dir[1]) * s,
        dir[2] + (next.dir[2] - dir[2]) * s,
      ]);
    }
  }
  const recoil = prev ? (0.6 + 0.4 * (prev.velocity ?? 1)) * Math.exp(-(t - prev.time) * 12) : 0;
  const shake = springSum(shots, t, { omega: 34, zeta: 0.16, amp: (e) => 0.05 * (0.4 + (e.velocity ?? 1)) });
  return { dir, recoil, shake };
}

/** Rotation (rad) de la couronne dentée de la tourelle : un cran à chaque tir. */
export function turretSpin(ch, t) {
  return steppedTotal(ch.shotTimes, t, (2 * Math.PI) / 48, 0.18);
}

/** Intensité d'éclat d'une lame à l'instant t, et piste de la dernière frappe. */
export function barPulse(ch, bar, t) {
  const i = upperBound(bar.hits, t, (h) => h.time) - 1;
  if (i < 0) return { pulse: 0, track: -1 };
  const h = bar.hits[i];
  return { pulse: h.velocity * Math.exp(-(t - h.time) * ch.options.barDecay), track: h.track, since: t - h.time };
}
