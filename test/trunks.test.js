import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedBall, backBall, trunkDistance } from '../src/trunks.js';
import { frameOf } from '../src/passes.js';
import { stationBall } from '../src/ballistics.js';
import { buildEnsemble } from '../src/arranger.js';

const marimba = Array.from({ length: 100 }, (_, i) => ({ midi: 60 + (i % 5), time: 1 + i * 0.4, duration: 0.2, velocity: 0.8, track: 0 }));
const line = (midi0, track, step = 0.8, dur = 0.6) => Array.from({ length: 50 }, (_, i) => ({ midi: midi0 + (i % 6), time: 1 + i * step, duration: dur, velocity: 0.8, track }));
// Accords : trois notes ensemble, pour vérifier que leurs billes se suivent dans le tuyau.
const chords = Array.from({ length: 30 }, (_, i) => [48, 52, 55].map((midi) => ({ midi, time: 2 + i, duration: 0.7, velocity: 0.8, track: 1 }))).flat();
const e = buildEnsemble({ balls: marimba, pads: chords, bass: line(36, 2, 0.25, 0.2), keys: line(64, 3, 0.2, 0.15), bells: line(72, 4) }, [], [], { style: 'balls' });
const tr = e.trunks;

test('réseau : une ligne par instrument à rangée, tuyaux étagés, colonnes rangées comme les instruments', () => {
  const rows = e.instruments.filter((i) => i.model.row);
  assert.equal(tr.lines.length, rows.length);
  // Deux tuyaux ne sont jamais à la même hauteur, et tous passent au-dessus de l'instrument le plus haut.
  const levels = tr.lines.flatMap((l) => [l.feedCorners[1][1], l.returnCorners[2][1]]);
  assert.equal(new Set(levels.map((y) => y.toFixed(3))).size, levels.length);
  for (const y of levels) assert.ok(y >= Math.max(...e.instruments.filter((i) => i.footprint).map((i) => i.footprint.top)) + 1);
  // Les retours passent au-dessus de toutes les alimentations.
  assert.ok(Math.min(...tr.lines.map((l) => l.returnCorners[2][1])) > Math.max(...tr.lines.map((l) => l.feedCorners[1][1])));
  const xs = tr.lines.map((l) => l.feedCorners[0][0]);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= tr.options.columnGap - 1e-9);
});

test('réseau : chaque tuyau se pose contre le bout de la rampe ou du collecteur de son instrument', () => {
  for (const l of tr.lines) {
    const ins = e.instruments[l.instrument];
    const f = frameOf(ins);
    const loop = ins.model.row.loop;
    const ramp = f.toWorld(loop[loop.length - 1]);
    const end = l.feed.pointAt(l.feed.length);
    assert.ok(Math.abs(end[0] - ramp[0]) < 1e-6 && Math.abs(end[2] - ramp[2]) < 1e-6 && end[1] - ramp[1] > 0.058 && end[1] - ramp[1] < 0.1);
    const start = l.back.pointAt(0);
    const d = Math.hypot(...f.toWorld(loop[0]).map((v, c) => v - start[c]));
    assert.ok(d > 0.058 && d < 0.1);
  }
});

test('réseau : une bille par tir, arrivée à temps, jamais deux billes au même endroit', () => {
  for (const l of tr.lines) {
    const row = e.instruments[l.instrument].model.row;
    assert.equal(l.feedBalls.length, row.shots.length);
    assert.equal(l.backBalls.length, row.shots.length);
    // La dernière bille d'alimentation arrive avant que la dernière bille ne sorte de sa buse.
    const lastShot = row.shots[row.shots.length - 1];
    assert.ok(l.feedBalls[l.feedBalls.length - 1].time <= Math.max(...row.shots.map((s) => s.time - s.station.before)) + 1e-9);
    assert.ok(l.backBalls[0].time >= Math.min(...row.shots.map((s) => s.time + (s.hold ?? 0) + s.station.after)) - 1e-9);
    assert.ok(lastShot.time > 0);
    const gap = (2 * l.ballRadius) / tr.options.speed;
    for (const balls of [l.feedBalls, l.backBalls]) for (let i = 1; i < balls.length; i++) assert.ok(balls[i].time - balls[i - 1].time >= gap, 'billes qui se touchent dans le tuyau');
    // La bille est dans le verre pendant tout son trajet, et nulle part ailleurs.
    const p = [0, 0, 0];
    const b = l.feedBalls[0];
    assert.ok(feedBall(tr, l, b, b.time - l.feedSpan / 2, p));
    assert.ok(trunkDistance(tr, p) < 0.06);
    assert.equal(feedBall(tr, l, b, b.time + 0.1, p), false);
    assert.equal(feedBall(tr, l, b, b.time - l.feedSpan - 0.1, p), false);
    assert.ok(backBall(tr, l, l.backBalls[0], l.backBalls[0].time + 1, p));
    assert.equal(backBall(tr, l, l.backBalls[0], l.backBalls[0].time - 0.1, p), false);
  }
});

test('réseau : les passes passent au large des tuyaux', () => {
  assert.ok(e.passes.cannons.length >= 1);
  const p = [0, 0, 0];
  for (const c of e.passes.cannons)
    for (const st of new Set(c.shots.map((s) => s.station)))
      for (let dt = -st.flightIn + 0.02; dt < 0; dt += 0.02) {
        stationBall(st, dt, p);
        assert.ok(trunkDistance(tr, p) >= 0.25, `passe à ${trunkDistance(tr, p).toFixed(2)} m d'un tuyau`);
      }
  assert.equal(buildEnsemble({ balls: marimba, bass: line(36, 2) }).trunks, undefined, 'pas de réseau hors du style « billes »');
});
