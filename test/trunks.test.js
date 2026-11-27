import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trunkBall, trunkDistance } from '../src/trunks.js';
import { frameOf } from '../src/passes.js';
import { stationBall } from '../src/ballistics.js';
import { buildEnsemble } from '../src/arranger.js';
import { analyzeSong, deployAt } from '../src/sections.js';

const marimba = Array.from({ length: 100 }, (_, i) => ({ midi: 60 + (i % 5), time: 1 + i * 0.4, duration: 0.2, velocity: 0.8, track: 0 }));
const line = (midi0, track, step = 0.8, dur = 0.6) => Array.from({ length: 50 }, (_, i) => ({ midi: midi0 + (i % 6), time: 1 + i * step, duration: dur, velocity: 0.8, track }));
// Accords : trois notes ensemble, pour vérifier que leurs billes se suivent dans le tuyau.
const chords = Array.from({ length: 30 }, (_, i) => [48, 52, 55].map((midi) => ({ midi, time: 2 + i, duration: 0.7, velocity: 0.8, track: 1 }))).flat();
const drums = [36, 38, 42, 45, 49].flatMap((midi, k) => Array.from({ length: 20 }, (_, i) => ({ midi, time: 1 + i * 0.5 + k * 0.1, duration: 0.1, velocity: 0.8, track: 5 })));
const e = buildEnsemble({ balls: marimba, pads: chords, bass: line(36, 2, 0.25, 0.2), keys: line(64, 3, 0.2, 0.15), bells: line(72, 4), drums }, [], [], { style: 'balls' });
const tr = e.trunks;
const o = tr.options;

test('réseau : au sol, de la tourelle vers les estrades, en tronçons droits sur une grille', () => {
  assert.ok(tr.lines.length >= 5, `${tr.lines.length} lignes`);
  assert.ok(tr.arrived >= tr.lines.length - 3, 'la plupart des lignes arrivent au pied de leur estrade');
  // Une seule ligne pour toute la batterie.
  assert.ok(tr.lines.filter((l) => l.kit).length <= 1);
  for (const l of tr.lines) {
    const pts = l.maze.points;
    for (const p of pts) assert.ok(p[1] <= o.axisY + 1e-9, 'jamais au-dessus du sol');
    // Les deux bouts plongent dans le sol ; l'un est dans la rangée des départs, derrière la tourelle.
    assert.ok(pts[0][1] < 0 && pts[pts.length - 1][1] < 0);
    const hub = l.kind === 'feed' ? pts[0] : pts[pts.length - 1];
    assert.ok(Math.abs(hub[2] + o.manifold) < o.cell);
    // Tracé propre : des tronçons parallèles ou perpendiculaires au bord de scène, peu de coudes.
    const flat = pts.filter((p) => p[1] > o.axisY - 1e-6);
    let skew = 0;
    for (let i = 1; i < flat.length; i++) if (Math.abs(flat[i][0] - flat[i - 1][0]) > 1e-6 && Math.abs(flat[i][2] - flat[i - 1][2]) > 1e-6) skew += Math.hypot(flat[i][0] - flat[i - 1][0], flat[i][2] - flat[i - 1][2]);
    // De biais seulement dans l'arrondi des coudes (quelques centimètres chacun).
    assert.ok(skew <= 0.16 * (l.turns + 1), `${skew.toFixed(2)} m de biais pour ${l.turns} coudes`);
    assert.ok(l.turns <= 20, `${l.turns} coudes`);
    if (l.arrived) {
      const end = l.kind === 'feed' ? pts[pts.length - 1] : pts[0];
      assert.ok(Math.hypot(end[0] - l.foot[0], end[2] - l.foot[1]) < 1, 'plongée au pied de l\'estrade');
    }
  }
});

test('réseau : deux tuyaux ne se touchent jamais, et aucun ne passe sous une estrade', () => {
  const flats = tr.lines.map((l) => l.maze.points.filter((p) => p[1] > o.axisY - 1e-6));
  for (let i = 0; i < flats.length; i++)
    for (let j = i + 1; j < flats.length; j++)
      for (const p of flats[i]) for (const q of flats[j]) assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) > 2 * o.radius + 0.01, `lignes ${i} et ${j} à ${Math.hypot(p[0] - q[0], p[2] - q[2]).toFixed(3)} m`);
  for (const pts of flats)
    for (const p of pts)
      for (const ins of e.instruments) {
        const g = ins.footprint;
        if (!g) continue;
        const [dx, dz] = [p[0] - g.center[0], p[2] - g.center[1]];
        const [c, s] = [Math.cos(g.yaw), Math.sin(g.yaw)];
        assert.ok(Math.abs(c * dx - s * dz) > g.halfW || Math.abs(s * dx + c * dz) > g.halfD, `tuyau sous l'estrade de ${ins.kind}`);
      }
});

test('colonnes : plantées dans l\'estrade, raccordées aux bouts de la rampe et du collecteur', () => {
  for (const l of tr.lines.filter((x) => x.riser)) {
    const ins = e.instruments[l.instrument];
    const f = frameOf(ins);
    const loop = ins.model.row.loop;
    const pts = l.riser.points;
    const [foot, joint] = l.kind === 'feed' ? [pts[0], pts[pts.length - 1]] : [pts[pts.length - 1], pts[0]];
    assert.ok(Math.abs(foot[1] - f.toWorld([0, 0, 0])[1]) < 1e-9, 'pied au niveau de l\'estrade');
    const end = f.toWorld(l.kind === 'feed' ? loop[loop.length - 1] : loop[0]);
    const d = Math.hypot(joint[0] - end[0], joint[1] - end[1], joint[2] - end[2]);
    assert.ok(d > 0.058 && d < 0.1, `raccord à ${d.toFixed(3)} m`);
    // Dans l'encombrement déclaré de l'instrument.
    const q = f.toLocal(foot);
    assert.ok(Math.abs(q[0]) <= ins.footprint.halfW && Math.abs(q[2]) <= ins.footprint.halfD);
  }
});

test('billes : une par tir, dans le verre ou sous le sol, jamais deux au même endroit', () => {
  const p = [0, 0, 0];
  for (const l of tr.lines) {
    const count = l.kit ? e.instruments[l.instrument].model.shots.length : e.instruments[l.instrument].model.row.shots.length;
    assert.equal(l.balls.length, count);
    const gap = (2 * l.ballRadius) / o.speed;
    for (let i = 1; i < l.balls.length; i++) assert.ok(l.balls[i].time - l.balls[i - 1].time >= gap, 'billes qui se touchent');
    const b = l.balls[0];
    if (l.kind === 'feed') {
      // Dans les lacets bien avant, sous le sol entre les deux, dans la colonne juste avant, disparue après.
      assert.ok(trunkBall(tr, l, b, b.time - l.before + l.mazeSpan / 2, p) && p[1] <= o.axisY + 1e-9);
      assert.equal(trunkBall(tr, l, b, b.time + 0.05, p), false);
      if (l.riser) {
        assert.equal(trunkBall(tr, l, b, b.time - l.riserSpan - o.hidden / 2, p), false, 'sous le sol');
        assert.ok(trunkBall(tr, l, b, b.time - l.riserSpan / 2, p));
        assert.ok(trunkDistance(tr, p) < 0.06, 'dans sa colonne');
        trunkBall(tr, l, b, b.time, p);
        assert.ok(Math.hypot(...l.riser.pointAt(l.riser.length).map((v, c) => v - p[c])) < 1e-6, 'arrivée au bout de la rampe');
      }
    } else {
      assert.equal(trunkBall(tr, l, b, b.time - 0.05, p), false);
      assert.ok(trunkBall(tr, l, b, b.time + l.riserSpan / 2, p));
      assert.equal(trunkBall(tr, l, b, b.time + l.riserSpan + o.hidden / 2, p), false, 'sous le sol');
      assert.ok(trunkBall(tr, l, b, b.time + l.riserSpan + o.hidden + l.mazeSpan / 2, p) && p[1] <= o.axisY + 1e-9);
    }
  }
});

test('passes au large des colonnes ; tous les instruments en place dès le début', () => {
  assert.ok(e.passes.cannons.length >= 1);
  const p = [0, 0, 0];
  for (const c of e.passes.cannons)
    for (const st of new Set(c.shots.map((s) => s.station)))
      for (let dt = -st.flightIn + 0.02; dt < 0; dt += 0.02) {
        stationBall(st, dt, p);
        assert.ok(trunkDistance(tr, p) >= 0.25, `passe à ${trunkDistance(tr, p).toFixed(2)} m d'une colonne`);
      }
  // La basse n'entre qu'à 60 s : sans réseau elle sortirait du sol à ce moment-là.
  const late = line(36, 2).map((n) => ({ ...n, time: n.time + 60 }));
  const withNet = buildEnsemble({ balls: marimba, bass: late }, [], [], { style: 'balls' });
  const song = analyzeSong(withNet);
  withNet.instruments.forEach((_, k) => assert.equal(deployAt(song, k, withNet.start), 1));
  const without = buildEnsemble({ balls: marimba, bass: late });
  assert.equal(without.trunks, undefined, 'pas de réseau hors du style « billes »');
  assert.equal(deployAt(analyzeSong(without), without.instruments.findIndex((i) => i.kind === 'bass'), without.start), 0);
});
