// Test de fumée du build de production dans un vrai navigateur :
// sert dist/ sous /animusic/ (comme GitHub Pages), charge la page, vérifie qu'il n'y a
// pas d'erreur, que la démo se construit, que la lecture avance, que les échantillons
// se chargent et qu'un fichier MIDI se lit.
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures.push(msg);
};

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('GL Driver') && errors.push(m.text()));
  const missing = [];
  page.on('response', (r) => r.status() >= 400 && missing.push(`${r.status()} ${r.url()}`));

  await page.goto(url);
  await page.waitForFunction(() => window.animusic?.ensemble, null, { timeout: 15000 });
  const kinds = await page.evaluate(() => window.animusic.ensemble.instruments.map((i) => i.kind));
  check(kinds.length === 4, `démo construite avec ${kinds.join(', ')}`);

  await page.waitForFunction(() => document.getElementById('sound').textContent === '', null, { timeout: 30000 });
  const ready = await page.evaluate(() => window.animusic.player.ready.size);
  check(ready >= 5, `${ready} jeux d'échantillons chargés`);

  await page.click('#play');
  await page.waitForTimeout(2500);
  const t = await page.evaluate(() => window.animusic.player.currentTime());
  check(t > 0.5, `la lecture avance (t = ${t.toFixed(2)} s)`);

  // Export glTF de la démo (animation cuite).
  const download = page.waitForEvent('download', { timeout: 60000 });
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
  await page.waitForTimeout(500);
  const stats = await page.textContent('#stats');
  check(stats.includes('4 notes'), `fichier MIDI lu (${stats})`);

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
