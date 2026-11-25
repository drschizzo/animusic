// Banc d'essai de l'import audio : compare la transcription d'un enregistrement à sa
// partition d'origine (fichier .mid de même nom, ex. morceau.mp3 + morceau.mid).
//
//   node tools/audio-bench.cjs dossier/morceau.mp3 [...]   (ffmpeg requis)
//
// Les sorties brutes de Basic Pitch sont mises en cache (morceau.bp.json) pour pouvoir
// régler les seuils rapidement : AUDIO_BENCH_NOCACHE=1 pour recalculer.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const tf = require('@tensorflow/tfjs');
const bp = require('@spotify/basic-pitch');
const { Midi } = require('@tonejs/midi');

const SR = 22050;
const TOL = 0.05; // tolérance d'attaque (s)

function decode(file, seconds) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-t', String(seconds), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function loadModel() {
  const dir = path.join(__dirname, '../node_modules/@spotify/basic-pitch/model/');
  const json = JSON.parse(fs.readFileSync(dir + 'model.json'));
  const w = fs.readFileSync(dir + 'group1-shard1of1.bin');
  return tf.loadGraphModel({
    load: async () => ({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest[0].weights,
      weightData: w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength),
      format: json.format,
    }),
  });
}

/** F1 d'attaques (et de hauteur si `pitch`) avec appariement glouton. */
function score(found, truth, pitch) {
  const used = new Uint8Array(found.length);
  let hit = 0;
  for (const t of truth) {
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      if (used[i] || Math.abs(f.time - t.time) > TOL || (pitch && f.midi !== t.midi)) continue;
      used[i] = 1;
      hit++;
      break;
    }
  }
  const p = found.length ? hit / found.length : 0;
  const r = truth.length ? hit / truth.length : 0;
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0, n: truth.length, found: found.length };
}
const fmt = (s) => `F1 ${(s.f1 * 100).toFixed(0)}% (précision ${(s.p * 100).toFixed(0)}%, rappel ${(s.r * 100).toFixed(0)}%, ${s.found}/${s.n})`;

(async () => {
  await tf.setBackend('cpu');
  const { runModel, rawToNotes } = await import('../src/transcribe.js');
  const { detectDrums } = await import('../src/drumDetect.js');
  const { arrangeTranscription } = await import('../src/audioArrange.js');
  const { assignRoles } = await import('../src/arranger.js');
  const { pieceForNote } = await import('../src/drums.js');
  const { parseMidi } = await import('../src/midi.js');
  const model = loadModel();

  for (const file of process.argv.slice(2)) {
    const seconds = 60;
    const samples = decode(file, seconds);
    const dur = samples.length / SR;
    const midiFile = file.replace(/\.\w+$/, '.mid');
    // Attention : un petit Buffer Node partage un ArrayBuffer commun, d'où le slice.
    const buf = fs.readFileSync(midiFile);
    const song = parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path.basename(midiFile));
    const roles = assignRoles(song.tracks);
    const gt = { all: [], bass: [], drums: { kick: [], snare: [], hihat: [] } };
    song.tracks.forEach((t, i) =>
      t.notes.filter((n) => n.time < dur - 0.2).forEach((n) => {
        if (t.percussion) {
          const piece = pieceForNote(n.midi);
          const cls = piece === 'kick' ? 'kick' : piece === 'snare' ? 'snare' : piece === 'hihat' ? 'hihat' : null;
          if (cls) gt.drums[cls].push(n);
        } else {
          gt.all.push(n);
          if (roles[i] === 'bass') gt.bass.push(n);
        }
      }),
    );

    // Notes (avec cache des sorties brutes du modèle). Réglages : variables d'environnement
    // TRANSCRIBE, DRUMS, ARRANGE (JSON d'options).
    const cache = file.replace(/\.\w+$/, '.bp.json');
    let raw;
    let ms = 0;
    if (fs.existsSync(cache) && !process.env.AUDIO_BENCH_NOCACHE) raw = JSON.parse(fs.readFileSync(cache));
    else {
      const t0 = Date.now();
      raw = await runModel(bp, model, samples);
      ms = Date.now() - t0;
      fs.writeFileSync(cache, JSON.stringify(raw));
    }
    const opt = (name) => JSON.parse(process.env[name] || '{}');
    const notes = rawToNotes(bp, raw, opt('TRANSCRIBE'));
    const t1 = Date.now();
    const drums = detectDrums(samples, SR, opt('DRUMS'));
    const drumMs = Date.now() - t1;
    const tracks = arrangeTranscription(notes, drums, opt('ARRANGE'));
    const byRole = Object.fromEntries(tracks.map((t) => [t.role, t.notes]));

    console.log(`\n== ${path.basename(file)} (${dur.toFixed(0)} s) — notes ${ms ? (ms / 1000).toFixed(0) + ' s (CPU)' : 'en cache'}, batterie ${(drumMs / 1000).toFixed(1)} s`);
    if (gt.all.length) {
      console.log(`  notes (hauteur exacte)   : ${fmt(score(notes, gt.all, true))}`);
      console.log(`  attaques (toutes notes)  : ${fmt(score(notes, gt.all, false))}`);
    }
    if (gt.bass.length) console.log(`  basse (hauteur exacte)   : ${fmt(score(byRole.bass ?? [], gt.bass, true))}`);
    for (const [cls, note] of [['kick', 36], ['snare', 38], ['hihat', 42]]) {
      const found = drums.filter((d) => d.midi === note);
      if (gt.drums[cls].length || found.length) console.log(`  ${cls.padEnd(24)} : ${fmt(score(found, gt.drums[cls], false))}`);
    }
    console.log(`  présence batterie : aigu ${(drums.presence.high * 100).toFixed(1)}%`);
    console.log(`  pistes : ${tracks.map((t) => `${t.role} ${t.notes.length}`).join(', ')}`);
  }
})();
