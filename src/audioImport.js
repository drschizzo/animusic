// Import d'un enregistrement (mp3, wav, ogg…) : transcription des notes (Basic Pitch,
// TensorFlow.js) et détection de la batterie (Web Worker), puis répartition en pistes.
// Tout se passe dans le navigateur : le fichier n'est envoyé nulle part.
// Les bibliothèques lourdes ne sont chargées qu'à la première utilisation.

import { runModel, rawToNotes, SAMPLE_RATE } from './transcribe.js';
import { arrangeTranscription } from './audioArrange.js';

const MODEL_URL = `${import.meta.env?.BASE_URL ?? './'}models/basic-pitch/model.json`;
let modelPromise = null;

export const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i;
// Un .mid est souvent déclaré « audio/midi » par le navigateur : ce n'est pas un enregistrement.
const MIDI_FILE = (file) => /\.(mid|midi|kar)$/i.test(file.name) || /midi|\/mid$/i.test(file.type);
export const isAudioFile = (file) => !MIDI_FILE(file) && (file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name));

/** Décode puis convertit en mono 22 050 Hz (format attendu par Basic Pitch). */
async function decode(file) {
  const bytes = await file.arrayBuffer();
  const original = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes);
  const length = Math.ceil(original.duration * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(1, length, SAMPLE_RATE); // le passage en mono est fait par le mixage
  const src = ctx.createBufferSource();
  src.buffer = original;
  src.connect(ctx.destination);
  src.start();
  const mono = await ctx.startRendering();
  return { original, samples: mono.getChannelData(0) };
}

function detectDrumsInWorker(samples, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./drumWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress != null) return onProgress(e.data.progress);
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    // Copie : le tableau d'origine sert encore à la transcription.
    worker.postMessage({ samples: samples.slice(), sampleRate: SAMPLE_RATE });
  });
}

/**
 * @param {File} file
 * @param {(message:string)=>void} onStatus
 * @returns morceau au format de midi.js, avec `audio` (AudioBuffer original) et des rôles imposés
 */
export async function importAudio(file, onStatus = () => {}) {
  onStatus('Décodage de l’audio…');
  const { original, samples } = await decode(file);

  let drumProgress = 0;
  let noteProgress = 0;
  const report = () =>
    onStatus(`Analyse : notes ${Math.round(noteProgress * 100)} % · batterie ${Math.round(drumProgress * 100)} %`);
  const drumsJob = detectDrumsInWorker(samples, (p) => {
    drumProgress = p;
    report();
  });

  onStatus('Chargement du modèle de transcription…');
  const [tf, bp] = await Promise.all([import('@tensorflow/tfjs'), import('@spotify/basic-pitch')]);
  await tf.ready();
  modelPromise ??= tf.loadGraphModel(MODEL_URL);
  const raw = await runModel(bp, modelPromise, samples, (p) => {
    noteProgress = p;
    report();
  });
  noteProgress = 1;
  report();
  const notes = rawToNotes(bp, raw);
  const drums = await drumsJob;

  const tracks = arrangeTranscription(notes, drums.hits);
  onStatus('');
  return {
    name: file.name.replace(/\.[^.]+$/, ''),
    tracks,
    audio: original,
    analysis: { notes: notes.length, drums: drums.hits.length, drumsAbsent: drums.absent, backend: tf.getBackend() },
  };
}
