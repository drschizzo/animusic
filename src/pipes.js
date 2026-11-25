// Tubes d'orgue lumineux pour les notes tenues (nappes, accords, cordes) :
// module pur. Un tube par hauteur ; une colonne de lumière y monte pendant
// toute la durée de la note. Une valve à la base s'ouvre juste avant la note
// (anticipation), puis la lumière retombe après la fin de la note.
//
// Coordonnées locales : x le long de la rangée, z vers le centre de la scène.

import { upperBound, lerp } from './util.js';

export const PIPE_DEFAULTS = {
  spacing: 0.42,
  maxWidth: 6,
  hLow: 3.4, // hauteur du tube le plus grave
  hHigh: 1.3,
  attack: 0.08,
  release: 0.45,
  anticipation: 0.18,
};

export function buildPipes(notes, options = {}) {
  const o = { ...PIPE_DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = [...new Set(sorted.map((n) => n.midi))].sort((a, b) => a - b);
  const n = pitches.length;
  const spacing = Math.min(o.spacing, o.maxWidth / Math.max(1, n));
  const pipes = pitches.map((midi, i) => {
    const u = n > 1 ? i / (n - 1) : 0.5;
    return { index: i, midi, u, x: (i - (n - 1) / 2) * spacing, height: lerp(o.hLow, o.hHigh, u), notes: [], maxDur: 0 };
  });
  const byMidi = new Map(pipes.map((p) => [p.midi, p]));
  for (const note of sorted) {
    const p = byMidi.get(note.midi);
    const duration = Math.max(0.05, note.duration);
    p.notes.push({ start: note.time, end: note.time + duration, velocity: note.velocity, track: note.track });
    p.maxDur = Math.max(p.maxDur, duration);
  }
  return {
    options: o,
    origin: o.origin ?? [0, 0, 0],
    yaw: o.yaw ?? 0,
    spacing,
    width: n * spacing + 0.6,
    pipes,
    onsets: sorted.map((n) => n.time),
  };
}

/**
 * État d'un tube à l'instant t.
 * level : hauteur de la colonne de lumière (0..1), valve : ouverture (0..1), track : piste.
 */
export function pipeState(model, pipe, t) {
  const o = model.options;
  let level = 0;
  let valve = 0;
  let track = -1;
  // Seules les notes commencées depuis moins de maxDur + release peuvent encore briller.
  const horizon = t - pipe.maxDur - o.release;
  for (let i = upperBound(pipe.notes, t + o.anticipation, (n) => n.start) - 1; i >= 0; i--) {
    const n = pipe.notes[i];
    if (n.start < horizon) break;
    let l;
    let v;
    if (t < n.start) {
      l = 0;
      v = (t - (n.start - o.anticipation)) / o.anticipation;
    } else {
      const peak = Math.min(1, (Math.min(t, n.end) - n.start) / o.attack);
      const fade = t <= n.end ? 1 : Math.max(0, 1 - (t - n.end) / o.release) ** 2;
      l = peak * fade * (0.6 + 0.4 * n.velocity);
      v = fade;
    }
    if (l > level) track = n.track;
    level = Math.max(level, l);
    valve = Math.max(valve, v);
  }
  return { level, valve: Math.min(1, Math.max(0, valve)), track };
}
