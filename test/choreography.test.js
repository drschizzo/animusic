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
    assert.ok(Math.abs(ball.impact - ball.launch - ch.options.flightTime) < 1e-12);
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
  assert.ok(recoil > 0.99);
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
