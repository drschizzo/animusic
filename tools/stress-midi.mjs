// Génère des fichiers MIDI de stress (pop dense multi-pistes avec changements de tempo,
// piano 88 touches de 5 min, cas limites) : node tools/stress-midi.mjs <dossier>
import midiPkg from '@tonejs/midi';
import { writeFileSync } from 'node:fs';
const { Midi } = midiPkg;
const out = process.argv[2];
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

// 1. Pop dense, 12 pistes, changements de tempo.
{
  const m = new Midi();
  m.header.tempos = [{ ticks: 0, bpm: 100 }, { ticks: 480 * 64, bpm: 140 }, { ticks: 480 * 128, bpm: 90 }];
  m.header.update();
  const T = (beat) => m.header.ticksToSeconds(beat * 480);
  const add = (name, program, channel, fn) => { const t = m.addTrack(); t.name = name; t.channel = channel; t.instrument.number = program; fn(t); };
  const bars = 64;
  add('Drums', 0, 9, (t) => { for (let b = 0; b < bars * 4; b += 0.5) { t.addNote({ midi: 42, time: T(b), duration: 0.05, velocity: 0.5 }); if (b % 2 === 0) t.addNote({ midi: 36, time: T(b), duration: 0.1 }); if (b % 2 === 1) t.addNote({ midi: 38, time: T(b), duration: 0.1 }); } for (let b = 0; b < bars * 4; b += 16) t.addNote({ midi: 49, time: T(b), duration: 1 }); });
  add('Bass', 33, 1, (t) => { for (let b = 0; b < bars * 4; b += 0.5) t.addNote({ midi: 36 + [0, 0, 7, 5][Math.floor(b / 4) % 4] + (b % 1 ? 12 : 0), time: T(b), duration: T(b + 0.45) - T(b), velocity: 0.8 }); });
  add('Strings', 48, 2, (t) => { for (let b = 0; b < bars * 4; b += 4) for (const d of [0, 4, 7, 12]) t.addNote({ midi: 60 + d + [0, 0, 7, 5][(b / 4) % 4], time: T(b), duration: T(b + 4) - T(b), velocity: 0.5 }); });
  add('Pad', 89, 3, (t) => { for (let b = 0; b < bars * 4; b += 8) for (const d of [0, 7, 16]) t.addNote({ midi: 48 + d, time: T(b), duration: T(b + 8) - T(b), velocity: 0.4 }); });
  add('Lead', 81, 4, (t) => { for (let b = 0; b < bars * 4; b += 0.25) if (rnd() < 0.6) t.addNote({ midi: 72 + Math.floor(rnd() * 15), time: T(b), duration: T(b + 0.25) - T(b), velocity: 0.7 }); });
  add('Piano', 0, 5, (t) => { for (let b = 0; b < bars * 4; b += 1) for (const d of [0, 4, 7]) t.addNote({ midi: 60 + d + Math.floor(rnd() * 3), time: T(b), duration: T(b + 0.9) - T(b), velocity: 0.6 }); });
  add('Guitar', 25, 6, (t) => { for (let b = 0; b < bars * 4; b += 0.5) t.addNote({ midi: 55 + Math.floor(rnd() * 12), time: T(b), duration: 0.2, velocity: 0.6 }); });
  add('Brass', 61, 7, (t) => { for (let b = 0; b < bars * 4; b += 8) t.addNote({ midi: 67, time: T(b + 6), duration: T(b + 8) - T(b + 6), velocity: 0.9 }); });
  add('Flute', 73, 8, (t) => { for (let b = 0; b < bars * 4; b += 0.5) if (rnd() < 0.3) t.addNote({ midi: 84 + Math.floor(rnd() * 10), time: T(b), duration: 0.4, velocity: 0.6 }); });
  add('Bells', 14, 10, (t) => { for (let b = 0; b < bars * 4; b += 4) t.addNote({ midi: 96, time: T(b), duration: 2, velocity: 0.7 }); });
  add('Choir', 52, 11, (t) => { for (let b = 0; b < bars * 4; b += 16) t.addNote({ midi: 64, time: T(b), duration: T(b + 16) - T(b), velocity: 0.5 }); });
  add('Toms', 0, 9, (t) => { for (let b = 15; b < bars * 4; b += 16) for (let k = 0; k < 8; k++) t.addNote({ midi: [50, 48, 47, 45, 43, 41, 41, 41][k], time: T(b + k / 8), duration: 0.1 }); });
  writeFileSync(`${out}/pop-dense.mid`, Buffer.from(m.toArray()));
}
// 2. Piano 88 touches, très dense, 5 minutes.
{
  const m = new Midi(); const t = m.addTrack(); t.name = 'Piano'; t.instrument.number = 0;
  for (let i = 0; i < 300 * 12; i++) { const time = i / 12; t.addNote({ midi: 21 + Math.floor(rnd() * 88), time, duration: 0.15, velocity: 0.3 + rnd() * 0.7 }); if (i % 6 === 0) for (const d of [0, 4, 7, 11]) t.addNote({ midi: 36 + d + Math.floor(rnd() * 24), time, duration: 0.5, velocity: 0.6 }); }
  writeFileSync(`${out}/piano88-long.mid`, Buffer.from(m.toArray()));
}
// 3. Cas limites.
{
  const m = new Midi();
  m.addTrack().name = 'Vide';
  const a = m.addTrack(); a.name = 'Zéro'; a.addNote({ midi: 60, time: 0, duration: 0, velocity: 0 }); a.addNote({ midi: 60, time: 0, duration: 0.5 }); a.addNote({ midi: 60, time: 0, duration: 0.5 });
  a.addNote({ midi: 0, time: 1, duration: 0.2 }); a.addNote({ midi: 127, time: 1, duration: 0.2 });
  const one = m.addTrack(); one.name = 'Une note'; one.instrument.number = 40; one.addNote({ midi: 70, time: 30, duration: 3 });
  const d = m.addTrack(); d.channel = 9; d.name = 'Percu bizarre'; for (const n of [27, 34, 82, 87, 36, 36]) d.addNote({ midi: n, time: 2, duration: 0.1 });
  writeFileSync(`${out}/edge-cases.mid`, Buffer.from(m.toArray()));
}
console.log('ok');
