import * as THREE from 'three';
import './style.css';
import { ensembleSteps, assignRoles, groupParts, ROLES } from './arranger.js';
import { planShots, cameraAt } from './director.js';
import { parseMidi, demoSong } from './midi.js';
import { isAudioFile, importAudio } from './audioImport.js';
import { Player } from './audio.js';
import { Stage } from './scene.js';
import { sustainedEnd, sliced, breathe } from './util.js';
import { Loader } from './loader.js';
import { RAW, backendName, gpuRenderer } from './gpu.js';
import { GPUTierDetector } from './vendor/three-advanced-techniques/utils/GPUTierDetector.js';

// Import d'enregistrements (mp3, wav…) : désactivé pour l'instant (trop lent, résultat
// pas encore satisfaisant). Le code reste en place : passer à true pour le réactiver.
const AUDIO_IMPORT = false;
// Morceau de démonstration (servi depuis public/) ; la démo générée sert de secours.
const DEMO_URL = `${import.meta.env?.BASE_URL ?? './'}demo/chameleon.mid`;
const DEMO_NAME = 'Chameleon (Herbie Hancock)';

const PALETTE = ['#ff8a3d', '#3dc6ff', '#b56bff', '#5cff8f', '#ff5c8a', '#ffe14d', '#4dffe1', '#ff4d4d'];

const $ = (id) => document.getElementById(id);
const loader = new Loader();

/**
 * Habillage qui s'efface : pendant la lecture, titre et barre disparaissent quand la
 * souris ne bouge plus (sauf panneau ouvert ou souris sur la barre).
 */
const idle = {
  timer: 0,
  poke() {
    document.body.classList.remove('idle');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (player?.playing && !openSheet && !$('dock').matches(':hover')) document.body.classList.add('idle');
    }, 2800);
  },
};
let openSheet = null;
// L'écran de chargement d'abord : on laisse le navigateur l'afficher avant de créer le
// moteur de rendu (délai de secours : un onglet en arrière-plan ne dessine pas).
await new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
  setTimeout(resolve, 250);
});
const stage = new Stage($('stage'));
const player = new Player();
let song = null;
let ensemble = null;
let shotPlan = null;
let duration = 0;
// Scène en construction : ni rendu ni lecture tant qu'elle n'est pas complète.
let building = false;

function colorFor(i) {
  return new THREE.Color(PALETTE[i % PALETTE.length]);
}

/** Message passager en bas de l'écran ; `ms` : effacé après ce délai (0 : reste affiché). */
const toastTimers = new Map();
function toast(id, msg, ms = 0) {
  const el = $(id);
  clearTimeout(toastTimers.get(id));
  el.textContent = msg ?? '';
  el.hidden = !msg;
  if (msg && ms) toastTimers.set(id, setTimeout(() => (el.hidden = true), ms));
}

function showError(msg) {
  toast('error', msg, 8000);
}

/**
 * (Re)construit la scène à partir du rôle de chaque piste. La construction est longue :
 * elle se fait par tranches, derrière l'écran de chargement. Les demandes se suivent une
 * à une ; une demande dépassée par une plus récente est abandonnée.
 */
let buildQueue = Promise.resolve();
let buildCount = 0;
let pending = 0;
/**
 * Tout chargement passe par ici, l'un après l'autre, derrière l'écran de chargement :
 * construction d'un morceau, changement de qualité, lumière indirecte. L'écran ne
 * disparaît qu'une fois la file vide.
 */
function enqueue(job) {
  pending++;
  building = true; // dès maintenant : plus aucune image de la scène avant la fin
  buildQueue = buildQueue
    .then(job)
    .catch((err) => console.error(err))
    .finally(() => {
      if (--pending) return; // une demande arrivée entre-temps prend la suite : l'écran reste
      building = false;
      loader.hide();
      updatePlayButton();
    });
  return buildQueue;
}

function rebuild() {
  const n = ++buildCount;
  return enqueue(async () => {
    if (n === buildCount) await construct();
  });
}

/**
 * Réglage qui recompile les matières (qualité, lumière indirecte) : appliqué derrière
 * l'écran de chargement, puis rodé comme une construction, pour que la scène ne réapparaisse
 * qu'une fois prête. La lecture est suspendue le temps du chargement.
 */
function refresh(apply) {
  if (!ensemble && !pending) return apply(); // rien d'affiché : la prochaine construction rodera tout
  return enqueue(async () => {
    const resume = player.playing;
    if (resume) player.pause();
    updatePlayButton();
    await loader.show(undefined, 'quality');
    loader.progress(0.05, 'quality');
    apply();
    if (ensemble) await stage.warmUp((f, step) => loader.progress(0.05 + 0.95 * f, step === 'scène' ? 'quality' : step));
    // Reprise, sauf si un autre chargement suit (il décidera).
    if (resume && pending === 1) await player.play();
  });
}

async function construct() {
  // Une partie musicale = un instrument (voir groupParts).
  const parts = groupParts(song.tracks);
  player.stop();
  updatePlayButton();
  if (!parts.length) {
    showError('Aucune piste à jouer.');
    return;
  }
  showError('');
  await loader.show(song.name, 'model');
  loader.progress(0, 'model');
  try {
    await breathe();
    // Expression (pédale de sustain, pitch bend, modulation) de chaque piste.
    const controls = song.tracks.map((t) => ({ sustain: t.sustain, bends: t.bends, mod: t.mod }));
    const built = await sliced(ensembleSteps(parts, controls, song.tracks.map((t) => t.program ?? -1), { style: $('style').value }));
    loader.progress(0.15, 'machines');
    await stage.build(built, song.tracks.map((_, i) => colorFor(i)), (f, step) => loader.progress(0.15 + 0.85 * f, step));
    ensemble = built;
    shotPlan = planShots(ensemble);
    prepareSound(parts);
    const n = song.tracks.length;
    const m = ensemble.instruments.length;
    $('trackSummary').textContent = `${n} piste${n > 1 ? 's' : ''} · ${m} instrument${m > 1 ? 's' : ''}`;
    $('duration').textContent = fmt(duration);
  } catch (err) {
    console.error(err);
    ensemble = null;
    showError(`La scène n'a pas pu être construite : ${err.message}`);
  }
}

/** Notes et coups de batterie confiés au lecteur audio. */
function prepareSound(parts) {
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
}

/** Charge (en arrière-plan, une seule fois) le lecteur SoundFont. */
async function loadSounds() {
  if (!player.useSamples) return;
  if (!player.soundfont.ready) toast('sound', 'Chargement des sons (40 Mo la première fois)…');
  const ok = await player.prepareSounds();
  toast('sound', ok ? '' : 'Les sons réalistes n\u2019ont pas pu être chargés : synthèse utilisée.', 6000);
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
  return rebuild();
}

let importing = false;
async function loadFile(file) {
  if (importing) return;
  try {
    if (!AUDIO_IMPORT && isAudioFile(file)) {
      showError('L\u2019import d\u2019enregistrements audio est désactivé pour le moment : utilise un fichier MIDI.');
      return;
    }
    if (isAudioFile(file)) {
      // Enregistrement : transcription dans le navigateur (chargée à la demande).
      importing = true;
      player.stop();
      updatePlayButton();
      document.body.classList.add('busy');
      showError('');
      const song = await importAudio(file, (msg) => status(msg));
      const a = song.analysis;
      await loadSong(song);
      status(
        `Transcription : ${a.notes} notes${a.drumsAbsent ? ', pas de batterie détectée' : `, ${a.drums} coups de batterie`}. ` +
          'Rôles modifiables ci-dessus.',
      );
    } else {
      const buf = await file.arrayBuffer();
      await loadSong(parseMidi(buf, file.name.replace(/\.midi?$/i, '')));
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

let everPlayed = false;
function updatePlayButton() {
  const playing = player.playing;
  everPlayed ||= playing;
  $('play').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
  $('play').title = playing ? 'Pause (espace)' : 'Lecture (espace)';
  // Premier lancement : grand bouton au centre, tant que rien n'a été joué.
  $('bigPlay').hidden = playing || everPlayed || !ensemble || building;
  idle.poke();
}

$('file').addEventListener('change', (e) => {
  openFiles([...e.target.files]);
  e.target.value = '';
});
if (AUDIO_IMPORT) $('file').accept += ',audio/*,.mp3,.wav,.ogg,.flac,.m4a';

/** Charge le MIDI de démonstration ; à défaut (hors ligne…), la démo générée. */
let demoBuffer = null;
async function loadDemo() {
  try {
    if (!demoBuffer) {
      const res = await fetch(DEMO_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      demoBuffer = await res.arrayBuffer();
    }
    return await loadSong(parseMidi(demoBuffer, DEMO_NAME));
  } catch (err) {
    console.warn('Démo MIDI indisponible, démo générée à la place :', err);
    return loadSong(demoSong());
  }
}

$('demo').addEventListener('click', async () => {
  if (building) return;
  player.unlock(); // pendant le clic : la lecture démarrera une fois la scène construite
  showError('');
  playlist.index = -1;
  renderPlaylist();
  player.stop();
  updatePlayButton();
  await loadDemo();
  if (ensemble) await player.play();
  updatePlayButton();
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
  $('playlistSummary').textContent = `Playlist · ${n} morceau${n > 1 ? 'x' : ''}`;
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
  $('prevSong').hidden = $('nextSong').hidden = n < 2;
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
  if (!ensemble || building) return;
  if (player.playing) player.pause();
  else await player.play();
  updatePlayButton();
});
$('restart').addEventListener('click', async () => {
  if (!ensemble || building) return;
  player.stop();
  await player.play();
  updatePlayButton();
});
// Barre de lecture : pendant le glisser, c'est elle qui pilote le temps.
let seeking = false;
$('seek').addEventListener('pointerdown', () => (seeking = true));
window.addEventListener('pointerup', () => (seeking = false));
$('seek').addEventListener('input', (e) => {
  player.seek(Number(e.target.value));
  fillRange(e.target);
});
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
  // Un message de fin (« terminé », « enregistrée ») s'efface ; un état en cours reste.
  toast('exportStatus', msg, /en cours|%/.test(msg ?? '') ? 0 : 6000);
}
// Nom de fichier en ASCII : certains navigateurs ignorent les noms accentués.
const safeName = () =>
  (song?.name || 'animusic')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\- ]+/g, '_')
    .trim() || 'animusic';

async function startRecording() {
  if (building) return;
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
  $('record').textContent = 'Arrêter la vidéo';
  $('record').classList.add('recording');
  status('Enregistrement en cours : le morceau est rejoué en entier.');
}
function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  player.stopCapture();
  player.pause();
  updatePlayButton();
  $('record').textContent = 'Vidéo';
  $('record').classList.remove('recording');
}
$('record').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

// ---- Export glTF pour Blender (animation cuite, chargé à la demande) ----
$('exportGltf').addEventListener('click', async () => {
  if (!ensemble || recorder || building) return;
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


// Caméra : réalisateur automatique, orbite lente ou libre (souris).
let camMode = 'director';
function setCamMode(mode) {
  camMode = mode;
  $('camMode').value = mode;
  for (const b of document.querySelectorAll('[data-cam]')) b.setAttribute('aria-checked', String(b.dataset.cam === mode));
  stage.controls.autoRotate = mode === 'orbit';
  if (mode === 'orbit') stage.resetView();
}
$('camMode').addEventListener('change', (e) => setCamMode(e.target.value));
for (const b of document.querySelectorAll('[data-cam]')) b.addEventListener('click', () => setCamMode(b.dataset.cam));
// Dès que l'utilisateur manipule la vue, on lui laisse la main.
stage.controls.addEventListener('start', () => camMode === 'director' && setCamMode('free'));

// Réglage fin de la synchro image/son (ex. casque Bluetooth dont la latence est mal annoncée).
function setOffset(ms) {
  player.manualOffset = ms / 1000;
  $('offset').value = ms;
  $('offsetVal').textContent = `${ms} ms`;
  fillRange($('offset'));
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
  if (player.playing) $('latency').textContent = `Latence du son compensée : ${Math.round(player.compensation() * 1000)} ms.`;
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

// Qualité graphique. En mode auto, on part du niveau que permet le processeur graphique
// (lu sur l'adaptateur WebGPU, quelques ms, sans mesure) et on descend d'un cran si
// l'animation tombe durablement sous ~40 images/s pendant la lecture.
const LEVELS = ['high', 'medium', 'low'];
let qualityMode = 'auto';
const autoStart = await startingQuality();
async function startingQuality() {
  try {
    const found = await new GPUTierDetector(['low', 'medium', 'high']).detect(gpuRenderer);
    // Sans WebGPU, rien à lire : le moteur WebGL part de « haute » comme avant.
    if (!found.signals.webgpu) return 'high';
    if (found.tier !== 'high') console.info(`Qualité de départ : ${found.tier} (${found.deviceClass})`, found.reasons);
    return found.tier;
  } catch {
    return 'high';
  }
}
function setQuality(mode) {
  qualityMode = mode;
  $('quality').value = mode;
  const level = mode === 'auto' ? autoStart : mode;
  if (level !== stage.quality) refresh(() => stage.setQuality(level));
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
let indirectLight = null;
function setIndirectLight(on) {
  $('gi').checked = on;
  // Sans effet hors qualité haute : rien à recompiler, la valeur est retenue pour plus tard.
  if (on !== indirectLight) {
    const changed = indirectLight !== null;
    indirectLight = on;
    if (changed && stage.quality === 'high') refresh(() => stage.setIndirectLight(on));
    else stage.setIndirectLight(on);
  }
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
const fpsMeter = { frames: 0, since: performance.now(), slow: 0, cpu: 0 };
function measureFps() {
  fpsMeter.frames++;
  const now = performance.now();
  if (now - fpsMeter.since < 1000) return;
  const fps = (fpsMeter.frames * 1000) / (now - fpsMeter.since);
  const cpu = fpsMeter.cpu / fpsMeter.frames; // temps processeur moyen de stage.render() (ms)
  fpsMeter.frames = 0;
  fpsMeter.since = now;
  // Moteur utilisé (gpu.js) et temps processeur de rendu par image.
  if (!$('settingsSheet').hidden) {
    const names = { high: 'haute', medium: 'moyenne', low: 'basse' };
    $('fps').textContent = `${Math.round(fps)} img/s · ${cpu.toFixed(1)} ms · ${backendName(stage.renderer)} · qualité ${names[stage.quality] ?? stage.quality}`;
  }
  fpsMeter.cpu = 0;
  // Scène brute (?raw) : pas de baisse automatique de qualité, elle fausserait la comparaison.
  if (qualityMode !== 'auto' || !player.playing || RAW) {
    fpsMeter.playingSince = null;
    return;
  }
  // Les premières secondes de lecture ne comptent pas : chargement des sons,
  // premières compilations… un à-coup isolé ne doit pas dégrader toute la session.
  fpsMeter.playingSince ??= now;
  if (now - fpsMeter.playingSince < 3000) return;
  fpsMeter.slow = fps < 40 ? fpsMeter.slow + 1 : 0;
  const i = LEVELS.indexOf(stage.quality);
  if (fpsMeter.slow >= 3 && i < LEVELS.length - 1 && !building) {
    const next = LEVELS[i + 1];
    refresh(() => stage.setQuality(next));
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

const frameState = { second: -1 };
function frame(now = performance.now()) {
  requestAnimationFrame(frame);
  // Scène en construction : c'est elle qui tient le moteur de rendu.
  if (building) return;
  if (ensemble) {
    const t = player.currentTime() + displayLead(now);
    stage.update(t);
    if (camMode === 'director' && shotPlan) stage.setCamera(cameraAt(shotPlan, t));
    const shown = Math.floor(Math.max(0, t));
    if (shown !== frameState.second) {
      frameState.second = shown;
      $('time').textContent = fmt(t);
    }
    if (!seeking) {
      $('seek').value = Math.max(0, t);
      fillRange($('seek'));
    }
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
  const before = performance.now();
  stage.render();
  fpsMeter.cpu += performance.now() - before;
  measureFps();
}

// ---- Habillage : panneaux, masquage automatique, raccourcis ----

/** Partie parcourue d'un curseur (dégradé de la piste, voir style.css). */
function fillRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min || 1)) * 100}%`);
}

/** Ouvre un panneau (un seul à la fois) ; `id` nul ou déjà ouvert : ferme. */
function toggleSheet(id) {
  const next = id && id !== openSheet ? id : null;
  if (openSheet) {
    $(openSheet).hidden = true;
    document.querySelector(`[data-sheet="${openSheet}"]`)?.classList.remove('on');
  }
  openSheet = next;
  if (next) {
    $(next).hidden = false;
    document.querySelector(`[data-sheet="${next}"]`)?.classList.add('on');
  }
  idle.poke();
}
for (const b of document.querySelectorAll('[data-sheet]')) b.addEventListener('click', () => toggleSheet(b.dataset.sheet));
for (const b of document.querySelectorAll('.sheet .close')) b.addEventListener('click', () => toggleSheet(null));
// Un clic hors du panneau le ferme ; sur la scène, il ne prend pas la caméra pour autant.
window.addEventListener(
  'pointerdown',
  (e) => {
    if (!openSheet || e.target.closest('.sheet, [data-sheet]')) return;
    toggleSheet(null);
    if (e.target.closest('#stage')) e.stopPropagation();
  },
  true,
);
// Choisir un morceau referme le panneau : l'écran de chargement prend le relais.
for (const id of ['demo', 'file', 'addFiles']) $(id).addEventListener(id === 'demo' ? 'click' : 'change', () => toggleSheet(null));
$('playlistItems').addEventListener('click', (e) => e.target.closest('.remove') || toggleSheet(null));

$('bigPlay').addEventListener('click', () => $('play').click());

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$('fullscreen').addEventListener('click', toggleFullscreen);

for (const type of ['pointermove', 'pointerdown', 'wheel']) window.addEventListener(type, () => idle.poke(), { passive: true });
window.addEventListener('keydown', (e) => {
  idle.poke();
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const field = e.target.closest?.('input, select, textarea, button, label');
  if (e.key === 'Escape') toggleSheet(null);
  else if (e.key === ' ' && !field) {
    e.preventDefault();
    $('play').click();
  } else if ((e.key === 'f' || e.key === 'F') && !field) toggleFullscreen();
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !field && ensemble && !building) {
    const t = Math.min(duration, Math.max(0, player.currentTime() + (e.key === 'ArrowLeft' ? -5 : 5)));
    player.seek(t);
  }
});

loadDemo();
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
