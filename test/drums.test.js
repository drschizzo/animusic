import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDrumKit, pieceForNote, strikeLift, armAngles, armTip, hitPulse, PIECES } from '../src/drums.js';

// Une note de chaque élément, plus une série rapide de charleston.
const notes = [36, 38, 42, 41, 45, 48, 49, 51, 56].map((midi, i) => ({
  midi,
  time: 1 + i * 0.5,
  velocity: 0.8,
  track: 0,
}));
for (let i = 0; i < 16; i++) notes.push({ midi: 42, time: 6 + i * 0.1, velocity: 0.6, track: 0 });

const close = (a, b, eps = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} ≉ ${b}`));

test('mapping General MIDI', () => {
  assert.equal(pieceForNote(36), 'kick');
  assert.equal(pieceForNote(38), 'snare');
  assert.equal(pieceForNote(46), 'hihat');
  assert.equal(pieceForNote(49), 'crash');
  assert.equal(pieceForNote(80), 'perc');
});

test('un élément par type utilisé, et seulement ceux-là', () => {
  const kit = buildDrumKit(notes);
  assert.deepEqual(kit.pieces.map((p) => p.name).sort(), Object.keys(PIECES).sort());
  const small = buildDrumKit([{ midi: 38, time: 1, velocity: 1, track: 0 }]);
  assert.deepEqual(small.pieces.map((p) => p.name), ['snare']);
});

test('la baguette touche exactement le point de frappe à chaque note', () => {
  const kit = buildDrumKit(notes, { center: [0, 0, -4] });
  for (const piece of kit.pieces) {
    for (const hit of piece.hits) {
      assert.ok(Math.abs(strikeLift(kit, piece, hit.time)) < 1e-9);
      close(armTip(piece, armAngles(kit, piece, hit.time)), piece.hitPoint);
    }
  }
});

test('la baguette est levée avant le coup et revient au repos ensuite', () => {
  const kit = buildDrumKit(notes);
  const snare = kit.pieces.find((p) => p.name === 'snare');
  const t = snare.hits[0].time;
  assert.ok(strikeLift(kit, snare, t - 0.15) > 0.3);
  assert.ok(strikeLift(kit, snare, t - 5) > 0.2);
  assert.ok(Math.abs(strikeLift(kit, snare, t + 2) - kit.options.restLift) < 1e-3);
});

test('les coups rapprochés restent continus et toujours au-dessus de la peau', () => {
  const kit = buildDrumKit(notes);
  const hh = kit.pieces.find((p) => p.name === 'hihat');
  let prev = strikeLift(kit, hh, 5.9);
  for (let t = 5.9; t < 8; t += 0.001) {
    const h = strikeLift(kit, hh, t);
    assert.ok(h >= -1e-9, `h=${h} à t=${t}`);
    assert.ok(Math.abs(h - prev) < 0.05, `saut à t=${t}`);
    prev = h;
  }
});

test('éclat maximal à l\'impact', () => {
  const kit = buildDrumKit(notes);
  const kick = kit.pieces.find((p) => p.name === 'kick');
  assert.equal(hitPulse(kit, kick, 0.5).pulse, 0);
  assert.ok(Math.abs(hitPulse(kit, kick, 1).pulse - 0.8) < 1e-9);
});
