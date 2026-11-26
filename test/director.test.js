import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnsemble } from '../src/arranger.js';
import { planShots, cameraAt } from '../src/director.js';
import { ballPosition } from '../src/choreography.js';

// Billes pendant 0-20 s, puis un solo de batterie 20-30 s.
const balls = Array.from({ length: 80 }, (_, i) => ({ midi: 60 + (i % 12), time: i * 0.25, duration: 0.2, velocity: 0.8, track: 0 }));
const drums = Array.from({ length: 80 }, (_, i) => ({ midi: [36, 38, 42][i % 3], time: 20 + i * 0.125, duration: 0.1, velocity: 0.8, track: 1 }));
const ensemble = buildEnsemble({ balls, drums });

test('les plans couvrent tout le morceau sans trou', () => {
  const { shots } = planShots(ensemble);
  assert.ok(shots[0].start <= ensemble.start);
  assert.ok(shots[shots.length - 1].end >= ensemble.end);
  for (let i = 1; i < shots.length; i++) assert.equal(shots[i].start, shots[i - 1].end);
});

test('le solo de batterie est filmé', () => {
  const { shots } = planShots(ensemble);
  const drumsIndex = ensemble.instruments.findIndex((i) => i.kind === 'drums');
  const solo = shots.filter((s) => s.start >= 20 && s.end <= 31);
  assert.ok(solo.some((s) => s.subject === drumsIndex));
  // Pendant le solo, on ne filme jamais les billes (silencieuses).
  const ballsIndex = ensemble.instruments.findIndex((i) => i.kind === 'balls');
  assert.ok(solo.every((s) => s.subject !== ballsIndex));
});

test('la caméra se déplace sans à-coup, sauf aux coupes franches', () => {
  const plan = planShots(ensemble);
  const cuts = plan.shots.filter((s) => s.cut).map((s) => s.start);
  let prev = cameraAt(plan, ensemble.start);
  for (let t = ensemble.start; t < ensemble.end; t += 0.01) {
    const p = cameraAt(plan, t);
    const d = Math.hypot(...p.position.map((v, k) => v - prev.position[k]));
    const atCut = cuts.some((c) => c > t - 0.0101 && c <= t + 1e-9);
    assert.ok(atCut || d < 0.25, `saut de ${d.toFixed(3)} m à t=${t.toFixed(2)}`);
    assert.ok(p.focus > 0 && Number.isFinite(p.focus));
    prev = p;
  }
});

test('les coupes franches tombent sur des temps forts', () => {
  const plan = planShots(ensemble);
  const kick = ensemble.instruments.find((i) => i.kind === 'drums').model.pieces.flatMap((p) => p.hits.map((h) => h.time));
  for (const s of plan.shots.filter((x) => x.cut)) assert.ok(kick.some((k) => Math.abs(k - s.start) < 1e-9) || balls.some((n) => Math.abs(n.time - s.start) < 1e-9));
});

test('une poursuite garde la bille dans le champ', () => {
  // Phrase rapide : rebonds en chaîne, donc des billes à suivre.
  const many = Array.from({ length: 200 }, (_, i) => ({ midi: 60 + ((i * 5) % 12), time: i * 0.35, duration: 0.2, velocity: 0.8, track: 0 }));
  const ens = buildEnsemble({ balls: many });
  const plan = planShots(ens, { followChance: 1 });
  const follows = plan.shots.filter((s) => s.type === 'follow');
  assert.ok(follows.length > 0);
  for (const s of follows) {
    for (let t = s.start + options(plan).blend; t < s.end; t += 0.05) {
      const cam = cameraAt(plan, t);
      const b = plan.balls.balls[s.ball];
      if (t > b.lastImpact) break;
      const p = ballPosition(plan.balls, b, t);
      // Angle entre l'axe de visée et la direction de la bille : moins de ~25°.
      const v = cam.target.map((x, k) => x - cam.position[k]);
      const w = p.map((x, k) => x - cam.position[k]);
      const cos = v.reduce((a, x, k) => a + x * w[k], 0) / (Math.hypot(...v) * Math.hypot(...w));
      assert.ok(cos > Math.cos((25 * Math.PI) / 180), `bille hors champ à t=${t.toFixed(2)}`);
    }
  }
});
const options = (plan) => plan.options;

test('plan déterministe', () => {
  assert.deepEqual(planShots(ensemble), planShots(ensemble));
});
