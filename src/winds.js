// Vents (cuivres, anches, flûtes) : module pur.
//
// Un tuyau par hauteur jouée. Le son naît du souffle : une soupape s'ouvre juste
// avant la note (anticipation), l'air passe pendant toute sa durée et sort par le
// pavillon (cuivres, anches) ou par le haut du tuyau (flûtes de Pan), puis la soupape
// se referme. Le style dépend du timbre de la piste :
//   brass : cors dorés à pavillon évasé, piston enfoncé pendant la note ;
//   reed  : corps noir et pavillon argenté (clarinette, saxophone) ;
//   flute : flûte de Pan, tuyaux verticaux argentés soufflés par une buse.
//
// Coordonnées locales : x le long de la rangée, y vers le haut, z vers le public.

import { lerp, controlAt } from './util.js';
import { sustainState } from './pipes.js';

export const WIND_DEFAULTS = {
  spacing: 0.34,
  maxWidth: 5.2,
  lenLow: 1.5, // longueur du tuyau le plus grave
  lenHigh: 0.55,
  attack: 0.05,
  release: 0.16,
  anticipation: 0.15,
};

/** Style visuel d'après le programme General MIDI de la piste principale. */
export function windStyle(program) {
  if (program >= 56 && program <= 63) return 'brass';
  if ((program >= 64 && program <= 71) || program === 109 || program === 111) return 'reed';
  return 'flute';
}

export function buildWinds(notes, options = {}) {
  const o = { ...WIND_DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = [...new Set(sorted.map((n) => n.midi))].sort((a, b) => a - b);
  const n = pitches.length;
  const spacing = Math.min(o.spacing, o.maxWidth / Math.max(1, n));
  const pipes = pitches.map((midi, i) => {
    const u = n > 1 ? i / (n - 1) : 0.5;
    return { index: i, midi, u, x: (i - (n - 1) / 2) * spacing, length: lerp(o.lenLow, o.lenHigh, u), notes: [], maxDur: 0 };
  });
  const byMidi = new Map(pipes.map((p) => [p.midi, p]));
  for (const note of sorted) {
    const p = byMidi.get(note.midi);
    const duration = Math.max(0.06, note.duration);
    p.notes.push({ start: note.time, end: note.time + duration, velocity: note.velocity, track: note.track });
    p.maxDur = Math.max(p.maxDur, duration);
  }
  return {
    options: o,
    origin: o.origin ?? [0, 0, 0],
    yaw: o.yaw ?? 0,
    style: o.style ?? 'brass',
    spacing,
    width: n * spacing + 0.7,
    pipes,
    controls: o.controls ?? {},
    onsets: sorted.map((x) => x.time),
  };
}

/** État d'un tuyau : souffle (level 0..1), soupape (valve 0..1), piste, vibrato (modulation). */
export function windState(model, pipe, t) {
  const s = sustainState(pipe.notes, pipe.maxDur, model.options, t);
  const vibrato = s.track >= 0 ? controlAt(model.controls[s.track]?.mod, t) : 0;
  return { ...s, vibrato };
}
