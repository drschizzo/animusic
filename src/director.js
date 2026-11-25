// Réalisateur caméra : module pur. Comme la partition est connue d'avance, la
// liste des plans est calculée une fois pour tout le morceau, en fonction de
// l'activité de chaque instrument. La caméra glisse ensuite d'un plan à l'autre.

import { countOnsets, smoothstep, lerp } from './util.js';

export const DIRECTOR_DEFAULTS = {
  minShot: 3.5,
  maxShot: 6.5,
  blend: 1.4, // durée du fondu de mouvement entre deux plans
  orbitSpeed: 0.06, // rad/s : lente rotation pendant un plan
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

/**
 * @param ensemble résultat de buildEnsemble
 * @returns { shots: [{start,end,type,subject,angle,dist,height,center}], options }
 */
export function planShots(ensemble, options = {}) {
  const o = { ...DIRECTOR_DEFAULTS, ...options };
  const R = ensemble.radius;
  const inst = ensemble.instruments;
  const random = rng(Math.round(ensemble.end * 1000) + inst.length * 7919);
  const t0 = Math.min(ensemble.start, 0);
  const t1 = Math.max(ensemble.end, t0 + 1);

  // Rythme moyen de chaque instrument, pour repérer ses moments forts.
  const rate = inst.map((i) => i.onsets.length / Math.max(1, t1 - t0));
  const first = inst.map((i) => i.onsets[0] ?? Infinity);

  const wide = () => ({
    type: 'wide',
    subject: -1,
    center: [0, 1, -R * 0.3],
    dist: R * 1.25 + 3,
    height: R * 0.5 + 2.5,
    angle: (random() - 0.5) * 0.9,
  });

  const shots = [];
  let t = t0;
  let lastSubject = -2;
  let sinceWide = 0;
  while (t < t1) {
    const len = lerp(o.minShot, o.maxShot, random());
    const end = Math.min(t1, t + len);
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

    let shot;
    if (best < 0 || sinceWide >= 3 || (shots.length === 0 && inst.length > 1)) {
      shot = wide();
      sinceWide = 0;
    } else {
      const ins = inst[best];
      const { center, radius } = ins.focus;
      const cam = { distScale: 1.7, minHeight: 0, allowLow: true, ...ins.camera };
      const low = cam.allowLow && random() < 0.3;
      shot = {
        type: low ? 'low' : 'close',
        subject: best,
        center,
        dist: radius * (low ? 1.3 : cam.distScale) + 1.5,
        height: low ? 0.6 - center[1] * 0.5 : Math.max(cam.minHeight, radius * 0.45 + 0.8),
        // Face à l'instrument, avec un léger décalage de côté.
        angle: (ins.front ?? 0) + (random() - 0.5) * 1.1,
      };
      sinceWide++;
    }
    shot.start = t;
    shot.end = end;
    shot.spin = (random() < 0.5 ? -1 : 1) * o.orbitSpeed;
    shots.push(shot);
    lastSubject = shot.subject;
    t = end;
  }
  return { shots, options: o };
}

function shotPose(shot, t) {
  const a = shot.angle + shot.spin * (t - shot.start);
  const [cx, cy, cz] = shot.center;
  return {
    position: [cx + Math.sin(a) * shot.dist, cy + shot.height, cz + Math.cos(a) * shot.dist],
    target: shot.center,
  };
}

/** Pose de la caméra à l'instant t : position + point visé. */
export function cameraAt(plan, t) {
  const { shots, options } = plan;
  if (!shots.length) return { position: [0, 8, 14], target: [0, 1, 0] };
  let i = shots.findIndex((s) => t < s.end);
  if (i < 0) i = shots.length - 1;
  const cur = shotPose(shots[i], t);
  if (i === 0 || t >= shots[i].start + options.blend) return cur;
  // Glissement depuis le plan précédent (qui continue son mouvement pendant le fondu).
  const prev = shotPose(shots[i - 1], t);
  const s = smoothstep((t - shots[i].start) / options.blend);
  const mix = (a, b) => a.map((v, k) => lerp(v, b[k], s));
  return { position: mix(prev.position, cur.position), target: mix(prev.target, cur.target) };
}
