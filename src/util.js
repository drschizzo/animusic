// Petits utilitaires partagés par les modules de chorégraphie.

/** Premier index i tel que key(arr[i]) > value (arr trié selon key). */
export function upperBound(arr, value, key = (x) => x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Premier index i tel que key(arr[i]) >= value (arr trié selon key). */
export function lowerBound(arr, value, key = (x) => x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, s) => a + (b - a) * s;
export const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Nombre d'attaques (onsets triés) dans [t0, t1). */
export function countOnsets(onsets, t0, t1) {
  return lowerBound(onsets, t1) - lowerBound(onsets, t0);
}

/**
 * Levée d'un marteau (ou d'une baguette) qui doit toucher sa cible pile aux
 * instants `hits[i].time` : 0 au contact, ~rest au repos, jusqu'à 1 en levée
 * d'anticipation (plus haut si le coup est fort et espacé du précédent).
 */
export function strikeLift(hits, t, { rest = 0.3, window = 0.3, rebound = 14 } = {}) {
  const i = upperBound(hits, t, (h) => h.time) - 1;
  const prev = hits[i];
  const next = hits[i + 1];
  const after = prev ? rest * (1 - Math.exp(-(t - prev.time) * rebound)) : rest;
  if (!next) return after;
  const gap = prev ? next.time - prev.time : Infinity;
  const w = Math.min(window, gap * 0.5);
  if (w <= 0) return 0;
  const d = next.time - t;
  const peak = (0.55 + 0.45 * next.velocity) * clamp(gap / 0.4, 0.3, 1);
  const windup = d <= w ? peak * Math.sin(((Math.PI / 2) * d) / w) : peak;
  const b = smoothstep((2 * w - d) / w);
  return after * (1 - b) + windup * b;
}

/** Éclat après la dernière frappe : { pulse, since, track }. */
export function lastHitPulse(hits, t, decay) {
  const i = upperBound(hits, t, (h) => h.time) - 1;
  if (i < 0) return { pulse: 0, since: Infinity, track: -1 };
  const h = hits[i];
  const since = t - h.time;
  return { pulse: h.velocity * Math.exp(-since * decay), since, track: h.track };
}
