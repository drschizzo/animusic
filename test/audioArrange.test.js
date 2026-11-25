import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeTranscription } from '../src/audioArrange.js';

const n = (midi, time, duration = 0.3, velocity = 0.8) => ({ midi, time, duration, velocity });

test('basse : la plus grave de chaque attaque, coupée à l\'attaque suivante', () => {
  const notes = [
    n(40, 0, 1.0), n(64, 0.01), n(67, 0.02), // accord : basse 40
    n(43, 0.5, 1.0), n(71, 0.5), // basse 43 (la 40 est coupée à 0,5 s)
    n(76, 1.0), n(79, 1.25), n(72, 1.5), n(74, 1.75), // mélodie aiguë
  ];
  const tracks = arrangeTranscription(notes);
  const bass = tracks.find((t) => t.role === 'bass').notes;
  assert.deepEqual(bass.map((x) => x.midi), [40, 43]);
  assert.equal(bass[0].duration, 0.5);
  const balls = tracks.find((t) => t.role === 'balls').notes;
  assert.ok(balls.every((x) => x.midi > 50));
});

test('nappes : les notes longues vont à l\'orgue', () => {
  const notes = [n(60, 0, 2), n(64, 0, 2), n(67, 0, 2), n(72, 0.5), n(74, 1), n(45, 0)];
  const pads = arrangeTranscription(notes).find((t) => t.role === 'pads').notes;
  assert.deepEqual(pads.map((x) => x.midi).sort(), [60, 64, 67]);
});

test('polyphonie des billes limitée par accord, notes faibles ignorées', () => {
  const cluster = [60, 62, 64, 65, 67, 69, 71, 72].map((m, i) => n(m, 0, 0.3, 0.3 + i * 0.05));
  const tracks = arrangeTranscription([...cluster, n(80, 1, 0.3, 0.1), n(40, 0)], [], { maxPolyphony: 5 });
  const balls = tracks.find((t) => t.role === 'balls').notes;
  assert.equal(balls.length, 5);
  // Les 5 plus fortes de l'accord.
  assert.deepEqual(balls.map((x) => x.midi).sort((a, b) => a - b), [65, 67, 69, 71, 72]);
  assert.ok(!balls.some((x) => x.midi === 80));
});

test('batterie transmise telle quelle, pistes vides omises', () => {
  const drums = [{ midi: 36, time: 0, duration: 0.1, velocity: 1 }];
  const tracks = arrangeTranscription([], drums);
  assert.deepEqual(tracks.map((t) => t.role), ['drums']);
  assert.ok(tracks[0].percussion);
});
