// Arrangeur : choisit l'instrument virtuel de chaque piste, puis construit et
// dispose tous les instruments de la scène (module pur).
//
// Principe : une partie musicale = un instrument visible, dont le mécanisme correspond
// au timbre (on frappe une marimba, on pince une guitare, on frotte un violon, on souffle
// dans un cor). Deux pistes ne partagent un instrument que si elles sont le même
// instrument (pistes doublées) ou si la scène serait trop chargée.

import { buildChoreography } from './choreography.js';
import { buildDrumKit } from './drums.js';
import { planPasses } from './passes.js';
import { buildBassStrings } from './strings.js';
import { buildPipes } from './pipes.js';
import { buildBells } from './bells.js';
import { buildLaserHarp } from './laser.js';
import { buildKeyboard } from './keys.js';
import { buildBowed } from './bowed.js';
import { buildWinds, windStyle } from './winds.js';
import { mergeEvents, clamp } from './util.js';
import { mergeSpans } from './sections.js';
import { GM_ATTACK } from './gmAttack.js';

export const ROLES = {
  balls: 'Billes (marimba)',
  bells: 'Carillon',
  keys: 'Clavier',
  plucked: 'Cordes pincées',
  bass: 'Basse',
  bowed: 'Cordes frottées',
  winds: 'Vents',
  pads: 'Orgue',
  laser: 'Harpe laser',
  drums: 'Batterie',
  sound: 'Son seul (sans instrument)',
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

/**
 * Famille de timbre d'un programme General MIDI : le mécanisme qui produit le son.
 * Renvoie null si le programme est inconnu (import audio) : les statistiques décident.
 */
export function familyOf(p) {
  if (p < 0 || p > 127 || !Number.isFinite(p)) return null;
  if (p <= 7) return 'keys'; // pianos, clavecin, clavinet
  if (p <= 15) return p === 12 || p === 13 || p === 15 ? 'balls' : 'bells'; // marimba, xylophone, tympanon | célesta, glockenspiel, vibraphone, cloches
  if (p <= 23) return 'pads'; // orgues, accordéons
  if (p <= 31) return 'plucked'; // guitares
  if (p <= 39) return 'bass';
  if (p <= 44) return 'bowed'; // violon, alto, violoncelle, contrebasse, trémolo
  if (p <= 46) return 'plucked'; // pizzicato, harpe
  if (p === 47) return 'balls'; // timbales
  if (p <= 51) return 'bowed'; // ensembles de cordes (tranché par la polyphonie)
  if (p <= 55) return 'pads'; // chœurs
  if (p <= 79) return 'winds'; // cuivres, anches, flûtes
  if (p <= 87) return 'laser'; // leads de synthé : un son électronique, un rayon
  if (p <= 95) return 'pads'; // nappes de synthé
  if (p <= 103) return p === 98 ? 'bells' : 'pads'; // effets
  if (p <= 107) return 'plucked'; // sitar, banjo, shamisen, koto
  if (p === 108) return 'bells'; // kalimba
  if (p === 110) return 'bowed'; // violon folk
  if (p <= 111) return 'winds'; // cornemuse, shehnai
  if (p === 112) return 'bells';
  return 'balls'; // percussions accordées, effets sonores
}

/**
 * Rôle par défaut d'une piste prise isolément : la famille du programme General MIDI
 * décide du mécanisme ; les statistiques des notes corrigent (une ligne grave et
 * monodique va à la basse, un ensemble de cordes en accords tenus à l'orgue).
 */
export function classifyTrack(track) {
  if (track.percussion) return 'drums';
  const p = track.program ?? -1;
  const s = trackStats(track.notes);
  const family = familyOf(p);
  const held = s.meanDuration > 0.9 || (s.polyphony >= 2.5 && s.meanDuration > 0.5);
  const lowLine = s.meanPitch < 50 && s.polyphony < 1.4;
  if (family === 'bass') return 'bass';
  if ((p === 42 || p === 43) && s.meanPitch < 55 && s.polyphony < 1.6) return 'bass';
  if (family === 'bowed') {
    if (p >= 48 && (s.polyphony >= 1.5 || held)) return 'pads'; // pupitre de cordes en accords
    return s.meanDuration > 0.18 ? 'bowed' : 'plucked'; // staccato : pincé
  }
  if (family === 'winds' || family === 'laser') return family;
  if (lowLine && family !== 'pads') return 'bass';
  if (family) return family;
  // Programme inconnu : d'après les notes.
  if (held) return 'pads';
  return 'balls';
}

/** Valeur d'un contrôleur à l'instant t (événements triés), ou `def` avant le premier. */
function ccAt(events, t, def) {
  let v = def;
  for (const e of events) {
    if (e.time > t + 1e-6) break;
    v = e.value;
  }
  return v;
}

const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/**
 * Niveau sonore estimé d'une piste (dB, 0 = tout au maximum) : volume (CC7) et
 * expression (CC11) du fichier, vélocité, et part de l'attaque de l'instrument que
 * la note a le temps de jouer (des cordes qui mettent 0,3 s à s'établir ne font
 * qu'un souffle sur une note de 0,08 s). Moyenne en énergie sur les notes.
 */
export function trackLevel(track) {
  if (!track.notes?.length) return -Infinity;
  const ccs = track.ccs ?? [];
  const vol = ccs.filter((e) => e.number === 7);
  const expr = ccs.filter((e) => e.number === 11);
  const attack = track.percussion ? 0 : (GM_ATTACK[track.program] ?? 0);
  let energy = 0;
  for (const n of track.notes) {
    // Gains MIDI en loi carrée (convention General MIDI) : 40·log10(v/127).
    const gain = (ccAt(vol, n.time, 100) / 127) ** 2 * (ccAt(expr, n.time, 127) / 127) ** 2 * (n.velocity ?? 0.8) ** 2;
    const reached = attack > 0 ? Math.min(1, n.duration / attack) : 1;
    energy += (gain * reached) ** 2;
  }
  return dB(Math.sqrt(energy / track.notes.length));
}

/**
 * Pistes qui ne méritent pas d'instrument à l'écran parce qu'on ne les entend pas :
 * quasi muettes (plus de 30 dB sous la piste la plus forte), ou doublure couverte
 * (la plupart de leurs notes sont jouées en même temps, à la même hauteur, par une
 * piste plus forte d’au moins 10 dB). La batterie n'est jamais concernée.
 */
export function hiddenTracks(tracks) {
  const levels = tracks.map((t) => (t.percussion ? -Infinity : trackLevel(t)));
  const loudest = Math.max(...levels);
  if (!Number.isFinite(loudest)) return [];
  // Index par hauteur des instants d'attaque de chaque piste.
  const onsets = tracks.map((t) => {
    const m = new Map();
    for (const n of t.notes ?? []) (m.get(n.midi) ?? m.set(n.midi, []).get(n.midi)).push(n.time);
    for (const list of m.values()) list.sort((a, b) => a - b);
    return m;
  });
  const near = (list, t) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < t - 0.05) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo] <= t + 0.05;
  };
  const hidden = [];
  tracks.forEach((t, i) => {
    if (t.percussion || !t.notes?.length) return;
    if (levels[i] < loudest - 30) return hidden.push(i);
    const masked = tracks.some((u, j) => {
      if (j === i || u.percussion || levels[j] < levels[i] + 10) return false;
      let shared = 0;
      for (const n of t.notes) if (near(onsets[j].get(n.midi) ?? [], n.time)) shared++;
      return shared >= 0.6 * t.notes.length;
    });
    if (masked) hidden.push(i);
  });
  return hidden;
}

/**
 * Rôles de toutes les pistes d'un morceau : classification individuelle, puis
 * passe globale. S'il n'y a pas de basse, la piste mélodique nettement plus grave
 * que les autres (voix de basse d'un choral, violoncelle d'un quatuor) le devient.
 */
export function assignRoles(tracks) {
  const roles = tracks.map(classifyTrack);
  // Une piste qu'on n'entend pas ne doit pas avoir d'instrument à l'écran : elle reste jouée.
  hiddenTracks(tracks).forEach((i) => (roles[i] = 'sound'));
  if (!roles.includes('bass')) {
    const melodic = tracks
      .map((t, i) => ({ i, s: trackStats(t.notes) }))
      .filter(({ i }) => roles[i] !== 'drums' && roles[i] !== 'sound')
      .sort((a, b) => a.s.meanPitch - b.s.meanPitch);
    if (melodic.length >= 2) {
      const [low, next] = melodic;
      if (low.s.meanPitch < 58 && next.s.meanPitch - low.s.meanPitch >= 6 && low.s.polyphony < 1.6) roles[low.i] = 'bass';
    }
  }
  // Les billes sont l'instrument vedette, le plus spectaculaire : elles doivent porter
  // une partie fournie, présente tout au long du morceau. Si aucune piste ne leur va
  // (ou si la leur est maigre), la meilleure partie frappée ou pincée (clavier,
  // carillon, cordes pincées : même attaque, même voix) leur est confiée.
  const span = tracks.flatMap((t) => t.notes.map((n) => n.time));
  const t0 = Math.min(...span);
  const t1 = Math.max(...span);
  const presence = (t) => {
    if (!t.notes.length) return 0;
    const windows = Math.max(1, Math.ceil((t1 - t0) / 8));
    const hit = new Set(t.notes.map((n) => Math.floor((n.time - t0) / 8)));
    const s = trackStats(t.notes);
    const pitches = new Set(t.notes.map((n) => n.midi)).size;
    // Nombre de notes, part du morceau couverte, mélodie (assez de hauteurs différentes :
    // une piste de caisse claire ne fait pas jouer un arc de lames), attaque nette, peu d'accords.
    return Math.sqrt(t.notes.length) * (hit.size / windows) * Math.min(1, pitches / 6) * (s.meanDuration < 0.7 ? 1 : 0.6) * (s.polyphony <= 2.5 ? 1 : 0.7);
  };
  const ballsScore = tracks.reduce((a, t, i) => a + (roles[i] === 'balls' ? presence(t) : 0), 0);
  // D'abord les familles frappées ou pincées (même attaque) ; à défaut, un riff de synthé
  // ou de vents en notes brèves (le son vient des échantillons du programme : il ne change pas).
  const pick = (families, ok = () => true) =>
    tracks
      .map((t, i) => ({ i, score: families.includes(roles[i]) && (!ballsScore || t.notes.length >= 24) && ok(t) ? presence(t) : 0 }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  let candidates = pick(['keys', 'bells', 'plucked']);
  if (!candidates.length) candidates = pick(['laser', 'winds'], (t) => trackStats(t.notes).meanDuration < 0.5);
  if (candidates.length && ballsScore < 0.6 * candidates[0].score) roles[candidates[0].i] = 'balls';
  return roles;
}

/** Intervalles d'activité d'une partie (notes avec durée), élargis de `before` / `after`. */
const spansOf = (notes, before, after) => mergeSpans(notes.map((n) => [n.time - before, n.time + n.duration + after]));
const tracksOf = (notes) => [...new Set((notes ?? []).map((n) => n.track))];
const lastEnd = (notes) => Math.max(...notes.map((n) => n.time + n.duration));
/** Ligne musicale d'une partie (pour le réalisateur) : notes triées, hauteur et force. */
const lineOf = (notes) => notes.map((n) => ({ time: n.time, midi: n.midi, velocity: n.velocity, duration: n.duration })).sort((a, b) => a.time - b.time);
/** Piste qui joue le plus de notes d'une partie : sa couleur identifie l'instrument. */
const mainTrack = (notes) => {
  const count = new Map();
  for (const n of notes) count.set(n.track, (count.get(n.track) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
};

/**
 * Regroupe les pistes en parties : une partie par piste, sauf la batterie (un seul kit)
 * et les billes (un seul arc de lames, chaque piste y garde sa couleur). Les pistes
 * doublées (même rôle, même programme) partagent leur instrument. Au-delà de
 * `maxParts`, les plus petites parties rejoignent la plus grosse de même type.
 * @param tracks pistes avec `role`, `program`, `notes`
 * @returns [{ kind, tracks: [indices], notes: [{…, track}] }]
 */
export function groupParts(tracks, { maxParts = 10 } = {}) {
  const parts = [];
  const byKey = new Map();
  tracks.forEach((t, i) => {
    const kind = t.role;
    if (!kind || kind === 'off' || kind === 'sound' || !t.notes?.length) return;
    const key = kind === 'drums' || kind === 'balls' ? kind : `${kind}:${t.program ?? -1}`;
    let part = byKey.get(key);
    if (!part) {
      part = { kind, tracks: [], notes: [] };
      byKey.set(key, part);
      parts.push(part);
    }
    part.tracks.push(i);
    part.notes.push(...t.notes.map((n) => ({ ...n, track: i })));
  });
  while (parts.length > maxParts) {
    const mergeable = parts.filter((p) => parts.some((q) => q !== p && q.kind === p.kind));
    if (!mergeable.length) break;
    const small = mergeable.sort((a, b) => a.notes.length - b.notes.length)[0];
    const into = parts.filter((q) => q !== small && q.kind === small.kind).sort((a, b) => b.notes.length - a.notes.length)[0];
    into.tracks.push(...small.tracks);
    into.notes.push(...small.notes);
    parts.splice(parts.indexOf(small), 1);
  }
  return parts;
}

/**
 * Fabriques d'instruments : modèle construit en coordonnées locales (le placement vient
 * ensuite), plus ce qu'il faut savoir pour le filmer et le placer.
 *   focusY : hauteur du centre d'intérêt au-dessus de son socle
 */
/** Avance (s) du geste sur la note : la vie d'une bille avant sa frappe, sinon celle du mécanisme. */
const leadOf = (model, fallback) => (model.row ? Math.max(fallback, model.row.before + 0.1) : fallback);

/**
 * Place d'un instrument joué par une rangée de billes : l'estrade doit couvrir la rampe
 * des buses, en avant de l'instrument (l'estrade est centrée, d'où le facteur 2).
 */
const rowSeat = (model, kind) =>
  model.row ? { seat: { depth: Math.max(SEATS[kind].depth, 2 * (model.row.extent.maxZ + 0.3)), height: Math.max(SEATS[kind].height, model.row.extent.top + 0.1) } } : {};

const FACTORIES = {
  bass: (notes, ctx) => {
    const model = buildBassStrings(notes, { player: ctx.style === 'balls' ? 'balls' : 'picks' });
    return { model, focusY: 1.6, ...rowSeat(model, 'bass'), busy: spansOf(notes, leadOf(model, 0.3), 1), start: model.onsets[0] - leadOf(model, 0.3), end: lastEnd(notes) + 1 };
  },
  plucked: (notes, ctx) => {
    // Guitare, shamisen, harpe : cordes plus courtes, autant de médiators que d'accords serrés.
    const carriers = clamp(Math.ceil(trackStats(notes).polyphony) + 1, 2, 4);
    const model = buildBassStrings(notes, { lenLow: 2.1, lenHigh: 0.9, spacing: 0.24, maxWidth: 4.2, bottom: 0.55, pickY: 0.9, carriers, player: ctx.style === 'balls' ? 'balls' : 'picks' });
    model.style = 'plucked';
    return { model, focusY: 1.3, ...rowSeat(model, 'plucked'), busy: spansOf(notes, leadOf(model, 0.3), 1), start: model.onsets[0] - leadOf(model, 0.3), end: lastEnd(notes) + 1 };
  },
  pads: (notes, ctx) => {
    const model = buildPipes(notes, { player: ctx.style === 'balls' ? 'balls' : 'valves' });
    const o = model.options;
    return { model, focusY: 1.6, ...rowSeat(model, 'pads'), busy: spansOf(notes, leadOf(model, o.anticipation), o.release), start: model.onsets[0] - leadOf(model, o.anticipation), end: lastEnd(notes) + o.release + (model.row ? 1 : 0) };
  },
  bells: (notes, ctx) => {
    const model = buildBells(notes, { player: ctx.style === 'balls' ? 'balls' : 'hammers' });
    const o = model.options;
    return {
      model,
      ...rowSeat(model, 'bells'),
      focusY: 2.3,
      camera: { distScale: 1.5, minHeight: 0.6, allowLow: false },
      busy: spansOf(notes, leadOf(model, 0.6), 3),
      start: model.onsets[0] - leadOf(model, o.strikeTime * 2),
      end: model.onsets[model.onsets.length - 1] + 3,
    };
  },
  bowed: (notes, ctx) => {
    const model = buildBowed(notes, { controls: ctx.controlsFor(['mod']) });
    const o = model.options;
    return {
      model,
      focusY: 1.7,
      camera: { distScale: 1.4, minHeight: 0.8, allowLow: false },
      busy: spansOf(notes, o.approach + 0.4, o.release + 0.5),
      start: model.onsets[0] - 1,
      end: lastEnd(notes) + 1,
    };
  },
  laser: (notes, ctx) => {
    const model = buildLaserHarp(notes, { controls: ctx.controlsFor(['bends', 'mod']), player: ctx.style === 'balls' ? 'balls' : 'iris' });
    const o = model.options;
    return {
      model,
      ...rowSeat(model, 'laser'),
      focusY: 1.9,
      camera: { distScale: 1.5, minHeight: 0.6, allowLow: false },
      busy: spansOf(notes, leadOf(model, o.anticipation), o.release),
      start: model.onsets[0] - leadOf(model, o.anticipation),
      end: lastEnd(notes) + o.release + (model.row ? 1 : 0),
    };
  },
  winds: (notes, ctx) => {
    const model = buildWinds(notes, { style: windStyle(ctx.program), controls: ctx.controlsFor(['mod']), player: ctx.style === 'balls' ? 'balls' : 'valves' });
    const o = model.options;
    return {
      model,
      ...rowSeat(model, 'winds'),
      focusY: 1.2,
      camera: { distScale: 1.4, minHeight: 0.7, allowLow: false },
      busy: spansOf(notes, leadOf(model, o.anticipation), o.release),
      start: model.onsets[0] - leadOf(model, o.anticipation),
      end: lastEnd(notes) + o.release + (model.row ? 1 : 0),
    };
  },
  keys: (notes, ctx) => {
    const sustain = mergeEvents(ctx.tracks.map((tr) => ctx.controls[tr]?.sustain));
    const model = buildKeyboard(notes, ctx.style === 'balls' ? { sustain, player: 'balls', press: 0.04 } : { sustain });
    return {
      model,
      ...rowSeat(model, 'keys'),
      focusY: 1.1,
      camera: { distScale: 1.2, minHeight: 2.2, allowLow: false },
      busy: spansOf(notes, leadOf(model, 0.4), 1),
      start: model.onsets[0] - leadOf(model, model.options.strikeTime * 2),
      end: lastEnd(notes) + 1,
    };
  },
};

const side = (angle, r) => [Math.sin(angle) * r, 0, -Math.cos(angle) * r];
/** Orientation (yaw) pour que l'instrument fasse face au point (0, 0, z) : le « public ». */
const facing = ([x, , z], audienceZ) => Math.atan2(-x, audienceZ - z);

/**
 * Places d'orchestre. La scène est un amphithéâtre de gradins derrière l'arc de lames,
 * tourné vers le public : chaque gradin est plus haut que le précédent, si bien que
 * chaque instrument se voit par-dessus ceux de devant.
 *   gradin 0 : les voix mélodiques basses (vents, cordes pincées, harpe laser, cordes frottées),
 *              la plus basse au centre pour dégager la vue sur la rythmique ;
 *   gradin 1 : la section rythmique au centre, batterie puis basse à côté ;
 *   gradin 2 : les instruments hauts du fond (orgue, carillon).
 * `side` : côté préféré (−1 jardin, à gauche vu du public ; +1 cour), comme dans un
 * orchestre où les violons sont à gauche. `height` et `depth` : encombrement approché
 * (vérifié par tools/collide.mjs), utile au réalisateur pour ne jamais traverser un instrument.
 */
export const SEATS = {
  winds: { tier: 0, order: 0, height: 1.9, depth: 2.5, extraW: 0.1 },
  plucked: { tier: 0, order: 1, side: 1, height: 3.0, depth: 2.0, extraW: 0.6 },
  laser: { tier: 0, order: 2, height: 4.0, depth: 3.4, extraW: 1.3 },
  bowed: { tier: 0, order: 3, side: -1, height: 4.0, depth: 3.8, extraW: 0 },
  drums: { tier: 1, order: 0, height: 2.9, depth: 4.4, width: 6.2 },
  bass: { tier: 1, order: 1, height: 3.8, depth: 2.0, extraW: 0.6 },
  pads: { tier: 2, order: 0, height: 3.9, depth: 1.0, extraW: 0.1 },
  bells: { tier: 2, order: 1, height: 4.2, depth: 2.4, extraW: 1.3 },
  keys: { tier: -1, order: 0, height: 2.4, depth: 2.1, extraW: 0.5 },
};

const RISER_PAD = 0.35; // débord de l'estrade autour de l'instrument
const AISLE = 0.7; // allée entre deux gradins (et entre l'arc de lames et le premier)
const SEAT_GAP = 0.8; // espace entre deux estrades voisines

/** Hauteur d'estrade de chaque gradin, demi-ouverture maximale. */
export const TIERS = [
  { riser: 0.45, maxA: (95 * Math.PI) / 180 },
  { riser: 1.35, maxA: (80 * Math.PI) / 180 },
  { riser: 2.25, maxA: (70 * Math.PI) / 180 },
  { riser: 3.1, maxA: (62 * Math.PI) / 180 },
];

/**
 * Remplit un gradin depuis le centre : le premier instrument au milieu, les suivants de
 * part et d'autre (du côté préféré s'il y a la place, sinon en alternance). Renvoie
 * ceux qui n'ont pas trouvé de place.
 */
function fillTier(items, r, maxA, place) {
  const left = [];
  let lo = 0;
  let hi = 0;
  let first = true;
  for (const it of items) {
    const w = (it.seatW + SEAT_GAP) / r; // angle occupé, marge comprise
    if (first) {
      if (w / 2 > maxA) {
        left.push(it);
        continue;
      }
      place(it, 0);
      lo = -w / 2;
      hi = w / 2;
      first = false;
      continue;
    }
    const canR = hi + w <= maxA;
    const canL = lo - w >= -maxA;
    const pref = it.side ?? 0;
    const right = pref > 0 ? canR : pref < 0 ? !canL && canR : canR && (!canL || hi <= -lo);
    if (right) {
      place(it, hi + w / 2);
      hi += w;
    } else if (canL) {
      place(it, lo - w / 2);
      lo -= w;
    } else left.push(it);
  }
  return left;
}

/**
 * Construit tous les instruments et les dispose sur scène.
 * @param parts tableau de parties { kind, tracks, notes } (voir groupParts), ou objet
 *   { kind: notes } (une partie par type, forme historique utilisée par les tests)
 * @param controls contrôleurs expressifs par piste : [{ sustain, bends, mod }] (voir midi.js)
 * @param programs programme General MIDI de chaque piste (choix du style des vents)
 * @param options style : 'arms' (bras et mécanismes) ou 'balls' (tout ce qui peut l'être est joué par des billes)
 * @returns { instruments: [{kind, model, tracks, onsets, busy, focus:{center,radius}, front, start, end}], start, end, radius }
 */
export function buildEnsemble(parts, controls = [], programs = [], { style = 'arms', passes: passOptions = {} } = {}) {
  const list = Array.isArray(parts)
    ? parts
    : Object.entries(parts)
        .filter(([, notes]) => notes?.length)
        .map(([kind, notes]) => ({ kind, notes, tracks: tracksOf(notes) }));
  const all = (kind) => list.filter((p) => p.kind === kind).flatMap((p) => p.notes);
  const instruments = [];

  // Billes : l'arc de lames au fond, la tourelle au centre.
  const balls = buildChoreography(all('balls'));
  const R = balls.radius;
  if (balls.balls.length) {
    instruments.push({
      kind: 'balls',
      model: balls,
      tracks: tracksOf(all('balls')),
      onsets: balls.impacts.map((i) => i.time),
      line: lineOf(all('balls')),
      busy: mergeSpans(balls.balls.map((b) => [b.launch - 0.6, b.end])),
      focus: { center: [0, 1.4, -R * 0.7], radius: R * 0.75 },
      front: 0,
      start: balls.start,
      end: balls.duration,
    });
  }

  // Les autres parties : une instance chacune. La batterie est construite à sa place.
  const drumNotes = all('drums');
  const others = list
    .filter((p) => FACTORIES[p.kind] && p.notes.length)
    .sort((a, b) => b.notes.length - a.notes.length)
    .map((p) => {
      const tracks = p.tracks ?? tracksOf(p.notes);
      const main = mainTrack(p.notes);
      const ctx = {
        style,
        tracks,
        controls,
        program: programs[main] ?? -1,
        controlsFor: (keys) => Object.fromEntries(tracks.map((tr) => [tr, Object.fromEntries(keys.map((k) => [k, controls[tr]?.[k]]))])),
      };
      const made = FACTORIES[p.kind](p.notes, ctx);
      return { kind: p.kind, tracks, mainTrack: main, ...made, width: made.model.width, onsets: made.model.onsets, n: p.notes.length, line: lineOf(p.notes) };
    });
  if (drumNotes.length) {
    const drums = { kind: 'drums', notes: drumNotes, width: SEATS.drums.width, n: drumNotes.length };
    if (style === 'balls') {
      // Les tuyaux débordent du kit : l'estrade se règle sur leur encombrement réel, et le
      // kit est décalé pour s'y trouver centré.
      const e = buildDrumKit(drumNotes, { player: 'balls' }).extent;
      drums.width = e.maxX - e.minX;
      drums.seat = { width: drums.width, depth: e.maxZ - e.minZ, height: e.top };
      drums.shift = [-(e.minX + e.maxX) / 2, -(e.minZ + e.maxZ) / 2];
    }
    others.unshift(drums);
  }

  // Placement par gradin. Chaque gradin commence juste derrière le précédent (ou derrière
  // la gouttière et les entonnoirs de l'arc de lames pour le premier) ; dans un gradin,
  // ordre de la table SEATS, puis le plus fourni d'abord.
  const seatOf = (it) => ({ ...SEATS[it.kind], ...(it.seat ?? {}) });
  for (const it of others) {
    const seat = seatOf(it);
    it.seatW = (seat.width ?? it.width + seat.extraW) + 2 * RISER_PAD;
    it.seatD = seat.depth + 2 * RISER_PAD;
  }
  let outer = R + balls.options.troughGap + 0.9; // bord extérieur des entonnoirs et de leurs pieds
  let pending = [];
  let lastTier = null;
  TIERS.forEach((tier, k) => {
    const items = [...pending, ...others.filter((it) => seatOf(it).tier === k)].sort(
      (a, b) => seatOf(a).tier - seatOf(b).tier || seatOf(a).order - seatOf(b).order || b.n - a.n,
    );
    if (!items.length) return;
    for (const it of items) it.side = seatOf(it).side;
    const r = outer + AISLE + Math.max(...items.map((it) => it.seatD)) / 2;
    const placed = [];
    pending = fillTier(items, r, tier.maxA, (it, angle) => {
      const [x, , z] = side(angle, r);
      it.origin = [x, 0, z];
      it.yaw = facing(it.origin, R * 0.8);
      it.riser = tier.riser;
      placed.push(it);
    });
    // Bord extérieur du gradin : coins arrière des estrades compris.
    outer = Math.max(outer, ...placed.map((it) => Math.hypot(r + it.seatD / 2, it.seatW / 2)));
    lastTier = tier;
  });
  // Dernier recours (ensemble démesuré) : derrière le dernier gradin.
  pending.forEach((it, k) => {
    const [x, , z] = side((k % 2 ? 1 : -1) * (0.3 + 0.25 * k), outer + AISLE + it.seatD / 2);
    it.origin = [x, 0, z];
    it.yaw = facing(it.origin, R * 0.8);
    it.riser = lastTier?.riser ?? 0;
  });
  // Claviers : rangée au premier plan, devant la tourelle, au sol.
  const front = others.filter((it) => seatOf(it).tier < 0);
  const totalFront = front.reduce((a, it) => a + it.width + 0.8, -0.8);
  let x = -totalFront / 2;
  for (const it of front) {
    it.origin = [x + it.width / 2, 0, R * 0.42];
    it.yaw = 0;
    it.riser = 0;
    x += it.width + 0.8;
  }

  for (const it of others) {
    const o = it.origin;
    const seat = seatOf(it);
    if (it.kind === 'drums') {
      // La batterie, face au public, au centre de son gradin.
      const [sx, sz] = it.shift ?? [0, 0];
      const kit = buildDrumKit(drumNotes, { center: [o[0] + sx, 0, o[2] + sz], player: style === 'balls' ? 'balls' : 'arms' });
      const times = kit.pieces.flatMap((p) => p.hits.map((h) => h.time)).sort((a, b) => a - b);
      Object.assign(it, {
        model: kit,
        tracks: tracksOf(drumNotes),
        mainTrack: mainTrack(drumNotes),
        onsets: times,
        busy: mergeSpans(times.map((t) => [t - kit.lead - 0.3, t + 1])),
        focusY: 1.0,
        yaw: 0,
        camera: { distScale: 1.25, minHeight: 1.2, allowLow: false },
        start: times[0] - kit.lead,
        end: times[times.length - 1] + 1.5,
      });
    } else {
      it.model.origin = o;
      it.model.yaw = it.yaw;
    }
    instruments.push({
      kind: it.kind,
      model: it.model,
      tracks: it.tracks,
      mainTrack: it.mainTrack,
      onsets: it.onsets,
      line: it.line ?? [],
      busy: it.busy,
      riser: it.riser,
      focus: { center: [o[0], it.riser + it.focusY, o[2]], radius: Math.max(2, it.width * 0.6) },
      footprint: { center: [o[0], o[2]], yaw: it.yaw, halfW: it.seatW / 2, halfD: it.seatD / 2, top: it.riser + seat.height },
      front: it.yaw,
      camera: it.camera,
      start: it.start,
      end: it.end,
    });
  }

  const start = instruments.length ? Math.min(...instruments.map((i) => i.start)) : 0;
  const end = instruments.length ? Math.max(...instruments.map((i) => i.end)) : 0;
  // Rayon de la scène : jusqu'au bord de l'instrument le plus éloigné.
  const stageRadius = Math.max(
    R + 6.2,
    ...instruments.filter((i) => i.footprint).map((i) => Math.hypot(...i.footprint.center) + Math.max(i.footprint.halfW, i.footprint.halfD) + 0.8),
  );
  const ensemble = { instruments, start, end, radius: R, stageRadius };
  // Échanges de billes entre instruments voisins (voir passes.js).
  if (style === 'balls') ensemble.passes = planPasses(ensemble, passOptions);
  return ensemble;
}
