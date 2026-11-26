import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSynthEvents, controllerStateAt, bendValue, DRUM_CHANNEL } from '../src/synthEvents.js';

const tracks = [
  { program: 0, ccs: [{ time: 0, number: 7, value: 100 }, { time: 1, number: 64, value: 127 }], bends: [] },
  { program: 40, ccs: [], bends: [{ time: 0.5, value: -1 }, { time: 0.6, value: 1 }] },
];

test('un canal par piste, la batterie sur le canal 9', () => {
  const notes = [
    { track: 0, midi: 60, time: 0, held: 0.5, velocity: 1 },
    { track: 1, midi: 72, time: 0.25, held: 1, velocity: 0.5 },
  ];
  const { channels, frames } = buildSynthEvents(notes, [{ midi: 36, time: 0, velocity: 0.8 }], tracks, 2);
  assert.deepEqual(channels.map((c) => [c.channel, c.program]), [[0, 0], [1, 40]]);
  const first = frames[0];
  assert.equal(first.time, 2);
  // Contrôleurs avant les attaques dans une même trame.
  assert.deepEqual(first.msgs[0], ['cc', 0, 7, 100]);
  assert.ok(first.msgs.some((m) => m[0] === 'on' && m[1] === DRUM_CHANNEL && m[2] === 36));
  assert.ok(frames.some((f) => f.msgs.some((m) => m[0] === 'off' && m[2] === 60 && Math.abs(f.time - 2.5) < 1e-9)));
  // Trames triées.
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].time > frames[i - 1].time);
});

test('relâché avant attaque quand une note se répète', () => {
  const notes = [
    { track: 0, midi: 60, time: 0, held: 0.5, velocity: 1 },
    { track: 0, midi: 60, time: 0.5, held: 0.5, velocity: 1 },
  ];
  const { frames } = buildSynthEvents(notes, [], tracks);
  const f = frames.find((x) => x.time === 0.5);
  assert.deepEqual(f.msgs.map((m) => m[0]), ['off', 'on']);
});

test('les canaux mélodiques sautent ceux de batterie', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ track: i, midi: 60, time: 0, held: 1 }));
  const { channels } = buildSynthEvents(many, [], []);
  const chans = channels.map((c) => c.channel);
  assert.ok(!chans.includes(9) && !chans.includes(25));
  assert.equal(new Set(chans).size, 20);
});

test('état des contrôleurs à un instant donné', () => {
  const notes = [{ track: 0, midi: 60, time: 0, held: 2 }, { track: 1, midi: 60, time: 0, held: 2 }];
  const { frames } = buildSynthEvents(notes, [], tracks);
  const state = controllerStateAt(frames, 0.7);
  assert.deepEqual(state, [['cc', 0, 7, 100], ['bend', 1, 16383]]);
  assert.equal(bendValue(0), 8192);
  assert.equal(bendValue(-1), 0);
});
