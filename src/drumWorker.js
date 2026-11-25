// Web Worker : détection de la batterie hors du fil principal (calcul de plusieurs secondes).
import { detectDrums } from './drumDetect.js';

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const hits = detectDrums(samples, sampleRate, {}, (progress) => self.postMessage({ progress }));
    self.postMessage({ hits: [...hits], presence: hits.presence, absent: !!hits.absent });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
