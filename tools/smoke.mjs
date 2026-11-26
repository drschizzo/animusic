// Test de fumée du build de production dans un vrai navigateur :
// sert dist/ sous /animusic/ (comme GitHub Pages), charge la page, vérifie qu'il n'y a
// pas d'erreur, que la démo se construit, que la lecture avance, que le lecteur SoundFont
// se charge et joue, et qu'un fichier MIDI se lit.
//
//   npm run build && node tools/smoke.mjs
//
// Nécessite le paquet « playwright » (local, ou global via npm root -g) et Chromium.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join, extname } from 'node:path';
import midiPkg from '@tonejs/midi';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg', '.sf3': 'application/octet-stream' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/favicon.ico') return res.writeHead(204).end(); // demandée par le navigateur, pas par la page
  if (!path.startsWith('/animusic/')) return res.writeHead(404).end();
  const file = join('dist', path.slice('/animusic/'.length) || 'index.html');
  try {
    const body = await readFile(file.endsWith('/') ? join(file, 'index.html') : file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/animusic/`;

/** WAV 16 bits mono de 6 s : arpège (sinus + harmoniques) avec grosse caisse et charleston. */
function makeWav(sr = 22050, seconds = 6) {
  const n = sr * seconds;
  const x = new Float32Array(n);
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  [60, 64, 67, 72, 67, 64, 60, 64, 67, 72, 76, 72].forEach((midi, i) => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    const start = Math.round((0.3 + i * 0.45) * sr);
    for (let k = 0; k < sr * 0.4 && start + k < n; k++) {
      const t = k / sr;
      x[start + k] += 0.3 * Math.exp(-t * 4) * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t));
    }
  });
  for (let b = 0; b < 12; b++) {
    const start = Math.round((0.3 + b * 0.45) * sr);
    let hp = 0;
    let prev = 0;
    for (let k = 0; k < sr * 0.2 && start + k < n; k++) {
      const t = k / sr;
      if (b % 2 === 0) x[start + k] += 0.8 * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 15);
      const w = noise();
      hp = 0.6 * (hp + w - prev); // passe-haut grossier
      prev = w;
      x[start + Math.round(0.225 * sr) + k] += 0.25 * hp * Math.exp(-t * 50);
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32000), 44 + i * 2);
  return buf;
}

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures.push(msg);
};

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // Chromium complet (nouveau mode sans écran) : le « headless shell » par défaut ne fait
  // sortir aucun son d'un AudioWorklet, donc rien du lecteur SoundFont.
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  // Sans carte graphique (CI), le rendu est logiciel : petite fenêtre pour garder la qualité « haute »
  // (tous les shaders sont compilés et exécutés) dans des délais raisonnables.
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('GL Driver') && errors.push(m.text()));
  const missing = [];
  page.on('response', (r) => r.status() >= 400 && missing.push(`${r.status()} ${r.url()}`));

  await page.goto(url);
  await page.waitForFunction(() => window.animusic?.ensemble, null, { timeout: 120000 });
  const kinds = await page.evaluate(() => window.animusic.ensemble.instruments.map((i) => i.kind));
  check(kinds.length === 8, `démo construite avec ${kinds.join(', ')}`);

  await page.waitForFunction(() => document.getElementById('sound').textContent === '', null, { timeout: 120000 });
  const sf = await page.evaluate(() => window.animusic.player.soundfontOn);
  check(sf, 'lecteur SoundFont chargé');

  // Niveau mesuré à la sortie du lecteur SoundFont (les synthés de secours n'y passent pas).
  await page.evaluate(() => {
    const p = window.animusic.player;
    const an = p.rawContext.createAnalyser();
    p.limiter.connect(an);
    window.__peak = 0;
    const buf = new Float32Array(an.fftSize);
    window.__meter = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      for (const v of buf) window.__peak = Math.max(window.__peak, Math.abs(v));
    }, 20);
  });
  await page.click('#play');
  await page.waitForTimeout(2500);
  const playing = await page.evaluate(() => {
    clearInterval(window.__meter);
    return { t: window.animusic.player.currentTime(), peak: window.__peak };
  });
  check(playing.t > 0.5, `la lecture avance (t = ${playing.t.toFixed(2)} s)`);
  check(playing.peak > 0.01, `le SoundFont joue (crête ${playing.peak.toFixed(3)})`);

  // Export glTF de la démo (animation cuite).
  const download = page.waitForEvent('download', { timeout: 240000 });
  await page.click('#exportGltf');
  const glb = await download;
  const size = (await readFile(await glb.path())).byteLength;
  check(glb.suggestedFilename().endsWith('.glb') && size > 500_000, `export glTF ${glb.suggestedFilename()} (${(size / 1e6).toFixed(1)} Mo)`);

  // Lecture d'un fichier MIDI généré à la volée.
  const { Midi } = midiPkg;
  const midi = new Midi();
  const track = midi.addTrack();
  [60, 64, 67, 72].forEach((n, i) => track.addNote({ midi: n, time: i * 0.3, duration: 0.25 }));
  await page.setInputFiles('#file', { name: 'test.mid', mimeType: 'audio/midi', buffer: Buffer.from(midi.toArray()) });
  await page.waitForFunction(() => window.animusic.ensemble.instruments.length === 1, null, { timeout: 60000 });
  const read = await page.evaluate(() => window.animusic.ensemble.instruments.map((i) => `${i.kind} : ${i.line.length} notes`).join(', '));
  check(read === 'balls : 4 notes', `fichier MIDI lu (${read})`);

  // Import d'un enregistrement (WAV synthétique) : transcription + batterie + lecture de l'original.
  await page.setInputFiles('#file', { name: 'essai.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await page.waitForFunction(() => document.getElementById('exportStatus').textContent.startsWith('Transcription'), null, {
    timeout: 180000,
  });
  const imported = await page.evaluate(() => ({
    roles: [...document.querySelectorAll('#tracks select')].map((s) => s.value),
    status: document.getElementById('exportStatus').textContent,
  }));
  check(imported.roles.includes('balls') && imported.roles.includes('drums'), `audio importé : ${imported.status} (${imported.roles.join(', ')})`);
  await page.click('#play');
  await page.waitForTimeout(1500);
  const original = await page.evaluate(() => window.animusic.player.original?.state);
  check(original === 'started', `enregistrement original en lecture (${original})`);

  check(missing.length === 0, `aucune ressource manquante ${missing.slice(0, 3).join(' ')}`);
  check(errors.length === 0, `aucune erreur JavaScript ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} échec(s)`);
  process.exit(1);
}
console.log('\nTest de fumée OK');
