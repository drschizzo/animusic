// Arrangeur : choisit l'instrument virtuel de chaque piste, puis construit et
// dispose tous les instruments de la scène (module pur).

import { buildChoreography } from './choreography.js';
import { buildDrumKit } from './drums.js';
import { buildBassStrings } from './strings.js';
import { buildPipes } from './pipes.js';
import { buildBells } from './bells.js';
import { buildLaserHarp } from './laser.js';
import { buildKeyboard } from './keys.js';

export const ROLES = {
  balls: 'Billes',
  bass: 'Basse',
  pads: 'Orgue',
  bells: 'Carillon',
  laser: 'Harpe laser',
  keys: 'Clavier',
  drums: 'Batterie',
  off: 'Masquée',
};

/** Statistiques simples d'une piste : hauteur moyenne, durée moyenne, polyphonie moyenne. */
export function trackStats(notes) {
  if (!notes.length) return { meanPitch: 0, meanDuration: 0, polyphony: 0 };
  let pitch = 0;
  let dur = 0;
  for (const n of notes) {
    pitch += n.midi;
    dur += n.duration;
  }
  // Polyphonie : nombre moyen de notes tenues au moment de chaque attaque.
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  let poly = 0;
  let j = 0;
  const active = [];
  for (const n of sorted) {
    active.push(n.time + n.duration);
    for (let k = active.length - 1; k >= 0; k--) if (active[k] <= n.time) active.splice(k, 1);
    poly += active.length;
    j++;
  }
  return { meanPitch: pitch / notes.length, meanDuration: dur / notes.length, polyphony: poly / j };
}

const PAD_PROGRAMS = (p) => (p >= 16 && p <= 23) || (p >= 48 && p <= 55) || (p >= 88 && p <= 95);
const BASS_PROGRAMS = (p) => p >= 32 && p <= 39;
const LOW_STRINGS = (p) => p === 42 || p === 43; // violoncelle, contrebasse
// Célesta, glockenspiel, boîte à musique, vibraphone, cloches tubulaires, kalimba, clochettes…
const BELL_PROGRAMS = (p) => (p >= 8 && p <= 11) || p === 14 || p === 98 || p === 108 || p === 112;
// Violon, alto, cuivres, anches, flûtes, leads de synthé, cornemuse, violon folk, shehnai.
const LEAD_PROGRAMS = (p) => p === 40 || p === 41 || (p >= 56 && p <= 87) || (p >= 109 && p <= 111);
const KEYBOARD_PROGRAMS = (p) => p >= 0 && p <= 7;

/**
 * Rôle par défaut d'une piste prise isolément : le programme General MIDI sert
 * d'indice, les statistiques des notes tranchent (un « ensemble de cordes » qui
 * joue des notes courtes ira aux billes, pas à l'orgue).
 */
export function classifyTrack(track) {
  if (track.percussion) return 'drums';
  const p = track.program ?? -1;
  const s = trackStats(track.notes);
  if (BASS_PROGRAMS(p)) return 'bass';
  if (LOW_STRINGS(p) && s.meanPitch < 55 && s.polyphony < 1.6) return 'bass';
  if (PAD_PROGRAMS(p) && s.meanDuration > 0.4) return 'pads';
  if (BELL_PROGRAMS(p)) return 'bells';
  if (s.meanPitch < 50 && s.polyphony < 1.4) return 'bass';
  // Ligne soliste tenue : un rayon par note.
  if (LEAD_PROGRAMS(p) && s.polyphony < 1.6 && s.meanDuration > 0.16) return 'laser';
  if (s.meanDuration > 0.9 || (s.polyphony >= 2.5 && s.meanDuration > 0.5)) return 'pads';
  if (KEYBOARD_PROGRAMS(p)) return 'keys';
  return 'balls';
}

/**
 * Rôles de toutes les pistes d'un morceau : classification individuelle, puis
 * passe globale. S'il n'y a pas de basse, la piste mélodique nettement plus grave
 * que les autres (voix de basse d'un choral, violoncelle d'un quatuor) le devient.
 */
export function assignRoles(tracks) {
  const roles = tracks.map(classifyTrack);
  if (!roles.includes('bass')) {
    const melodic = tracks
      .map((t, i) => ({ i, s: trackStats(t.notes) }))
      .filter(({ i }) => roles[i] !== 'drums')
      .sort((a, b) => a.s.meanPitch - b.s.meanPitch);
    if (melodic.length >= 2) {
      const [low, next] = melodic;
      if (low.s.meanPitch < 58 && next.s.meanPitch - low.s.meanPitch >= 6 && low.s.polyphony < 1.6) roles[low.i] = 'bass';
    }
  }
  // Les billes sont l'instrument vedette : s'il n'y en a pas, la piste de clavier
  // (ou à défaut de carillon) la plus fournie leur est confiée.
  if (!roles.includes('balls')) {
    for (const from of ['keys', 'bells']) {
      const candidates = tracks.map((t, i) => ({ i, n: t.notes.length })).filter(({ i }) => roles[i] === from);
      if (!candidates.length) continue;
      roles[candidates.sort((a, b) => b.n - a.n)[0].i] = 'balls';
      break;
    }
  }
  return roles;
}

const side = (angle, r) => [Math.sin(angle) * r, 0, -Math.cos(angle) * r];
/** Orientation (yaw) pour que l'instrument fasse face au point (0, 0, z) : le « public ». */
const facing = ([x, , z], audienceZ) => Math.atan2(-x, audienceZ - z);

/**
 * Construit tous les instruments.
 * @param parts { balls, bass, pads, drums, bells, laser, keys } : notes {midi,time,duration,velocity,track} par rôle
 * @returns { instruments: [{kind, model, onsets, focus:{center,radius}, start, end}], start, end, radius }
 */
export function buildEnsemble(parts) {
  const instruments = [];
  const balls = buildChoreography(parts.balls ?? []);
  const R = balls.radius;

  if (balls.balls.length) {
    instruments.push({
      kind: 'balls',
      model: balls,
      onsets: balls.balls.map((b) => b.impact),
      focus: { center: [0, 1.4, -R * 0.7], radius: R * 0.75 },
      front: 0,
      start: balls.start,
      end: balls.duration,
    });
  }

  if (parts.drums?.length) {
    const kit = buildDrumKit(parts.drums, { center: [0, 0, -(R * 0.5 + 0.4)] });
    const times = kit.pieces.flatMap((p) => p.hits.map((h) => h.time)).sort((a, b) => a - b);
    instruments.push({
      kind: 'drums',
      model: kit,
      onsets: times,
      focus: { center: [0, 1.0, kit.center[2]], radius: 2.6 },
      front: 0,
      // Les canons sont devant la batterie : on la filme en plongée, par-dessus.
      camera: { distScale: 1.25, minHeight: 3.3, allowLow: false },
      start: times[0] - kit.options.strikeTime,
      end: times[times.length - 1] + 1.5,
    });
  }

  // Basse à gauche, orgue à droite, en avant de l'arc et tournés vers le public.
  const sideAngle = (115 * Math.PI) / 180;
  const audienceZ = R * 1.2;
  if (parts.bass?.length) {
    const origin = side(-sideAngle, R * 0.8);
    const model = buildBassStrings(parts.bass, { origin, yaw: facing(origin, audienceZ) });
    instruments.push({
      kind: 'bass',
      model,
      onsets: model.onsets,
      focus: { center: [origin[0], 1.6, origin[2]], radius: Math.max(2, model.width * 0.6) },
      front: model.yaw,
      start: model.onsets[0] - 0.3,
      end: Math.max(...parts.bass.map((n) => n.time + n.duration)) + 1,
    });
  }
  if (parts.pads?.length) {
    const origin = side(sideAngle, R * 0.8);
    const model = buildPipes(parts.pads, { origin, yaw: facing(origin, audienceZ) });
    instruments.push({
      kind: 'pads',
      model,
      onsets: model.onsets,
      focus: { center: [origin[0], 1.6, origin[2]], radius: Math.max(2, model.width * 0.6) },
      front: model.yaw,
      start: model.onsets[0] - model.options.anticipation,
      end: Math.max(...parts.pads.map((n) => n.time + n.duration)) + model.options.release,
    });
  }

  // Carillon et harpe laser sur des estrades derrière l'arc de lames, filmés par-dessus.
  const backAngle = (27 * Math.PI) / 180;
  const riser = 0.7;
  const back = (angle) => {
    const [x, , z] = side(angle, R + 3.1);
    return [x, riser, z];
  };
  if (parts.bells?.length) {
    const origin = back(parts.laser?.length ? -backAngle : 0);
    const model = buildBells(parts.bells, { origin, yaw: facing(origin, 0) });
    instruments.push({
      kind: 'bells',
      model,
      onsets: model.onsets,
      focus: { center: [origin[0], riser + 2.3, origin[2]], radius: Math.max(2.4, model.width * 0.6) },
      front: model.yaw,
      camera: { distScale: 1.5, minHeight: 0.6, allowLow: false },
      start: model.onsets[0] - model.options.strikeTime * 2,
      end: model.onsets[model.onsets.length - 1] + 3,
    });
  }
  if (parts.laser?.length) {
    const origin = back(parts.bells?.length ? backAngle : 0);
    const model = buildLaserHarp(parts.laser, { origin, yaw: facing(origin, 0) });
    instruments.push({
      kind: 'laser',
      model,
      onsets: model.onsets,
      focus: { center: [origin[0], riser + 1.9, origin[2]], radius: Math.max(2.4, model.width * 0.6) },
      front: model.yaw,
      camera: { distScale: 1.5, minHeight: 0.6, allowLow: false },
      start: model.onsets[0] - model.options.anticipation,
      end: Math.max(...parts.laser.map((n) => n.time + n.duration)) + model.options.release,
    });
  }
  // Clavier au premier plan, vu du côté du pianiste.
  if (parts.keys?.length) {
    const origin = [0, 0, R * 0.42];
    const model = buildKeyboard(parts.keys, { origin, yaw: 0 });
    instruments.push({
      kind: 'keys',
      model,
      onsets: model.onsets,
      focus: { center: [origin[0], 1.1, origin[2]], radius: Math.max(1.8, model.width * 0.5) },
      front: 0,
      camera: { distScale: 1.2, minHeight: 2.2, allowLow: false },
      start: model.onsets[0] - model.options.strikeTime * 2,
      end: Math.max(...parts.keys.map((n) => n.time + n.duration)) + 1,
    });
  }

  const start = instruments.length ? Math.min(...instruments.map((i) => i.start)) : 0;
  const end = instruments.length ? Math.max(...instruments.map((i) => i.end)) : 0;
  return { instruments, start, end, radius: R, riser };
}
