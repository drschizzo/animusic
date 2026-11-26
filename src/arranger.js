// Arrangeur : choisit l'instrument virtuel de chaque piste, puis construit et
// dispose tous les instruments de la scène (module pur).
//
// Principe : une partie musicale = un instrument visible, dont le mécanisme correspond
// au timbre (on frappe une marimba, on pince une guitare, on frotte un violon, on souffle
// dans un cor). Deux pistes ne partagent un instrument que si elles sont le même
// instrument (pistes doublées) ou si la scène serait trop chargée.

import { buildChoreography } from './choreography.js';
import { buildDrumKit } from './drums.js';
import { buildBassStrings } from './strings.js';
import { buildPipes } from './pipes.js';
import { buildBells } from './bells.js';
import { buildLaserHarp } from './laser.js';
import { buildKeyboard } from './keys.js';
import { buildBowed } from './bowed.js';
import { buildWinds, windStyle } from './winds.js';
import { mergeEvents, clamp } from './util.js';
import { mergeSpans } from './sections.js';

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

/** Intervalles d'activité d'une partie (notes avec durée), élargis de `before` / `after`. */
const spansOf = (notes, before, after) => mergeSpans(notes.map((n) => [n.time - before, n.time + n.duration + after]));
const tracksOf = (notes) => [...new Set((notes ?? []).map((n) => n.track))];
const lastEnd = (notes) => Math.max(...notes.map((n) => n.time + n.duration));
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
    if (!kind || kind === 'off' || !t.notes?.length) return;
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
 *   ring : 'back' (derrière l'arc de lames, sur estrade si riser) ou 'side' (de part et d'autre)
 *   focusY : hauteur du centre d'intérêt au-dessus de son socle
 */
const FACTORIES = {
  bass: (notes) => {
    const model = buildBassStrings(notes);
    return { model, ring: 'side', focusY: 1.6, busy: spansOf(notes, 0.3, 1), start: model.onsets[0] - 0.3, end: lastEnd(notes) + 1 };
  },
  plucked: (notes, ctx) => {
    // Guitare, shamisen, harpe : cordes plus courtes, autant de médiators que d'accords serrés.
    const carriers = clamp(Math.ceil(trackStats(notes).polyphony) + 1, 2, 4);
    const model = buildBassStrings(notes, { lenLow: 2.1, lenHigh: 0.9, spacing: 0.24, maxWidth: 4.2, bottom: 0.55, pickY: 0.9, carriers });
    model.style = 'plucked';
    return { model, ring: ctx.preferBack ? 'back' : 'side', focusY: 1.3, busy: spansOf(notes, 0.3, 1), start: model.onsets[0] - 0.3, end: lastEnd(notes) + 1 };
  },
  pads: (notes) => {
    const model = buildPipes(notes);
    const o = model.options;
    return { model, ring: 'side', focusY: 1.6, busy: spansOf(notes, o.anticipation, o.release), start: model.onsets[0] - o.anticipation, end: lastEnd(notes) + o.release };
  },
  bells: (notes) => {
    const model = buildBells(notes);
    const o = model.options;
    return {
      model,
      ring: 'back',
      riser: true,
      focusY: 2.3,
      camera: { distScale: 1.5, minHeight: 0.6, allowLow: false },
      busy: spansOf(notes, 0.6, 3),
      start: model.onsets[0] - o.strikeTime * 2,
      end: model.onsets[model.onsets.length - 1] + 3,
    };
  },
  bowed: (notes, ctx) => {
    const model = buildBowed(notes, { controls: ctx.controlsFor(['mod']) });
    const o = model.options;
    return {
      model,
      ring: 'back',
      riser: true,
      focusY: 1.7,
      camera: { distScale: 1.4, minHeight: 0.8, allowLow: false },
      busy: spansOf(notes, o.approach + 0.4, o.release + 0.5),
      start: model.onsets[0] - 1,
      end: lastEnd(notes) + 1,
    };
  },
  laser: (notes, ctx) => {
    const model = buildLaserHarp(notes, { controls: ctx.controlsFor(['bends', 'mod']) });
    const o = model.options;
    return {
      model,
      ring: 'back',
      riser: true,
      focusY: 1.9,
      camera: { distScale: 1.5, minHeight: 0.6, allowLow: false },
      busy: spansOf(notes, o.anticipation, o.release),
      start: model.onsets[0] - o.anticipation,
      end: lastEnd(notes) + o.release,
    };
  },
  winds: (notes, ctx) => {
    const model = buildWinds(notes, { style: windStyle(ctx.program), controls: ctx.controlsFor(['mod']) });
    const o = model.options;
    return {
      model,
      ring: 'back',
      riser: true,
      focusY: 1.2,
      camera: { distScale: 1.4, minHeight: 0.7, allowLow: false },
      busy: spansOf(notes, o.anticipation, o.release),
      start: model.onsets[0] - o.anticipation,
      end: lastEnd(notes) + o.release,
    };
  },
  keys: (notes, ctx) => {
    const sustain = mergeEvents(ctx.tracks.map((tr) => ctx.controls[tr]?.sustain));
    const model = buildKeyboard(notes, { sustain });
    return {
      model,
      ring: 'front',
      focusY: 1.1,
      camera: { distScale: 1.2, minHeight: 2.2, allowLow: false },
      busy: spansOf(notes, 0.4, 1),
      start: model.onsets[0] - model.options.strikeTime * 2,
      end: lastEnd(notes) + 1,
    };
  },
};

const GAP = 1.6; // espace libre entre deux instruments voisins (m)
const side = (angle, r) => [Math.sin(angle) * r, 0, -Math.cos(angle) * r];
/** Orientation (yaw) pour que l'instrument fasse face au point (0, 0, z) : le « public ». */
const facing = ([x, , z], audienceZ) => Math.atan2(-x, audienceZ - z);

/**
 * Place des instruments sur un arc de rayon r : le premier au centre (angle `center`),
 * les suivants de part et d'autre en alternance, sans dépasser ±maxA. Renvoie ceux qui
 * n'ont pas trouvé de place.
 */
function fillArc(items, r, maxA, place) {
  const left = [];
  let lo = 0;
  let hi = 0;
  items.forEach((it, k) => {
    const w = (it.width + GAP) / r; // angle occupé, marge comprise
    if (k === 0) {
      if (w / 2 > maxA) return left.push(it);
      lo = -w / 2;
      hi = w / 2;
      return place(it, 0);
    }
    const right = hi + w <= maxA;
    const leftOk = lo - w >= -maxA;
    if (right && (!leftOk || hi <= -lo)) {
      place(it, hi + w / 2);
      hi += w;
    } else if (leftOk) {
      place(it, lo - w / 2);
      lo -= w;
    } else left.push(it);
  });
  return left;
}

/**
 * Construit tous les instruments et les dispose sur scène.
 * @param parts tableau de parties { kind, tracks, notes } (voir groupParts), ou objet
 *   { kind: notes } (une partie par type, forme historique utilisée par les tests)
 * @param controls contrôleurs expressifs par piste : [{ sustain, bends, mod }] (voir midi.js)
 * @param programs programme General MIDI de chaque piste (choix du style des vents)
 * @returns { instruments: [{kind, model, tracks, onsets, busy, focus:{center,radius}, front, start, end}], start, end, radius }
 */
export function buildEnsemble(parts, controls = [], programs = []) {
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
      busy: mergeSpans(balls.balls.map((b) => [b.launch - 0.6, b.end])),
      focus: { center: [0, 1.4, -R * 0.7], radius: R * 0.75 },
      front: 0,
      start: balls.start,
      end: balls.duration,
    });
  }

  // Batterie : au centre, entre la tourelle et l'arc.
  const drumNotes = all('drums');
  if (drumNotes.length) {
    const kit = buildDrumKit(drumNotes, { center: [0, 0, -(R * 0.5 + 0.4)] });
    const times = kit.pieces.flatMap((p) => p.hits.map((h) => h.time)).sort((a, b) => a - b);
    instruments.push({
      kind: 'drums',
      model: kit,
      tracks: tracksOf(drumNotes),
      mainTrack: mainTrack(drumNotes),
      onsets: times,
      busy: mergeSpans(times.map((t) => [t - kit.options.strikeTime - 0.3, t + 1])),
      focus: { center: [0, 1.0, kit.center[2]], radius: 2.6 },
      front: 0,
      // Les canons sont devant la batterie : on la filme en plongée, par-dessus.
      camera: { distScale: 1.25, minHeight: 3.3, allowLow: false },
      start: times[0] - kit.options.strikeTime,
      end: times[times.length - 1] + 1.5,
    });
  }

  // Les autres parties : une instance chacune, la plus fournie d'abord (meilleures places).
  const others = list
    .filter((p) => FACTORIES[p.kind] && p.notes.length)
    .sort((a, b) => b.notes.length - a.notes.length)
    .map((p) => {
      const tracks = p.tracks ?? tracksOf(p.notes);
      const main = mainTrack(p.notes);
      const ctx = {
        tracks,
        controls,
        program: programs[main] ?? -1,
        controlsFor: (keys) => Object.fromEntries(tracks.map((tr) => [tr, Object.fromEntries(keys.map((k) => [k, controls[tr]?.[k]]))])),
      };
      const made = FACTORIES[p.kind](p.notes, ctx);
      return { kind: p.kind, tracks, mainTrack: main, ...made, width: made.model.width, onsets: made.model.onsets };
    });

  // Placement : estrades derrière l'arc (instruments hauts ou solistes), côtés de la
  // scène (cordes pincées, basse, orgue), clavier au premier plan.
  const riser = 0.7;
  const backR = R + 3.1;
  const sideR = R * 0.85 + 0.4;
  const placed = [];
  const put = (it, angle, r, ring) => {
    const [x, , z] = side(angle, r);
    const y = ring === 'back' && it.riser ? riser : 0;
    const origin = [x, y, z];
    it.model.origin = origin;
    it.model.yaw = facing(origin, ring === 'back' ? 0 : R * 1.2);
    placed.push(it);
  };
  const back = others.filter((it) => it.ring === 'back');
  const sides = others.filter((it) => it.ring === 'side');
  const front = others.filter((it) => it.ring === 'front');
  const sideMin = (100 * Math.PI) / 180;
  const sideMax = (176 * Math.PI) / 180;
  // Côtés : on remplit à gauche et à droite en alternance, de l'avant-scène vers le public.
  const fillSides = (items) => {
    const used = [sideMin, sideMin];
    const left = [];
    for (const it of items) {
      const w = (it.width + GAP) / sideR;
      const k = used[0] <= used[1] ? 0 : 1;
      if (used[k] + w > sideMax) {
        left.push(it);
        continue;
      }
      put(it, (k === 0 ? -1 : 1) * (used[k] + w / 2), sideR, 'side');
      used[k] += w;
    }
    return left;
  };
  let overflow = fillArc(back, backR, (62 * Math.PI) / 180, (it, a) => put(it, a, backR, 'back'));
  overflow = fillSides([...sides, ...overflow]);
  // Dernier recours : un second rang, plus loin derrière.
  overflow = fillArc(overflow, backR + 4, (70 * Math.PI) / 180, (it, a) => put(it, a, backR + 4, 'back'));
  overflow.forEach((it, k) => put(it, (k % 2 ? 1 : -1) * (0.3 + 0.25 * k), backR + 8, 'back'));
  // Claviers : rangée au premier plan, centrée.
  const totalFront = front.reduce((a, it) => a + it.width + 0.8, -0.8);
  let x = -totalFront / 2;
  for (const it of front) {
    it.model.origin = [x + it.width / 2, 0, R * 0.42];
    it.model.yaw = 0;
    x += it.width + 0.8;
    placed.push(it);
  }

  for (const it of others) {
    const o = it.model.origin;
    instruments.push({
      kind: it.kind,
      model: it.model,
      tracks: it.tracks,
      mainTrack: it.mainTrack,
      onsets: it.onsets,
      busy: it.busy,
      focus: { center: [o[0], o[1] + it.focusY, o[2]], radius: Math.max(2, it.width * 0.6) },
      front: it.model.yaw,
      camera: it.camera,
      start: it.start,
      end: it.end,
    });
  }

  const start = instruments.length ? Math.min(...instruments.map((i) => i.start)) : 0;
  const end = instruments.length ? Math.max(...instruments.map((i) => i.end)) : 0;
  return { instruments, start, end, radius: R, riser };
}
