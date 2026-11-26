import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChoreography,
  ballPosition,
  activeBallRange,
  launcherPose,
  barPulse,
} from '../src/choreography.js';

const notes = [
  { midi: 60, time: 2.0, velocity: 0.8, track: 0 },
  { midi: 64, time: 2.0, velocity: 0.8, track: 0 },
  { midi: 67, time: 2.5, velocity: 0.8, track: 1 },
  { midi: 72, time: 3.0, velocity: 0.8, track: 1 },
  { midi: 60, time: 3.1, velocity: 0.8, track: 0 },
];

const close = (a, b, eps = 1e-9) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} ≉ ${b}`));

test('une lame par hauteur, triées du grave à l\'aigu', () => {
  const ch = buildChoreography(notes);
  assert.deepEqual(ch.bars.map((b) => b.midi), [60, 64, 67, 72]);
  assert.ok(ch.bars[0].angle < ch.bars[3].angle);
});

test('chaque bille part du canon au tir et touche sa lame pile au moment de la note', () => {
  const ch = buildChoreography(notes);
  for (const ball of ch.balls) {
    close(ballPosition(ch, ball, ball.launch), ball.p0);
    close(ballPosition(ch, ball, ball.impact), ch.bars[ball.bar].target, 1e-6);
    assert.equal(ch.bars[ball.bar].midi, ball.midi);
    // Une bille qui va rebondir est tirée plus haut (vol plus long).
    const flight = ball.hits > 1 ? ch.options.chainFlightTime : ch.options.flightTime;
    assert.ok(Math.abs(ball.impact - ball.launch - flight) < 1e-12);
  }
});

test('deux notes simultanées partent de canons différents', () => {
  const ch = buildChoreography(notes);
  const [a, b] = ch.balls;
  assert.notEqual(a.launcher, b.launcher);
});

test('activeBallRange contient exactement les billes vivantes', () => {
  const ch = buildChoreography(notes);
  for (let t = -1; t < 6; t += 0.05) {
    const [s, e] = activeBallRange(ch, t);
    const expected = ch.balls
      .map((b, i) => (t >= b.launch && t <= b.end ? i : -1))
      .filter((i) => i >= 0);
    for (const i of expected) assert.ok(i >= s && i < e, `t=${t} bille ${i} hors [${s},${e})`);
  }
});

test('le canon est aligné sur sa trajectoire au moment du tir', () => {
  const ch = buildChoreography(notes);
  const ball = ch.balls[0];
  const L = ch.launchers[ball.launcher];
  const { dir, recoil } = launcherPose(ch, L, ball.launch);
  const v = ball.v0;
  const l = Math.hypot(...v);
  close(dir, v.map((x) => x / l), 1e-3);
  assert.ok(recoil > 0.9 * (0.6 + 0.4 * ball.velocity)); // recul maximal au tir, proportionné à la note
});

test('la lame s\'illumine à l\'impact puis s\'éteint', () => {
  const ch = buildChoreography(notes);
  const bar = ch.bars[0];
  assert.equal(barPulse(ch, bar, 1.9).pulse, 0);
  assert.ok(barPulse(ch, bar, 2.0).pulse > 0.79);
  assert.ok(barPulse(ch, bar, 2.8).pulse < 0.01);
});

test('maxConcurrent couvre le pic de billes', () => {
  const ch = buildChoreography(notes);
  for (let t = -1; t < 6; t += 0.01) {
    const alive = ch.balls.filter((b) => t >= b.launch && t <= b.end).length;
    assert.ok(alive <= ch.maxConcurrent);
  }
});

// Phrase rapide sur une même piste : de quoi déclencher des rebonds en chaîne.
// Gammes montantes et descendantes en croches régulières.
const scale = [60, 62, 64, 65, 67, 69, 71, 72];
const phrase = Array.from({ length: 32 }, (_, i) => {
  const k = i % 14;
  return { midi: scale[k < 8 ? k : 14 - k], time: 2 + i * 0.4, velocity: 0.7, track: 0 };
});

test('rebonds en chaîne : chaque note est frappée par une bille, pile à son instant', () => {
  const ch = buildChoreography(phrase);
  assert.equal(ch.impacts.length, phrase.length);
  assert.ok(ch.balls.length < phrase.length, 'au moins une bille rebondit sur plusieurs lames');
  for (const im of ch.impacts) {
    close(ballPosition(ch, im.ball, im.time), ch.bars[im.bar].target, 1e-6);
    assert.equal(ch.bars[im.bar].midi, phrase.find((n) => Math.abs(n.time - im.time) < 1e-9).midi);
  }
});

test('trajectoire continue, du tir au retour dans la tourelle', () => {
  const ch = buildChoreography(phrase);
  for (const b of ch.balls) {
    let prev = null;
    for (let t = b.launch; t <= b.end; t += 0.002) {
      const p = ballPosition(ch, b, t);
      if (prev) assert.ok(Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) < 0.03, `saut à t=${t}`);
      assert.ok(p[1] >= ch.options.ballRadius - 1e-9);
      prev = p;
    }
    // Fin de parcours : au pied de la tourelle.
    const end = ballPosition(ch, b, b.end);
    assert.ok(Math.hypot(end[0], end[2]) < ch.options.launcherRadius + 1);
  }
});

test('rebonds crédibles : amortis, même cap, allure régulière', () => {
  const ch = buildChoreography(phrase);
  const chained = ch.balls.filter((b) => b.hits > 1);
  assert.ok(chained.length > 0);
  for (const b of chained) {
    const hops = ch.impacts.filter((im) => im.ball === b);
    for (let i = 2; i < hops.length; i++) {
      const [a, m, z] = [hops[i - 2], hops[i - 1], hops[i]];
      // Durée (donc hauteur) d'un rebond : jamais (nettement) plus que le précédent.
      assert.ok(z.time - m.time <= (m.time - a.time) * 1.04 + 1e-9);
      // Pas de demi-tour.
      const u = [m.position[0] - a.position[0], m.position[2] - a.position[2]];
      const v = [z.position[0] - m.position[0], z.position[2] - m.position[2]];
      assert.ok(u[0] * v[0] + u[1] * v[1] > 0, 'aller-retour');
    }
  }
});
