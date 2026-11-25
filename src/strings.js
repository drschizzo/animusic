// Basse à cordes pincées : module pur (sans Three.js).
//
// Une corde verticale par hauteur jouée. Des chariots coulissent sur un rail
// devant les cordes ; chacun porte un médiator qui se place devant la corde
// suivante puis la traverse pile à l'instant de la note (aller, puis retour au
// coup suivant). La corde vibre ensuite, amortie après la fin de la note.
//
// Coordonnées locales : x le long du rail, y vers le haut, z vers le centre de
// la scène (côté médiator). Le placement dans la scène est donné par origin + yaw.

import { upperBound, smoothstep, lerp } from './util.js';

export const STRING_DEFAULTS = {
  spacing: 0.32,
  maxWidth: 5,
  lenLow: 3.0, // longueur de la corde la plus grave
  lenHigh: 1.6,
  bottom: 0.45, // hauteur du chevalet bas
  pickY: 0.95, // hauteur du rail des chariots
  pickOffset: 0.14, // distance de repos du médiator au plan des cordes
  pluckTime: 0.06, // demi-durée du geste de pincement
  carriers: 2,
  minGap: 0.12, // délai minimal entre deux pincements d'un même chariot
  damp: 1.6, // amortissement pendant la note
  release: 8, // amortissement après la fin de la note
};

/**
 * @param {Array<{midi,time,duration,velocity,track}>} notes
 * @param {{origin?:number[], yaw?:number}} options
 */
export function buildBassStrings(notes, options = {}) {
  const o = { ...STRING_DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = [...new Set(sorted.map((n) => n.midi))].sort((a, b) => a - b);
  const n = pitches.length;
  const spacing = Math.min(o.spacing, o.maxWidth / Math.max(1, n));
  const strings = pitches.map((midi, i) => {
    const u = n > 1 ? i / (n - 1) : 0.5;
    return { index: i, midi, u, x: (i - (n - 1) / 2) * spacing, length: lerp(o.lenLow, o.lenHigh, u), hits: [] };
  });
  const byMidi = new Map(strings.map((s) => [s.midi, s]));

  const carriers = Array.from({ length: Math.min(o.carriers, n) }, (_, i) => ({ index: i, shots: [], last: -Infinity }));
  for (const note of sorted) {
    const s = byMidi.get(note.midi);
    let best = null;
    let bestScore = Infinity;
    for (const c of carriers) {
      const lastX = c.shots.length ? c.shots[c.shots.length - 1].x : s.x;
      const free = c.last <= note.time - o.minGap;
      const score = free ? Math.abs(lastX - s.x) : 1000 + c.last;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    // Le médiator alterne aller / retour à chaque pincement.
    const dir = best.shots.length % 2 === 0 ? 1 : -1;
    best.shots.push({ time: note.time, x: s.x, dir });
    best.last = note.time;
    s.hits.push({ time: note.time, duration: note.duration, velocity: note.velocity, track: note.track });
  }

  const width = n * spacing + 0.6;
  return {
    options: o,
    origin: o.origin ?? [0, 0, 0],
    yaw: o.yaw ?? 0,
    spacing,
    width,
    strings,
    carriers,
    onsets: sorted.map((n) => n.time),
  };
}

/** Position du chariot (x) et du médiator (z) à l'instant t. */
export function carrierPose(model, carrier, t) {
  const o = model.options;
  const shots = carrier.shots;
  const i = upperBound(shots, t, (s) => s.time) - 1;
  const prev = shots[i];
  const next = shots[i + 1];
  const a = o.pickOffset;
  const gap = prev && next ? next.time - prev.time : Infinity;
  const w = Math.min(o.pluckTime, gap * 0.3);
  const sweep = (shot) => -shot.dir * a * Math.sin((Math.PI / 2) * ((t - shot.time) / w));

  let x;
  if (!prev) x = next ? next.x : 0;
  else if (!next) x = prev.x;
  else {
    const moveStart = prev.time + Math.min(0.08, gap * 0.3);
    const moveEnd = next.time - w;
    x = lerp(prev.x, next.x, smoothstep((t - moveStart) / Math.max(1e-6, moveEnd - moveStart)));
  }

  let z;
  if (next && t >= next.time - w) z = sweep(next);
  else if (prev && t <= prev.time + w) z = sweep(prev);
  else if (prev) z = -prev.dir * a;
  else z = next ? next.dir * a : a;
  return { x, z };
}

/** Amplitude de vibration d'une corde à l'instant t. */
export function stringVibration(model, string, t) {
  const o = model.options;
  const i = upperBound(string.hits, t, (h) => h.time) - 1;
  if (i < 0) return { amp: 0, since: Infinity, track: -1 };
  const h = string.hits[i];
  const since = t - h.time;
  let amp = h.velocity * Math.exp(-since * o.damp);
  const off = h.time + h.duration;
  if (t > off) amp *= Math.exp(-(t - off) * o.release);
  return { amp, since, track: h.track };
}
