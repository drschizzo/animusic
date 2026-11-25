import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBassStrings, carrierPose, stringVibration } from '../src/strings.js';
import { buildPipes, pipeState } from '../src/pipes.js';
import { classifyTrack, buildEnsemble } from '../src/arranger.js';

const bassNotes = [];
[40, 43, 45, 40, 47, 43, 40, 40].forEach((midi, i) =>
  bassNotes.push({ midi, time: 1 + i * 0.25, duration: 0.2, velocity: 0.8, track: 1 }),
);

test('basse : une corde par hauteur', () => {
  const m = buildBassStrings(bassNotes);
  assert.deepEqual(m.strings.map((s) => s.midi), [40, 43, 45, 47]);
});

test('basse : le médiator traverse la bonne corde pile à l\'instant de la note', () => {
  const m = buildBassStrings(bassNotes);
  for (const c of m.carriers) {
    for (const shot of c.shots) {
      const p = carrierPose(m, c, shot.time);
      assert.ok(Math.abs(p.x - shot.x) < 1e-9, 'chariot devant la corde');
      assert.ok(Math.abs(p.z) < 1e-9, 'médiator dans le plan des cordes');
      // Juste avant : du côté « dir », juste après : de l'autre côté.
      assert.ok(carrierPose(m, c, shot.time - 0.01).z * shot.dir > 0);
      assert.ok(carrierPose(m, c, shot.time + 0.01).z * shot.dir < 0);
    }
  }
});

test('basse : le médiator ne croise jamais le plan des cordes en se déplaçant', () => {
  const m = buildBassStrings(bassNotes);
  for (const c of m.carriers) {
    let prev = carrierPose(m, c, 0);
    for (let t = 0; t < 4; t += 0.002) {
      const p = carrierPose(m, c, t);
      // Si x bouge, z doit être à distance de repos.
      if (Math.abs(p.x - prev.x) > 1e-6) assert.ok(Math.abs(p.z) > m.options.pickOffset * 0.99, `t=${t}`);
      assert.ok(Math.abs(p.z - prev.z) < 0.02, `saut de z à t=${t}`);
      prev = p;
    }
  }
});

test('basse : la corde vibre puis s\'amortit', () => {
  const m = buildBassStrings(bassNotes);
  const s = m.strings[3]; // 47, jouée une seule fois à t=2
  assert.equal(stringVibration(m, s, 1.9).amp, 0);
  assert.ok(stringVibration(m, s, 2.0).amp > 0.79);
  assert.ok(stringVibration(m, s, 3).amp < 0.01);
});

test('orgue : la lumière suit la durée de la note, la valve anticipe', () => {
  const m = buildPipes([{ midi: 60, time: 2, duration: 1.5, velocity: 1, track: 2 }]);
  const p = m.pipes[0];
  assert.equal(pipeState(m, p, 1.7).valve, 0);
  assert.ok(pipeState(m, p, 1.95).valve > 0);
  assert.equal(pipeState(m, p, 1.95).level, 0);
  assert.ok(pipeState(m, p, 2.5).level > 0.99);
  assert.ok(pipeState(m, p, 3.4).level > 0.99);
  assert.ok(pipeState(m, p, 3.7).level < 0.5);
  assert.equal(pipeState(m, p, 5).level, 0);
});

test('classification des pistes', () => {
  assert.equal(classifyTrack({ percussion: true, notes: [] }), 'drums');
  assert.equal(classifyTrack({ program: 33, notes: [] }), 'bass');
  assert.equal(classifyTrack({ program: 48, notes: [] }), 'pads');
  assert.equal(classifyTrack({ program: 0, notes: bassNotes }), 'bass');
  const chords = [60, 64, 67].map((midi) => ({ midi, time: 0, duration: 2, velocity: 0.7 }));
  assert.equal(classifyTrack({ program: 0, notes: chords }), 'pads');
  const melody = [72, 74, 76, 77].map((midi, i) => ({ midi, time: i * 0.3, duration: 0.25, velocity: 0.7 }));
  assert.equal(classifyTrack({ program: 0, notes: melody }), 'balls');
});

test('ensemble : instruments présents, début et fin globaux', () => {
  const e = buildEnsemble({
    balls: [{ midi: 72, time: 1, duration: 0.2, velocity: 1, track: 0 }],
    bass: bassNotes,
    pads: [{ midi: 60, time: 0.5, duration: 4, velocity: 1, track: 2 }],
    drums: [{ midi: 36, time: 1, duration: 0.1, velocity: 1, track: 3 }],
  });
  assert.deepEqual(e.instruments.map((i) => i.kind), ['balls', 'drums', 'bass', 'pads']);
  assert.ok(e.start < 0); // la première bille part avant t=0
  assert.ok(e.end >= 4.5);
  for (const i of e.instruments) assert.ok(i.onsets.every((t, k) => k === 0 || t >= i.onsets[k - 1]));
});
