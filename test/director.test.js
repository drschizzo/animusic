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
  // Plans qui couvrent le solo (le plan d'entrée de la batterie commence avant).
  assert.ok(shots.filter((s) => s.end > 20.5 && s.start < 31).some((s) => s.subject === drumsIndex));
  const solo = shots.filter((s) => s.start >= 20 && s.end <= 31);
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

// Orchestre : une mélodie aiguë (vents), des accords tenus (orgue), une basse, une
// batterie, et un clavier qui répond à la mélodie entre ses phrases.
const orchestra = (() => {
  const melody = [];
  const answer = [];
  for (let bar = 0; bar < 12; bar++) {
    const t0 = bar * 4;
    const phrase = bar % 2 === 0 ? melody : answer;
    const base = bar % 2 === 0 ? 76 : 69;
    for (let i = 0; i < 6; i++) phrase.push({ midi: base + [0, 2, 4, 7, 4, 2][i], time: t0 + i * 0.5, duration: 0.45, velocity: 0.85, track: bar % 2 === 0 ? 0 : 4 });
  }
  const pads = Array.from({ length: 12 }, (_, b) => [48, 55, 64].map((m) => ({ midi: m, time: b * 4, duration: 3.9, velocity: 0.5, track: 1 }))).flat();
  const bass = Array.from({ length: 96 }, (_, i) => ({ midi: 36 + (i % 4 === 3 ? 7 : 0), time: i * 0.5, duration: 0.4, velocity: 0.7, track: 2 }));
  const drums = Array.from({ length: 192 }, (_, i) => ({ midi: [36, 42, 38, 42][i % 4], time: i * 0.25, duration: 0.1, velocity: 0.7, track: 3 }));
  return buildEnsemble({ winds: melody, pads, bass, drums, plucked: answer });
})();

test('le réalisateur suit la mélodie plutôt que la densité', () => {
  const plan = planShots(orchestra);
  const time = new Map();
  for (const s of plan.shots) {
    const kinds = [s.subject, s.partner].filter((k) => k >= 0).map((k) => orchestra.instruments[k].kind);
    for (const kind of kinds) time.set(kind, (time.get(kind) ?? 0) + (s.end - s.start) / kinds.length);
  }
  const melodic = (time.get('winds') ?? 0) + (time.get('plucked') ?? 0);
  // La batterie joue 4 fois plus de notes que les vents, mais on écoute la mélodie.
  assert.ok(melodic > (time.get('drums') ?? 0) * 2, JSON.stringify([...time]));
  assert.ok(melodic > (time.get('pads') ?? 0) * 2 && melodic > (time.get('bass') ?? 0) * 2, JSON.stringify([...time]));
});

test('deux instruments qui se répondent sont cadrés ensemble', () => {
  const plan = planShots(orchestra, { duoChance: 1 });
  const duos = plan.shots.filter((s) => s.type === 'duo');
  assert.ok(duos.length > 0);
  const kinds = (s) => [s.subject, s.partner].map((k) => orchestra.instruments[k].kind).sort().join('+');
  assert.ok(duos.every((s) => kinds(s) === 'plucked+winds'), duos.map(kinds).join(', '));
});

test('la caméra ne traverse jamais un instrument', () => {
  for (const ens of [orchestra, ensemble]) {
    const plan = planShots(ens);
    for (let t = ens.start; t < ens.end; t += 0.05) {
      const { position: [x, y, z] } = cameraAt(plan, t);
      for (const ins of ens.instruments) {
        const f = ins.footprint;
        if (!f) continue;
        const dx = x - f.center[0];
        const dz = z - f.center[1];
        const lx = Math.cos(f.yaw) * dx - Math.sin(f.yaw) * dz;
        const lz = Math.sin(f.yaw) * dx + Math.cos(f.yaw) * dz;
        const inside = Math.abs(lx) < f.halfW && Math.abs(lz) < f.halfD && y < f.top + 0.3;
        assert.ok(!inside, `caméra dans ${ins.kind} à t=${t.toFixed(2)} (${[x, y, z].map((v) => v.toFixed(2))})`);
      }
      // Ni dans la tourelle, ni sous l'arc de lames.
      const r = Math.hypot(x, z);
      assert.ok(r > 2.4 || y > 1.9, `caméra dans la tourelle à t=${t.toFixed(2)}`);
    }
  }
});

test('la caméra ne traverse pas la scène en volant : glissement vers un cadrage voisin, coupe sinon', () => {
  for (const ens of [orchestra, ensemble]) {
    const plan = planShots(ens);
    const dt = 1 / 30;
    let prev = null;
    for (let t = ens.start; t < ens.end; t += dt) {
      const cam = cameraAt(plan, t);
      const d = cam.target.map((v, k) => v - cam.position[k]);
      const l = Math.hypot(...d);
      const aim = d.map((v) => v / l);
      const cut = plan.shots.some((s) => s.cut && s.start > t - dt - 1e-9 && s.start <= t + 1e-9);
      if (prev && !cut) {
        const speed = Math.hypot(...cam.position.map((v, k) => v - prev.position[k])) / dt;
        const turn = Math.acos(Math.min(1, aim[0] * prev.aim[0] + aim[1] * prev.aim[1] + aim[2] * prev.aim[2])) / dt;
        assert.ok(speed < 9, `caméra à ${speed.toFixed(1)} m/s à t=${t.toFixed(2)}`);
        assert.ok(turn < 1.6, `panoramique à ${((turn * 180) / Math.PI).toFixed(0)} °/s à t=${t.toFixed(2)}`);
      }
      prev = { position: cam.position, aim };
    }
    // Un plan qui ne coupe pas glisse vers un cadrage proche, en un temps borné.
    for (const s of plan.shots.filter((x) => !x.cut && x.blend)) assert.ok(s.blend <= options(plan).blendMax && s.blend <= (s.end - s.start) * 0.45 + 1e-9);
  }
});

test('style « billes » : l\'écran se partage entre tous les instruments qui jouent', () => {
  // Mélodie, basse et batterie jouent d'un bout à l'autre, deux minutes durant.
  const n = 240;
  const tune = Array.from({ length: n }, (_, i) => ({ midi: 72 + [0, 2, 4, 7, 9, 7, 4, 2][i % 8], time: i * 0.5, duration: 0.4, velocity: 0.85, track: 0 }));
  const low = Array.from({ length: n }, (_, i) => ({ midi: 36 + (i % 4 === 3 ? 7 : 0), time: i * 0.5, duration: 0.4, velocity: 0.7, track: 1 }));
  const kit = Array.from({ length: n * 2 }, (_, i) => ({ midi: [36, 42, 38, 42][i % 4], time: i * 0.25, duration: 0.1, velocity: 0.7, track: 2 }));
  const chords = Array.from({ length: 30 }, (_, b) => [48, 55, 64].map((m) => ({ midi: m, time: b * 4, duration: 3.9, velocity: 0.5, track: 3 }))).flat();
  const ens = buildEnsemble({ balls: tune, bass: low, drums: kit, pads: chords }, [], [], { style: 'balls' });
  const plan = planShots(ens);
  const time = ens.instruments.map(() => 0);
  let framed = 0;
  let run = 0;
  let last = -9;
  for (const s of plan.shots) {
    if (s.subject < 0) continue;
    time[s.subject] += s.end - s.start;
    framed += s.end - s.start;
    run = s.subject === last ? run + 1 : 1;
    last = s.subject;
    assert.ok(run <= options(plan).maxRepeat, 'trop de plans d\'affilée sur le même instrument');
  }
  ens.instruments.forEach((ins, k) => {
    const share = time[k] / framed;
    assert.ok(share >= 0.1, `${ins.kind} : ${(share * 100).toFixed(0)} % de l'écran`);
    assert.ok(share <= 0.5, `${ins.kind} : ${(share * 100).toFixed(0)} % de l'écran`);
  });
});
