import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCupRow, buildKeyRow } from '../src/ballRow.js';
import { stationBall, cupLift } from '../src/ballistics.js';
import { buildKeyboard, keyDepth } from '../src/keys.js';
import { buildPipes, pipeState } from '../src/pipes.js';
import { buildWinds } from '../src/winds.js';
import { buildLaserHarp } from '../src/laser.js';
import { buildEnsemble } from '../src/arranger.js';

const close = (a, b, eps = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} ≉ ${b}`));
const held = (midi0, track, n = 40) => Array.from({ length: n }, (_, i) => ({ midi: midi0 + (i % 6), time: 1 + i * 0.8, duration: 0.6, velocity: 0.8, track }));

test('coupelle : la bille arrive à l\'instant de la note, y reste le temps de la note, puis tombe dans son cornet', () => {
  const notes = [{ start: 1, end: 2, velocity: 1, track: 0 }, { start: 2.1, end: 2.2, velocity: 1, track: 0 }, { start: 2.2, end: 3, velocity: 1, track: 0 }];
  const row = buildCupRow([0, 0.4].map((x) => ({ x, notes })), { y: 1, z: 0.85 }, 0.4);
  const st = row.stations[0];
  // Notes trop rapprochées : pas de bille ; la précédente est éjectée avant l'arrivée de la suivante.
  assert.deepEqual(st.shots.map((s) => s.time), [1, 2.1]);
  assert.ok(st.shots[0].hold <= 2.1 - 1 - row.options.exitMargin + 1e-9);
  const p = [0, 0, 0];
  const hold = st.shots[0].hold;
  stationBall(st, 0, p, hold);
  close(p, [0, 1, 0.85]);
  // Posée : elle ne bouge que verticalement, avec la coupelle, de moins que la course du poussoir.
  for (let dt = 0.01; dt < hold; dt += 0.01) {
    stationBall(st, dt, p, hold);
    assert.ok(Math.abs(p[0]) < 1e-9 && Math.abs(p[2] - 0.85) < 1e-9 && Math.abs(p[1] - 1) <= row.options.cupTravel * 1.3);
    assert.ok(Math.abs(p[1] - 1 - cupLift(st, dt, hold)) < 1e-9);
  }
  // Éjection continue, puis cornet.
  stationBall(st, hold - 1e-4, p, hold);
  const q = [0, 0, 0];
  stationBall(st, hold + 1e-4, q, hold);
  assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.005);
  stationBall(st, hold + st.flightOut - 1e-6, p, hold);
  close(p, st.catch, 1e-4);
  assert.equal(stationBall(st, hold + st.after + 0.01, p, hold), false);
  // Rangée derrière l'instrument : tout est du côté −z.
  const back = buildCupRow([0, 0.4].map((x) => ({ x, notes })), { y: 1, z: -0.95 }, 0.4, { sign: -1 });
  assert.ok(back.stations[0].mouth[2] < -0.95 && back.stations[0].catch[2] < -0.95);
});

test('touches : buses orientées depuis une même rampe, la bille touche la touche à l\'instant de la note', () => {
  const hit = (x) => ({ x, hits: [{ time: 1, velocity: 1, track: 0 }] });
  const white = { y: 2.07, z: -0.28 };
  const black = { y: 2.34, z: -0.28 };
  const row = buildKeyRow([{ targets: [0, 0.118, 0.236].map(hit), y: 0.92, z: 0.25, axis: white }, { targets: [0.059].map(hit), y: 0.9625, z: 0.09, axis: black }], 0.118);
  assert.equal(row.stations.length, 4);
  const p = [0, 0, 0];
  for (const st of row.stations) {
    // La buse part de l'axe de la rampe, dans la direction de la vitesse de sortie.
    const axis = st.hit[2] > 0.1 ? white : black;
    close(st.feed.points[0].slice(1), [axis.y, axis.z]);
    const d = [0, 1, 2].map((c) => st.mouth[c] - st.feed.points[0][c]);
    const cos = (d[1] * st.v0[1] + d[2] * st.v0[2]) / (Math.hypot(...d) * Math.hypot(...st.v0));
    assert.ok(cos > 1 - 1e-9);
    stationBall(st, 0, p);
    assert.ok(Math.abs(p[1] - (st.hit[2] > 0.1 ? 0.92 : 0.9625) - row.ballRadius) < 1e-9);
    assert.ok(st.vOut[2] > 0.5, 'elle repart vers l\'avant');
    assert.ok(st.minGap <= 0.11);
  }
  // Tous les collecteurs à la même hauteur ; celui des noires est en retrait.
  const ends = row.stations.map((st) => st.drain.points[1]);
  for (const e of ends) assert.ok(Math.abs(e[1] - ends[0][1]) < 1e-9);
  // Un collecteur et une rampe de plus que le circuit principal.
  assert.equal(row.pipes.length, 2);
  // La bille d'une noire passe franchement au-dessus du bord avant des blanches (z = 0,36).
  const b = row.stations.find((st) => st.hit[2] < 0.1);
  for (let dt = 0; dt < b.flightOut; dt += 0.005) {
    stationBall(b, dt, p);
    if (p[2] < 0.42) assert.ok(p[1] - row.ballRadius > 0.92 + 0.03, `trop bas à z=${p[2].toFixed(2)}`);
  }
});

test('instruments à billes : clavier, orgue, vents et harpe laser ont leur rangée', () => {
  const keys = buildKeyboard(held(60, 0).map((n, i) => ({ ...n, midi: 60 + (i % 8) })), { player: 'balls', press: 0.04 });
  assert.equal(keys.row.kind, 'keys');
  assert.equal(keys.row.stations.length, keys.played.length);
  // La touche est encore relevée quand la bille arrive, enfoncée juste après.
  const k = keys.played[0];
  assert.equal(keyDepth(keys, k, k.hits[0].time), 0);
  assert.ok(keyDepth(keys, k, k.hits[0].time + 0.05) > 0.99);
  assert.ok(keyDepth(buildKeyboard(held(60, 0)), buildKeyboard(held(60, 0)).played[0], 1) > 0.99, 'sans billes : enfoncée à l\'instant de la note');

  const pipes = buildPipes(held(48, 1), { player: 'balls' });
  assert.equal(pipes.row.kind, 'cups');
  // La valve ne s'ouvre plus d'avance : seulement quand la bille est là.
  assert.equal(pipeState(pipes, pipes.pipes[0], pipes.pipes[0].notes[0].start - 0.1).valve, 0);
  assert.equal(buildPipes(held(48, 1)).row, undefined);

  assert.equal(buildWinds(held(60, 2), { player: 'balls', style: 'brass' }).row.sign, -1);
  assert.equal(buildWinds(held(60, 2), { player: 'balls', style: 'flute' }).row.sign, 1);
  const laser = buildLaserHarp(held(72, 3), { player: 'balls' });
  assert.ok(laser.row.stations[0].hit[2] > Math.max(...laser.emitters.map((e) => e.position[2])));
});

test('style « billes » : estrades à la mesure des rangées, passes vers les coupelles', () => {
  const marimba = Array.from({ length: 100 }, (_, i) => ({ midi: 60 + (i % 5), time: 1 + i * 0.4, duration: 0.2, velocity: 0.8, track: 0 }));
  const e = buildEnsemble({ balls: marimba, pads: held(48, 1), winds: held(60, 2), keys: held(64, 3), laser: held(72, 4) }, [], [], { style: 'balls' });
  for (const inst of e.instruments) {
    if (inst.kind === 'balls') continue;
    const row = inst.model.row;
    assert.ok(row, inst.kind);
    assert.ok(row.extent.maxZ <= inst.footprint.halfD, `${inst.kind} : rangée hors de l'estrade`);
    assert.ok(inst.riser + row.extent.top <= inst.footprint.top + 1e-9, `${inst.kind} : rangée plus haute que l'encombrement déclaré`);
  }
  // Une note = une bille : celle de la rampe ou celle d'un canon, et la coupelle s'enfonce dans les deux cas.
  const toCups = e.passes.cannons.filter((c) => e.instruments[c.receiver].model.row.kind === 'cups');
  assert.ok(toCups.length >= 1, 'au moins un canon vise des coupelles');
  assert.ok(!e.passes.cannons.some((c) => e.instruments[c.receiver].kind === 'keys'), 'le clavier ne reçoit pas de passes');
  for (const c of toCups) {
    const row = e.instruments[c.receiver].model.row;
    const own = new Set(row.shots.map((s) => `${s.index}:${s.time}`));
    for (const s of c.shots) {
      assert.ok(!own.has(`${s.index}:${s.time}`));
      const kept = row.stations[s.index].shots.find((h) => h.time === s.time);
      assert.ok(kept?.pass, 'la coupelle garde la frappe');
      assert.equal(s.hold, kept.hold);
    }
  }
});
