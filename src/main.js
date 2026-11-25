import * as THREE from 'three';
import './style.css';
import { buildEnsemble, assignRoles, ROLES } from './arranger.js';
import { planShots, cameraAt } from './director.js';
import { parseMidi, demoSong } from './midi.js';
import { isAudioFile, importAudio } from './audioImport.js';
import { Player } from './audio.js';
import { Stage } from './scene.js';

const PALETTE = ['#ff8a3d', '#3dc6ff', '#b56bff', '#5cff8f', '#ff5c8a', '#ffe14d', '#4dffe1', '#ff4d4d'];

const $ = (id) => document.getElementById(id);
const stage = new Stage($('stage'));
const player = new Player();
let song = null;
let ensemble = null;
let shotPlan = null;
let duration = 0;

function colorFor(i) {
  return new THREE.Color(PALETTE[i % PALETTE.length]);
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

/** (Re)construit la scène à partir du rôle de chaque piste. */
function rebuild() {
  const parts = { balls: [], bass: [], pads: [], drums: [], bells: [], laser: [], keys: [] };
  song.tracks.forEach((t, ti) => {
    if (t.role !== 'off') parts[t.role].push(...t.notes.map((n) => ({ ...n, track: ti })));
  });
  player.stop();
  updatePlayButton();
  const total = Object.values(parts).reduce((a, p) => a + p.length, 0);
  if (total === 0) {
    showError('Aucune piste à jouer.');
    return;
  }
  showError('');
  ensemble = buildEnsemble(parts);
  stage.build(ensemble, song.tracks.map((_, i) => colorFor(i)));
  shotPlan = planShots(ensemble);

  const voiceOf = { balls: 'mallet', bass: 'bass', pads: 'pad', bells: 'mallet', laser: 'pad', keys: 'mallet' };
  const notes = Object.keys(voiceOf).flatMap((role) =>
    parts[role].map((n) => ({ ...n, voice: voiceOf[role], program: song.tracks[n.track].program ?? 0 })),
  );
  const kit = ensemble.instruments.find((i) => i.kind === 'drums')?.model;
  const drumHits = kit ? kit.pieces.flatMap((p) => p.hits.map((h) => ({ ...h, piece: p.name }))) : [];
  duration = ensemble.end;
  // Pré-roll : laisse le temps à la première bille de voler / au premier bras de se lever.
  player.load(notes, drumHits, Math.max(0, -ensemble.start) + 0.5, song.audio ?? null);
  if (song.audio) player.setListenOriginal($('listen').value === 'original');
  $('seek').max = duration.toFixed(2);
  $('seek').value = 0;
  loadSounds(notes, drumHits.length > 0);

  const labels = { balls: 'billes', bass: 'basse', pads: 'orgue', drums: 'batterie', bells: 'carillon', laser: 'harpe laser', keys: 'clavier' };
  $('stats').textContent = ensemble.instruments
    .map((i) => `${labels[i.kind]} : ${i.onsets.length} notes`)
    .join(' · ');
}

/** Charge (en arrière-plan) les échantillons des instruments utilisés. */
async function loadSounds(notes, drums) {
  if (!player.useSamples) return;
  const programs = [...new Set(notes.map((n) => n.program))];
  $('sound').textContent = 'Chargement des sons…';
  const ok = await player.prepareSamples(programs, drums);
  $('sound').textContent = ok ? '' : 'Certains sons n\u2019ont pas pu être chargés : synthèse utilisée.';
}

function loadSong(s) {
  song = s;
  // Un import audio arrive avec des rôles déjà décidés ; un MIDI passe par l'arrangeur.
  if (!s.tracks.every((t) => t.role)) assignRoles(s.tracks).forEach((role, i) => (s.tracks[i].role = role));
  $('listenRow').hidden = !s.audio;
  $('song').hidden = false;
  $('songName').textContent = s.name;
  const list = $('tracks');
  list.innerHTML = '';
  s.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span class="name"></span><span class="muted"></span><select aria-label="Instrument"></select>`;
    li.querySelector('.name').textContent = t.name;
    li.querySelector('.muted').textContent = t.notes.length;
    const select = li.querySelector('select');
    for (const [value, label] of Object.entries(ROLES)) select.add(new Option(label, value, false, value === t.role));
    select.addEventListener('change', (e) => {
      t.role = e.target.value;
      rebuild();
    });
    list.appendChild(li);
  });
  rebuild();
}

let importing = false;
async function loadFile(file) {
  if (importing) return;
  try {
    if (isAudioFile(file)) {
      // Enregistrement : transcription dans le navigateur (chargée à la demande).
      importing = true;
      player.stop();
      updatePlayButton();
      document.body.classList.add('busy');
      showError('');
      const song = await importAudio(file, (msg) => status(msg));
      const a = song.analysis;
      loadSong(song);
      status(
        `Transcription : ${a.notes} notes${a.drumsAbsent ? ', pas de batterie détectée' : `, ${a.drums} coups de batterie`}. ` +
          'Rôles modifiables ci-dessus.',
      );
    } else {
      const buf = await file.arrayBuffer();
      loadSong(parseMidi(buf, file.name.replace(/\.midi?$/i, '')));
    }
  } catch (err) {
    console.error(err);
    status('');
    showError(`Impossible de lire ce fichier : ${err.message}`);
  } finally {
    importing = false;
    document.body.classList.remove('busy');
  }
}

function updatePlayButton() {
  $('play').textContent = player.playing ? '⏸ Pause' : '▶ Lecture';
}

$('file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
$('demo').addEventListener('click', () => loadSong(demoSong()));
$('play').addEventListener('click', async () => {
  if (!ensemble) return;
  if (player.playing) player.pause();
  else await player.play();
  updatePlayButton();
});
$('restart').addEventListener('click', async () => {
  player.stop();
  await player.play();
  updatePlayButton();
});
// Barre de lecture : pendant le glisser, c'est elle qui pilote le temps.
let seeking = false;
$('seek').addEventListener('pointerdown', () => (seeking = true));
window.addEventListener('pointerup', () => (seeking = false));
$('seek').addEventListener('input', (e) => player.seek(Number(e.target.value)));
// ---- Enregistrement vidéo (temps réel : canvas + mixage audio) ----
let recorder = null;
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function status(msg) {
  $('exportStatus').hidden = !msg;
  $('exportStatus').textContent = msg ?? '';
}
// Nom de fichier en ASCII : certains navigateurs ignorent les noms accentués.
const safeName = () =>
  (song?.name || 'animusic')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\- ]+/g, '_')
    .trim() || 'animusic';

async function startRecording() {
  if (!ensemble || !window.MediaRecorder) return status('Enregistrement vidéo non pris en charge par ce navigateur.');
  const mime = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].find((m) => MediaRecorder.isTypeSupported(m));
  player.stop();
  const audio = player.startCapture();
  const stream = new MediaStream([...stage.renderer.domElement.captureStream(60).getVideoTracks(), ...audio.getAudioTracks()]);
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    download(new Blob(chunks, { type: mime.split(';')[0] }), `${safeName()}.${ext}`);
    status(`Vidéo enregistrée (${ext}).`);
  };
  recorder.start(1000);
  await player.play();
  updatePlayButton();
  $('record').textContent = '⏹ Arrêter';
  status('Enregistrement en cours… (le morceau est rejoué en entier)');
}
function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  player.stopCapture();
  player.pause();
  updatePlayButton();
  $('record').textContent = '⏺ Vidéo';
}
$('record').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

// ---- Export glTF pour Blender (animation cuite, chargé à la demande) ----
$('exportGltf').addEventListener('click', async () => {
  if (!ensemble || recorder) return;
  player.pause();
  updatePlayButton();
  $('exportGltf').disabled = true;
  try {
    const { exportGLTF } = await import('./exporter.js');
    const glb = await exportGLTF(stage, ensemble, shotPlan, {
      fps: 30,
      trackColors: song.tracks.map((_, i) => colorFor(i)),
      name: safeName(),
      onProgress: (f) => status(`Export glTF : ${Math.round(f * 100)} %`),
    });
    download(new Blob([glb], { type: 'model/gltf-binary' }), `${safeName()}.glb`);
    status(`Export terminé (${(glb.byteLength / 1e6).toFixed(1)} Mo, 30 img/s). Son décalé de ${(-ensemble.start).toFixed(2)} s.`);
  } catch (err) {
    console.error(err);
    status(`Échec de l'export : ${err.message}`);
  } finally {
    $('exportGltf').disabled = false;
  }
});

$('listen').addEventListener('change', (e) => player.setListenOriginal(e.target.value === 'original'));

$('samples').addEventListener('change', (e) => {
  player.useSamples = e.target.checked;
  if (ensemble) rebuild();
});

$('collapse').addEventListener('click', () => {
  const collapsed = $('panel').classList.toggle('collapsed');
  $('collapse').setAttribute('aria-expanded', String(!collapsed));
});

// Caméra : réalisateur automatique, orbite lente ou libre (souris).
let camMode = 'director';
function setCamMode(mode) {
  camMode = mode;
  $('camMode').value = mode;
  stage.controls.autoRotate = mode === 'orbit';
  if (mode === 'orbit') stage.resetView();
}
$('camMode').addEventListener('change', (e) => setCamMode(e.target.value));
// Dès que l'utilisateur manipule la vue, on lui laisse la main.
stage.controls.addEventListener('start', () => camMode === 'director' && setCamMode('free'));

// Réglage fin de la synchro image/son (ex. casque Bluetooth dont la latence est mal annoncée).
function setOffset(ms) {
  player.manualOffset = ms / 1000;
  $('offset').value = ms;
  $('offsetVal').textContent = `${ms} ms`;
  try {
    localStorage.setItem('animusic.offsetMs', String(ms));
  } catch {
    /* stockage indisponible : réglage non mémorisé */
  }
}
$('offset').addEventListener('input', (e) => setOffset(Number(e.target.value)));
try {
  setOffset(Number(localStorage.getItem('animusic.offsetMs')) || 0);
} catch {
  setOffset(0);
}
setInterval(() => {
  if (player.playing) $('latency').textContent = `Latence audio compensée : ${Math.round(player.compensation() * 1000)} ms`;
}, 500);

// Glisser-déposer
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('drop').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// Qualité graphique. En mode auto, on part de « haute » et on descend d'un cran
// si l'animation tombe durablement sous ~40 images/s pendant la lecture.
const LEVELS = ['high', 'medium', 'low'];
let qualityMode = 'auto';
function setQuality(mode) {
  qualityMode = mode;
  $('quality').value = mode;
  stage.setQuality(mode === 'auto' ? 'high' : mode);
  try {
    localStorage.setItem('animusic.quality', mode);
  } catch {
    /* réglage non mémorisé */
  }
}
$('quality').addEventListener('change', (e) => setQuality(e.target.value));
try {
  setQuality(localStorage.getItem('animusic.quality') || 'auto');
} catch {
  setQuality('auto');
}
const fpsMeter = { frames: 0, since: performance.now(), slow: 0 };
function measureFps() {
  fpsMeter.frames++;
  const now = performance.now();
  if (now - fpsMeter.since < 1000) return;
  const fps = (fpsMeter.frames * 1000) / (now - fpsMeter.since);
  fpsMeter.frames = 0;
  fpsMeter.since = now;
  $('fps').textContent = `${Math.round(fps)} img/s`;
  if (qualityMode !== 'auto' || !player.playing) return;
  fpsMeter.slow = fps < 40 ? fpsMeter.slow + 1 : 0;
  const i = LEVELS.indexOf(stage.quality);
  if (fpsMeter.slow >= 3 && i < LEVELS.length - 1) {
    stage.setQuality(LEVELS[i + 1]);
    fpsMeter.slow = 0;
  }
}

const fmt = (s) => {
  const v = Math.max(0, s);
  return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
};

function frame() {
  if (ensemble) {
    const t = player.currentTime();
    stage.update(t);
    if (camMode === 'director' && shotPlan) stage.setCamera(cameraAt(shotPlan, t));
    $('time').textContent = `${fmt(t)} / ${fmt(duration)}`;
    if (!seeking) $('seek').value = Math.max(0, t);
    if (player.playing && t > duration + 0.5) {
      if (recorder) stopRecording();
      player.stop();
      updatePlayButton();
    }
  }
  stage.render();
  measureFps();
  requestAnimationFrame(frame);
}

loadSong(demoSong());
frame();

// Accès pour le débogage depuis la console.
window.animusic = { stage, player, get recorder() { return recorder; }, get ensemble() { return ensemble; } };
