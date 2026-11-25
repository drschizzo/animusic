// Capture d'écran du build de production à un instant du morceau de démo.
//
//   npm run build && node tools/shot.mjs sortie.png [--t 12] [--cam x,y,z,tx,ty,tz] [autre.png --t 20 …] [--ui] [--size 1280x720] [--quality high]
//
// Sans --cam, c'est le plan du réalisateur à l'instant t. Sert à l'aperçu du README.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join, extname } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const args = process.argv.slice(2);
const opt = (name, fallback, from = args) => (from.includes(`--${name}`) ? from[from.indexOf(`--${name}`) + 1] : fallback);
// Plusieurs captures en un seul lancement : chaque nom de fichier .png ouvre une capture,
// les options --t et --cam qui le suivent s'y appliquent.
const shots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].endsWith('.png')) shots.push({ out: args[i], own: [] });
  else if (shots.length) shots[shots.length - 1].own.push(args[i]);
}
if (!shots.length) shots.push({ out: 'apercu.png', own: [] });
for (const s of shots) Object.assign(s, { t: Number(opt('t', 12, s.own)), cam: opt('cam', '', s.own) });
const [width, height] = opt('size', '1280x720').split('x').map(Number);
const quality = opt('quality', 'high');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join('dist', path.replace(/^\/animusic\//, '') || 'index.html');
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file.endsWith('/') ? join(file, 'index.html') : file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(opt('dpr', 1)) });
  page.on('pageerror', (e) => console.error('ERREUR', e.message));
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.error(m.type(), m.text().slice(0, 600)));
  await page.goto(`http://localhost:${server.address().port}/animusic/`);
  await page.waitForFunction(() => window.animusic?.ensemble, null, { timeout: 60000 });
  for (const { out, t, cam } of shots) {
    await page.evaluate(
      ({ t, cam, quality, ui }) => {
        const a = window.animusic;
        if (!ui) document.getElementById('panel').style.display = 'none';
        document.getElementById('quality').value = quality;
        document.getElementById('quality').dispatchEvent(new Event('change'));
        a.player.seek(t);
        document.getElementById('camMode').value = cam ? 'free' : 'director';
        document.getElementById('camMode').dispatchEvent(new Event('change'));
        if (cam) {
          const c = cam.split(',').map(Number);
          a.stage.setCamera({ position: c.slice(0, 3), target: c.slice(3, 6) });
        }
      },
      { t, cam, quality, ui: args.includes('--ui') },
    );
    // Laisse passer quelques images (compilation des shaders, reflets, halo).
    await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n > 4 ? r() : requestAnimationFrame(f)); f(); }));
    await page.screenshot({ path: out, timeout: 180000 });
    console.log(`${out} (t = ${t} s)`);
  }
} finally {
  await browser.close();
  server.close();
}
