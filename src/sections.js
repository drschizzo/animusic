// Structure du morceau : module pur. Découpe le morceau en sections (intro, couplet,
// refrain…) à partir de l'activité de chaque instrument, et calcule quand chaque
// instrument doit être déployé sur scène (il sort du sol avant d'entrer et y
// redescend pendant ses longs silences).

import { upperBound, smoothstep, clamp, easeBack } from './util.js';

export const SECTION_DEFAULTS = {
  step: 0.5, // pas d'analyse (s)
  window: 6, // demi-fenêtre de comparaison avant / après (s)
  minSection: 7, // durée minimale d'une section
  threshold: 0.18, // nouveauté minimale pour couper
  rise: 2.4, // durée de la sortie du sol
  fall: 2.0, // durée de la descente
  restGap: 40, // silence au-delà duquel l'instrument redescend (rare : un va-et-vient lasse vite)
  introGrace: 12, // les instruments qui entrent avant ce délai sont déjà en place au début…
  introShare: 0.12, // … ou avant cette fraction du morceau, si elle est plus longue
};

/**
 * Délai en deçà duquel un instrument est en place dès le début : une scène presque vide
 * pendant une intro (batterie seule, par exemple) paraît cassée ; seules les entrées
 * franchement tardives se font en sortant du sol.
 */
export function introGrace(ensemble, options = {}) {
  const o = { ...SECTION_DEFAULTS, ...options };
  return Math.max(o.introGrace, o.introShare * (ensemble.end - ensemble.start));
}

/** Fusionne des intervalles [start, end] séparés de moins de `gap`. */
export function mergeSpans(spans, gap = 0) {
  const sorted = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * @param ensemble résultat de buildEnsemble (chaque instrument a `onsets` et `busy`)
 * @returns { sections: [{start, end, energy, index}], deploy: [[start, end]…] par instrument, options }
 */
export function analyzeSong(ensemble, options = {}) {
  const o = { ...SECTION_DEFAULTS, ...options };
  const inst = ensemble.instruments;
  const t0 = Math.min(0, ensemble.start);
  const t1 = Math.max(ensemble.end, t0 + 1);
  const n = Math.max(1, Math.ceil((t1 - t0) / o.step));

  // Activité de chaque instrument par case : attaques + présence (notes tenues).
  const grid = inst.map((ins) => {
    const a = new Float32Array(n);
    for (const t of ins.onsets) {
      const i = Math.floor((t - t0) / o.step);
      if (i >= 0 && i < n) a[i] += 1;
    }
    for (const [s, e] of ins.busy ?? []) {
      for (let i = Math.max(0, Math.floor((s - t0) / o.step)); i < Math.min(n, Math.ceil((e - t0) / o.step)); i++) a[i] += 0.5;
    }
    return a;
  });
  const total = new Float32Array(n);
  grid.forEach((a) => a.forEach((v, i) => (total[i] += v)));

  // Nouveauté : différence entre l'activité moyenne avant et après chaque instant.
  const w = Math.max(1, Math.round(o.window / o.step));
  const mean = (a, i0, i1) => {
    let s = 0;
    for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) s += a[i];
    return s / Math.max(1, Math.min(n, i1) - Math.max(0, i0));
  };
  const novelty = new Float32Array(n);
  for (let i = w; i < n - w; i++) {
    let diff = 0;
    let norm = 0;
    for (const a of grid) {
      const before = mean(a, i - w, i);
      const after = mean(a, i, i + w);
      diff += Math.abs(after - before);
      norm += before + after;
    }
    novelty[i] = norm > 0 ? (2 * diff) / norm : 0;
  }

  // Coupes : maxima locaux de nouveauté, espacés d'au moins minSection.
  const minGap = Math.round(o.minSection / o.step);
  const candidates = [];
  for (let i = 1; i < n - 1; i++) {
    if (novelty[i] >= o.threshold && novelty[i] >= novelty[i - 1] && novelty[i] > novelty[i + 1]) candidates.push(i);
  }
  candidates.sort((a, b) => novelty[b] - novelty[a]);
  const cuts = [];
  for (const i of candidates) if (cuts.every((c) => Math.abs(c - i) >= minGap) && i >= minGap && n - i >= minGap) cuts.push(i);
  cuts.sort((a, b) => a - b);

  const bounds = [0, ...cuts, n];
  const peak = Math.max(1e-6, ...Array.from({ length: n }, (_, i) => mean(total, i - 4, i + 4)));
  const sections = bounds.slice(0, -1).map((b, k) => ({
    index: k,
    start: t0 + b * o.step,
    end: t0 + bounds[k + 1] * o.step,
    energy: clamp(mean(total, b, bounds[k + 1]) / peak, 0, 1),
  }));

  // Déploiement : un instrument est sur scène pendant ses périodes d'activité (les
  // silences courts ne comptent pas), et reste en place après sa dernière note.
  const songStart = ensemble.start;
  const grace = introGrace(ensemble, o);
  const deploy = inst.map((ins) => {
    const spans = mergeSpans(ins.busy ?? [[ins.start, ins.end]], o.restGap);
    if (!spans.length) return [];
    if (spans[0][0] <= songStart + grace) spans[0][0] = -Infinity;
    spans[spans.length - 1][1] = Infinity;
    return spans;
  });
  return { sections, deploy, options: o };
}

/**
 * Déploiement d'un instrument à l'instant t : 0 sous le sol, 1 en place (montée lente
 * au départ, léger dépassement à l'arrivée, comme un vérin qui se cale). Toujours 1 pendant ses notes.
 */
export function deployAt(song, k, t) {
  const spans = song.deploy[k];
  if (!spans?.length) return 1;
  const o = song.options;
  const i = upperBound(spans, t + o.rise, (s) => s[0]) - 1;
  if (i < 0) return 0;
  const [s, e] = spans[i];
  if (t < s) return Math.max(0, easeBack(clamp((t - (s - o.rise)) / o.rise, 0, 1), 0.6));
  if (t <= e) return 1;
  return 1 - smoothstep((t - e) / o.fall);
}

/** Section en cours à l'instant t, avec le fondu vers la suivante : { index, next, blend, energy }. */
export function sectionAt(song, t, fade = 1.5) {
  const secs = song.sections;
  if (!secs.length) return { index: 0, next: 0, blend: 0, energy: 0.5 };
  let i = upperBound(secs, t, (s) => s.start) - 1;
  i = clamp(i, 0, secs.length - 1);
  const cur = secs[i];
  const prev = secs[i - 1];
  // Fondu depuis la section précédente, à partir de la coupe.
  const blend = prev ? smoothstep((t - cur.start) / fade) : 1;
  const from = prev && blend < 1 ? prev : cur;
  return {
    index: cur.index,
    from: from.index,
    blend,
    energy: from.energy + (cur.energy - from.energy) * blend,
    since: t - cur.start,
  };
}
