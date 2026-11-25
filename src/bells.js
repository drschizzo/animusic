// Carillon de cloches tubulaires : module pur (sans Three.js).
//
// Une cloche par hauteur jouée, suspendue à un portique, grave (longue) à
// gauche. Chaque cloche a son marteau, articulé derrière elle : il recule avant
// le coup, touche le haut du tube pile à l'instant de la note, puis la cloche
// se balance comme un pendule amorti.
//
// Coordonnées locales : x le long du portique, y vers le haut, z vers le public.

import { lerp, lowerBound, strikeLift, lastHitPulse } from './util.js';

export const BELL_DEFAULTS = {
  spacing: 0.36,
  maxWidth: 5.2,
  lenLow: 2.5, // longueur du tube le plus grave
  lenHigh: 0.8,
  top: 3.7, // hauteur de la traverse
  cord: 0.16, // longueur de la suspension
  strikeTime: 0.28,
  restLift: 0.28,
  hammerLift: 0.95, // rotation (rad) du marteau à levée maximale
  swing: 0.13, // amplitude (rad) du balancement pour une frappe forte
  swingDecay: 1.5,
  pulseDecay: 2.2,
};

export function buildBells(notes, options = {}) {
  const o = { ...BELL_DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = [...new Set(sorted.map((n) => n.midi))].sort((a, b) => a - b);
  const n = pitches.length;
  const spacing = Math.min(o.spacing, o.maxWidth / Math.max(1, n));
  const bells = pitches.map((midi, i) => {
    const u = n > 1 ? i / (n - 1) : 0.5;
    const length = lerp(o.lenLow, o.lenHigh, u);
    return {
      index: i,
      midi,
      u,
      x: (i - (n - 1) / 2) * spacing,
      length,
      // Pendule : la pulsation dépend de la distance du centre de masse au point d'attache.
      omega: Math.sqrt(9.8 / (o.cord + length / 2)),
      hits: [],
    };
  });
  const byMidi = new Map(bells.map((b) => [b.midi, b]));
  for (const note of sorted) byMidi.get(note.midi).hits.push({ time: note.time, velocity: note.velocity, track: note.track });
  return {
    options: o,
    origin: o.origin ?? [0, 0, 0],
    yaw: o.yaw ?? 0,
    spacing,
    width: n * spacing + 0.8,
    bells,
    onsets: sorted.map((n) => n.time),
  };
}

/** Angle du marteau (rad) : 0 au contact avec la cloche, positif en arrière. */
export function hammerAngle(model, bell, t) {
  const o = model.options;
  return o.hammerLift * strikeLift(bell.hits, t, { rest: o.restLift, window: o.strikeTime });
}

/**
 * Balancement et éclat d'une cloche à l'instant t. Le balancement est la somme
 * des réponses aux frappes récentes : il reste continu quand les coups se suivent.
 */
export function bellState(model, bell, t) {
  const o = model.options;
  const hits = bell.hits;
  let angle = 0;
  const horizon = t - 5 / o.swingDecay;
  for (let i = lowerBound(hits, t, (h) => h.time) - 1; i >= 0 && hits[i].time >= horizon; i--) {
    const s = t - hits[i].time;
    angle += hits[i].velocity * o.swing * Math.exp(-s * o.swingDecay) * Math.sin(bell.omega * s);
  }
  // lowerBound exclut une frappe à l'instant exact t : sa contribution au balancement est nulle.
  return { angle, ...lastHitPulse(hits, t, o.pulseDecay) };
}
