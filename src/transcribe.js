// Transcription des notes d'un enregistrement avec Basic Pitch (Spotify, Apache-2.0).
// La bibliothèque et le modèle sont passés en paramètre : chargement dynamique dans le
// navigateur, CommonJS + fichiers locaux dans Node (banc d'essai).

export const TRANSCRIBE_DEFAULTS = {
  onsetThreshold: 0.65, // confiance minimale d'une attaque (réglé avec tools/audio-bench.cjs)
  frameThreshold: 0.3, // confiance minimale d'une note tenue
  minNoteFrames: 11, // durée minimale (trames de ~11,6 ms) : ~0,13 s
  minFreq: 30, // Hz
  maxFreq: 4200, // Hz (au-delà : harmoniques et sifflantes)
};

export const SAMPLE_RATE = 22050;

/**
 * Passe le modèle sur l'audio : sorties brutes (trames, attaques, contours).
 * @param bp exports de @spotify/basic-pitch
 * @param model tf.GraphModel (ou Promise) du modèle Basic Pitch
 * @param {Float32Array} samples audio mono à 22 050 Hz
 */
export async function runModel(bp, model, samples, onProgress = () => {}) {
  const basicPitch = new bp.BasicPitch(model);
  const raw = { frames: [], onsets: [], contours: [] };
  await basicPitch.evaluateModel(
    samples,
    (f, on, c) => {
      raw.frames.push(...f);
      raw.onsets.push(...on);
      raw.contours.push(...c);
    },
    onProgress,
  );
  return raw;
}

/** Sorties brutes → notes [{midi, time, duration, velocity}] triées. */
export function rawToNotes(bp, raw, options = {}) {
  const o = { ...TRANSCRIBE_DEFAULTS, ...options };
  const events = bp.noteFramesToTime(
    bp.addPitchBendsToNoteEvents(
      raw.contours,
      bp.outputToNotesPoly(raw.frames, raw.onsets, o.onsetThreshold, o.frameThreshold, o.minNoteFrames, true, o.maxFreq, o.minFreq),
    ),
  );
  return events
    .map((e) => ({
      midi: e.pitchMidi,
      time: e.startTimeSeconds,
      duration: e.durationSeconds,
      velocity: Math.min(1, Math.max(0.2, e.amplitude)),
    }))
    .sort((a, b) => a.time - b.time || a.midi - b.midi);
}

/** Transcription complète d'un audio mono à 22 050 Hz. */
export async function transcribeNotes(bp, model, samples, options = {}, onProgress = () => {}) {
  return rawToNotes(bp, await runModel(bp, model, samples, onProgress), options);
}
