// Cordes frottées (violon, alto, violoncelle…) : module pur.
//
// Les cordes sont tendues verticalement sur le pourtour d'une cage circulaire, la
// plus grave (la plus longue) d'abord : leurs sommets dessinent une spirale. Autour
// de la cage, chaque archet tourne sur son propre anneau (à sa hauteur, ils ne se
// croisent jamais), se place devant la corde de la note, s'y pose juste avant
// l'attaque et la frotte pendant toute la durée de la note en glissant le long de
// la tangente (un archet tangent au cercle ne touche qu'une seule corde). Il tire
// et pousse alternativement, comme un musicien.
//
// Coordonnées locales : axe de la cage selon y, angle 0 face au public (+z).

import { upperBound, smoothstep, lerp, clamp, easeBack, controlAt } from './util.js';

export const BOWED_DEFAULTS = {
  spacing: 0.26, // écart entre cordes sur le pourtour
  minRadius: 0.85,
  bottom: 0.5, // hauteur du cordier
  lenLow: 3.0,
  lenHigh: 1.6,
  bows: 3,
  bowY: 1.05, // hauteur de l'anneau du premier archet
  bowStep: 0.24, // écart vertical entre les anneaux
  bowLength: 1.5,
  approach: 0.14, // l'archet se pose avant la note
  lift: 0.1, // et se relève après
  minMove: 0.12, // durée minimale d'un déplacement entre deux cordes
  attack: 0.09,
  release: 0.35,
};

export function buildBowed(notes, options = {}) {
  const o = { ...BOWED_DEFAULTS, ...options };
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = [...new Set(sorted.map((n) => n.midi))].sort((a, b) => a - b);
  const n = pitches.length;
  const radius = Math.max(o.minRadius, (n * o.spacing) / (2 * Math.PI));
  // Les cordes occupent 330° : l'ouverture, à l'arrière, sépare la plus grave de la plus aiguë.
  const span = (Math.PI * 2 * 330) / 360;
  const strings = pitches.map((midi, i) => {
    const u = n > 1 ? i / (n - 1) : 0.5;
    return {
      index: i,
      midi,
      u,
      angle: span / 2 - (n > 1 ? u * span : span / 2), // position (sin a, cos a) · radius ; ouverture à l arrière
      length: lerp(o.lenLow, o.lenHigh, u),
      notes: [],
    };
  });
  const byMidi = new Map(strings.map((s) => [s.midi, s]));

  const bows = Array.from({ length: Math.min(o.bows, Math.max(1, n)) }, (_, k) => ({
    index: k,
    y: o.bowY + k * o.bowStep,
    strokes: [],
  }));
  for (const note of sorted) {
    const s = byMidi.get(note.midi);
    const start = note.time;
    const end = note.time + Math.max(0.12, note.duration);
    s.notes.push({ start, end, velocity: note.velocity, track: note.track });
    // Archet libre le plus proche (en angle) ; sinon celui qui se libère le premier,
    // dont on écourte le coup d'archet précédent.
    let best = null;
    let bestScore = Infinity;
    for (const b of bows) {
      const last = b.strokes[b.strokes.length - 1];
      const free = !last || last.end + o.lift + o.minMove + o.approach <= start;
      const dist = last ? Math.abs(angleDiff(last.angle, s.angle)) : 0;
      const score = free ? dist : 1000 + (last?.end ?? 0);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    const last = best.strokes[best.strokes.length - 1];
    if (last && last.end + o.lift + o.minMove + o.approach > start) {
      last.end = Math.max(last.start + 0.05, start - o.lift - o.minMove - o.approach);
    }
    const dir = best.strokes.length % 2 === 0 ? 1 : -1;
    // Longueur du coup d'archet : plus longue pour une note longue ou forte, bornée par l'archet.
    const length = clamp((end - start) * (0.5 + 0.6 * note.velocity), 0.15, o.bowLength * 0.75);
    best.strokes.push({ start, end, angle: s.angle, string: s.index, dir, length, velocity: note.velocity, track: note.track });
  }
  for (const s of strings) s.maxDur = Math.max(0, ...s.notes.map((x) => x.end - x.start));

  return {
    options: o,
    origin: o.origin ?? [0, 0, 0],
    yaw: o.yaw ?? 0,
    radius,
    width: 2 * (radius + 0.9),
    strings,
    bows,
    controls: o.controls ?? {},
    onsets: sorted.map((x) => x.time),
  };
}

/** Écart angulaire signé le plus court de a vers b. */
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Pose d'un archet à l'instant t :
 *  angle : position sur son anneau (rad) ; press : 0 écarté … 1 posé sur la corde ;
 *  stroke : décalage (m) le long de la tangente ; playing : coup en cours (0..1) ; track.
 */
export function bowPose(model, bow, t) {
  const o = model.options;
  const strokes = bow.strokes;
  if (!strokes.length) return { angle: 0, press: 0, stroke: 0, playing: 0, track: -1 };
  const i = upperBound(strokes, t + o.approach, (s) => s.start) - 1;
  const cur = strokes[Math.max(0, i)];
  const next = strokes[i + 1];
  // Le coup d'archet va de −dir·L/2 à +dir·L/2 pendant la note.
  const startX = (s) => (-s.dir * s.length) / 2;
  const endX = (s) => (s.dir * s.length) / 2;

  if (i < 0) {
    return { angle: cur.angle, press: 0, stroke: startX(cur), playing: 0, track: cur.track };
  }
  let angle = cur.angle;
  let stroke;
  let press;
  let playing = 0;
  if (t < cur.start) {
    // Approche : l'archet se pose.
    press = smoothstep((t - (cur.start - o.approach)) / o.approach);
    stroke = startX(cur);
  } else if (t <= cur.end) {
    press = 1;
    const u = (t - cur.start) / (cur.end - cur.start);
    stroke = lerp(startX(cur), endX(cur), u);
    playing = 1;
  } else {
    press = 1 - smoothstep((t - cur.end) / o.lift);
    stroke = endX(cur);
    if (next) {
      // Déplacement vers la corde suivante, une fois relevé, avec anticipation et dépassement.
      const m0 = cur.end + o.lift;
      const m1 = next.start - o.approach;
      const s = m1 > m0 ? easeBack((t - m0) / (m1 - m0), 0.6) : t >= m1 ? 1 : 0;
      angle = cur.angle + angleDiff(cur.angle, next.angle) * s;
      stroke = lerp(endX(cur), startX(next), smoothstep((t - m0) / Math.max(1e-3, m1 - m0)));
    }
  }
  return { angle, press, stroke, playing, track: cur.track, velocity: cur.velocity };
}

/** Vibration d'une corde : amplitude (0..1), piste, et vibrato (modulation de la piste). */
export function bowedString(model, string, t) {
  const o = model.options;
  let amp = 0;
  let track = -1;
  const horizon = t - string.maxDur - o.release * 4;
  for (let i = upperBound(string.notes, t, (n) => n.start) - 1; i >= 0; i--) {
    const n = string.notes[i];
    if (n.start < horizon) break;
    const rise = Math.min(1, (t - n.start) / o.attack);
    const a = (t <= n.end ? rise : rise * Math.exp(-(t - n.end) / o.release)) * (0.55 + 0.45 * n.velocity);
    if (a > amp) {
      amp = a;
      track = n.track;
    }
  }
  const mod = track >= 0 ? controlAt(model.controls[track]?.mod, t) : 0;
  return { amp, track, vibrato: mod };
}
