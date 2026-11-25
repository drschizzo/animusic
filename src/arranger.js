// Arrangeur : choisit l'instrument virtuel de chaque piste, puis construit et
// dispose tous les instruments de la scène (module pur).

import { buildChoreography } from './choreography.js';
import { buildDrumKit } from './drums.js';
import { buildBassStrings } from './strings.js';
import { buildPipes } from './pipes.js';

export const ROLES = {
  balls: 'Billes',
  bass: 'Basse',
  pads: 'Orgue',
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

/** Rôle par défaut d'une piste, d'après son programme General MIDI puis ses statistiques. */
export function classifyTrack(track) {
  if (track.percussion) return 'drums';
  const p = track.program ?? -1;
  if (p >= 32 && p <= 39) return 'bass';
  if ((p >= 16 && p <= 23) || (p >= 48 && p <= 55) || (p >= 88 && p <= 95)) return 'pads';
  const s = trackStats(track.notes);
  if (s.meanPitch < 50 && s.polyphony < 1.4) return 'bass';
  if (s.meanDuration > 0.9 || (s.polyphony >= 2.5 && s.meanDuration > 0.5)) return 'pads';
  return 'balls';
}

const side = (angle, r) => [Math.sin(angle) * r, 0, -Math.cos(angle) * r];
/** Orientation (yaw) pour que l'instrument fasse face au point (0, 0, z) : le « public ». */
const facing = ([x, , z], audienceZ) => Math.atan2(-x, audienceZ - z);

/**
 * Construit tous les instruments.
 * @param parts { balls, bass, pads, drums } : notes {midi,time,duration,velocity,track} par rôle
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

  const start = instruments.length ? Math.min(...instruments.map((i) => i.start)) : 0;
  const end = instruments.length ? Math.max(...instruments.map((i) => i.end)) : 0;
  return { instruments, start, end, radius: R };
}
