// Harpe laser pour les lignes mélodiques tenues (solistes, cuivres, bois, leads) :
// module pur. Un émetteur par hauteur, disposés en éventail ; chacun tire un
// rayon vers un cristal suspendu pendant toute la durée de la note. L'iris de
// l'émetteur s'ouvre juste avant (anticipation), le cristal brille de la somme
// des rayons qu'il reçoit.
//
// Coordonnées locales : x le long de la console, y vers le haut, z vers le public.

import { sustainState } from './pipes.js';
import { controlAt } from './util.js';

export const LASER_DEFAULTS = {
  spacing: 0.3,
  maxWidth: 4.6,
  curve: 0.07, // courbure de la console (les extrémités avancent vers le public)
  emitterY: 0.55, // hauteur de sortie des rayons
  focusHeight: 3.3, // hauteur du cristal
  attack: 0.035,
  release: 0.16,
  anticipation: 0.22,
};

export function buildLaserHarp(notes, options = {}) {
  const o = { ...LASER_DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = [...new Set(sorted.map((n) => n.midi))].sort((a, b) => a - b);
  const n = pitches.length;
  const spacing = Math.min(o.spacing, o.maxWidth / Math.max(1, n));
  const emitters = pitches.map((midi, i) => {
    const x = (i - (n - 1) / 2) * spacing;
    return { index: i, midi, u: n > 1 ? i / (n - 1) : 0.5, position: [x, o.emitterY, o.curve * x * x], notes: [], maxDur: 0 };
  });
  const byMidi = new Map(emitters.map((e) => [e.midi, e]));
  for (const note of sorted) {
    const e = byMidi.get(note.midi);
    const duration = Math.max(0.05, note.duration);
    e.notes.push({ start: note.time, end: note.time + duration, velocity: note.velocity, track: note.track });
    e.maxDur = Math.max(e.maxDur, duration);
  }
  return {
    options: o,
    origin: o.origin ?? [0, 0, 0],
    yaw: o.yaw ?? 0,
    spacing,
    width: n * spacing + 0.8,
    focus: [0, o.focusHeight, 0],
    // Contrôleurs expressifs par piste : { [track]: { bends, mod } }.
    controls: o.controls ?? {},
    emitters,
    onsets: sorted.map((n) => n.time),
  };
}

/** État d'un émetteur : level (intensité du rayon), valve (ouverture de l'iris), track. */
export function laserState(model, emitter, t) {
  return sustainState(emitter.notes, emitter.maxDur, model.options, t);
}

/** Énergie reçue par le cristal (somme des rayons, 0..1) et piste dominante. */
export function crystalState(model, t) {
  let energy = 0;
  let best = 0;
  let track = -1;
  for (const e of model.emitters) {
    const s = laserState(model, e, t);
    energy += s.level;
    if (s.level > best) {
      best = s.level;
      track = s.track;
    }
  }
  return { energy: Math.min(1, energy), track };
}

/**
 * Expression d'une piste à l'instant t : bend (−1..1, le rayon se courbe) et
 * modulation (0..1, le rayon ondule).
 */
export function laserExpression(model, track, t) {
  const c = model.controls[track];
  return { bend: controlAt(c?.bends, t), mod: controlAt(c?.mod, t) };
}
