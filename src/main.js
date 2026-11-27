import * as THREE from 'three';
import './style.css';
import { buildEnsemble, assignRoles, groupParts, ROLES } from './arranger.js';
import { planShots, cameraAt } from './director.js';
import { parseMidi, demoSong } from './midi.js';
import { isAudioFile, importAudio } from './audioImport.js';
import { Player } from './audio.js';
import { Stage } from './scene.js';
import { sustainedEnd } from './util.js';

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
  // Une partie musicale = un instrument (voir groupParts).
  const parts = groupParts(song.tracks);
  player.stop();
  updatePlayButton();
  if (!parts.length) {
    showError('Aucune piste à jouer.');
    return;
  }
  showError('');
  // Expression (pédale de sustain, pitch bend, modulation) de chaque piste.
  const controls = song.tracks.map((t) => ({ sustain: t.sustain, bends: t.bends, mod: t.mod }));
  ensemble = buildEnsemble(parts, controls, song.tracks.map((t) => t.program ?? -1), { style: $('style').value });
  stage.build(ensemble, song.tracks.map((_, i) => colorFor(i)));
  shotPlan = planShots(ensemble);

  const voiceOf = { balls: 'mallet', bass: 'bass', pads: 'pad', bells: 'mallet', laser: 'pad', bowed: 'pad', winds: 'pad', plucked: 'mallet', keys: 'mallet' };
  // Pistes « son seul » (doublures couvertes, pistes quasi muettes) : jouées, sans instrument.
  const soundOnly = song.tracks.flatMap((t, i) =>
    t.role === 'sound' && !t.percussion ? [{ kind: 'pads', notes: t.notes.map((n) => ({ ...n, track: i })) }] : [],
  );
  const notes = [...parts, ...soundOnly]
    .filter((p) => voiceOf[p.kind])
    .flatMap((p) =>
      p.notes.map((n) => ({
        ...n,
        held: n.duration,
        // La pédale de sustain prolonge le son au-delà du relâché de la touche.
        duration: sustainedEnd(n, song.tracks[n.track].sustain) - n.time,
        voice: voiceOf[p.kind],
        program: song.tracks[n.track].program ?? 0,
      })),
    );
  const kit = ensemble.instruments.find((i) => i.kind === 'drums')?.model;
  const drumHits = kit ? kit.pieces.flatMap((p) => p.hits.map((h) => ({ ...h, piece: p.name }))) : [];
  duration = ensemble.end;
  // Pré-roll : laisse le temps à la première bille de voler / au premier bras de se lever.
  player.load(notes, drumHits, Math.max(0, -ensemble.start) + 0.5, song.audio ?? null, song.tracks);
  if (song.audio) player.setListenOriginal($('listen').value === 'original');
  $('seek').max = duration.toFixed(2);
  $('seek').value = 0;
  loadSounds();

  $('trackSummary').textContent = `${song.tracks.length} pistes → ${ensemble.instruments.length} instruments`;
}

/** Charge (en arrière-plan, une seule fois) le lecteur SoundFont. */
async function loadSounds() {
  if (!player.useSamples) return;
  if (!player.soundfont.ready) $('sound').textContent = 'Chargement des sons (40 Mo la première fois)…';
  const ok = await player.prepareSounds();
  $('sound').textContent = ok ? '' : 'Les sons réalistes n\u2019ont pas pu être chargés : synthèse utilisée.';
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

$('file').addEventListener('change', (e) => {
  openFiles([...e.target.files]);
  e.target.value = '';
});
$('demo').addEventListener('click', () => {
  playlist.index = -1;
  renderPlaylist();
  loadSong(demoSong());
});

// --- Playlist (fichiers MIDI) : les morceaux s'enchaînent ; « Lecture en boucle »
// reprend au premier une fois le dernier terminé.
const playlist = { files: [], index: -1 };
const isMidi = (f) => /\.midi?$/i.test(f.name);

/**
 * Fichiers choisis ou déposés : plusieurs MIDI (ou un MIDI quand une playlist existe
 * déjà) vont dans la playlist ; un fichier seul se charge directement, comme avant.
 */
function openFiles(files) {
  const midi = files.filter(isMidi);
  if (files.length === 1 && (!midi.length || !playlist.files.length)) {
    playlist.index = -1;
    renderPlaylist();
    return loadFile(files[0]);
  }
  if (midi.length < files.length) showError('Seuls les fichiers MIDI vont dans la playlist.');
  addToPlaylist(midi);
}

function addToPlaylist(files) {
  if (!files.length) return;
  const start = playlist.files.length;
  playlist.files.push(...files);
  renderPlaylist();
  // Rien de la playlist en cours : on charge le premier ajouté (prêt à jouer).
  if (playlist.index < 0) playFromPlaylist(start, false);
}

async function playFromPlaylist(i, autoplay = true) {
  const file = playlist.files[i];
  if (!file) return;
  playlist.index = i;
  renderPlaylist();
  player.stop();
  await loadFile(file);
  if (autoplay && ensemble) await player.play();
  updatePlayButton();
}

/** Morceau suivant (−1 en fin de playlist, sauf en boucle). */
function nextIndex(step = 1) {
  const n = playlist.files.length;
  if (playlist.index < 0 || !n) return -1;
  const i = playlist.index + step;
  if (i >= 0 && i < n) return i;
  return $('loop')?.checked ? (i + n) % n : -1;
}

function renderPlaylist() {
  const n = playlist.files.length;
  $('playlist').hidden = !n;
  $('playlistSummary').textContent = `Playlist (${n} morceau${n > 1 ? 'x' : ''})`;
  const list = $('playlistItems');
  list.innerHTML = '';
  playlist.files.forEach((file, i) => {
    const li = document.createElement('li');
    li.className = i === playlist.index ? 'current' : '';
    li.innerHTML = '<span class="name"></span><button class="remove" title="Retirer de la playlist">×</button>';
    li.querySelector('.name').textContent = file.name.replace(/\.midi?$/i, '');
    li.title = file.name;
    li.addEventListener('click', () => playFromPlaylist(i));
    li.querySelector('.remove').addEventListener('click', (e) => {
      e.stopPropagation();
      playlist.files.splice(i, 1);
      if (playlist.index > i) playlist.index--;
      else if (playlist.index === i) playlist.index = -1; // le morceau chargé reste à l'écran
      renderPlaylist();
    });
    list.appendChild(li);
  });
  $('prevSong').disabled = nextIndex(-1) < 0;
  $('nextSong').disabled = nextIndex(1) < 0;
}

$('addFiles').addEventListener('change', (e) => {
  addToPlaylist([...e.target.files].filter(isMidi));
  e.target.value = '';
});
$('prevSong').addEventListener('click', () => playFromPlaylist(nextIndex(-1)));
$('nextSong').addEventListener('click', () => playFromPlaylist(nextIndex(1)));
$('clearPlaylist').addEventListener('click', () => {
  playlist.files = [];
  playlist.index = -1;
  renderPlaylist();
});
$('loop')?.addEventListener('change', renderPlaylist);
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

// Lecture en boucle (réglage mémorisé).
try {
  $('loop').checked = localStorage.getItem('animusic.loop') === '1';
} catch {
  /* stockage indisponible */
}
$('loop').addEventListener('change', (e) => {
  try {
    localStorage.setItem('animusic.loop', e.target.checked ? '1' : '0');
  } catch {
    /* réglage non mémorisé */
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
  const files = [...e.dataTransfer.files];
  if (files.length) openFiles(files);
});

// Style de jeu : billes ou bras et mécanismes. La scène est reconstruite au changement.
try {
  $('style').value = localStorage.getItem('animusic.style') === 'arms' ? 'arms' : 'balls';
} catch {
  /* réglage non mémorisé */
}
$('style').addEventListener('change', (e) => {
  try {
    localStorage.setItem('animusic.style', e.target.value);
  } catch {
    /* réglage non mémorisé */
  }
  if (ensemble) rebuild();
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
// Lumière indirecte (SSGI) : coûteuse, donc débrayable ; elle n'agit qu'en qualité haute.
function setIndirectLight(on) {
  $('gi').checked = on;
  stage.setIndirectLight(on);
  try {
    localStorage.setItem('animusic.gi', on ? '1' : '0');
  } catch {
    /* réglage non mémorisé */
  }
}
$('gi').addEventListener('change', (e) => setIndirectLight(e.target.checked));
try {
  setIndirectLight(localStorage.getItem('animusic.gi') !== '0');
} catch {
  setIndirectLight(true);
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
  if (qualityMode !== 'auto' || !player.playing) {
    fpsMeter.playingSince = null;
    return;
  }
  // Les premières secondes de lecture ne comptent pas : chargement des sons,
  // premières compilations… un à-coup isolé ne doit pas dégrader toute la session.
  fpsMeter.playingSince ??= now;
  if (now - fpsMeter.playingSince < 3000) return;
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

// Avance de l'image : une image calculée maintenant n'apparaît à l'écran qu'au
// rafraîchissement suivant, au plus tôt. On la dessine donc en avance d'un intervalle
// d'image (mesuré, lissé) : sans cela elle retarde sur le son, d'autant plus que la
// cadence est basse (30 ms à 35 images/s). Pas pendant une vidéo : l'image y est captée
// à la source, comme le son.
const pacing = { last: 0, interval: 1 / 60 };
function displayLead(now) {
  const dt = (now - pacing.last) / 1000;
  pacing.last = now;
  if (dt > 0 && dt < 0.1) pacing.interval += (dt - pacing.interval) * 0.1;
  return player.playing && !recorder ? Math.min(0.05, pacing.interval) : 0;
}

function frame(now = performance.now()) {
  if (ensemble) {
    const t = player.currentTime() + displayLead(now);
    stage.update(t);
    if (camMode === 'director' && shotPlan) stage.setCamera(cameraAt(shotPlan, t));
    $('time').textContent = `${fmt(t)} / ${fmt(duration)}`;
    if (!seeking) $('seek').value = Math.max(0, t);
    // Fin de morceau dans une playlist : on enchaîne sur le suivant (pas pendant une vidéo).
    if (player.playing && t > duration + 0.5 && !recorder && nextIndex(1) >= 0) playFromPlaylist(nextIndex(1));
    else if (player.playing && t > duration + 0.5) {
      // Une vidéo s'arrête toujours à la fin du morceau, même en boucle.
      const again = $('loop').checked && !recorder;
      if (recorder) stopRecording();
      player.stop();
      if (again) player.play().then(updatePlayButton);
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
window.animusic = {
  stage,
  player,
  get recorder() {
    return recorder;
  },
  get ensemble() {
    return ensemble;
  },
  get shotPlan() {
    return shotPlan;
  },
  /** Recalcule les plans du réalisateur avec d'autres réglages (essais, captures). */
  replan(options) {
    shotPlan = planShots(ensemble, options);
    return shotPlan.shots.map(({ type, machine, start, end }) => ({ type, machine, start, end }));
  },
};
