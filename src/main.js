import * as THREE from 'three';
import './style.css';
import { buildChoreography } from './choreography.js';
import { buildDrumKit } from './drums.js';
import { parseMidi, demoSong } from './midi.js';
import { Player } from './audio.js';
import { Stage } from './scene.js';

const PALETTE = ['#ff8a3d', '#3dc6ff', '#b56bff', '#5cff8f', '#ff5c8a', '#ffe14d', '#4dffe1', '#ff4d4d'];

const $ = (id) => document.getElementById(id);
const stage = new Stage($('stage'));
const player = new Player();
let song = null;
let choreo = null;
let duration = 0;

function colorFor(i) {
  return new THREE.Color(PALETTE[i % PALETTE.length]);
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

/** (Re)construit la scène à partir des pistes cochées. */
function rebuild() {
  const pick = (perc) =>
    song.tracks.flatMap((t, ti) => (t.enabled && t.percussion === perc ? t.notes.map((n) => ({ ...n, track: ti })) : []));
  const notes = pick(false);
  const drumNotes = pick(true);
  player.stop();
  updatePlayButton();
  if (notes.length + drumNotes.length === 0) {
    showError('Aucune piste sélectionnée.');
    return;
  }
  showError('');
  choreo = buildChoreography(notes);
  // La batterie se place entre les canons et l'arc de lames.
  const kit = buildDrumKit(drumNotes, { center: [0, 0, -(choreo.radius * 0.5 + 0.4)] });
  stage.build(choreo, song.tracks.map((_, i) => colorFor(i)), kit);

  const drumHits = kit.pieces.flatMap((p) => p.hits.map((h) => ({ ...h, piece: p.name })));
  const firstDrum = Math.min(...drumHits.map((h) => h.time));
  const lastDrum = Math.max(...drumHits.map((h) => h.time));
  // Pré-roll : laisse le temps à la première bille de voler / au premier bras de se lever.
  const start = Math.min(notes.length ? choreo.start : Infinity, firstDrum - kit.options.strikeTime);
  duration = Math.max(notes.length ? choreo.duration : 0, drumHits.length ? lastDrum + 1.5 : 0);
  player.load(notes, drumHits, Math.max(0, -start) + 0.5);
  $('seek').max = duration.toFixed(2);
  $('seek').value = 0;

  const parts = [];
  if (notes.length)
    parts.push(`${notes.length} notes`, `${choreo.bars.length} lames`, `${choreo.launchers.length} canons`,
      `jusqu'à ${choreo.maxConcurrent} billes en vol`);
  if (drumHits.length) parts.push(`${drumHits.length} frappes`, `${kit.pieces.length} bras robotisés`);
  $('stats').textContent = parts.join(' · ');
}

function loadSong(s) {
  song = s;
  $('song').hidden = false;
  $('songName').textContent = s.name;
  const list = $('tracks');
  list.innerHTML = '';
  s.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<label><input type="checkbox" ${t.enabled ? 'checked' : ''}/>
      <span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span></span><span class="muted"></span></label>`;
    li.querySelector('span:nth-of-type(2)').textContent = t.name;
    li.querySelector('.muted').textContent = `${t.notes.length}${t.percussion ? ' · percu' : ''}`;
    li.querySelector('input').addEventListener('change', (e) => {
      t.enabled = e.target.checked;
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
  if (!choreo) return;
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
$('orbit').addEventListener('change', (e) => (stage.controls.autoRotate = e.target.checked));

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
  if (choreo) {
    const t = player.currentTime();
    stage.update(t);
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
window.animusic = { stage, player, get choreo() { return choreo; } };
