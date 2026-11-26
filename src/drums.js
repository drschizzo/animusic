// Batterie robotisée : module pur (sans Three.js), comme choreography.js.
//
// Chaque élément de batterie utilisé par le morceau reçoit un bras robotisé
// (ou une pédale pour la grosse caisse). La pose du bras est calculée à partir
// des frappes : levée d'anticipation avant le coup, contact pile à l'instant
// de la note, rebond, puis retour en position de repos.

export const DRUM_DEFAULTS = {
  restLift: 0.3, // hauteur de repos (0 = baguette au contact, 1 = levée maximale)
  strikeTime: 0.3, // durée maximale de la descente vers le coup
  reboundRate: 14,
  pulseDecay: 7,
  upperArm: 0.75,
  forearm: 0.85, // avant-bras + baguette
  shoulderAbove: 0.55, // hauteur de l'épaule au-dessus du point de frappe
  armReach: 1.15, // distance horizontale socle du bras → centre de l'élément
  upperLift: 0.35, // rotation (rad) de l'épaule à levée maximale
  forearmLift: 1.1, // rotation (rad) de l'avant-bras à levée maximale
  pedalLift: 0.9,
};

// Disposition (repère local du kit : +z vers la caméra). armDir = direction du socle du bras.
export const PIECES = {
  kick: { kind: 'kick', radius: 0.45, depth: 0.4, y: 0.45, pos: [0, -0.75] },
  snare: { kind: 'drum', radius: 0.3, depth: 0.16, y: 0.72, pos: [-0.85, 0.25], armDir: [-0.5, 0.87] },
  hihat: { kind: 'cymbal', radius: 0.32, y: 1.0, pos: [-1.65, -0.05], armDir: [-0.98, 0.2] },
  tomHigh: { kind: 'drum', radius: 0.24, depth: 0.22, y: 0.98, pos: [-0.45, -0.25], armDir: [-0.4, -0.92] },
  tomMid: { kind: 'drum', radius: 0.27, depth: 0.24, y: 1.0, pos: [0.4, -0.25], armDir: [0.4, -0.92] },
  tomLow: { kind: 'drum', radius: 0.36, depth: 0.4, y: 0.62, pos: [1.05, 0.3], armDir: [0.7, 0.7] },
  crash: { kind: 'cymbal', radius: 0.45, y: 1.65, pos: [-1.45, -1.0], armDir: [-0.6, -0.8] },
  ride: { kind: 'cymbal', radius: 0.52, y: 1.4, pos: [1.75, -0.35], armDir: [0.8, -0.6] },
  perc: { kind: 'block', radius: 0.18, depth: 0.12, y: 0.85, pos: [0, 0.75], armDir: [0, 1] },
};

/** Élément de batterie correspondant à une note General MIDI (canal 10). */
export function pieceForNote(midi) {
  if (midi === 35 || midi === 36) return 'kick';
  if (midi >= 37 && midi <= 40) return 'snare';
  if (midi === 42 || midi === 44 || midi === 46) return 'hihat';
  if (midi === 41 || midi === 43) return 'tomLow';
  if (midi === 45 || midi === 47) return 'tomMid';
  if (midi === 48 || midi === 50) return 'tomHigh';
  if (midi === 49 || midi === 52 || midi === 55 || midi === 57) return 'crash';
  if (midi === 51 || midi === 53 || midi === 59) return 'ride';
  return 'perc';
}

const norm2 = ([x, z]) => {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
};

function upperBound(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

import { springSum } from './util.js';

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * Bras à deux segments dans un plan vertical. Résolution IK (coude vers le haut)
 * pour que le bout de la baguette touche `target` en pose de frappe.
 */
function solveArm(shoulder, target, l1, l2) {
  const u = norm2([target[0] - shoulder[0], target[2] - shoulder[2]]);
  const dx = Math.hypot(target[0] - shoulder[0], target[2] - shoulder[2]);
  const dy = target[1] - shoulder[1];
  const dist = Math.hypot(dx, dy);
  if (dist >= l1 + l2 || dist <= Math.abs(l1 - l2)) throw new Error('Cible hors de portée du bras');
  const phi = Math.atan2(dy, dx);
  const beta = Math.acos((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist));
  const a1 = phi + beta;
  const ex = l1 * Math.cos(a1);
  const ey = l1 * Math.sin(a1);
  const a2 = Math.atan2(dy - ey, dx - ex);
  return { root: shoulder, dir: u, links: [{ length: l1, angle0: a1 }, { length: l2, angle0: a2 }] };
}

/**
 * @param {Array<{midi:number,time:number,velocity:number,track:number}>} notes notes de percussion
 * @param {{center?: number[]}} options center = position du kit dans la scène
 */
export function buildDrumKit(notes, options = {}) {
  const o = { ...DRUM_DEFAULTS, ...options };
  const center = o.center ?? [0, 0, 0];
  const byPiece = new Map();
  for (const n of [...notes].sort((a, b) => a.time - b.time)) {
    const name = pieceForNote(n.midi);
    if (!byPiece.has(name)) byPiece.set(name, []);
    byPiece.get(name).push({ time: n.time, velocity: n.velocity, track: n.track, midi: n.midi });
  }

  const pieces = Object.keys(PIECES)
    .filter((name) => byPiece.has(name))
    .map((name) => {
      const def = PIECES[name];
      const pos = [center[0] + def.pos[0], def.y, center[2] + def.pos[1]];
      const piece = { name, ...def, position: pos, hits: byPiece.get(name) };

      if (def.kind === 'kick') {
        // Pédale : batteur pivotant derrière la peau arrière.
        const back = pos[2] - def.depth / 2;
        const pivot = [pos[0], 0.1, back - 0.28];
        const target = [pos[0], pos[1] - 0.05, back];
        const dz = target[2] - pivot[2];
        const dy = target[1] - pivot[1];
        piece.hitPoint = target;
        piece.arm = {
          root: pivot,
          dir: [0, 1],
          links: [{ length: Math.hypot(dz, dy), angle0: Math.atan2(dy, dz) }],
          lifts: [o.pedalLift],
        };
        return piece;
      }

      const d = norm2(def.armDir);
      const offset = def.kind === 'cymbal' ? def.radius * 0.75 : def.radius * 0.35;
      const top = def.kind === 'cymbal' ? pos[1] + 0.02 : pos[1] + 0.03;
      piece.hitPoint = [pos[0] + d[0] * offset, top, pos[2] + d[1] * offset];
      const base = [pos[0] + d[0] * o.armReach, 0, pos[2] + d[1] * o.armReach];
      const shoulder = [base[0], top + o.shoulderAbove, base[2]];
      piece.arm = solveArm(shoulder, piece.hitPoint, o.upperArm, o.forearm);
      piece.arm.base = base;
      piece.arm.lifts = [o.upperLift, o.forearmLift];
      return piece;
    });

  return { options: o, center, pieces };
}

/** Levée de la baguette à l'instant t : 0 au contact, ~restLift au repos. */
export function strikeLift(kit, piece, t) {
  const o = kit.options;
  const hits = piece.hits;
  const i = upperBound(hits, t) - 1;
  const prev = hits[i];
  const next = hits[i + 1];
  const after = prev ? o.restLift * (1 - Math.exp(-(t - prev.time) * o.reboundRate)) : o.restLift;
  if (!next) return after;

  const gap = prev ? next.time - prev.time : Infinity;
  const w = Math.min(o.strikeTime, gap * 0.5);
  const d = next.time - t;
  // Coups rapprochés → petite amplitude ; coups forts → grande levée.
  const peak = (0.55 + 0.45 * next.velocity) * clamp(gap / 0.4, 0.3, 1);
  const windup = d <= w ? peak * Math.sin(((Math.PI / 2) * d) / w) : peak;
  const b = smoothstep((2 * w - d) / w);
  return after * (1 - b) + windup * b;
}

/** Angles absolus des segments du bras (dans son plan vertical) à l'instant t. */
export function armAngles(kit, piece, t) {
  const h = strikeLift(kit, piece, t);
  const angles = piece.arm.links.map((l, i) => l.angle0 + h * piece.arm.lifts[i]);
  // Mouvement secondaire : après chaque coup, la baguette fouette et l'épaule encaisse
  // (ressorts amortis). Nul à l'approche d'une frappe : le contact reste exact.
  const hits = piece.hits;
  const i = upperBound(hits, t);
  const gap = Math.min(i > 0 ? t - hits[i - 1].time : Infinity, i < hits.length ? hits[i].time - t : Infinity);
  const near = smoothstep(gap / 0.06);
  if (near > 0) {
    const last = angles.length - 1;
    angles[last] += near * springSum(hits, t, { omega: 38, zeta: 0.22, amp: (e) => 0.09 * e.velocity });
    if (last > 0) angles[0] += near * springSum(hits, t, { omega: 17, zeta: 0.3, amp: (e) => 0.035 * e.velocity });
  }
  return angles;
}

/** Position du bout de la baguette (ou du batteur) pour des angles donnés. */
export function armTip(piece, angles) {
  const { root, dir, links } = piece.arm;
  let x = 0;
  let y = 0;
  links.forEach((l, i) => {
    x += l.length * Math.cos(angles[i]);
    y += l.length * Math.sin(angles[i]);
  });
  return [root[0] + dir[0] * x, root[1] + y, root[2] + dir[1] * x];
}

/** Éclat / vibration après la dernière frappe. */
export function hitPulse(kit, piece, t) {
  const i = upperBound(piece.hits, t) - 1;
  if (i < 0) return { pulse: 0, since: Infinity, track: -1 };
  const h = piece.hits[i];
  const since = t - h.time;
  return { pulse: h.velocity * Math.exp(-since * kit.options.pulseDecay), since, track: h.track };
}
