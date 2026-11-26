// Réalisateur caméra : module pur. Comme la partition est connue d'avance, la
// liste des plans est calculée une fois pour tout le morceau, en fonction de
// l'activité de chaque instrument. La caméra glisse ensuite d'un plan à l'autre,
// ou coupe franchement sur un temps fort.
//
// Types de plans : large, rapproché, contre-plongée, travelling latéral, grue
// (montée ou descente), entrée (l'instrument qui sort du sol est cadré avant sa
// première note) et poursuite (la caméra suit une bille d'un rebond à l'autre).

import { countOnsets, smoothstep, lerp, clamp, lowerBound } from './util.js';
import { ballPosition } from './choreography.js';
import { SECTION_DEFAULTS, introGrace } from './sections.js';

export const DIRECTOR_DEFAULTS = {
  minShot: 3.5,
  maxShot: 6.5,
  blend: 1.4, // durée du fondu de mouvement entre deux plans
  orbitSpeed: 0.06, // rad/s : lente rotation pendant un plan
  snap: 0.45, // une fin de plan se cale sur le temps fort le plus proche à ± snap s
  cutChance: 0.55, // probabilité d'une coupe franche quand le plan finit sur un temps fort
  followChance: 0.4, // probabilité de suivre une bille quand les billes sont à l'honneur
};

/** Pseudo-aléatoire déterministe (même morceau → mêmes plans). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Temps forts : grosse caisse et caisse claire s'il y a une batterie, sinon toutes les attaques. */
function strongBeats(ensemble) {
  const kit = ensemble.instruments.find((i) => i.kind === 'drums')?.model;
  const times = kit
    ? kit.pieces.filter((p) => p.name === 'kick' || p.name === 'snare' || p.name === 'crash').flatMap((p) => p.hits.filter((h) => h.velocity >= 0.6).map((h) => h.time))
    : [];
  const all = times.length ? times : ensemble.instruments.flatMap((i) => i.onsets);
  return [...new Set(all)].sort((a, b) => a - b);
}

/**
 * @param ensemble résultat de buildEnsemble
 * @returns { shots: [{start,end,type,subject,angle,dist,height,center,cut,…}], options, balls }
 */
export function planShots(ensemble, options = {}) {
  const o = { ...DIRECTOR_DEFAULTS, ...options };
  const R = ensemble.radius;
  const inst = ensemble.instruments;
  const random = rng(Math.round(ensemble.end * 1000) + inst.length * 7919);
  const t0 = Math.min(ensemble.start, 0);
  const t1 = Math.max(ensemble.end, t0 + 1);
  const beats = strongBeats(ensemble);
  const ballsIndex = inst.findIndex((i) => i.kind === 'balls');
  const ballsModel = ballsIndex >= 0 ? inst[ballsIndex].model : null;

  // Rythme moyen de chaque instrument, pour repérer ses moments forts.
  const rate = inst.map((i) => i.onsets.length / Math.max(1, t1 - t0));
  const first = inst.map((i) => i.onsets[0] ?? Infinity);
  // Entrées en scène : l'instrument sort du sol (voir sections.js) ; on le cadre pendant sa montée.
  const { rise } = SECTION_DEFAULTS;
  const grace = introGrace(ensemble);
  const entries = inst
    .map((ins, k) => ({ k, time: (ins.busy?.[0]?.[0] ?? Infinity) - rise }))
    .filter((e) => Number.isFinite(e.time) && e.time + rise > ensemble.start + grace)
    .sort((a, b) => a.time - b.time);

  const wide = () => ({
    type: 'wide',
    subject: -1,
    center: [0, 1, -R * 0.3],
    dist: R * 1.45 + 4.5,
    height: R * 0.5 + 2.5,
    angle: (random() - 0.5) * 0.9,
  });

  /** Plan cadré sur un instrument, d'un type tiré au sort. */
  const framed = (k) => {
    const ins = inst[k];
    const { center, radius } = ins.focus;
    const cam = { distScale: 1.7, minHeight: 0, allowLow: true, ...ins.camera };
    const angle = (ins.front ?? 0) + (random() - 0.5) * 1.1;
    const r = random();
    const base = { subject: k, center, angle };
    const dist = radius * cam.distScale + 1.5;
    const height = Math.max(cam.minHeight, radius * 0.45 + 0.8);
    if (cam.allowLow && r < 0.22) return { ...base, type: 'low', dist: radius * 1.3 + 1.5, height: 0.6 - center[1] * 0.5 };
    if (r < 0.42) return { ...base, type: 'dolly', dist: dist * 0.9, height, travel: (random() < 0.5 ? -1 : 1) * Math.min(3.5, radius * 1.4) };
    if (r < 0.58) {
      const up = random() < 0.5;
      return { ...base, type: 'crane', dist, height: up ? Math.max(cam.minHeight, 0.4) : height + 2.2, height2: up ? height + 2.2 : Math.max(cam.minHeight, height * 0.7) };
    }
    return { ...base, type: 'close', dist, height };
  };

  /** Bille à suivre : lancée dans les premières secondes du plan, la plus forte (note accentuée). */
  const followBall = (t) => {
    if (!ballsModel) return -1;
    const balls = ballsModel.balls;
    let best = -1;
    let bestScore = 0.8; // au moins 0,8 s de vol
    for (let i = lowerBound(balls, t + 0.2, (b) => b.launch); i < balls.length && balls[i].launch < t + 1.2; i++) {
      const b = balls[i];
      const score = b.lastImpact - b.launch + 0.5 * b.velocity;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  };

  const shots = [];
  let t = t0;
  let lastSubject = -2;
  let sinceWide = 0;
  let entry = 0;
  let cutPending = false; // le plan précédent s'est terminé sur un temps fort : coupe franche
  while (t < t1) {
    const cut = cutPending && shots.length > 0;
    cutPending = false;
    let end = Math.min(t1, t + lerp(o.minShot, o.maxShot, random()));
    let shot = null;
    while (entry < entries.length && entries[entry].time < t - 0.6) entry++;
    const e = entries[entry];
    if (e && e.time <= t + 0.6) {
      // Entrée en scène : l'instrument monte du sol, on le cadre jusqu'après sa première note.
      const ins = inst[e.k];
      const { center, radius } = ins.focus;
      shot = {
        type: 'crane',
        entry: true,
        subject: e.k,
        center,
        angle: (ins.front ?? 0) + (random() - 0.5) * 0.5,
        dist: radius * 1.5 + 2,
        height: Math.max(0.6, radius * 0.6 + 1.4),
        height2: Math.max(0.5, radius * 0.35 + 0.6),
      };
      end = Math.min(t1, Math.max(t + 3, e.time + rise + 2.2));
      entry++;
      // Entrées rapprochées : on enchaîne sur la suivante.
      const following = entries[entry];
      if (following && following.time < end) end = Math.max(t + 2.4, following.time);
    } else {
      // Une entrée imminente impose la fin du plan.
      if (e && e.time < end + 1.5) end = Math.max(t + 1.5, e.time);
      else {
        // Fin de plan calée sur le temps fort le plus proche.
        const i = lowerBound(beats, end);
        const near = [beats[i - 1], beats[i]].filter((b) => b !== undefined && Math.abs(b - end) <= o.snap && b > t + o.minShot * 0.6);
        if (near.length) {
          end = Math.min(t1, near.sort((a, b) => Math.abs(a - end) - Math.abs(b - end))[0]);
          cutPending = random() < o.cutChance;
        }
      }
      // Score : activité dans le segment rapportée à l'activité habituelle, bonus d'entrée.
      let best = -1;
      let bestScore = 0;
      inst.forEach((ins, k) => {
        const n = countOnsets(ins.onsets, t, end);
        if (!n) return;
        let score = n / (rate[k] * (end - t) + 1);
        if (first[k] >= t && first[k] < end) score += 2; // l'instrument fait son entrée
        if (k === lastSubject) score *= 0.5; // variété
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      });

      if (best < 0 || sinceWide >= 3 || (shots.length === 0 && inst.length > 1)) {
        shot = wide();
        sinceWide = 0;
      } else {
        const ball = best === ballsIndex && random() < o.followChance ? followBall(t) : -1;
        if (ball >= 0) {
          const b = ballsModel.balls[ball];
          shot = { type: 'follow', subject: best, ball, center: inst[best].focus.center, side: random() < 0.5 ? -1 : 1 };
          end = Math.min(t1, Math.max(end, b.lastImpact + 0.7));
          cutPending = false;
        } else shot = framed(best);
        sinceWide++;
      }
    }
    shot.start = t;
    shot.end = end;
    shot.spin = (random() < 0.5 ? -1 : 1) * o.orbitSpeed;
    shot.cut = cut;
    shots.push(shot);
    lastSubject = shot.subject;
    t = end;
  }
  return { shots, options: o, balls: ballsModel };
}

const tmp = [0, 0, 0];
/** Position lissée d'une bille (moyenne sur ±0,25 s, bornée à sa durée de vie). */
function smoothBall(ch, b, t, out) {
  out[0] = out[1] = out[2] = 0;
  const n = 7;
  for (let k = 0; k < n; k++) {
    const tk = clamp(t + (k - 3) * 0.08, b.launch, b.end);
    ballPosition(ch, b, tk, tmp);
    out[0] += tmp[0] / n;
    out[1] += tmp[1] / n;
    out[2] += tmp[2] / n;
  }
  return out;
}

function shotPose(plan, shot, t) {
  const u = clamp((t - shot.start) / Math.max(1e-3, shot.end - shot.start), 0, 1);
  if (shot.type === 'follow' && plan.balls) {
    const ch = plan.balls;
    const b = ch.balls[shot.ball];
    const target = smoothBall(ch, b, clamp(t, b.launch, b.lastImpact + 0.5), [0, 0, 0]);
    // Caméra à l'intérieur de l'arc, dans l'axe de la bille, un peu de côté et en hauteur.
    const a = Math.atan2(target[0], -target[2]) + shot.side * 0.35;
    const r = ch.radius * 0.42;
    return { position: [Math.sin(a) * r, 2.1 + target[1] * 0.3, -Math.cos(a) * r], target, aperture: 1 };
  }
  const [cx, cy, cz] = shot.center;
  const a = shot.angle + shot.spin * (t - shot.start);
  let height = shot.height;
  let px = cx + Math.sin(a) * shot.dist;
  let pz = cz + Math.cos(a) * shot.dist;
  let target = shot.center;
  if (shot.type === 'dolly') {
    // Travelling : la caméra glisse sur un rail perpendiculaire à l'axe de visée.
    const s = (smoothstep(u) - 0.5) * shot.travel;
    px += Math.cos(a) * s;
    pz -= Math.sin(a) * s;
    target = [cx + Math.cos(a) * s * 0.3, cy, cz - Math.sin(a) * s * 0.3];
  } else if (shot.type === 'crane') {
    height = lerp(shot.height, shot.height2, smoothstep(u));
  }
  const aperture = shot.type === 'wide' ? 0.25 : shot.type === 'low' ? 0.9 : 0.7;
  return { position: [px, cy + height, pz], target, aperture };
}

/**
 * Pose de la caméra à l'instant t : position, point visé, distance de mise au point
 * (`focus`) et ouverture relative du diaphragme (`aperture`, 0 = tout net).
 */
export function cameraAt(plan, t) {
  const { shots, options } = plan;
  if (!shots.length) return { position: [0, 8, 14], target: [0, 1, 0], focus: 15, aperture: 0 };
  let i = shots.findIndex((s) => t < s.end);
  if (i < 0) i = shots.length - 1;
  let pose = shotPose(plan, shots[i], t);
  if (i > 0 && !shots[i].cut && t < shots[i].start + options.blend) {
    // Glissement depuis le plan précédent (qui continue son mouvement pendant le fondu).
    const prev = shotPose(plan, shots[i - 1], t);
    const s = smoothstep((t - shots[i].start) / options.blend);
    const mix = (a, b) => a.map((v, k) => lerp(v, b[k], s));
    pose = { position: mix(prev.position, pose.position), target: mix(prev.target, pose.target), aperture: lerp(prev.aperture, pose.aperture, s) };
  }
  const focus = Math.hypot(...pose.position.map((v, k) => v - pose.target[k]));
  return { ...pose, focus };
}
