import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBassStrings, carrierPose, stringVibration } from '../src/strings.js';
import { buildPipes, pipeState } from '../src/pipes.js';
import { classifyTrack, assignRoles, buildEnsemble } from '../src/arranger.js';
import { buildBells, hammerAngle, bellState } from '../src/bells.js';
import { buildLaserHarp, laserState, crystalState } from '../src/laser.js';
import { buildKeyboard, keyDepth, keyHammerAngle, tineVibration } from '../src/keys.js';

const bassNotes = [];
[40, 43, 45, 40, 47, 43, 40, 40].forEach((midi, i) =>
  bassNotes.push({ midi, time: 1 + i * 0.25, duration: 0.2, velocity: 0.8, track: 1 }),
);

test('basse : une corde par hauteur', () => {
  const m = buildBassStrings(bassNotes);
  assert.deepEqual(m.strings.map((s) => s.midi), [40, 43, 45, 47]);
});

test('basse : le médiator traverse la bonne corde pile à l\'instant de la note', () => {
  const m = buildBassStrings(bassNotes);
  for (const c of m.carriers) {
    for (const shot of c.shots) {
      const p = carrierPose(m, c, shot.time);
      assert.ok(Math.abs(p.x - shot.x) < 1e-9, 'chariot devant la corde');
      assert.ok(Math.abs(p.z) < 1e-9, 'médiator dans le plan des cordes');
      // Juste avant : du côté « dir », juste après : de l'autre côté.
      assert.ok(carrierPose(m, c, shot.time - 0.01).z * shot.dir > 0);
      assert.ok(carrierPose(m, c, shot.time + 0.01).z * shot.dir < 0);
    }
  }
});

test('basse : le médiator ne croise jamais le plan des cordes en se déplaçant', () => {
  const m = buildBassStrings(bassNotes);
  for (const c of m.carriers) {
    let prev = carrierPose(m, c, 0);
    for (let t = 0; t < 4; t += 0.002) {
      const p = carrierPose(m, c, t);
      // Si x bouge, z doit être à distance de repos.
      if (Math.abs(p.x - prev.x) > 1e-6) assert.ok(Math.abs(p.z) > m.options.pickOffset * 0.99, `t=${t}`);
      assert.ok(Math.abs(p.z - prev.z) < 0.02, `saut de z à t=${t}`);
      prev = p;
    }
  }
});

test('basse : la corde vibre puis s\'amortit', () => {
  const m = buildBassStrings(bassNotes);
  const s = m.strings[3]; // 47, jouée une seule fois à t=2
  assert.equal(stringVibration(m, s, 1.9).amp, 0);
  assert.ok(stringVibration(m, s, 2.0).amp > 0.79);
  assert.ok(stringVibration(m, s, 3).amp < 0.01);
});

test('orgue : la lumière suit la durée de la note, la valve anticipe', () => {
  const m = buildPipes([{ midi: 60, time: 2, duration: 1.5, velocity: 1, track: 2 }]);
  const p = m.pipes[0];
  assert.equal(pipeState(m, p, 1.7).valve, 0);
  assert.ok(pipeState(m, p, 1.95).valve > 0);
  assert.equal(pipeState(m, p, 1.95).level, 0);
  assert.ok(pipeState(m, p, 2.5).level > 0.99);
  assert.ok(pipeState(m, p, 3.4).level > 0.99);
  assert.ok(pipeState(m, p, 3.7).level < 0.5);
  assert.equal(pipeState(m, p, 5).level, 0);
});

test('classification des pistes', () => {
  assert.equal(classifyTrack({ percussion: true, notes: [] }), 'drums');
  assert.equal(classifyTrack({ program: 33, notes: [] }), 'bass');
  const long = [60, 64].map((midi) => ({ midi, time: 0, duration: 1.5, velocity: 0.7 }));
  const short = [60, 64, 67, 72].map((midi, i) => ({ midi, time: i * 0.2, duration: 0.15, velocity: 0.7 }));
  assert.equal(classifyTrack({ program: 48, notes: long }), 'pads');
  // « Ensemble de cordes » mais notes courtes : c'est une ligne mélodique.
  assert.equal(classifyTrack({ program: 48, notes: short }), 'balls');
  assert.equal(classifyTrack({ program: 0, notes: bassNotes }), 'bass');
  const chords = [60, 64, 67].map((midi) => ({ midi, time: 0, duration: 2, velocity: 0.7 }));
  assert.equal(classifyTrack({ program: 0, notes: chords }), 'pads');
  const melody = [72, 74, 76, 77].map((midi, i) => ({ midi, time: i * 0.3, duration: 0.25, velocity: 0.7 }));
  assert.equal(classifyTrack({ program: 0, notes: melody }), 'keys');
  assert.equal(classifyTrack({ program: 24, notes: melody }), 'balls');
  assert.equal(classifyTrack({ program: 14, notes: melody }), 'bells');
  // Flûte soliste aux notes tenues : harpe laser ; en accords plaqués : orgue.
  const solo = [72, 74, 76, 77].map((midi, i) => ({ midi, time: i * 0.5, duration: 0.45, velocity: 0.7 }));
  assert.equal(classifyTrack({ program: 73, notes: solo }), 'laser');
  assert.equal(classifyTrack({ program: 61, notes: chords }), 'pads');
});

test('passe globale : sans billes, la piste de clavier la plus fournie les reçoit', () => {
  const line = (base, n) => Array.from({ length: n }, (_, i) => ({ midi: base + (i % 5), time: i * 0.25, duration: 0.2, velocity: 0.7 }));
  const tracks = [
    { program: 0, notes: line(60, 8) },
    { program: 0, notes: line(72, 20) },
    { program: 14, notes: line(84, 4) },
  ];
  assert.deepEqual(assignRoles(tracks), ['keys', 'balls', 'bells']);
  // Une guitare tient déjà les billes : le piano reste au clavier.
  assert.deepEqual(assignRoles([{ program: 24, notes: line(60, 8) }, { program: 0, notes: line(72, 20) }]), ['balls', 'keys']);
});

test('passe globale : la voix nettement plus grave devient la basse', () => {
  const voice = (base) => [0, 2, 4, 5].map((d, i) => ({ midi: base + d, time: i * 0.5, duration: 0.45, velocity: 0.7 }));
  const chorale = [72, 65, 58, 51].map((base) => ({ program: 0, notes: voice(base) }));
  assert.deepEqual(assignRoles(chorale), ['balls', 'keys', 'keys', 'bass']);
  // Voix serrées : pas de basse forcée.
  const close = [64, 62, 60].map((base) => ({ program: 0, notes: voice(base) }));
  assert.ok(!assignRoles(close).includes('bass'));
});

test('ensemble : instruments présents, début et fin globaux', () => {
  const e = buildEnsemble({
    balls: [{ midi: 72, time: 1, duration: 0.2, velocity: 1, track: 0 }],
    bass: bassNotes,
    pads: [{ midi: 60, time: 0.5, duration: 4, velocity: 1, track: 2 }],
    drums: [{ midi: 36, time: 1, duration: 0.1, velocity: 1, track: 3 }],
    bells: [{ midi: 79, time: 2, duration: 0.5, velocity: 1, track: 4 }],
    laser: [{ midi: 67, time: 2, duration: 1, velocity: 1, track: 5 }],
    keys: [{ midi: 60, time: 3, duration: 0.5, velocity: 1, track: 6 }],
  });
  assert.deepEqual(e.instruments.map((i) => i.kind), ['balls', 'drums', 'bass', 'pads', 'bells', 'laser', 'keys']);
  // Aucun instrument ne chevauche un autre au sol.
  for (const a of e.instruments) {
    for (const b of e.instruments) {
      if (a === b || a.kind === 'balls' || b.kind === 'balls') continue;
      const d = Math.hypot(a.focus.center[0] - b.focus.center[0], a.focus.center[2] - b.focus.center[2]);
      assert.ok(d > 2.5, `${a.kind} / ${b.kind} trop proches (${d.toFixed(2)})`);
    }
  }
  assert.ok(e.start < 0); // la première bille part avant t=0
  assert.ok(e.end >= 4.5);
  for (const i of e.instruments) assert.ok(i.onsets.every((t, k) => k === 0 || t >= i.onsets[k - 1]));
});

const bellNotes = [72, 76, 79, 72, 72].map((midi, i) => ({ midi, time: 1 + i * 0.5, duration: 0.4, velocity: 0.9, track: 0 }));

test('carillon : le marteau touche la cloche pile à la note, puis elle se balance', () => {
  const m = buildBells(bellNotes);
  assert.deepEqual(m.bells.map((b) => b.midi), [72, 76, 79]);
  assert.ok(m.bells[0].length > m.bells[2].length, 'grave = tube long');
  for (const b of m.bells) {
    for (const h of b.hits) {
      assert.ok(Math.abs(hammerAngle(m, b, h.time)) < 1e-9);
      assert.ok(hammerAngle(m, b, h.time - 0.1) > 0.2, 'levée avant le coup');
    }
    // Jamais à travers la cloche, mouvement continu.
    let prev = hammerAngle(m, b, 0);
    for (let t = 0; t < 6; t += 0.002) {
      const a = hammerAngle(m, b, t);
      assert.ok(a >= -1e-9);
      assert.ok(Math.abs(a - prev) < 0.06, `saut du marteau à t=${t}`);
      prev = a;
    }
  }
  const b = m.bells[0]; // frappée à 1, 2,5 et 3
  assert.equal(bellState(m, b, 0.9).angle, 0);
  assert.equal(bellState(m, b, 0.9).pulse, 0);
  assert.ok(Math.abs(bellState(m, b, 1.3).angle) > 0.02);
  assert.ok(bellState(m, b, 1.0).pulse > 0.89);
  let prev = bellState(m, b, 0).angle;
  for (let t = 0; t < 12; t += 0.002) {
    const a = bellState(m, b, t).angle;
    assert.ok(Math.abs(a - prev) < 0.01, `saut du balancement à t=${t}`);
    prev = a;
  }
  assert.ok(Math.abs(bellState(m, b, 12).angle) < 1e-3);
});

test('harpe laser : le rayon dure autant que la note, le cristal reçoit l\'énergie', () => {
  const m = buildLaserHarp([
    { midi: 60, time: 1, duration: 1, velocity: 1, track: 3 },
    { midi: 67, time: 1.5, duration: 1, velocity: 1, track: 4 },
  ]);
  const [a, b] = m.emitters;
  assert.equal(laserState(m, a, 0.5).level, 0);
  assert.ok(laserState(m, a, 0.9).valve > 0, 'iris ouvert avant la note');
  assert.ok(laserState(m, a, 1.5).level > 0.99);
  assert.equal(laserState(m, b, 1.2).level, 0);
  assert.equal(laserState(m, a, 2.5).level, 0);
  assert.equal(crystalState(m, 0.5).energy, 0);
  assert.equal(crystalState(m, 1.2).track, 3);
  assert.equal(crystalState(m, 2.3).track, 4);
  assert.equal(crystalState(m, 1.7).energy, 1);
});

test('clavier : touches noires et blanches, enfoncement tenu, marteau à l\'heure', () => {
  const notes = [
    { midi: 61, time: 1, duration: 0.5, velocity: 0.8, track: 0 },
    { midi: 64, time: 1, duration: 0.1, velocity: 0.8, track: 0 },
    { midi: 64, time: 1.12, duration: 0.1, velocity: 0.8, track: 0 },
    { midi: 64, time: 1.24, duration: 1, velocity: 0.8, track: 0 },
  ];
  const m = buildKeyboard(notes);
  assert.ok(!m.keys[0].black && !m.keys[m.keys.length - 1].black, 'bornes blanches');
  assert.ok(m.keys.length >= 13);
  const cs = m.keys.find((k) => k.midi === 61);
  const e = m.keys.find((k) => k.midi === 64);
  assert.ok(cs.black && !e.black);
  const c = m.keys.find((k) => k.midi === 60);
  const d = m.keys.find((k) => k.midi === 62);
  assert.ok(Math.abs(cs.x - (c.x + d.x) / 2) < 1e-9, 'do# entre do et ré');
  assert.equal(keyDepth(m, cs, 0.5), 0);
  assert.equal(keyDepth(m, cs, 1), 1);
  assert.equal(keyDepth(m, cs, 1.4), 1);
  assert.equal(keyDepth(m, cs, 1.7), 0);
  assert.equal(keyDepth(m, c, 1.2), 0, 'touche non jouée immobile');
  // Notes répétées : enfoncée à chaque attaque, mouvement continu.
  for (const t of [1, 1.12, 1.24]) assert.equal(keyDepth(m, e, t), 1);
  let prev = keyDepth(m, e, 0);
  let dips = 0;
  for (let t = 0; t < 3; t += 0.001) {
    const v = keyDepth(m, e, t);
    assert.ok(Math.abs(v - prev) < 0.06, `saut de touche à t=${t}`);
    if (prev === 1 && v < 1) dips++;
    prev = v;
  }
  assert.equal(dips, 3, 'la touche remonte entre les notes répétées');
  for (const h of e.hits) assert.ok(Math.abs(keyHammerAngle(m, e, h.time)) < 1e-9);
  assert.equal(tineVibration(m, e, 0.9).amp, 0);
  assert.ok(tineVibration(m, e, 1.24).amp > 0.79);
  assert.ok(tineVibration(m, e, 4).amp < 0.01);
});
