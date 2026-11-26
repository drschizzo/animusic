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

const drums = [36, 38, 42, 45, 49].flatMap((midi, k) => Array.from({ length: 20 }, (_, i) => ({ midi, time: 1 + i * 0.5 + k * 0.1, duration: 0.1, velocity: 0.8, track: 5 })));
const gap = (A, B) => {
  let min = Infinity;
  for (const p of A) for (const q of B) min = Math.min(min, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  return min;
};

test('réseau : une arche par rangée et par fût, colonnes en demi-cercle, aucun tuyau n\'en touche un autre', () => {
  const full = buildEnsemble({ balls: marimba, pads: chords, bass: line(36, 2, 0.25, 0.2), keys: line(64, 3, 0.2, 0.15), bells: line(72, 4), drums }, [], [], { style: 'balls' });
  const net = full.trunks;
  const kit = full.instruments.find((i) => i.kind === 'drums');
  // Trois rangées (le clavier, tout contre la colonnade, n'a pas d'arche) et les cinq fûts.
  assert.equal(net.lines.filter((l) => l.back).length, 3);
  assert.equal(net.lines.filter((l) => l.piece).length, kit.model.pieces.length);
  assert.ok(!net.lines.some((l) => full.instruments[l.instrument].kind === 'keys'));
  // Colonnes sur leur demi-cercle, écartées, hautes au centre.
  const o = net.options;
  for (const l of net.lines) assert.ok(Math.abs(Math.hypot(l.foot[0], l.foot[2]) - o.ringFeed) < 1e-9 && l.foot[2] > 0);
  const phis = net.lines.map((l) => l.phi);
  for (let i = 1; i < phis.length; i++) assert.ok((phis[i] - phis[i - 1]) * o.ringFeed >= o.columnGap - 1e-9);
  const mid = net.lines[Math.floor(net.lines.length / 2)];
  assert.ok(mid.tall > net.lines[0].tall);
  // Toutes les arches passent au-dessus de l'instrument le plus haut, et aucun tuyau n'en touche un autre.
  const top = Math.max(...full.instruments.filter((i) => i.footprint).map((i) => i.footprint.top));
  const pipes = net.lines.flatMap((l) => (l.back ? [l.feed.points, l.back.points] : [l.feed.points]));
  for (const pts of pipes) assert.ok(Math.max(...pts.map((p) => p[1])) >= top + 0.9);
  for (let i = 0; i < pipes.length; i++) for (let j = i + 1; j < pipes.length; j++) assert.ok(gap(pipes[i], pipes[j]) > 2 * o.radius + 0.02, `tuyaux ${i} et ${j} trop proches`);
  // Chaque fût reçoit une bille par tir, arrivée avant qu'elle ne sorte de la bouche.
  for (const l of net.lines.filter((x) => x.piece)) {
    const piece = kit.model.pieces.find((p) => p.name === l.piece);
    assert.equal(l.feedBalls.length, piece.shots.length);
    assert.ok(l.feedBalls[0].time <= piece.shots[0].time - piece.station.before);
    assert.equal(l.backBalls.length, 0);
  }
});

test('style « billes » : tous les instruments sont en place dès le début', async () => {
  const { analyzeSong, deployAt } = await import('../src/sections.js');
  // La basse n'entre qu'à 60 s : sans réseau elle sortirait du sol à ce moment-là.
  const late = line(36, 2).map((n) => ({ ...n, time: n.time + 60 }));
  const withNet = buildEnsemble({ balls: marimba, bass: late }, [], [], { style: 'balls' });
  const song = analyzeSong(withNet);
  withNet.instruments.forEach((_, k) => assert.equal(deployAt(song, k, withNet.start), 1));
  const without = buildEnsemble({ balls: marimba, bass: late });
  const bass = without.instruments.findIndex((i) => i.kind === 'bass');
  assert.equal(deployAt(analyzeSong(without), bass, without.start), 0);
});

test('réseau : chaque arche se pose contre le bout de la rampe ou du collecteur de son instrument', () => {
  for (const l of tr.lines) {
    const ins = e.instruments[l.instrument];
    const f = frameOf(ins);
    const loop = ins.model.row.loop;
    const ramp = f.toWorld(loop[loop.length - 1]);
    const end = l.feed.pointAt(l.feed.length);
    assert.ok(Math.abs(end[0] - ramp[0]) < 1e-6 && Math.abs(end[2] - ramp[2]) < 1e-6 && end[1] - ramp[1] > 0.058 && end[1] - ramp[1] < 0.1);
    // Elle arrive à la verticale.
    const before = l.feed.pointAt(l.feed.length - 0.2);
    assert.ok(Math.hypot(before[0] - end[0], before[2] - end[2]) < 0.03 && before[1] > end[1]);
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
