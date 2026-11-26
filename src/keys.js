// Clavier mécanique : module pur. Un clavier de piano couvre l'étendue jouée ;
// la touche s'enfonce juste avant la note et reste tenue pendant sa durée.
// Derrière le clavier, chaque touche jouée a son marteau qui frappe une lame
// vibrante (comme un piano électrique) pile à l'instant de la note.
//
// Coordonnées locales : x le long du clavier, y vers le haut, z vers le public
// (le bord avant des touches est côté +z).

import { upperBound, smoothstep, lerp, strikeLift, sustainedEnd, pedalAt } from './util.js';
import { buildKeyRow } from './ballRow.js';

export const KEY_DEFAULTS = {
  whiteWidth: 0.118,
  maxWidth: 6.4,
  press: 0.07, // durée de l'enfoncement, avant la note
  releaseTime: 0.09,
  minHold: 0.05,
  strikeTime: 0.2,
  restLift: 0.22,
  hammerLift: 1.0, // rotation (rad) du marteau à levée maximale
  tineLow: 1.25, // hauteur de la lame la plus grave
  tineHigh: 0.45,
  damp: 2.2, // amortissement de la lame pendant la note
  release: 9, // amortissement après la fin de la note
  player: 'self', // 'self' = les touches s'enfoncent seules, 'balls' = une bille tombe sur chaque touche jouée
  keyTop: 0.92, // hauteur du dessus des touches blanches
  blackTop: 0.0425, // surépaisseur des touches noires
  whiteHit: 0.25, // profondeur (z) du point de frappe sur une touche blanche (partie avant, dégagée)
  blackHit: 0.09, // … et sur une touche noire
  rampAbove: 1.42, // hauteur de la rampe des buses des blanches au-dessus des touches
  blackRampAbove: 1.15, // … et de celle des noires, plus basse : les buses de deux demi-tons voisins ne se touchent
  // pas, et la bille d'une noire, qui tombe plus près des lames, passe sous les buses des blanches
  rampZ: -0.28, // profondeur des rampes : devant les lames vibrantes
};

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (midi) => BLACK.has(((midi % 12) + 12) % 12);

export function buildKeyboard(notes, options = {}) {
  const o = { ...KEY_DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  let lo = Math.min(...sorted.map((n) => n.midi));
  let hi = Math.max(...sorted.map((n) => n.midi));
  // Le clavier commence et finit sur une touche blanche, avec au moins une octave.
  while (hi - lo < 12) hi++;
  if (isBlack(lo)) lo--;
  if (isBlack(hi)) hi++;

  let whites = 0;
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites++;
  const keyWidth = Math.min(o.whiteWidth, o.maxWidth / whites);
  const keys = [];
  let w = 0;
  for (let midi = lo; midi <= hi; midi++) {
    const black = isBlack(midi);
    // Une touche noire est à cheval sur la limite entre deux blanches.
    const x = (black ? w - 0.5 : w + 0) * keyWidth - ((whites - 1) * keyWidth) / 2;
    keys.push({ index: keys.length, midi, black, x, u: (midi - lo) / (hi - lo), notes: [], hits: [] });
    if (!black) w++;
  }
  const sustain = o.sustain ?? [];
  for (const note of sorted) {
    const k = keys[note.midi - lo];
    const end = note.time + Math.max(o.minHold, note.duration);
    // ring : fin du son (la pédale de sustain le prolonge après le relâché de la touche).
    const ring = Math.max(end, sustainedEnd(note, sustain));
    k.notes.push({ start: note.time, end, ring, velocity: note.velocity, track: note.track });
    k.hits.push({ time: note.time, velocity: note.velocity, track: note.track });
  }
  for (const k of keys) {
    k.tine = lerp(o.tineLow, o.tineHigh, k.u);
    // La touche doit remonter avant d'être rejouée.
    k.notes.forEach((n, i) => {
      const next = k.notes[i + 1];
      n.off = next ? Math.max(n.start + Math.min(o.minHold, (next.start - n.start) * 0.4), Math.min(n.end, next.start - o.press - o.releaseTime)) : n.end;
    });
  }
  const model = {
    options: o,
    origin: o.origin ?? [0, 0, 0],
    yaw: o.yaw ?? 0,
    keyWidth,
    width: whites * keyWidth + 0.5,
    low: lo,
    keys,
    sustain,
    played: keys.filter((k) => k.hits.length),
    onsets: sorted.map((n) => n.time),
  };
  if (o.player === 'balls') {
    const half = model.width / 2;
    model.row = buildKeyRow(
      [
        { targets: model.played.filter((k) => !k.black), y: o.keyTop, z: o.whiteHit, axis: { y: o.keyTop + o.rampAbove, z: o.rampZ } },
        { targets: model.played.filter((k) => k.black), y: o.keyTop + o.blackTop, z: o.blackHit, axis: { y: o.keyTop + o.blackRampAbove, z: o.rampZ } },
      ],
      keyWidth,
      { span: [-half - 0.12, half + 0.12] },
    );
  }
  return model;
}

/** Enfoncement d'une touche (0 = relevée, 1 = à fond) à l'instant t. */
export function keyDepth(model, key, t) {
  const o = model.options;
  const notes = key.notes;
  // Avec les billes, la touche ne s'enfonce qu'à l'impact : tout le geste est retardé d'autant.
  if (model.row) t -= o.press;
  let depth = 0;
  const last = upperBound(notes, t + o.press, (n) => n.start) - 1;
  for (let i = last; i >= 0 && i >= last - 1; i--) {
    const n = notes[i];
    let d;
    if (t < n.start) d = smoothstep((t - (n.start - o.press)) / o.press);
    else if (t <= n.off) d = 1;
    else d = 1 - smoothstep((t - n.off) / o.releaseTime);
    depth = Math.max(depth, d);
  }
  return depth;
}

/** Angle du marteau (rad) : 0 au contact de la lame, positif en arrière. */
export function keyHammerAngle(model, key, t) {
  const o = model.options;
  return o.hammerLift * strikeLift(key.hits, t, { rest: o.restLift, window: o.strikeTime });
}

/** Vibration de la lame d'une touche : { amp, since, track }. */
export function tineVibration(model, key, t) {
  const o = model.options;
  const i = upperBound(key.notes, t, (n) => n.start) - 1;
  if (i < 0) return { amp: 0, since: Infinity, track: -1 };
  const n = key.notes[i];
  const since = t - n.start;
  let amp = n.velocity * Math.exp(-since * o.damp);
  if (t > n.ring) amp *= Math.exp(-(t - n.ring) * o.release);
  return { amp, since, track: n.track };
}

/** Pédale de sustain : 0 relevée, 1 enfoncée (les étouffoirs s'écartent des lames). */
export function sustainPedal(model, t) {
  return pedalAt(model.sustain, t);
}
