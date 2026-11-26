import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnsemble } from '../src/arranger.js';
import { analyzeSong, deployAt, sectionAt, mergeSpans } from '../src/sections.js';

// 0–20 s : billes seules ; 20–40 s : billes + batterie ; 40–60 s : billes seules.
const balls = Array.from({ length: 120 }, (_, i) => ({ midi: 60 + (i % 7), time: i * 0.5, duration: 0.2, velocity: 0.7, track: 0 }));
const drums = Array.from({ length: 80 }, (_, i) => ({ midi: 36, time: 20 + i * 0.25, duration: 0.1, velocity: 0.9, track: 1 }));
const ensemble = buildEnsemble({ balls, drums });
const song = analyzeSong(ensemble);
const drumIndex = ensemble.instruments.findIndex((i) => i.kind === 'drums');

test('mergeSpans fusionne les intervalles proches', () => {
  assert.deepEqual(mergeSpans([[5, 6], [0, 1], [1.5, 2]], 1), [[0, 2], [5, 6]]);
});

test("les sections coupent à l'entrée et à la sortie de la batterie", () => {
  const cuts = song.sections.slice(1).map((s) => s.start);
  assert.ok(cuts.some((c) => Math.abs(c - 20) < 2), `coupes : ${cuts}`);
  assert.ok(cuts.some((c) => Math.abs(c - 40) < 2.5), `coupes : ${cuts}`);
  const middle = song.sections.find((s) => s.start <= 30 && s.end > 30);
  assert.ok(middle.energy > song.sections[0].energy);
});

test("la batterie sort du sol avant sa première note et y est en place pendant qu'elle joue", () => {
  const first = ensemble.instruments[drumIndex].onsets[0];
  assert.equal(deployAt(song, drumIndex, 5), 0);
  assert.ok(deployAt(song, drumIndex, first - 1) > 0);
  for (let t = first - 0.3; t < 39; t += 0.1) assert.ok(deployAt(song, drumIndex, t) >= 0.999, `t=${t}`);
  // Les billes jouent dès le début : déjà en place.
  assert.equal(deployAt(song, 0, -1), 1);
});

test('le fondu entre sections est continu', () => {
  let prev = sectionAt(song, 0).energy;
  for (let t = 0; t < 60; t += 0.01) {
    const e = sectionAt(song, t).energy;
    assert.ok(Math.abs(e - prev) < 0.02, `saut d'énergie à t=${t}`);
    prev = e;
  }
});
