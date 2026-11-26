// Réseau : une seule machine. Module pur (sans Three.js), en coordonnées de la scène.
//
// Autour de la tourelle du marimba, côté public, se dresse une colonnade de verre en
// demi-cercle, haute au centre comme un buffet d'orgue. Du sommet de chaque colonne part
// une arche qui passe par-dessus la tourelle et redescend, à la verticale, sur la rampe
// d'un instrument ou sur le tuyau d'un fût de la batterie ; les instruments à rangée ont
// aussi une arche de retour, depuis leur collecteur. Les billes y circulent à vitesse
// constante, en avance sur la musique : chacune arrive au bout de son arche juste à temps
// pour être tirée, si bien que le rythme d'un instrument se lit d'avance dans son tuyau.

import { polyline, fillet } from './ballistics.js';
import { frameOf } from './passes.js';

export const TRUNK_DEFAULTS = {
  speed: 5, // vitesse des billes dans le réseau (m/s)
  radius: 0.058, // rayon extérieur des tuyaux
  ringFeed: 2.0, // rayon du demi-cercle des colonnes d'alimentation (le plateau de la tourelle fait 1,72)
  ringBack: 2.35, // … et de celui des colonnes de retour, derrière elles
  columnGap: 0.3, // écart entre deux colonnes, le long du demi-cercle
  maxAngle: 1.25, // demi-ouverture de la colonnade (rad) : les chargeurs du marimba sont sur les côtés
  columnLow: 3.6, // hauteur des colonnes des extrémités…
  columnHigh: 6.0, // … et de celles du centre
  clearance: 1.0, // hauteur du sommet des arches au-dessus de l'instrument le plus haut
  minApex: 6.8,
  rise: 0.07, // une arche longue monte plus haut (m par m de portée) : les arches s'emboîtent
  backLift: 0.45, // l'arche de retour passe au-dessus de l'arche d'alimentation
  step: 0.35, // surélévation d'une arche qui en frôlerait une autre
  gap: 0.16, // distance minimale entre les axes de deux tuyaux
  stub: 0.3, // le retour quitte le collecteur de côté avant de monter
  baseY: 0.3, // dessus du socle de la colonnade
};

/** Arche : colonne verticale, puis courbe (Bézier cubique à tangentes verticales) jusqu'au raccord. */
function arch(foot, top, end, apex, reverse = false) {
  const a = (4 / 3) * Math.max(0.3, apex - top);
  const b = (4 / 3) * Math.max(0.3, apex - end[1]);
  const pts = [[foot[0], foot[1], foot[2]]];
  const n = Math.max(24, Math.ceil((Math.hypot(end[0] - foot[0], end[2] - foot[2]) + a + b) / 0.12));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const h = u * u * (3 - 2 * u); // en plan : de la colonne au raccord, sans à-coup
    const v = 1 - u;
    pts.push([foot[0] + (end[0] - foot[0]) * h, v * v * v * top + 3 * v * v * u * (top + a) + 3 * v * u * u * (end[1] + b) + u * u * u * end[1], foot[2] + (end[2] - foot[2]) * h]);
  }
  return reverse ? pts.reverse() : pts;
}

/** Plus petite distance entre les axes de deux tuyaux (polylignes). */
function pipeGap(A, B) {
  let min = Infinity;
  for (let i = 0; i < A.length; i += 2) {
    const p = A[i];
    for (let j = 1; j < B.length; j++) {
      const a = B[j - 1];
      const d = [B[j][0] - a[0], B[j][1] - a[1], B[j][2] - a[2]];
      const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1)));
      min = Math.min(min, Math.hypot(p[0] - a[0] - d[0] * u, p[1] - a[1] - d[1] * u, p[2] - a[2] - d[2] * u));
    }
  }
  return min;
}

/**
 * Raccords de l'ensemble : pour chaque instrument à rangée, le bout de sa rampe (et celui
 * de son collecteur) ; pour la batterie, le dessus du tuyau de chaque fût.
 */
function ports(ensemble, o) {
  const lip = o.radius + 0.012; // les tuyaux se posent contre les pièces, sans y entrer
  const out = [];
  ensemble.instruments.forEach((ins, k) => {
    const f = frameOf(ins);
    const row = ins.model.row;
    // Un clavier est devant la colonnade, tout contre elle : une arche vers lui couperait les colonnes.
    if (row && row.kind === 'keys') return;
    if (row) {
      const loop = row.loop;
      const [W0, yc, zc] = loop[0];
      const [, ym, zm] = loop[loop.length - 1];
      const along = (s) => Math.abs(s.station.hit[0] - W0) / o.speed;
      out.push({
        instrument: k,
        ballRadius: row.ballRadius,
        joint: f.toWorld([W0, ym + lip, zm]),
        drain: [f.toWorld([W0 - lip, yc, zc]), f.toWorld([W0 - o.stub, yc, zc])],
        // Arrivée : à temps pour parcourir la rampe jusqu'à la buse ; départ : une fois le collecteur parcouru.
        shots: () => row.shots.map((s) => ({ arrive: s.time - s.station.before - along(s) - 0.03, depart: s.time + (s.hold ?? 0) + s.station.after + along(s) + 0.03, track: s.track })),
      });
    } else if (ins.kind === 'drums' && ins.model.player === 'balls') {
      for (const piece of ins.model.pieces) {
        // Sur la traverse du tuyau (en haut de la crosse ; au sol pour la grosse caisse).
        const [a, b] = piece.station.bar;
        const inside = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); // de là à la bouche, la bille est cachée dans l'acier
        out.push({
          instrument: k,
          piece: piece.name,
          ballRadius: piece.station.ballRadius,
          joint: f.toWorld([(a[0] + b[0]) / 2, a[1] + lip, (a[2] + b[2]) / 2]),
          shots: () => piece.shots.map((s) => ({ arrive: s.time - piece.station.before - inside / o.speed - 0.1, track: s.track })),
        });
      }
    }
  });
  return out;
}

/**
 * Trace le réseau. Les colonnes sont rangées sur leur demi-cercle dans l'ordre des
 * raccords vus de la tourelle (de gauche à droite) : les arches s'ouvrent en éventail
 * sans se croiser ; celles qui se frôleraient malgré tout sont surélevées, et retirées
 * si cela ne suffit pas.
 */
export function planTrunks(ensemble, options = {}) {
  const o = { ...TRUNK_DEFAULTS, ...options };
  const tops = ensemble.instruments.filter((i) => i.footprint).map((i) => i.footprint.top);
  const apex0 = Math.max(o.minApex, ...tops.map((t) => t + o.clearance));
  const all = ports(ensemble, o)
    // Rang sur la colonnade : l'angle du raccord vu de la tourelle (les arches passent par-dessus elle).
    .map((p) => ({ ...p, azimuth: Math.atan2(p.joint[0], -p.joint[2]) }))
    .sort((a, b) => a.azimuth - b.azimuth);
  const room = Math.floor((2 * o.maxAngle * o.ringFeed) / o.columnGap) + 1;
  // Trop de raccords pour la colonnade : les rangées d'abord, puis les fûts.
  const kept = all.length <= room ? all : [...all.filter((p) => p.drain), ...all.filter((p) => !p.drain)].slice(0, room).sort((a, b) => a.azimuth - b.azimuth);
  const n = kept.length;
  const dphi = o.columnGap / o.ringFeed;
  let lines = kept.map((p, i) => {
    const phi = (i - (n - 1) / 2) * dphi; // angle de la colonne, compté depuis l'axe du public (+z)
    const tall = o.columnLow + (o.columnHigh - o.columnLow) * Math.cos((phi / o.maxAngle) * (Math.PI / 2));
    const at = (r) => [Math.sin(phi) * r, o.baseY, Math.cos(phi) * r];
    const foot = at(o.ringFeed);
    const span = Math.hypot(p.joint[0] - foot[0], p.joint[2] - foot[2]);
    return { ...p, phi, tall, foot, backFoot: at(o.ringBack), apex: Math.max(apex0, p.joint[1] + 1.2) + o.rise * span, lift: 0 };
  });
  const shape = (l) => {
    l.feedPoints = arch(l.foot, l.tall, l.joint, l.apex + l.lift);
    // Retour : départ de côté, coude arrondi, puis l'arche (parcourue du collecteur vers la colonne).
    const up = l.drain && [l.drain[1][0], l.drain[1][1] + 0.3, l.drain[1][2]];
    l.backPoints = l.drain ? [...fillet([l.drain[0], l.drain[1], up], 0.14, 0.04), ...arch(l.backFoot, l.tall + 0.5, up, l.apex + l.lift + o.backLift, true).slice(1)] : null;
  };
  lines.forEach(shape);
  const pipes = (l) => (l.backPoints ? [l.feedPoints, l.backPoints] : [l.feedPoints]);
  const clash = (a, b) => pipes(a).some((A) => pipes(b).some((B) => pipeGap(A, B) < o.gap));
  for (let round = 0; round < 10; round++) {
    let moved = false;
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++) {
        if (!clash(lines[i], lines[j])) continue;
        // La plus longue des deux passe au-dessus.
        const up = lines[i].apex + lines[i].lift >= lines[j].apex + lines[j].lift ? lines[i] : lines[j];
        up.lift += o.step;
        shape(up);
        moved = true;
      }
    if (!moved) break;
  }
  // Dernier recours : retirer les arches encore en conflit (les fûts avant les rangées).
  for (;;) {
    const bad = lines.filter((a) => lines.some((b) => a !== b && clash(a, b)));
    if (!bad.length) break;
    const drop = bad.find((l) => !l.drain) ?? bad[0];
    o.debug?.(bad.map((a) => `${a.piece ?? a.instrument}: ` + lines.filter((b) => a !== b && clash(a, b)).map((b) => b.piece ?? b.instrument).join(',')).join(' | '));
    lines = lines.filter((l) => l !== drop);
  }
  for (const l of lines) {
    l.feed = polyline(l.feedPoints);
    l.back = l.backPoints ? polyline(l.backPoints) : null;
    l.feedBalls = [];
    l.backBalls = [];
  }
  const segments = [];
  for (const l of lines)
    for (const pts of pipes(l))
      for (let i = 4; i < pts.length; i += 4) {
        const a = pts[i - 4];
        const b = pts[i];
        segments.push({ a, b, min: [0, 1, 2].map((c) => Math.min(a[c], b[c])), max: [0, 1, 2].map((c) => Math.max(a[c], b[c])) });
      }
  return { options: o, apex: apex0, lines, segments, colonnade: n ? { feed: o.ringFeed, back: o.ringBack, half: ((n - 1) / 2) * dphi + 0.12, top: o.baseY } : null };
}

/**
 * Horaires des billes du réseau, d'après les billes réellement tirées (à appeler après
 * le choix des passes). Deux billes d'un même tuyau ne se touchent pas.
 */
export function scheduleTrunks(trunks) {
  const o = trunks.options;
  for (const line of trunks.lines) {
    const gap = (2.4 * line.ballRadius) / o.speed;
    const shots = line.shots();
    const feed = shots.map((s) => ({ time: s.arrive, track: s.track })).sort((a, b) => a.time - b.time);
    for (let i = feed.length - 2; i >= 0; i--) feed[i].time = Math.min(feed[i].time, feed[i + 1].time - gap);
    const back = line.back ? shots.map((s) => ({ time: s.depart, track: s.track })).sort((a, b) => a.time - b.time) : [];
    for (let i = 1; i < back.length; i++) back[i].time = Math.max(back[i].time, back[i - 1].time + gap);
    line.feedBalls = feed; // time = arrivée au raccord
    line.backBalls = back; // time = départ du bout du collecteur
    line.feedSpan = line.feed.length / o.speed;
    line.backSpan = line.back ? line.back.length / o.speed : 0;
  }
  return trunks;
}

/** Position d'une bille d'alimentation (arrivée à `ball.time`) à l'instant t, ou false hors du tuyau. */
export function feedBall(trunks, line, ball, t, out = [0, 0, 0]) {
  const s = line.feed.length - trunks.options.speed * (ball.time - t);
  if (s < 0 || s > line.feed.length) return false;
  line.feed.pointAt(s, out);
  return true;
}

/** Position d'une bille de retour (partie à `ball.time`) à l'instant t, ou false hors du tuyau. */
export function backBall(trunks, line, ball, t, out = [0, 0, 0]) {
  const s = trunks.options.speed * (t - ball.time);
  if (s < 0 || s > line.back.length) return false;
  line.back.pointAt(s, out);
  return true;
}

/** Distance d'un point aux axes des tuyaux du réseau (au-delà de 1 m : simplement « loin »). */
export function trunkDistance(trunks, p) {
  let min = Infinity;
  for (const { a, b, min: lo, max: hi } of trunks.segments) {
    if (p[0] < lo[0] - 1 || p[0] > hi[0] + 1 || p[1] < lo[1] - 1 || p[1] > hi[1] + 1 || p[2] < lo[2] - 1 || p[2] > hi[2] + 1) continue;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2])));
    min = Math.min(min, Math.hypot(p[0] - a[0] - d[0] * u, p[1] - a[1] - d[1] * u, p[2] - a[2] - d[2] * u));
  }
  return min;
}
