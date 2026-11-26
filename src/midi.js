import * as midiPkg from '@tonejs/midi';

// Vite charge la version ES module (export nommé), Node la version CommonJS (export par défaut).
const Midi = midiPkg.Midi ?? midiPkg.default?.Midi;

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
        program: t.instrument.number,
        notes: t.notes.map((n) => ({
          midi: n.midi,
          time: n.time,
          duration: n.duration,
          velocity: n.velocity,
        })),
        ...controlsOf(t),
      };
    });
  return { name: midi.name || fileName, tracks };
}

/**
 * Contrôleurs expressifs d'une piste : pédale de sustain (CC64), molette de
 * modulation (CC1, 0..1) et pitch bend (−1..1), en événements triés par temps.
 */
function controlsOf(t) {
  const cc = t.controlChanges ?? {};
  const byTime = (a, b) => a.time - b.time;
  const sustain = [];
  for (const e of [...(cc[64] ?? [])].sort(byTime)) {
    const on = e.value >= 0.5;
    if (!sustain.length || sustain[sustain.length - 1].on !== on) sustain.push({ time: e.time, on });
  }
  const mod = (cc[1] ?? []).map((e) => ({ time: e.time, value: e.value })).sort(byTime);
  const bends = (t.pitchBends ?? []).map((e) => ({ time: e.time, value: e.value })).sort(byTime);
  return { sustain, mod, bends };
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

  const bells = [];
  const lead = [];
  const keys = [];
  // Contre-chant : [note, durée en temps] par mesure.
  const counter = [
    [[67, 4], [72, 4]],
    [[69, 4], [64, 2], [69, 2]],
    [[65, 3], [69, 1], [72, 4]],
    [[71, 4], [67, 2], [62, 2]],
  ];
  const counterStart = (c, s) => counter[c].slice(0, s).reduce((a, [, len]) => a + len, 0);

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
      // Carillon : notes de l'accord égrenées, une octave au-dessus (dès la 3e mesure).
      if (bar >= 2) {
        [0, 2, 1, 2].forEach((p, s) => bells.push({ midi: tones[p] + 12, time: t0 + s * beat * 2, duration: beat * 2, velocity: s === 0 ? 0.9 : 0.65 }));
      }
      // Contre-chant tenu (harpe laser) sur la reprise.
      if (rep === 1) {
        counter[c].forEach(([m, len], s) => lead.push({ midi: m, time: t0 + counterStart(c, s) * beat, duration: len * beat * 0.92, velocity: 0.75 }));
      }
      // Piano : accords plaqués à contretemps.
      if (bar >= 1) {
        for (const s of [1, 3, 5, 6.5]) {
          for (const m of chord) keys.push({ midi: m + 12, time: t0 + s * beat, duration: beat * 0.45, velocity: 0.6 });
        }
      }
    });
  }
  // Batterie : grosse caisse 1 & 3, caisse claire 2 & 4, charleston en croches,
  // crash en début de phrase, roulement de toms en fin de phrase.
  const drums = [];
  const hit = (midi, time, velocity = 0.8) => drums.push({ midi, time, duration: 0.1, velocity });
  for (let bar = 0; bar < 8; bar++) {
    const t0 = bar * 8 * beat;
    const fill = bar % 4 === 3;
    if (bar % 4 === 0) hit(49, t0, 0.9);
    for (let q = 0; q < 8; q++) {
      const t = t0 + q * beat;
      if (fill && q >= 6) continue;
      if (q % 4 === 0) hit(36, t, 0.95);
      if (q % 4 === 2) hit(38, t, 0.85);
      if (q === 7 && !fill) hit(36, t + beat / 2, 0.7);
      if (bar % 4 !== 0 || q > 0) hit(42, t, q % 2 ? 0.45 : 0.6);
      hit(42, t + beat / 2, 0.35);
    }
    if (fill) [50, 50, 48, 48, 45, 45, 43, 41].forEach((m, i) => hit(m, t0 + 6 * beat + (i * beat) / 4, 0.8));
  }

  // Nappe : accords tenus sur toute la mesure.
  const pad = [];
  for (let bar = 0; bar < 8; bar++) {
    const chord = chords[bar % 4];
    for (const m of [chord[0] + 12, chord[1] + 12, chord[2] + 12]) {
      pad.push({ midi: m, time: bar * 8 * beat, duration: 8 * beat * 0.95, velocity: 0.6 });
    }
  }

  // Violon (cordes frottées) : notes longues, de la 3e mesure à la fin, sur les notes de l'accord.
  const violin = [];
  for (let bar = 2; bar < 8; bar++) {
    const chord = chords[bar % 4];
    const line = bar % 2 ? [chord[2] + 24, chord[1] + 24] : [chord[1] + 24, chord[0] + 24];
    line.forEach((m, k) => violin.push({ midi: m, time: (bar * 8 + k * 4) * beat, duration: 4 * beat * 0.9, velocity: k ? 0.6 : 0.75 }));
  }
  const violinMod = violin.flatMap((n) => [
    { time: n.time, value: 0 },
    { time: n.time + n.duration * 0.4, value: 0.5 },
    { time: n.time + n.duration * 0.7, value: 1 },
  ]);

  // Expression : pédale de sustain du piano (enfoncée sur chaque mesure, relevée juste
  // avant la suivante), coulés de pitch bend et vibrato (modulation) sur le contre-chant.
  const pianoSustain = [];
  for (let bar = 1; bar < 8; bar++) {
    pianoSustain.push({ time: bar * 8 * beat + 0.05, on: true }, { time: (bar + 1) * 8 * beat - 0.08, on: false });
  }
  const leadBends = [];
  const leadMod = [];
  lead.forEach((n, i) => {
    // Attaque « par en dessous » sur une note sur deux, chute en fin de note sur les longues.
    for (let k = 0; k <= 12; k++) {
      const u = k / 12;
      if (i % 2 === 0) leadBends.push({ time: n.time + u * 0.3, value: -0.6 * (1 - u) * (1 - u) });
      if (n.duration > 1.2) leadBends.push({ time: n.time + n.duration - 0.35 + u * 0.35, value: -0.5 * u * u });
    }
    leadBends.push({ time: n.time + n.duration + 0.02, value: 0 });
    for (let k = 0; k <= 10; k++) leadMod.push({ time: n.time + (k / 10) * n.duration, value: Math.min(1, (k / 10) * 1.4) * (n.duration > 1 ? 1 : 0.4) });
    leadMod.push({ time: n.time + n.duration + 0.01, value: 0 });
  });
  leadBends.sort((a, b) => a.time - b.time);

  return {
    name: 'Démo',
    tracks: [
      { name: 'Arpèges', percussion: false, program: 12, notes: arp },
      { name: 'Basse', percussion: false, program: 33, notes: bass },
      { name: 'Mélodie', percussion: false, program: 13, notes: melody },
      { name: 'Nappe', percussion: false, program: 19, notes: pad },
      { name: 'Carillon', percussion: false, program: 14, notes: bells },
      { name: 'Contre-chant', percussion: false, program: 73, notes: lead, bends: leadBends, mod: leadMod },
      { name: 'Violon', percussion: false, program: 40, notes: violin, mod: violinMod },
      { name: 'Piano', percussion: false, program: 0, notes: keys, sustain: pianoSustain },
      { name: 'Batterie', percussion: true, program: 0, notes: drums },
    ],
  };
}
