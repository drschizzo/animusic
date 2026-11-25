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
