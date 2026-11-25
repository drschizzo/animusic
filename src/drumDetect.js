// Détection de la batterie dans un enregistrement (module pur, sans DOM).
//
// 1. Spectrogramme (FFT 1024, saut 256).
// 2. Séparation harmonique / percussive (HPSS, Fitzgerald 2010) : un son percussif est
//    lisse le long des fréquences, un son harmonique est lisse dans le temps. Deux filtres
//    médians donnent un masque qui ne garde que la partie percussive.
// 3. Par bande (grave → grosse caisse, médium → caisse claire, aigu → charleston) :
//    flux d'énergie (montées brusques), seuil adaptatif, sélection des pics.

export const DETECT_DEFAULTS = {
  fftSize: 1024,
  hop: 256,
  medianFreq: 17, // bins
  medianTime: 17, // trames
  bands: {
    // Réglages mesurés sur des rendus FluidR3 dont la partition est connue (tools/audio-bench.cjs).
    kick: { lo: 35, hi: 150, note: 36, minGap: 0.09, sensitivity: 1.6 },
    snare: { lo: 180, hi: 3000, note: 38, minGap: 0.09, sensitivity: 1.6 }, // corps du fût + timbre
    hihat: { lo: 5000, hi: 11000, note: 42, minGap: 0.06, sensitivity: 1.0, minStrength: 0.15 }, // coups doux
  },
  thresholdWindow: 0.5, // secondes : fenêtre du seuil adaptatif
  minStrength: 0.5, // montée minimale, en part de l'énergie moyenne de la bande
  snareOverKick: 0.6, // une caisse claire simultanée à une grosse caisse doit être au moins 0,6× aussi marquée
  kickOverSnare: 1.5, // une grosse caisse simultanée à une caisse claire doit être 1,5× plus marquée
  globalFloor: 0.03,
  minPresence: 0.065, // part percussive minimale dans l'aigu pour conclure à une batterie // ... et au moins cette part de l'énergie moyenne de tout le spectre
};

/** FFT radix-2 en place (re, im de longueur puissance de 2). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Spectrogramme d'amplitude : Float32Array [frames × bins]. */
export function spectrogram(samples, fftSize, hop) {
  const bins = fftSize / 2 + 1;
  const frames = Math.max(1, Math.floor((samples.length - fftSize) / hop) + 1);
  const out = new Float32Array(frames * bins);
  const win = new Float64Array(fftSize).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize));
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = (samples[off + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) out[f * bins + k] = Math.hypot(re[k], im[k]);
  }
  return { data: out, frames, bins };
}

/** Médiane glissante d'un tableau (fenêtre impaire), par tri d'une petite fenêtre. */
function medianFilter(src, out, size) {
  const n = src.length;
  const h = size >> 1;
  const buf = new Float32Array(size);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = i - h; k <= i + h; k++) buf[m++] = src[Math.min(n - 1, Math.max(0, k))];
    buf.sort();
    out[i] = buf[h];
  }
}

/** Partie percussive du spectrogramme (masque doux HPSS). */
export function percussive(spec, medianFreq, medianTime) {
  const { data, frames, bins } = spec;
  // Composante harmonique : médiane dans le temps, bin par bin.
  const H = new Float32Array(data.length);
  const col = new Float32Array(frames);
  const colOut = new Float32Array(frames);
  for (let k = 0; k < bins; k++) {
    for (let f = 0; f < frames; f++) col[f] = data[f * bins + k];
    medianFilter(col, colOut, medianTime);
    for (let f = 0; f < frames; f++) H[f * bins + k] = colOut[f];
  }
  // Composante percussive : médiane en fréquence, trame par trame ; masque doux écrit sur place
  // dans H (réutilisé comme sortie) pour limiter la mémoire sur les longs morceaux.
  const row = new Float32Array(bins);
  const P = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bins; k++) row[k] = data[f * bins + k];
    medianFilter(row, P, medianFreq);
    for (let k = 0; k < bins; k++) {
      const i = f * bins + k;
      const p2 = P[k] * P[k];
      const h2 = H[i] * H[i];
      H[i] = p2 + h2 > 0 ? (data[i] * p2) / (p2 + h2) : 0;
    }
  }
  return { data: H, frames, bins };
}

/**
 * Détection des montées d'énergie dans une bande de fréquences.
 * @param perc spectrogramme percussif, @param full spectrogramme complet (référence de niveau)
 */
function bandOnsets(perc, full, sampleRate, hop, band, o) {
  const { frames, bins } = perc;
  const binHz = sampleRate / ((bins - 1) * 2);
  const k0 = Math.max(1, Math.floor(band.lo / binHz));
  const k1 = Math.min(bins - 1, Math.ceil(band.hi / binHz));
  const env = new Float32Array(frames);
  let level = 0; // énergie moyenne de la bande dans le signal complet
  for (let f = 0; f < frames; f++) {
    let e = 0;
    let t = 0;
    for (let k = k0; k <= k1; k++) {
      e += perc.data[f * bins + k];
      t += full.data[f * bins + k];
    }
    env[f] = e;
    level += t;
  }
  level /= frames;
  // Plancher global : une bande presque vide (ex. aucun grave) ne doit pas réagir au moindre bruit.
  let total = 0;
  for (let i = 0; i < full.data.length; i++) total += full.data[i];
  total /= frames;
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, env[f] - env[f - 1]);

  // Seuil : adaptatif (moyenne locale + sensibilité × écart moyen) ET absolu
  // (une vraie frappe fait monter la bande d'une part notable de son niveau moyen).
  const w = Math.max(1, Math.round((o.thresholdWindow * sampleRate) / hop / 2));
  const absolute = Math.max((band.minStrength ?? o.minStrength) * level, o.globalFloor * total);
  const minGap = Math.round((band.minGap * sampleRate) / hop);
  const hits = [];
  let last = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < absolute || flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) {
      sum += flux[k];
      n++;
    }
    const mean = sum / n;
    let dev = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) dev += Math.abs(flux[k] - mean);
    if (flux[f] <= mean + band.sensitivity * (dev / n)) continue;
    if (f - last < minGap) {
      // Garde le plus fort de deux pics trop proches.
      if (hits.length && flux[f] > hits[hits.length - 1].flux) hits[hits.length - 1] = { frame: f, flux: flux[f] };
      continue;
    }
    hits.push({ frame: f, flux: flux[f] });
    last = f;
  }
  // Force relative au 90e centile des coups retenus → vélocité.
  const ref = [...hits.map((h) => h.flux)].sort((a, b) => a - b)[Math.floor(hits.length * 0.9)] || 1;
  // L'attaque est au milieu de la fenêtre d'analyse.
  return hits.map((h) => ({
    frame: h.frame,
    rel: h.flux / Math.max(1e-9, level), // force de la montée rapportée au niveau habituel de la bande
    time: (h.frame * hop + o.fftSize / 2) / sampleRate,
    midi: band.note,
    velocity: Math.min(1, Math.max(0.3, (0.9 * h.flux) / ref)),
  }));
}

/**
 * @param {Float32Array} samples audio mono
 * @param {number} sampleRate
 * @param {(fraction:number)=>void} onProgress
 * @returns notes de batterie General MIDI [{midi, time, duration, velocity}] triées
 */
export function detectDrums(samples, sampleRate, options = {}, onProgress = () => {}) {
  const o = { ...DETECT_DEFAULTS, ...options, bands: { ...DETECT_DEFAULTS.bands, ...options.bands } };
  const spec = spectrogram(samples, o.fftSize, o.hop);
  onProgress(0.3);
  const perc = percussive(spec, o.medianFreq, o.medianTime);
  onProgress(0.8);
  // Indicateurs de présence d'une batterie : part de l'énergie percussive dans l'aigu
  // (cymbales, charleston ; quasi nulle pour un piano) et part percussive dans le grave.
  const share = (lo, hi) => {
    const binHz = sampleRate / o.fftSize;
    const k0 = Math.floor(lo / binHz);
    const k1 = Math.ceil(hi / binHz);
    let band = 0;
    let all = 0;
    for (let f = 0; f < perc.frames; f++)
      for (let k = 1; k < perc.bins; k++) {
        const v = perc.data[f * perc.bins + k];
        all += v;
        if (k >= k0 && k <= k1) band += v;
      }
    return band / Math.max(1e-9, all);
  };
  const presence = { high: share(6500, 11000) };
  // Pas de cymbales ni de charleston : très probablement pas de batterie (piano, cordes…),
  // dont les attaques seraient sinon prises pour des coups.
  if (presence.high < o.minPresence) {
    onProgress(1);
    return Object.assign([], { presence, absent: true });
  }
  const [kicks, snares, hats] = ['kick', 'snare', 'hihat'].map((b) => bandOnsets(perc, spec, sampleRate, o.hop, o.bands[b], o));
  // Un coup de caisse claire (bruit large bande) fait aussi monter le grave : si une
  // « grosse caisse » coïncide avec une caisse claire nettement plus forte, c'est une fausse alerte.
  const near = (list, f) => list.find((x) => Math.abs(x.frame - f) <= 2);
  const realKicks = kicks.filter((k) => {
    const sn = near(snares, k.frame);
    return !sn || k.rel >= o.kickOverSnare * sn.rel;
  });
  // Symétrique : l'attaque d'une grosse caisse (clic large bande) peut faire monter le médium.
  const realSnares = snares.filter((sn) => {
    const k = near(kicks, sn.frame);
    return !k || sn.rel >= o.snareOverKick * k.rel;
  });
  onProgress(1);
  const result = [...realKicks, ...realSnares, ...hats]
    .map(({ time, midi, velocity }) => ({ time, midi, velocity, duration: 0.1 }))
    .sort((a, b) => a.time - b.time || a.midi - b.midi);
  result.presence = presence;
  return result;
}
