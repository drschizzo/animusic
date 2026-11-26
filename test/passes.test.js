import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solvePass, frameOf, planPasses } from '../src/passes.js';
import { ballistic, bounce, stationBall } from '../src/ballistics.js';
import { buildEnsemble } from '../src/arranger.js';

const close = (a, b, eps = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} ≉ ${b}`));

test('passe : la parabole part du canon, le rebond suit la loi de réflexion et retombe dans le cornet', () => {
  for (const pivot of [[1.2, -1.5, 5], [-2, -0.5, 4], [0, 0.5, 7]]) {
    const s = solvePass({ pivot, axis: [0, 0], y: 2, rho: 0.1, caught: [0, 1.25, 0.47], restitution: 0.55, barrel: 0.6 });
    assert.ok(s, `pas de solution depuis ${pivot}`);
    // Bouche au bout du fût, dans l'axe de la vitesse de sortie.
    close(s.mouth, [0, 1, 2].map((c) => pivot[c] + s.dir[c] * 0.6));
    close(ballistic(s.mouth, s.v0, s.flightIn), s.hit);
    // Impact sur le cylindre, normale radiale.
    assert.ok(Math.abs(Math.hypot(s.hit[0], s.hit[2]) - 0.1) < 1e-9);
    close(bounce(s.vIn, s.normal, 0.55), s.vOut);
    close(ballistic(s.hit, s.vOut, s.flightOut), [0, 1.25, 0.47]);
  }
});

test('repère d\'un instrument : aller-retour local ↔ scène', () => {
  const f = frameOf({ model: { origin: [3, 0, -8], yaw: 0.4 }, riser: 1.35 });
  close(f.toLocal(f.toWorld([0.5, 2, 1.5])), [0.5, 2, 1.5]);
  assert.ok(Math.abs(f.toWorld([0, 0, 0])[1] - 1.353) < 1e-9);
});

// Une guitare au premier gradin, une basse derrière elle : la guitare peut passer des billes à la basse.
const line = (midi0, track, n = 120) => Array.from({ length: n }, (_, i) => ({ midi: midi0 + (i % 7), time: 1 + i * 0.5, duration: 0.3, velocity: 0.8, track }));
const build = () => buildEnsemble({ balls: line(60, 0), plucked: line(55, 1), bass: line(36, 2) }, [], [], { style: 'balls' });

test('échanges : des notes de la basse sont servies par le canon, chacune par une seule bille', () => {
  const e = build();
  const bass = e.instruments.find((i) => i.kind === 'bass');
  const cannon = e.passes.cannons.find((c) => e.instruments[c.receiver] === bass);
  assert.ok(cannon, 'un canon vise la basse');
  assert.ok(cannon.shots.length >= 5, `${cannon.shots.length} passes`);
  // Une note = une bille : passe ou buse habituelle, jamais les deux.
  const row = bass.model.row;
  const own = new Set(row.shots.map((s) => s.time));
  for (const s of cannon.shots) assert.ok(!own.has(s.time));
  assert.equal(row.shots.length + cannon.shots.length, 120);
  assert.equal(row.stations.reduce((a, st) => a + st.shots.length, 0), row.shots.length);
  // Le canon a le temps de viser, et ne tire que pendant les fenêtres d'échange.
  for (let i = 1; i < cannon.launches.length; i++) assert.ok(cannon.launches[i].time - cannon.launches[i - 1].time >= e.passes.options.cannonGap - 1e-9);
  for (const s of cannon.shots) assert.ok(e.passes.windows.some(([a, b]) => s.time >= a && s.time < b));
});

test('échanges : la bille de passe frappe la corde à l\'instant de la note et finit dans son cornet', () => {
  const e = build();
  const cannon = e.passes.cannons[0];
  const recv = e.instruments[cannon.receiver];
  const f = frameOf(recv);
  const p = [0, 0, 0];
  for (const shot of cannon.shots.slice(0, 20)) {
    const target = recv.model.row.stations[shot.index];
    stationBall(shot.station, 0, p);
    const q = f.toLocal(p);
    // Sur le pourtour de la corde, à la hauteur de frappe habituelle.
    assert.ok(Math.abs(Math.hypot(q[0] - target.hit[0], q[2]) - target.hit[2]) < 1e-6);
    assert.ok(Math.abs(q[1] - target.hit[1]) < 1e-6);
    stationBall(shot.station, shot.station.flightOut - 1e-6, p);
    close(f.toLocal(p), target.catch, 1e-4);
    // Elle naît dans le fût du canon.
    stationBall(shot.station, -shot.station.before + 1e-6, p);
    assert.ok(Math.hypot(p[0] - cannon.pivot[0], p[1] - cannon.pivot[1], p[2] - cannon.pivot[2]) < cannon.barrel);
  }
});

test('échanges : aucune bille de passe ne touche une bille de la rangée', () => {
  const e = build();
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  for (const cannon of e.passes.cannons) {
    const recv = e.instruments[cannon.receiver];
    const f = frameOf(recv);
    const row = recv.model.row;
    for (const shot of cannon.shots)
      for (let dt = -shot.station.before; dt < shot.station.after; dt += 1 / 240) {
        stationBall(shot.station, dt, p);
        for (const other of row.shots) {
          if (Math.abs(other.time - shot.time) > 3 || !stationBall(other.station, shot.time + dt - other.time, q)) continue;
          const w = f.toWorld(q);
          assert.ok(Math.hypot(p[0] - w[0], p[1] - w[1], p[2] - w[2]) >= 2 * row.ballRadius, `contact à t=${(shot.time + dt).toFixed(2)}`);
        }
      }
  }
});

test('sans voisin bien placé, c\'est le canon central de la tourelle du marimba qui tire', () => {
  assert.equal(buildEnsemble({ balls: line(60, 0), bass: line(36, 2) }).passes, undefined, 'pas de passes hors du style « billes »');
  const e = buildEnsemble({ balls: line(60, 0), bass: line(36, 2) }, [], [], { style: 'balls' });
  assert.equal(e.passes.cannons.length, 1);
  const cannon = e.passes.cannons[0];
  assert.equal(e.instruments[cannon.sender].kind, 'balls');
  assert.equal(cannon.mount, 'hub');
  close(cannon.pivot, [0, e.passes.options.hubHeight, 0]);
  assert.ok(cannon.shots.length >= 5, `${cannon.shots.length} passes`);
  // Long lob : plus d'une seconde de vol, bien au-dessus des billes du marimba.
  const st = cannon.shots[0].station;
  assert.ok(st.flightIn > 1 && st.flightIn < 2.6);
  // Les tirs du mât sont triés et espacés, même s'il sert plusieurs instruments.
  const all = build().passes.cannons.filter((c) => c.mount === 'hub');
  for (const c of all) for (let i = 1; i < c.launches.length; i++) assert.ok(c.launches[i].time - c.launches[i - 1].time >= e.passes.options.cannonGap - 1e-9);
  assert.equal(typeof planPasses, 'function');
});
