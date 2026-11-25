// Répartit une transcription (un seul flux de notes + coups de batterie) en pistes
// jouables par les instruments de la scène. Module pur.
//
// - Basse : notes graves, réduites à une ligne monophonique (la plus grave à chaque attaque).
// - Orgue : notes longues (nappes, accords tenus).
// - Billes : le reste, avec une polyphonie limitée pour rester lisible.
// - Batterie : coups détectés (drumDetect.js).

export const ARRANGE_DEFAULTS = {
  minVelocity: 0.25, // en dessous : souvent des harmoniques ou du bruit
  bassMax: null, // note MIDI la plus aiguë considérée comme basse ; null = adaptatif
  bassBelowMedian: 5, // adaptatif : médiane des hauteurs du morceau moins une quarte (réglé avec tools/audio-bench.cjs)...
  bassRange: [45, 60], // ... bornée à cette plage
  padMinDuration: 0.9, // secondes
  chordWindow: 0.035, // attaques regroupées en un même accord
  maxPolyphony: 5, // billes lancées au maximum par accord
};

/** Regroupe les notes (triées) dont les attaques sont à moins de `window` s. */
function chords(notes, window) {
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && n.time - g[0].time <= window) g.push(n);
    else groups.push([n]);
  }
  return groups;
}

/**
 * @param notes notes transcrites [{midi,time,duration,velocity}]
 * @param drums coups détectés [{midi,time,duration,velocity}]
 * @returns pistes au format de midi.js, avec un rôle imposé : [{name, percussion, program, role, notes}]
 */
export function arrangeTranscription(notes, drums = [], options = {}) {
  const o = { ...ARRANGE_DEFAULTS, ...options };
  const sorted = notes.filter((n) => n.velocity >= o.minVelocity).sort((a, b) => a.time - b.time || a.midi - b.midi);

  // Registre de basse : fixe, ou relatif au morceau (médiane des hauteurs moins une quarte).
  let bassMax = o.bassMax;
  if (bassMax == null) {
    const pitches = sorted.map((n) => n.midi).sort((a, b) => a - b);
    const median = pitches[Math.floor(pitches.length / 2)] ?? 60;
    bassMax = Math.min(o.bassRange[1], Math.max(o.bassRange[0], median - o.bassBelowMedian));
  }
  // Basse : à chaque attaque, la note la plus grave si elle est dans le registre de basse.
  const bass = chords(sorted, o.chordWindow)
    .map((g) => g.reduce((lo, n) => (n.midi < lo.midi ? n : lo)))
    .filter((n) => n.midi <= bassMax)
    .map((n) => ({ ...n }));
  for (let i = 0; i < bass.length - 1; i++) bass[i].duration = Math.min(bass[i].duration, bass[i + 1].time - bass[i].time);
  const bassSet = new Set(bass.map((n) => `${n.midi}@${n.time}`));

  // Le reste va aux billes / à l'orgue, sauf les doublures d'octave d'une note de basse
  // simultanée (souvent ses harmoniques, détectées en plus de la fondamentale).
  const isOctaveOfBass = (n) =>
    bass.some((b) => Math.abs(b.time - n.time) <= o.chordWindow && n.midi !== b.midi && (n.midi - b.midi) % 12 === 0);
  const rest = sorted.filter((n) => !bassSet.has(`${n.midi}@${n.time}`) && !isOctaveOfBass(n));
  const pads = rest.filter((n) => n.duration >= o.padMinDuration);
  const melodic = chords(
    rest.filter((n) => n.duration < o.padMinDuration),
    o.chordWindow,
  ).flatMap((g) => [...g].sort((a, b) => b.velocity - a.velocity).slice(0, o.maxPolyphony));

  const tracks = [
    { name: 'Mélodie / accords (détectés)', percussion: false, program: 0, role: 'balls', notes: melodic },
    { name: 'Basse (détectée)', percussion: false, program: 33, role: 'bass', notes: bass },
    { name: 'Nappes (détectées)', percussion: false, program: 89, role: 'pads', notes: pads },
    { name: 'Batterie (détectée)', percussion: true, program: 0, role: 'drums', notes: drums },
  ];
  return tracks.filter((t) => t.notes.length > 0);
}
