// Génère les échantillons audio de l'appli à partir du SoundFont General MIDI
// FluidR3 (licence MIT, paquet Debian/Ubuntu « fluid-soundfont-gm »).
//
//   sudo apt-get install fluidsynth fluid-soundfont-gm ffmpeg
//   node tools/make-samples.mjs
//
// Produit public/samples/gm/<programme>/<note>.mp3 (13 notes par instrument,
// de C1 à C7 toutes les 6 demi-tons) et public/samples/drums/<note>.mp3
// (kit standard, notes 35 à 81), plus un index JSON.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import midiPkg from '@tonejs/midi';

const { Midi } = midiPkg;

const run = promisify(execFile);
const SF2 = process.env.SF2 ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
const OUT = 'public/samples';
const NOTES = Array.from({ length: 13 }, (_, i) => 24 + i * 6); // 24..96
const DRUM_NOTES = Array.from({ length: 47 }, (_, i) => 35 + i); // 35..81
const SLOT = 4.5; // secondes entre deux notes dans le rendu
const HOLD = 3.0; // durée de la note tenue
const RATE = 32000;

if (!existsSync(SF2)) {
  console.error(`SoundFont introuvable : ${SF2}`);
  process.exit(1);
}
const tmp = join(tmpdir(), 'animusic-samples');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

async function render(name, notes, { program = 0, percussion = false, hold = HOLD }) {
  const midi = new Midi();
  const track = midi.addTrack();
  track.channel = percussion ? 9 : 0;
  track.instrument.number = program;
  notes.forEach((n, k) => track.addNote({ midi: n, time: k * SLOT, duration: hold, velocity: 0.8 }));
  const mid = join(tmp, `${name}.mid`);
  const wav = join(tmp, `${name}.wav`);
  writeFileSync(mid, Buffer.from(midi.toArray()));
  await run('fluidsynth', ['-ni', '-q', '-R', '0', '-C', '0', '-g', '0.9', '-r', String(RATE), '-F', wav, SF2, mid]);
  return wav;
}

/** Découpe une note ; renvoie false (et supprime le fichier) si elle est silencieuse (hors tessiture). */
async function cut(wav, k, dest, maxLen) {
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', String(k * SLOT), '-t', String(maxLen), '-i', wav,
    '-ac', '1', '-ar', String(RATE),
    // Coupe le silence final pour alléger les fichiers.
    '-af', 'areverse,silenceremove=start_periods=1:start_threshold=-55dB,areverse',
    '-b:a', '40k', dest,
  ]);
  if (statSync(dest).size < 800) {
    rmSync(dest);
    return false;
  }
  return true;
}

async function pool(items, worker, size = Math.max(2, cpus().length)) {
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await worker(item);
      }
    }),
  );
}

// index.programs[p] = notes réellement disponibles pour le programme p.
const index = { programs: {}, drums: [] };
let done = 0;

await pool([...Array(128).keys()], async (program) => {
  const dir = join(OUT, 'gm', String(program));
  mkdirSync(dir, { recursive: true });
  const wav = await render(`p${program}`, NOTES, { program });
  const ok = [];
  for (const [k, n] of NOTES.entries()) if (await cut(wav, k, join(dir, `${n}.mp3`), SLOT - 0.1)) ok.push(n);
  rmSync(wav);
  index.programs[program] = ok;
  process.stdout.write(`\rprogrammes : ${++done}/128`);
});
console.log();

mkdirSync(join(OUT, 'drums'), { recursive: true });
const wav = await render('drums', DRUM_NOTES, { percussion: true, hold: 1.5 });
for (const [k, n] of DRUM_NOTES.entries()) if (await cut(wav, k, join(OUT, 'drums', `${n}.mp3`), 3)) index.drums.push(n);
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));

const count = readdirSync(join(OUT, 'gm')).length;
const files = Object.values(index.programs).reduce((a, n) => a + n.length, 0);
console.log(`OK : ${count} instruments (${files} notes), ${index.drums.length} sons de batterie dans ${OUT}`);
