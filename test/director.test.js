import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnsemble } from '../src/arranger.js';
import { planShots, cameraAt } from '../src/director.js';

// Billes pendant 0-20 s, puis un solo de batterie 20-30 s.
const balls = Array.from({ length: 80 }, (_, i) => ({ midi: 60 + (i % 12), time: i * 0.25, duration: 0.2, velocity: 0.8, track: 0 }));
const drums = Array.from({ length: 80 }, (_, i) => ({ midi: [36, 38, 42][i % 3], time: 20 + i * 0.125, duration: 0.1, velocity: 0.8, track: 1 }));
const ensemble = buildEnsemble({ balls, drums });

test('les plans couvrent tout le morceau sans trou', () => {
  const { shots } = planShots(ensemble);
  assert.ok(shots[0].start <= ensemble.start);
  assert.ok(shots[shots.length - 1].end >= ensemble.end);
  for (let i = 1; i < shots.length; i++) assert.equal(shots[i].start, shots[i - 1].end);
});

test('le solo de batterie est filmé', () => {
  const { shots } = planShots(ensemble);
  const drumsIndex = ensemble.instruments.findIndex((i) => i.kind === 'drums');
  const solo = shots.filter((s) => s.start >= 20 && s.end <= 31);
  assert.ok(solo.some((s) => s.subject === drumsIndex));
  // Pendant le solo, on ne filme jamais les billes (silencieuses).
  const ballsIndex = ensemble.instruments.findIndex((i) => i.kind === 'balls');
  assert.ok(solo.every((s) => s.subject !== ballsIndex));
});

test('la caméra se déplace sans à-coup', () => {
  const plan = planShots(ensemble);
  let prev = cameraAt(plan, ensemble.start);
  for (let t = ensemble.start; t < ensemble.end; t += 0.01) {
    const p = cameraAt(plan, t);
    const d = Math.hypot(...p.position.map((v, k) => v - prev.position[k]));
    assert.ok(d < 0.25, `saut de ${d.toFixed(3)} m à t=${t.toFixed(2)}`);
    prev = p;
  }
});

test('plan déterministe', () => {
  assert.deepEqual(planShots(ensemble), planShots(ensemble));
});
