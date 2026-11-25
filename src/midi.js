import { Midi } from '@tonejs/midi';

/**
 * Convertit un fichier MIDI en structure interne :
 * { name, tracks: [{ name, percussion, enabled, notes: [{midi,time,duration,velocity}] }] }
 */
export function parseMidi(arrayBuffer, fileName = 'MIDI') {
  const midi = new Midi(arrayBuffer);
  const tracks = midi.tracks
    .filter((t) => t.notes.length > 0)
    .map((t, i) => {
      const percussion = t.instrument.percussion || t.channel === 9;
      return {
        name: t.name || t.instrument.name || `Piste ${i + 1}`,
        percussion,
        enabled: !percussion,
        notes: t.notes.map((n) => ({
          midi: n.midi,
          time: n.time,
          duration: n.duration,
          velocity: n.velocity,
        })),
      };
    });
  return { name: midi.name || fileName, tracks };
}

/** Morceau de démonstration généré (aucun fichier requis). */
export function demoSong() {
  const beat = 0.42;
  const chords = [
    [48, 52, 55], // Do
    [45, 48, 52], // La m
    [41, 45, 48], // Fa
    [43, 47, 50], // Sol
  ];
  const arp = [];
  const bass = [];
  const melody = [];
  const tune = [
    [76, 74, 72, 74, 76, 76, 76, null],
    [74, 74, 74, null, 76, 79, 79, null],
    [76, 74, 72, 74, 76, 76, 76, 76],
    [74, 74, 76, 74, 72, null, null, null],
  ];

  for (let rep = 0; rep < 2; rep++) {
    chords.forEach((chord, c) => {
      const bar = rep * 4 + c;
      const t0 = bar * 8 * beat;
      bass.push({ midi: chord[0], time: t0, duration: beat * 4, velocity: 0.9 });
      bass.push({ midi: chord[0] + 7, time: t0 + 4 * beat, duration: beat * 4, velocity: 0.8 });
      const tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24];
      const pattern = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 2, 1];
      pattern.forEach((p, s) => {
        arp.push({ midi: tones[p], time: t0 + s * beat * 0.5, duration: beat * 0.5, velocity: s % 4 === 0 ? 0.8 : 0.55 });
      });
      if (rep === 1) {
        tune[c].forEach((m, s) => {
          if (m !== null) melody.push({ midi: m, time: t0 + s * beat, duration: beat, velocity: 0.9 });
        });
      }
    });
  }
  return {
    name: 'Démo',
    tracks: [
      { name: 'Arpèges', percussion: false, enabled: true, notes: arp },
      { name: 'Basse', percussion: false, enabled: true, notes: bass },
      { name: 'Mélodie', percussion: false, enabled: true, notes: melody },
    ],
  };
}
