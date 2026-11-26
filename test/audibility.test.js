import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles, hiddenTracks, trackLevel, groupParts } from '../src/arranger.js';

// Mélodie en notes brèves (comme le thème d'Axel F).
const melody = (shift = 0, dur = 0.08) =>
  Array.from({ length: 64 }, (_, k) => ({ midi: 60 + ((k * 5) % 12), time: k * 0.25 + shift, duration: dur, velocity: 0.5 }));

test('des cordes lentes en notes brèves sonnent bien plus bas qu’un piano', () => {
  const piano = trackLevel({ program: 0, notes: melody() });
  const strings = trackLevel({ program: 51, notes: melody() });
  assert.ok(piano - strings > 6, `${piano} / ${strings}`);
  // Le volume du fichier compte.
  const quiet = trackLevel({ program: 0, notes: melody(), ccs: [{ time: 0, number: 7, value: 50 }] });
  assert.ok(piano - quiet > 6);
  assert.equal(trackLevel({ program: 0, notes: melody(), ccs: [{ time: 0, number: 7, value: 0 }] }), -Infinity);
});

test('une doublure couverte et une piste muette passent en « son seul »', () => {
  const tracks = [
    { name: 'cordes', program: 51, notes: melody(), ccs: [{ time: 0, number: 7, value: 57 }] },
    { name: 'piano', program: 0, notes: melody(0.017) },
    { name: 'harmonica', program: 22, notes: melody(0.1, 0.3), ccs: [{ time: 0, number: 7, value: 4 }] },
    { name: 'basse', program: 33, notes: melody(0, 0.2).map((n) => ({ ...n, midi: n.midi - 24 })) },
  ];
  assert.deepEqual(hiddenTracks(tracks), [0, 2]);
  const roles = assignRoles(tracks);
  assert.equal(roles[0], 'sound');
  assert.equal(roles[2], 'sound');
  assert.equal(roles[3], 'bass');
  // Sans instrument à l'écran.
  tracks.forEach((t, i) => (t.role = roles[i]));
  assert.ok(groupParts(tracks).every((p) => !p.tracks.includes(0) && !p.tracks.includes(2)));
});

test('deux pistes à l’unisson et à niveau égal restent toutes deux visibles', () => {
  const tracks = [
    { program: 0, notes: melody() },
    { program: 73, notes: melody(0.01, 0.2) },
  ];
  assert.deepEqual(hiddenTracks(tracks), []);
});
