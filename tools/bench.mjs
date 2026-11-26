// Banc d'essai : passe des fichiers MIDI dans toute la chaîne (lecture, arrangement,
// chorégraphie, plans caméra) puis simule 60 images/s sur tout le morceau en appelant
// les mêmes fonctions de pose que les vues. Vérifie l'absence de NaN et mesure les temps.
//
//   node tools/bench.mjs fichier1.mid [fichier2.mid ...]

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseMidi } from '../src/midi.js';
import { assignRoles, buildEnsemble, groupParts } from '../src/arranger.js';
import { windState } from '../src/winds.js';
import { planShots, cameraAt } from '../src/director.js';
import { activeBallRange, ballPosition, ballScale, launcherPose, barPulse } from '../src/choreography.js';
import { armAngles, hitPulse } from '../src/drums.js';
import { hammerAngle, bellState } from '../src/bells.js';
import { laserState } from '../src/laser.js';
import { bowPose, bowedString } from '../src/bowed.js';
import { keyDepth, keyHammerAngle, tineVibration } from '../src/keys.js';
import { carrierPose, stringVibration } from '../src/strings.js';
import { pipeState } from '../src/pipes.js';
import { analyzeSong, deployAt, sectionAt } from '../src/sections.js';

const finite = (...vals) => vals.flat(Infinity).every((v) => typeof v !== 'number' || Number.isFinite(v));

function frame(ens, plan, t, song) {
  let bad = 0;
  const check = (...v) => {
    if (!finite(...v)) bad++;
  };
  for (const inst of ens.instruments) {
    const m = inst.model;
    if (inst.kind === 'balls') {
      const [s, e] = activeBallRange(m, t);
      for (let i = s; i < e; i++) check(ballPosition(m, m.balls[i], t), ballScale(m.balls[i], t));
      for (const L of m.launchers) check(Object.values(launcherPose(m, L, t)));
      for (const b of m.bars) check(Object.values(barPulse(m, b, t)).filter((v) => v !== Infinity));
    } else if (inst.kind === 'drums') {
      for (const p of m.pieces) check(armAngles(m, p, t), hitPulse(m, p, t).pulse);
    } else if (inst.kind === 'winds') {
      for (const p of m.pipes) check(Object.values(windState(m, p, t)));
    } else if (inst.kind === 'bass' || inst.kind === 'plucked') {
      for (const s of m.strings) check(stringVibration(m, s, t).amp);
      for (const c of m.carriers) check(Object.values(carrierPose(m, c, t)));
    } else if (inst.kind === 'pads') {
      for (const p of m.pipes) check(Object.values(pipeState(m, p, t)));
    } else if (inst.kind === 'bells') {
      for (const b of m.bells) check(hammerAngle(m, b, t), bellState(m, b, t).angle, bellState(m, b, t).pulse);
    } else if (inst.kind === 'bowed') {
      for (const b of m.bows) check(Object.values(bowPose(m, b, t)));
      for (const s of m.strings) check(Object.values(bowedString(m, s, t)));
    } else if (inst.kind === 'laser') {
      for (const e of m.emitters) check(Object.values(laserState(m, e, t)));
    } else if (inst.kind === 'keys') {
      for (const k of m.played) check(keyDepth(m, k, t), keyHammerAngle(m, k, t), tineVibration(m, k, t).amp);
    }
  }
  const cam = cameraAt(plan, t);
  check(cam.position, cam.target);
  ens.instruments.forEach((_, k) => check(deployAt(song, k, t)));
  check(sectionAt(song, t).energy);
  return bad;
}

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  let t0 = performance.now();
  const song = parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), basename(file));
  const parseMs = performance.now() - t0;

  const assigned = assignRoles(song.tracks);
  const roles = song.tracks.map((tr, ti) => {
    tr.role = assigned[ti];
    return `${tr.name}[${tr.program}]→${tr.role}(${tr.notes.length})`;
  });
  const parts = groupParts(song.tracks);
  const controls = song.tracks.map((t) => ({ sustain: t.sustain, bends: t.bends, mod: t.mod }));

  t0 = performance.now();
  const ens = buildEnsemble(parts, controls, song.tracks.map((t) => t.program ?? -1));
  const buildMs = performance.now() - t0;
  t0 = performance.now();
  const plan = planShots(ens);
  const planMs = performance.now() - t0;
  const structure = analyzeSong(ens);

  let bad = 0;
  let worst = 0;
  let frames = 0;
  t0 = performance.now();
  for (let t = ens.start; t <= ens.end; t += 1 / 60) {
    const f0 = performance.now();
    bad += frame(ens, plan, t, structure);
    worst = Math.max(worst, performance.now() - f0);
    frames++;
  }
  const avg = (performance.now() - t0) / Math.max(1, frames);

  const kinds = ens.instruments.map((i) => {
    const m = i.model;
    const extra =
      i.kind === 'balls' ? ` ${m.bars.length} lames, rayon ${m.radius.toFixed(1)} m, ${m.maxConcurrent} billes max`
      : i.kind === 'drums' ? ` ${m.pieces.length} éléments`
      : i.kind === 'bass' || i.kind === 'plucked' ? ` ${m.strings.length} cordes, largeur ${m.width.toFixed(1)} m`
      : i.kind === 'winds' ? ` ${m.pipes.length} tuyaux (${m.style}), largeur ${m.width.toFixed(1)} m`
      : i.kind === 'bells' ? ` ${m.bells.length} cloches, largeur ${m.width.toFixed(1)} m`
      : i.kind === 'laser' ? ` ${m.emitters.length} rayons, largeur ${m.width.toFixed(1)} m`
      : i.kind === 'bowed' ? ` ${m.strings.length} cordes, ${m.bows.length} archets`
      : i.kind === 'keys' ? ` ${m.keys.length} touches, largeur ${m.width.toFixed(1)} m`
      : ` ${m.pipes.length} tubes, largeur ${m.width.toFixed(1)} m`;
    return `${i.kind}: ${i.onsets.length} notes,${extra}`;
  });

  console.log(`\n== ${basename(file)} (${(ens.end - ens.start).toFixed(0)} s)`);
  console.log(`  pistes : ${roles.join(' | ')}`);
  console.log(`  instruments : ${kinds.join(' ; ') || 'aucun'}`);
  console.log(`  ${plan.shots.length} plans caméra · sections : ${structure.sections.map((s) => s.start.toFixed(0)).join(", ")} s`);
  console.log(
    `  lecture ${parseMs.toFixed(1)} ms · arrangement ${buildMs.toFixed(1)} ms · plans ${planMs.toFixed(1)} ms · ` +
      `pose/image moy ${avg.toFixed(3)} ms, pire ${worst.toFixed(2)} ms · valeurs invalides : ${bad}`,
  );
}
