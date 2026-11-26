// Génère src/gmAttack.js : temps (s) que met chaque programme General MIDI de la banque
// à atteindre son plein volume (délai + attaque de l’enveloppe), mesuré au do central
// (la couche la plus rapide : un piano a aussi une couche de résonance lente).
// L'arrangeur s'en sert pour savoir si une note courte a le temps de se faire entendre.
//
//   node tools/gm-attack.mjs

import fs from 'node:fs';
import { SoundBankLoader } from 'spessasynth_core';
import { StbVorbis } from 'stb-vorbis';

await StbVorbis.ready;
const buf = fs.readFileSync('public/soundfonts/MuseScore_General.sf3');
const bank = SoundBankLoader.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const sec = (tc) => (tc <= -12000 ? 0 : 2 ** (tc / 1200));
const attack = [];
for (let p = 0; p < 128; p++) {
  const preset = bank.getPreset({ program: p, bankMSB: 0, bankLSB: 0, isGMGSDrum: false }, 'gs');
  const voices = preset.getVoiceParameters(60, 100);
  const t = Math.min(...voices.map((v) => sec(v.generators[33]) + sec(v.generators[34])));
  attack.push(Math.round(t * 1000) / 1000);
}
fs.writeFileSync(
  'src/gmAttack.js',
  `// Généré par tools/gm-attack.mjs depuis public/soundfonts/MuseScore_General.sf3 : ne pas modifier.\n` +
    `// Temps (s) d'attaque de chaque programme General MIDI (délai + attaque, do central).\n` +
    `export const GM_ATTACK = ${JSON.stringify(attack)};\n`,
);
console.log(attack.map((a, p) => (a >= 0.05 ? `${p}:${a}` : null)).filter(Boolean).join(' '));
