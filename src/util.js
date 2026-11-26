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

/**
 * Oscillateur amorti excité par une suite d'impulsions (triées par `time`) : somme
 * des réponses x(s) = a·e^(−ζωs)·sin(ω_d·s). Nulle à l'instant de chaque impulsion,
 * donc sans à-coup ; sert à tous les « mouvements secondaires » (tremblement d'un
 * canon après le tir, baguette qui fouette, chariot qui se balance en s'arrêtant).
 * `amp(e)` donne l'amplitude signée de chaque impulsion.
 */
export function springSum(events, t, { omega = 14, zeta = 0.2, amp = (e) => e.velocity ?? 1 } = {}) {
  const decay = zeta * omega;
  const wd = omega * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
  const horizon = t - 6 / decay;
  let x = 0;
  for (let i = upperBound(events, t, (e) => e.time) - 1; i >= 0; i--) {
    const e = events[i];
    if (e.time < horizon) break;
    const s = t - e.time;
    x += amp(e) * Math.exp(-decay * s) * Math.sin(wd * s);
  }
  return x;
}

/**
 * Interpolation 0 → 1 avec anticipation et dépassement (léger recul avant de partir,
 * puis on dépasse la cible et on revient) : vaut exactement 0 et 1 aux extrémités.
 */
export function easeBack(x, s = 0.9) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c = s * 1.525;
  const y = 2 * x;
  return y < 1 ? (y * y * ((c + 1) * y - c)) / 2 : ((y - 2) * (y - 2) * ((c + 1) * (y - 2) + c) + 2) / 2;
}

/** Cumul lissé de pas réguliers : chaque événement fait avancer la valeur de `step` en `dur` secondes. */
export function steppedTotal(events, t, step, dur) {
  const done = upperBound(events, t - dur, (e) => e.time);
  let v = done * step;
  for (let i = done; i < events.length && events[i].time <= t; i++) v += step * smoothstep((t - events[i].time) / dur);
  return v;
}

/** Valeur d'un contrôleur continu (événements {time, value} triés) à l'instant t. */
export function controlAt(events, t, fallback = 0) {
  if (!events?.length) return fallback;
  const i = upperBound(events, t, (e) => e.time) - 1;
  return i < 0 ? fallback : events[i].value;
}

/** Position d'une pédale (événements {time, on} triés) : 0 relevée, 1 enfoncée, transitions de `travel` s. */
export function pedalAt(events, t, travel = 0.08) {
  if (!events?.length) return 0;
  const i = upperBound(events, t, (e) => e.time) - 1;
  if (i < 0) return 0;
  const from = i > 0 && events[i - 1].on ? 1 : 0;
  const to = events[i].on ? 1 : 0;
  return lerp(from, to, smoothstep((t - events[i].time) / travel));
}

/** Fusionne les événements de plusieurs pistes (tri par temps). */
export function mergeEvents(lists) {
  return lists.filter(Boolean).flat().sort((a, b) => a.time - b.time);
}

/**
 * Fin réellement entendue d'une note : si la pédale de sustain est enfoncée quand la
 * touche est relâchée, le son tient jusqu'à ce qu'elle remonte.
 */
export function sustainedEnd(note, sustain = []) {
  const end = note.time + note.duration;
  let down = false;
  let i = 0;
  for (; i < sustain.length && sustain[i].time <= end; i++) down = sustain[i].on;
  if (!down) return end;
  for (; i < sustain.length; i++) if (!sustain[i].on) return Math.max(end, sustain[i].time);
  return end + 4;
}
