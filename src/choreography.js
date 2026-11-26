// Chorégraphie : transforme une liste de notes en mouvements calculés à l'avance.
// Module pur (aucune dépendance à Three.js) pour pouvoir être testé et réutilisé
// (ex. export futur vers Blender).
//
// Principe « animation à l'envers » : pour chaque note on connaît l'instant
// d'impact et la position de la lame ciblée ; on en déduit l'instant de
// lancement et la vitesse initiale de la bille pour une parabole exacte.

import { easeBack, springSum } from './util.js';

export const DEFAULTS = {
  gravity: 9.8,
  flightTime: 1.2, // secondes entre le tir et l'impact
  postImpact: 1.4, // durée de vie de la bille après l'impact
  ballRadius: 0.12,

  radius: 6, // rayon minimal de l'arc de lames (plus grand, il repousse tout l'orchestre)
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

  // Récupération : gouttière en arc derrière les lames, puis tubes de retour vers la tourelle.
  exitTime: 0.5, // vol minimal de la dernière lame à la gouttière (allongé pour franchir la lame)
  troughGap: 1.4, // distance gouttière ↔ lames (au-delà du bout des lames les plus longues)
  troughY: 1.22, // hauteur (centre de bille) au milieu de la gouttière
  troughEndY: 1.05, // … et à ses extrémités, au-dessus des entonnoirs
  rollSpeed: 2.4, // vitesse dans la gouttière
  tubeSpeed: 4.2, // vitesse dans les tubes
  tubeY: 0.2, // hauteur des tubes au sol (centre de bille)
  funnelDepth: 0.42, // de l'arrivée de la gouttière au bas du goulot de l'entonnoir
  loaderGap: 0.95, // chargeur (où rentrent les billes) : distance au-delà des canons
  loaderRadius: 0.3,
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
  const g = o.gravity;
  /** Vitesse initiale d'une parabole de p à q en `dt` secondes. */
  const aim = (p, q, dt) => [(q[0] - p[0]) / dt, (q[1] - p[1] + 0.5 * g * dt * dt) / dt, (q[2] - p[2]) / dt];

  // Une note = une bille, tirée par le canon le plus proche : le geste reste lisible.
  const shots = sorted.map((note) => {
    const bar = barByMidi.get(note.midi);
    bar.hits.push({ time: note.time, velocity: note.velocity, track: note.track });
    return { track: note.track, notes: [{ ...note, bar }] };
  });

  const balls = [];
  const impacts = [];
  shots
    .map((c) => ({ c, launch: c.notes[0].time - o.flightTime }))
    .sort((x, y) => x.launch - y.launch)
    .forEach(({ c, launch }) => {
      const first = c.notes[0];
      const bar = first.bar;
      const T = first.time - launch;
      // Choix du canon : le plus proche angulairement parmi les canons libres,
      // sinon celui qui a tiré le moins récemment.
      let L = launchers[0];
      let best = Infinity;
      for (const l of launchers) {
        const free = l.lastLaunch <= launch - o.minLauncherGap;
        const score = free ? Math.abs(l.angle - bar.angle) : 1000 + l.lastLaunch;
        if (score < best) {
          best = score;
          L = l;
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
        v0 = aim(p0, bar.target, T);
        dir = norm(v0);
      }
      L.shots.push({ time: launch, dir, velocity: first.velocity });
      L.lastLaunch = launch;

      const ball = {
        launch,
        impact: first.time,
        p0,
        v0,
        target: bar.target,
        segs: [{ t0: launch, p: p0, v: v0 }],
        launcher: L.index,
        bar: bar.index,
        track: c.track,
        midi: first.midi,
        velocity: first.velocity,
        lastImpact: first.time,
        lastBar: bar.index,
        hits: c.notes.length,
      };
      c.notes.forEach((n, i) => {
        if (i > 0) {
          const prev = c.notes[i - 1];
          ball.segs.push({ t0: prev.time, p: prev.bar.target, v: aim(prev.bar.target, n.bar.target, n.time - prev.time) });
          ball.lastImpact = n.time;
          ball.lastBar = n.bar.index;
        }
        impacts.push({ time: n.time, position: n.bar.target, velocity: n.velocity, track: n.track, bar: n.bar.index, ball });
      });
      balls.push(ball);
    });
  impacts.sort((x, y) => x.time - y.time);

  // --- Récupération : chaque bille, après sa dernière lame, saute dans la gouttière,
  // y roule jusqu'au bout le plus proche, tombe dans un tube et revient à la tourelle.
  const returns = buildReturnPaths(o, radius, arc);
  for (const b of balls) {
    const bar = bars[b.lastBar];
    // Rebond de la lame vers la gouttière, juste derrière elle : assez haut pour
    // franchir le bout de la lame (la bille ne doit jamais la traverser).
    const landAngle = bar.angle;
    const side = landAngle > 1e-6 ? 1 : landAngle < -1e-6 ? 0 : b.launcher % 2;
    const path = returns[side];
    const s0 = path.troughAt(Math.abs(landAngle));
    const land = path.pointAt(s0);
    const exit = exitTime(o, bar, land);
    b.segs.push({ t0: b.lastImpact, p: bar.target, v: aim(bar.target, land, exit) });
    const t0 = b.lastImpact + exit;
    b.path = { t0, side, s0, t1: t0 + path.timeBetween(s0, path.length) };
    b.end = b.path.t1;
  }

  // Nombre maximal de billes simultanées (taille du pool de rendu) et durée de vie maximale.
  const events = [];
  let maxLife = 0;
  for (const b of balls) {
    events.push([b.launch, 1], [b.end, -1]);
    maxLife = Math.max(maxLife, b.end - b.launch);
  }
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let maxConcurrent = 0;
  let alive = 0;
  for (const [, d] of events) maxConcurrent = Math.max(maxConcurrent, (alive += d));

  const first = balls.length ? balls[0].launch : 0;
  const last = balls.length ? Math.max(...balls.map((b) => b.end)) : 0;
  return { options: o, bars, launchers, balls, impacts, returns, radius, arc, maxConcurrent, maxLife, start: first, duration: last };
}

/**
 * Durée du saut d'une lame vers la gouttière : la plus courte (≥ exitTime) pour que la
 * bille ne touche ni le bout de la lame ni le bord intérieur de la gouttière (elle y
 * plonge par le haut). Recherche numérique dans le plan radial-vertical.
 */
function exitTime(o, bar, land) {
  const D = Math.hypot(land[0] - bar.target[0], land[2] - bar.target[2]);
  const dy = land[1] - bar.target[1];
  const r = o.ballRadius;
  const g = o.gravity;
  // Coins à éviter (x horizontal depuis le départ, y relatif) et distance minimale.
  const corners = [
    [bar.length / 2, -r - 0.03, r + 0.04], // bout de la lame (arête supérieure)
    [D - r - 0.06, dy + 0.06, r + 0.045], // lèvre intérieure de la gouttière
  ];
  for (let T = o.exitTime; T < 3; T += 0.02) {
    const vy = (dy + 0.5 * g * T * T) / T;
    let ok = true;
    for (let k = 1; k <= 40 && ok; k++) {
      const t = (k / 40) * T;
      const x = (D * t) / T;
      const y = vy * t - 0.5 * g * t * t;
      for (const [cx, cy, min] of corners) if (Math.hypot(x - cx, y - cy) < min) ok = false;
    }
    if (ok) return T;
  }
  return 3;
}

/**
 * Chemins de retour (gauche, droite), en coordonnées de centre de bille : gouttière en
 * arc qui descend vers l'extrémité, chute dans un tube, course au sol jusqu'au pied de
 * la tourelle, montée dans le plateau. Polyligne aux angles adoucis, paramétrée par
 * l'abscisse curviligne ; la vitesse est `rollSpeed` dans la gouttière, `tubeSpeed` ensuite.
 */
export function buildReturnPaths(o, radius, arc) {
  const Rt = radius + o.troughGap;
  const endA = arc / 2 + 0.14;
  const steps = Math.max(8, Math.ceil(endA / 0.03));
  const troughY = (a) => o.troughY - ((o.troughY - o.troughEndY) * a) / endA;
  return [-1, 1].map((sign) => {
    const at = (a, r, y) => [Math.sin(sign * a) * r, y, -Math.cos(sign * a) * r];
    const trough = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * endA;
      trough.push(at(a, Rt, troughY(a)));
    }
    // Au bout de la gouttière, la bille tombe dans un entonnoir (axe vertical), descend
    // dans son goulot puis dans un tube de verre qui file au sol, droit vers la tourelle,
    // et entre dans le chargeur (boîtier opaque où elle disparaît).
    const yEnd = troughY(endA);
    const dropA = endA + 0.25 / Rt;
    const drop = at(dropA, Rt, yEnd - 0.04);
    const neck = at(dropA, Rt, yEnd - 0.04 - o.funnelDepth);
    const rLoader = o.launcherRadius + o.loaderGap;
    let tube = [neck, at(dropA, Rt, o.tubeY), at(dropA, Rt - 0.6, o.tubeY), at(dropA, rLoader + 0.6, o.tubeY), at(dropA, rLoader, o.tubeY)];
    tube = chaikin(tube, 3);
    const points = [...trough, drop, ...tube];
    const cum = [0];
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const troughEnd = cum[steps];
    const length = cum[cum.length - 1];
    const [fx, , fz] = drop;
    const [lx, , lz] = at(dropA, rLoader, 0);
    return {
      side: sign,
      points,
      cum,
      troughSteps: steps,
      /** Entonnoir : axe (x, z), haut (sous l'arrivée de la gouttière), bas du goulot. */
      funnel: { x: fx, z: fz, top: yEnd - o.ballRadius - 0.02, neck: neck[1] },
      /** Points du tube de verre (à partir du goulot). */
      tubeStart: steps + 2,
      /** Chargeur : boîtier cylindrique au pied de la tourelle, où rentrent les billes. */
      loader: { x: lx, z: lz, angle: sign * dropA, radius: o.loaderRadius },
      troughEnd,
      length,
      /** Abscisse du point de la gouttière à l'angle a (rad, ≥ 0). */
      troughAt(a) {
        const f = Math.min(steps, Math.max(0, (a / endA) * steps));
        const i = Math.min(steps - 1, Math.floor(f));
        return cum[i] + (cum[i + 1] - cum[i]) * (f - i);
      },
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
      /** Durée de parcours entre deux abscisses. */
      timeBetween(s0, s1) {
        const inTrough = Math.max(0, Math.min(s1, troughEnd) - s0);
        return inTrough / o.rollSpeed + (s1 - s0 - inTrough) / o.tubeSpeed;
      },
      /** Abscisse atteinte `dt` secondes après être parti de s0. */
      advance(s0, dt) {
        const rollTime = Math.max(0, troughEnd - s0) / o.rollSpeed;
        if (dt <= rollTime) return s0 + dt * o.rollSpeed;
        return Math.max(s0, troughEnd) + (dt - rollTime) * o.tubeSpeed;
      },
    };
  });
}

/** Adoucit les angles d'une polyligne (subdivision de Chaikin, extrémités conservées). */
function chaikin(pts, iterations) {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [a, b] = [p[i], p[i + 1]];
      q.push(a.map((v, c) => 0.75 * v + 0.25 * b[c]), a.map((v, c) => 0.25 * v + 0.75 * b[c]));
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Position d'une bille à l'instant t (écrite dans out). */
export function ballPosition(ch, ball, t, out = [0, 0, 0]) {
  if (ball.path && t >= ball.path.t0) {
    const path = ch.returns[ball.path.side];
    return path.pointAt(path.advance(ball.path.s0, t - ball.path.t0), out);
  }
  const g = ch.options.gravity;
  const segs = ball.segs;
  let k = segs.length - 1;
  while (k > 0 && segs[k].t0 > t) k--;
  const { p, v, t0 } = segs[k];
  const dt = t - t0;
  out[0] = p[0] + v[0] * dt;
  out[1] = Math.max(ch.options.ballRadius, p[1] + v[1] * dt - 0.5 * g * dt * dt);
  out[2] = p[2] + v[2] * dt;
  return out;
}

/** Échelle d'une bille : 1 pendant toute sa vie (elle finit cachée dans le chargeur). */
export function ballScale(ball, t) {
  if (t < ball.launch || t >= ball.end) return 0;
  return 1;
}

/** Intervalle [start, end) des billes (triées par tir) potentiellement visibles à t. */
export function activeBallRange(ch, t) {
  const start = lowerBound(ch.balls, t - ch.maxLife, (b) => b.launch);
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

/** Intensité d'éclat d'une lame à l'instant t, et piste de la dernière frappe. */
export function barPulse(ch, bar, t) {
  const i = upperBound(bar.hits, t, (h) => h.time) - 1;
  if (i < 0) return { pulse: 0, track: -1 };
  const h = bar.hits[i];
  return { pulse: h.velocity * Math.exp(-(t - h.time) * ch.options.barDecay), track: h.track, since: t - h.time };
}
