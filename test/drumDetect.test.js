import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, detectDrums } from '../src/drumDetect.js';

const SR = 22050;

test('FFT : un sinus pur donne un pic au bon bin', () => {
  const n = 256;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 10 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
  assert.equal(mags.indexOf(Math.max(...mags)), 10);
});

/** Signal synthétique : accord tenu + grosse caisse, caisse claire et charleston à des instants connus. */
function synthetic(duration, events) {
  const s = new Float32Array(Math.round(duration * SR));
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    // Nappe harmonique continue (ne doit pas déclencher de coups).
    s[i] = 0.15 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t));
  }
  // Passe-haut d'ordre 4 (~6 kHz) pour un charleston réaliste : très peu d'énergie dans le médium.
  const highpass = (x) => {
    const rc = 1 / (2 * Math.PI * 6000);
    const a = rc / (rc + 1 / SR);
    let y = x;
    for (let pass = 0; pass < 4; pass++) {
      const out = new Float32Array(y.length);
      for (let i = 1; i < y.length; i++) out[i] = a * (out[i - 1] + y[i] - y[i - 1]);
      y = out;
    }
    return y;
  };
  const hatNoise = highpass(Float32Array.from({ length: SR }, () => noise()));
  // Timbre de caisse claire : bruit passe-bas (~4 kHz), peu d'énergie dans l'aigu, comme un vrai fût.
  const lowpass = (x) => {
    const a = 1 / (1 + SR / (2 * Math.PI * 4000));
    let y = x;
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(y.length);
      for (let i = 1; i < y.length; i++) out[i] = out[i - 1] + a * (y[i] - out[i - 1]);
      y = out;
    }
    return y;
  };
  const snareNoise = lowpass(Float32Array.from({ length: SR }, () => noise()));
  for (const { kind, time } of events) {
    const start = Math.round(time * SR);
    for (let i = 0; i < SR * 0.25 && start + i < s.length; i++) {
      const t = i / SR;
      let v = 0;
      if (kind === 'kick') v = Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12);
      if (kind === 'snare') v = snareNoise[i] * Math.exp(-t * 25) * 1.5 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.3;
      if (kind === 'hihat') {
        v = hatNoise[i] * Math.exp(-t * 40) * 3;
      }
      s[start + i] += v;
    }
  }
  return s;
}

function score(found, truth, tol = 0.04) {
  let hit = 0;
  const used = new Set();
  for (const t of truth) {
    const k = found.findIndex((f, i) => !used.has(i) && Math.abs(f.time - t) <= tol);
    if (k >= 0) {
      used.add(k);
      hit++;
    }
  }
  return { recall: hit / truth.length, precision: found.length ? hit / found.length : 1 };
}

test('détection : grosse caisse, caisse claire et charleston retrouvées, nappe ignorée', () => {
  const events = [];
  for (let b = 0; b < 16; b++) {
    const t = 0.5 + b * 0.5;
    events.push({ kind: b % 2 ? 'snare' : 'kick', time: t });
    events.push({ kind: 'hihat', time: t + 0.25 });
  }
  const hits = detectDrums(synthetic(9, events), SR);
  // Seuils de garde-fou : la référence de qualité est tools/audio-bench.cjs sur de vrais
  // rendus. Ici la caisse claire en bruit synthétique déborde dans la bande de la charleston.
  const minPrecision = { kick: 0.85, snare: 0.85, hihat: 0.6 };
  for (const [kind, note] of [['kick', 36], ['snare', 38], ['hihat', 42]]) {
    const truth = events.filter((e) => e.kind === kind).map((e) => e.time);
    const s = score(hits.filter((h) => h.midi === note), truth);
    assert.ok(s.recall >= 0.85, `${kind} : rappel ${s.recall.toFixed(2)}`);
    assert.ok(s.precision >= minPrecision[kind], `${kind} : précision ${s.precision.toFixed(2)}`);
  }
});

test('détection : un enregistrement sans batterie ne produit presque rien', () => {
  const hits = detectDrums(synthetic(6, []), SR);
  assert.ok(hits.length <= 2, `${hits.length} coups fantômes`);
});
