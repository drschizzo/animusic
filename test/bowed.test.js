import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBowed, bowPose, bowedString } from '../src/bowed.js';
import { classifyTrack } from '../src/arranger.js';

const notes = [
  { midi: 67, time: 1, duration: 1.5, velocity: 0.8, track: 0 },
  { midi: 72, time: 1.2, duration: 1, velocity: 0.7, track: 0 },
  { midi: 64, time: 3, duration: 0.8, velocity: 0.6, track: 0 },
  { midi: 76, time: 3.1, duration: 2, velocity: 0.9, track: 0 },
  { midi: 67, time: 4.2, duration: 0.6, velocity: 0.8, track: 0 },
];

test('une corde par hauteur, sur le pourtour de la cage', () => {
  const m = buildBowed(notes);
  assert.deepEqual(m.strings.map((s) => s.midi), [64, 67, 72, 76]);
  assert.ok(m.strings.every((s) => Math.abs(s.angle) <= Math.PI));
});

test("pendant chaque note, un archet est posé sur la bonne corde et la frotte", () => {
  const m = buildBowed(notes);
  for (const b of m.bows) {
    for (const s of b.strokes) {
      for (let t = s.start; t <= s.end; t += 0.05) {
        const p = bowPose(m, b, t);
        assert.equal(p.press, 1, `posé à t=${t}`);
        assert.ok(Math.abs(p.angle - m.strings[s.string].angle) < 1e-9);
        assert.equal(p.playing, 1);
      }
      // Le coup d'archet avance dans le sens prévu.
      const a = bowPose(m, b, s.start).stroke;
      const z = bowPose(m, b, s.end).stroke;
      assert.ok((z - a) * s.dir > 0);
    }
    // Les coups d'un même archet ne se chevauchent pas.
    b.strokes.forEach((s, i) => i && assert.ok(s.start > b.strokes[i - 1].end));
  }
  const total = m.bows.reduce((n, b) => n + b.strokes.length, 0);
  assert.equal(total, notes.length);
});

test('la corde vibre pendant la note puis s’éteint', () => {
  const m = buildBowed(notes);
  const s = m.strings.find((x) => x.midi === 76);
  assert.equal(bowedString(m, s, 3.0).amp, 0);
  assert.ok(bowedString(m, s, 4).amp > 0.5);
  assert.ok(bowedString(m, s, 7).amp < 0.01);
});

test('un violon joué tenu va aux cordes frottées', () => {
  const track = { program: 40, notes: notes.map((n) => ({ ...n })) };
  assert.equal(classifyTrack(track), 'bowed');
});
