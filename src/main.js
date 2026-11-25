import * as THREE from 'three';
import { buildChoreography } from './choreography.js';
import { parseMidi, demoSong } from './midi.js';
import { Player } from './audio.js';
import { Stage } from './scene.js';

const PALETTE = ['#ff8a3d', '#3dc6ff', '#b56bff', '#5cff8f', '#ff5c8a', '#ffe14d', '#4dffe1', '#ff4d4d'];

const $ = (id) => document.getElementById(id);
const stage = new Stage($('stage'));
const player = new Player();
let song = null;
let choreo = null;

function colorFor(i) {
  return new THREE.Color(PALETTE[i % PALETTE.length]);
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

/** (Re)construit la scène à partir des pistes cochées. */
function rebuild() {
  const notes = song.tracks.flatMap((t, ti) => (t.enabled ? t.notes.map((n) => ({ ...n, track: ti })) : []));
  player.stop();
  updatePlayButton();
  if (notes.length === 0) {
    showError('Aucune piste sélectionnée.');
    return;
  }
  showError('');
  choreo = buildChoreography(notes);
  stage.build(choreo, song.tracks.map((_, i) => colorFor(i)));
  // Pré-roll : laisse le temps à la première bille de voler.
  player.load(notes, Math.max(0, -choreo.start) + 0.5);
  $('stats').textContent =
    `${notes.length} notes · ${choreo.bars.length} lames · ${choreo.launchers.length} canons · ` +
    `jusqu'à ${choreo.maxConcurrent} billes en vol`;
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
$('orbit').addEventListener('change', (e) => (stage.controls.autoRotate = e.target.checked));

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
    $('time').textContent = `${fmt(t)} / ${fmt(choreo.duration)}`;
    if (player.playing && t > choreo.duration + 0.5) {
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
