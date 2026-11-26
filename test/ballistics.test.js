import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStrike, buildStation, stationBall, shotClearance, assignShots, bounce, fillet, polyline, fallTime, GRAVITY } from '../src/ballistics.js';
import { buildDrumKit, PIECES } from '../src/drums.js';
import { buildEnsemble } from '../src/arranger.js';

const close = (a, b, eps = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} ≉ ${b}`));

test('rebond : composante normale inversée et amortie, tangentielle conservée', () => {
  close(bounce([1.5, -5, 0.5], [0, 1, 0], 0.5), [1.5, 2.5, 0.5]);
  close(bounce([0, -1, 3], [0, 0, -1], 0.5), [0, -1, -1.5]);
});

test('arrondi : extrémités conservées, aucun angle vif', () => {
  const pts = fillet([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], 0.2);
  close(pts[0], [0, 0, 0]);
  close(pts[pts.length - 1], [1, 1, 1]);
  for (let i = 2; i < pts.length; i++) {
    const u = [0, 1, 2].map((c) => pts[i - 1][c] - pts[i - 2][c]);
    const w = [0, 1, 2].map((c) => pts[i][c] - pts[i - 1][c]);
    const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
    assert.ok(cos > 0.97, `angle vif au point ${i}`);
  }
});

const strike = planStrike({ hit: [1, 1, 2], normal: [0, 1, 0], vIn: [1.5, -5, 0], flightIn: 0.3, restitution: 0.55, flightOut: fallTime(2.75, 0.2) });
const pipe = (p, v, back) => {
  const l = Math.hypot(...v);
  return [[0, 1, 2].map((c) => p[c] - (v[c] / l) * (back ? -1 : 1)), p];
};
const station = buildStation(strike, { ballRadius: 0.04, feed: pipe(strike.mouth, strike.v0), drain: pipe(strike.catch, strike.vCatch, true).reverse() });

test('la bille est exactement au point de frappe à l\'instant de la note', () => {
  const p = [0, 0, 0];
  assert.ok(stationBall(station, 0, p));
  close(p, [1, 1, 2]);
  assert.ok(Math.abs(strike.catch[1] - 0.8) < 1e-9, 'le cornet est 20 cm plus bas');
});

test('trajectoire continue du tuyau au cornet, vitesse de sortie dans l\'axe du tuyau', () => {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const step = 1e-3;
  let maxSpeed = 0;
  for (let dt = -station.before + step; dt < station.after - step; dt += step) {
    stationBall(station, dt, a);
    stationBall(station, dt + step, b);
    maxSpeed = Math.max(maxSpeed, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / step);
  }
  assert.ok(maxSpeed < 8, `saut de position (${maxSpeed} m/s)`);
  assert.equal(stationBall(station, -station.before - 0.01, a), false);
  assert.equal(stationBall(station, station.after + 0.01, a), false);
  // Avant la bouche, la bille avance en ligne droite dans l'axe de v0.
  stationBall(station, -station.flightIn - 0.05, a);
  const l = Math.hypot(...strike.v0);
  close(a, [0, 1, 2].map((c) => strike.mouth[c] - strike.v0[c] * 0.05), 1e-6 * l);
});

test('deux billes d\'une même station ne se touchent jamais à l\'écart minimal', () => {
  assert.ok(station.minGap < 0.12);
  assert.ok(shotClearance(station, station.minGap) >= 0.08);
  const next = 0.2 + station.minGap + 1e-9;
  const shots = assignShots(station, [0, 0.01, 0.2, next].map((time) => ({ time })));
  assert.deepEqual(shots.map((s) => s.time), [0, 0.2, next]);
});

// Une note de chaque élément, plus une série rapide de charleston.
const notes = [36, 38, 42, 41, 45, 48, 49, 51, 56].map((midi, i) => ({ midi, time: 1 + i * 0.5, velocity: 0.8, track: 0 }));
for (let i = 0; i < 16; i++) notes.push({ midi: 42, time: 6 + i * 0.1, velocity: 0.6, track: 0 });

test('batterie à billes : une station par élément, la bille touche la surface frappée', () => {
  const kit = buildDrumKit(notes, { player: 'balls', center: [0, 0, -4] });
  assert.deepEqual(kit.pieces.map((p) => p.name).sort(), Object.keys(PIECES).sort());
  const r = kit.options.ballRadius;
  for (const piece of kit.pieces) {
    const st = piece.station;
    assert.ok(!piece.arm, 'pas de bras');
    const p = [0, 0, 0];
    stationBall(st, 0, p);
    const gap = Math.hypot(p[0] - piece.hitPoint[0], p[1] - piece.hitPoint[1], p[2] - piece.hitPoint[2]);
    assert.ok(Math.abs(gap - r) < 0.001, `${piece.name} : bille à ${gap} de la surface`);
    // Une bille par frappe (aucune n'est assez rapprochée ici pour être écartée).
    assert.equal(piece.shots.length, piece.hits.length);
    assert.ok(st.minGap <= 0.08, `${piece.name} : écart minimal ${st.minGap}`);
    // La bille repart vers l'extérieur et le cornet l'attend sur sa trajectoire.
    stationBall(st, st.flightOut - 1e-6, p);
    close(p, st.catch, 1e-4);
    // Tuyau continu du cornet à la bouche, jamais sous le sol.
    close(st.tube[0], st.catch);
    close(st.tube[st.tube.length - 1], st.mouth);
    for (const q of st.tube) assert.ok(q[1] >= kit.options.pipeFloorY - 1e-9);
  }
  assert.ok(kit.maxBalls >= 2 && kit.maxBalls <= 16);
});

test('batterie à billes : les billes de deux éléments ne se croisent pas', () => {
  // Tous les éléments frappés ensemble, à tous les décalages utiles.
  const kit = buildDrumKit([36, 38, 42, 41, 45, 48, 49, 51, 56].map((midi) => ({ midi, time: 1, velocity: 1, track: 0 })), { player: 'balls' });
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  for (let i = 0; i < kit.pieces.length; i++)
    for (let j = i + 1; j < kit.pieces.length; j++) {
      const [A, B] = [kit.pieces[i].station, kit.pieces[j].station];
      for (let dt = -1; dt < 1.2; dt += 1 / 240)
        for (let lag = -1.2; lag <= 1.2; lag += 1 / 60) {
          if (!stationBall(A, dt, a) || !stationBall(B, dt - lag, b)) continue;
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          assert.ok(d >= 0.085, `${kit.pieces[i].name} ↔ ${kit.pieces[j].name} : ${d.toFixed(3)} m`);
        }
    }
});

test('style « billes » : l\'estrade de la batterie couvre ses tuyaux', () => {
  const balls = Array.from({ length: 20 }, (_, i) => ({ midi: 60 + (i % 5), time: 1 + i * 0.5, duration: 0.2, velocity: 0.8, track: 0 }));
  const drums = notes.map((n) => ({ ...n, duration: 0.1, track: 1 }));
  const e = buildEnsemble({ balls, drums }, [], [], { style: 'balls' });
  const inst = e.instruments.find((i) => i.kind === 'drums');
  const kit = inst.model;
  assert.equal(kit.player, 'balls');
  const f = inst.footprint;
  for (const piece of kit.pieces)
    for (const q of piece.station.tube) {
      assert.ok(Math.abs(q[0] - f.center[0]) <= f.halfW && Math.abs(q[2] - f.center[1]) <= f.halfD, `${piece.name} déborde de l'estrade`);
      assert.ok(inst.riser + q[1] <= f.top);
    }
  // Sans option, rien ne change : bras robotisés.
  assert.equal(buildEnsemble({ balls, drums }).instruments.find((i) => i.kind === 'drums').model.player, 'arms');
  assert.equal(GRAVITY, 9.8);
  assert.ok(polyline(kit.pieces[0].station.tube).length > 1);
});

// --- Rangées de stations : carillon et cordes
import { buildBallRow } from '../src/ballRow.js';
import { buildBells } from '../src/bells.js';
import { buildBassStrings } from '../src/strings.js';

const melody = Array.from({ length: 24 }, (_, i) => ({ midi: 60 + (i % 9), time: 1 + i * 0.25, duration: 0.3, velocity: 0.8, track: 0 }));

test('rangée : une station par cible, plans parallèles, cornets qui ne se chevauchent pas', () => {
  for (const spacing of [0.36, 0.24, 0.14]) {
    const targets = Array.from({ length: 6 }, (_, i) => ({ x: i * spacing, hits: [{ time: 1 + i, velocity: 1, track: 0 }] }));
    const row = buildBallRow(targets, { y: 2, z: 0.05 }, spacing);
    assert.equal(row.stations.length, 6);
    assert.ok(2 * row.hornRadius < spacing, 'cornets voisins séparés');
    assert.ok(row.tubeRadius > row.ballRadius && row.hornRadius >= row.tubeRadius);
    const p = [0, 0, 0];
    row.stations.forEach((st, i) => {
      // La bille reste dans le plan de sa cible et touche la surface à l'instant de la note.
      for (let dt = -st.before; dt < st.after; dt += 0.01) if (stationBall(st, dt, p)) assert.ok(Math.abs(p[0] - i * spacing) < 1e-9);
      stationBall(st, 0, p);
      close(p, [i * spacing, 2, 0.05 + row.ballRadius]);
      assert.ok(st.minGap <= 0.08);
    });
    assert.equal(row.shots.length, 6);
  }
});

test('carillon et cordes à billes : frappe sur le tube ou la corde, sans marteau ni chariot', () => {
  const bells = buildBells(melody, { player: 'balls' });
  assert.equal(bells.row.stations.length, bells.bells.length);
  const o = bells.options;
  for (const st of bells.row.stations) {
    assert.ok(Math.abs(st.hit[2] - (bells.radius + bells.row.ballRadius)) < 1e-9);
    assert.ok(st.hit[1] < o.top - o.cord && st.hit[1] > o.top - o.cord - o.lenHigh, 'sur le tube le plus court');
  }
  assert.equal(bells.row.shots.length, melody.length);
  assert.equal(buildBells(melody).row, undefined);

  const strings = buildBassStrings(melody, { player: 'balls' });
  assert.equal(strings.carriers.length, 0);
  const so = strings.options;
  for (const st of strings.row.stations) assert.ok(st.hit[1] > so.bottom && st.hit[1] < so.bottom + so.lenHigh, 'sur la corde la plus courte');
  // Le collecteur reste au-dessus du socle.
  for (const q of strings.row.loop) assert.ok(q[1] > 0.3);
  assert.ok(buildBassStrings(melody).carriers.length > 0);
});

test('style « billes » : carillon et cordes ont leur rampe sur l\'estrade', () => {
  const e = buildEnsemble({ balls: melody, bells: melody.map((n) => ({ ...n, track: 1 })), bass: melody.map((n) => ({ ...n, midi: n.midi - 24, track: 2 })), plucked: melody.map((n) => ({ ...n, track: 3 })) }, [], [], { style: 'balls' });
  for (const kind of ['bells', 'bass', 'plucked']) {
    const inst = e.instruments.find((i) => i.kind === kind);
    assert.ok(inst.model.row, kind);
    assert.ok(inst.model.row.extent.maxZ <= inst.footprint.halfD, `${kind} : rampe hors de l'estrade`);
    assert.ok(inst.start <= inst.model.onsets[0] - inst.model.row.before);
  }
});
