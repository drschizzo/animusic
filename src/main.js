import * as THREE from 'three';
import './style.css';
import { buildEnsemble, classifyTrack, ROLES } from './arranger.js';
import { planShots, cameraAt } from './director.js';
import { parseMidi, demoSong } from './midi.js';
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
  const parts = { balls: [], bass: [], pads: [], drums: [] };
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

  const voiceOf = { balls: 'mallet', bass: 'bass', pads: 'pad' };
  const notes = ['balls', 'bass', 'pads'].flatMap((role) => parts[role].map((n) => ({ ...n, voice: voiceOf[role] })));
  const kit = ensemble.instruments.find((i) => i.kind === 'drums')?.model;
  const drumHits = kit ? kit.pieces.flatMap((p) => p.hits.map((h) => ({ ...h, piece: p.name }))) : [];
  duration = ensemble.end;
  // Pré-roll : laisse le temps à la première bille de voler / au premier bras de se lever.
  player.load(notes, drumHits, Math.max(0, -ensemble.start) + 0.5);
  $('seek').max = duration.toFixed(2);
  $('seek').value = 0;

  const labels = { balls: 'billes', bass: 'basse', pads: 'orgue', drums: 'batterie' };
  $('stats').textContent = ensemble.instruments
    .map((i) => `${labels[i.kind]} : ${i.onsets.length} notes`)
    .join(' · ');
}

function loadSong(s) {
  song = s;
  for (const t of s.tracks) t.role = classifyTrack(t);
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

async function loadFile(file) {
  try {
    const buf = await file.arrayBuffer();
    loadSong(parseMidi(buf, file.name.replace(/\.midi?$/i, '')));
  } catch (err) {
    console.error(err);
    showError(`Impossible de lire ce fichier MIDI : ${err.message}`);
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
      player.stop();
      updatePlayButton();
    }
  }
  stage.render();
  requestAnimationFrame(frame);
}

loadSong(demoSong());
frame();

// Accès pour le débogage depuis la console.
window.animusic = { stage, player, get ensemble() { return ensemble; } };
