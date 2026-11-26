// Réalisateur caméra : module pur. Comme la partition est connue d'avance, la
// liste des plans est calculée une fois pour tout le morceau, en fonction de
// l'activité de chaque instrument. La caméra glisse ensuite d'un plan à l'autre,
// ou coupe franchement sur un temps fort.
//
// Le sujet d'un plan est la voix qu'on écoute : la mélodie (ligne la plus aiguë et la
// plus chantante), un instrument qui entre ou qui répond, un break de batterie. Quand
// deux instruments se répondent, un plan les cadre ensemble (dialogue). Les plans durent
// le temps d'une phrase : on coupe à la fin de la phrase plutôt qu'au milieu du geste.
//
// Types de plans : large, rapproché, contre-plongée, travelling latéral, grue
// (montée ou descente), entrée (l'instrument qui sort du sol est cadré avant sa
// première note), dialogue (deux instruments qui se répondent) et poursuite (la
// caméra suit une bille d'un rebond à l'autre).
//
// La caméra ne traverse jamais un instrument : chacun déclare son encombrement
// (arranger.js), la caméra le survole si son chemin y passe, et chaque plan choisit un
// angle d'où le sujet n'est pas masqué par un autre instrument.

import { countOnsets, smoothstep, lerp, clamp, lowerBound } from './util.js';
import { ballPosition } from './choreography.js';
import { SECTION_DEFAULTS, introGrace } from './sections.js';

export const DIRECTOR_DEFAULTS = {
  minShot: 4.5,
  maxShot: 8,
  blend: 1.4, // durée du fondu de mouvement entre deux plans
  orbitSpeed: 0.06, // rad/s : lente rotation pendant un plan
  snap: 0.45, // une fin de plan se cale sur le temps fort le plus proche à ± snap s
  cutChance: 0.55, // probabilité d'une coupe franche quand le plan finit sur un temps fort
  followChance: 0.4, // probabilité de suivre une bille quand les billes sont à l'honneur
  duoChance: 0.7, // probabilité d'un plan de dialogue quand deux instruments se répondent
  duoSpan: 9, // distance maximale (m) entre deux instruments cadrés ensemble
  phraseGap: 0.8, // silence (s) qui sépare deux phrases
  clearance: 0.6, // marge (m) au-dessus d'un instrument survolé
};

/** Familles mélodiques : celles qui peuvent porter la mélodie. */
const MELODIC = new Set(['balls', 'keys', 'plucked', 'bowed', 'winds', 'laser', 'bells']);

/**
 * Obstacles pour la caméra : boîtes orientées (encombrement des instruments) et, pour
 * les billes, la tourelle, l'arc de lames et les tubes de retour.
 */
export function obstaclesOf(ensemble) {
  const out = [];
  for (const ins of ensemble.instruments) {
    const f = ins.footprint;
    if (f) out.push({ type: 'box', cx: f.center[0], cz: f.center[1], c: Math.cos(f.yaw), s: Math.sin(f.yaw), hw: f.halfW, hd: f.halfD, top: f.top });
    if (ins.kind === 'balls') {
      const ch = ins.model;
      const o = ch.options;
      out.push({ type: 'disc', cx: 0, cz: 0, r: o.launcherRadius + o.loaderGap + o.loaderRadius + 0.1, top: o.launcherY + o.barrelLength + 0.3 });
      if (ch.bars.length) out.push({ type: 'ring', r0: ch.radius - o.barLengthMax / 2 - 0.15, r1: ch.radius + o.troughGap + 0.9, a: ch.arc / 2 + 0.35, top: o.troughY + 0.45 });
      for (const path of ch.returns ?? []) {
        const f2 = path.funnel;
        out.push({ type: 'seg', ax: f2.x, az: f2.z, bx: path.loader.x, bz: path.loader.z, r: 0.45, top: 0.5 });
        out.push({ type: 'disc', cx: f2.x, cz: f2.z, r: 0.85, top: f2.top + 0.1 });
      }
    }
  }
  return out;
}

/**
 * Distance horizontale (m) d'un point à l'emprise d'un obstacle (0 dedans).
 */
function outside(o, x, z) {
  if (o.type === 'box') {
    const dx = x - o.cx;
    const dz = z - o.cz;
    const lx = Math.abs(o.c * dx - o.s * dz) - o.hw;
    const lz = Math.abs(o.s * dx + o.c * dz) - o.hd;
    return Math.hypot(Math.max(0, lx), Math.max(0, lz));
  }
  if (o.type === 'disc') return Math.max(0, Math.hypot(x - o.cx, z - o.cz) - o.r);
  if (o.type === 'ring') {
    const r = Math.hypot(x, z);
    const a = Math.abs(Math.atan2(x, -z));
    const dr = Math.max(0, o.r0 - r, r - o.r1);
    const da = Math.max(0, a - o.a) * r;
    return Math.hypot(dr, da);
  }
  // Segment épaissi.
  const vx = o.bx - o.ax;
  const vz = o.bz - o.az;
  const u = clamp(((x - o.ax) * vx + (z - o.az) * vz) / (vx * vx + vz * vz || 1), 0, 1);
  return Math.max(0, Math.hypot(x - o.ax - u * vx, z - o.az - u * vz) - o.r);
}

/**
 * Hauteur minimale de la caméra au point (x, z) : au-dessus de tout instrument dont
 * elle approche, avec une rampe douce (la caméra monte en approchant, pas d'à-coup).
 */
export function minCameraHeight(obstacles, x, z, margin = 0.6) {
  let h = 0;
  for (const o of obstacles) {
    const d = outside(o, x, z);
    if (d >= 1.5) continue;
    h = Math.max(h, (o.top + margin) * (1 - smoothstep(d / 1.5)));
  }
  return h;
}

/** Le segment p → q passe-t-il à travers un obstacle (en ignorant les derniers 15 %) ? */
function blocked(obstacles, p, q, skip) {
  for (let k = 1; k <= 20; k++) {
    const u = (k / 20) * 0.85;
    const x = p[0] + (q[0] - p[0]) * u;
    const y = p[1] + (q[1] - p[1]) * u;
    const z = p[2] + (q[2] - p[2]) * u;
    for (const o of obstacles) if (o !== skip && y < o.top && outside(o, x, z) === 0) return true;
  }
  return false;
}

/** Pseudo-aléatoire déterministe (même morceau → mêmes plans). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Temps forts : grosse caisse et caisse claire s'il y a une batterie, sinon toutes les attaques. */
function strongBeats(ensemble) {
  const kit = ensemble.instruments.find((i) => i.kind === 'drums')?.model;
  const times = kit
    ? kit.pieces.filter((p) => p.name === 'kick' || p.name === 'snare' || p.name === 'crash').flatMap((p) => p.hits.filter((h) => h.velocity >= 0.6).map((h) => h.time))
    : [];
  const all = times.length ? times : ensemble.instruments.flatMap((i) => i.onsets);
  return [...new Set(all)].sort((a, b) => a - b);
}

/**
 * @param ensemble résultat de buildEnsemble
 * @returns { shots: [{start,end,type,subject,angle,dist,height,center,cut,…}], options, balls }
 */
export function planShots(ensemble, options = {}) {
  const o = { ...DIRECTOR_DEFAULTS, ...options };
  const R = ensemble.radius;
  const inst = ensemble.instruments;
  const random = rng(Math.round(ensemble.end * 1000) + inst.length * 7919);
  const t0 = Math.min(ensemble.start, 0);
  const t1 = Math.max(ensemble.end, t0 + 1);
  const beats = strongBeats(ensemble);
  const ballsIndex = inst.findIndex((i) => i.kind === 'balls');
  const ballsModel = ballsIndex >= 0 ? inst[ballsIndex].model : null;
  const obstacles = obstaclesOf(ensemble);
  const own = inst.map((ins) => obstacles.find((ob) => ob.type === 'box' && ins.footprint && ob.cx === ins.footprint.center[0] && ob.cz === ins.footprint.center[1]));
  const stageR = ensemble.stageRadius ?? R + 6.2;

  // Rythme moyen de chaque instrument, pour repérer ses moments forts.
  const rate = inst.map((i) => i.onsets.length / Math.max(1, t1 - t0));
  const first = inst.map((i) => i.onsets[0] ?? Infinity);
  // Entrées en scène : l'instrument sort du sol (voir sections.js) ; on le cadre pendant sa montée.
  const { rise } = SECTION_DEFAULTS;
  const grace = introGrace(ensemble);
  const entries = inst
    .map((ins, k) => ({ k, time: (ins.busy?.[0]?.[0] ?? Infinity) - rise }))
    .filter((e) => Number.isFinite(e.time) && e.time + rise > ensemble.start + grace)
    .sort((a, b) => a.time - b.time);

  // Plan d'ensemble : tout l'amphithéâtre, de face (gradins compris).
  const wide = () => ({
    type: 'wide',
    subject: -1,
    center: [0, 1.5, -stageR * 0.42],
    dist: stageR * 1.15 + 4,
    height: stageR * 0.42 + 3,
    angle: (random() - 0.5) * 0.7,
  });

  /** Position de caméra d'un plan cadré (sans la rotation lente). */
  const eye = (center, angle, dist, height) => [center[0] + Math.sin(angle) * dist, center[1] + height, center[2] + Math.cos(angle) * dist];

  /**
   * Angle de prise de vue : le plus proche de l'axe voulu d'où le sujet n'est masqué par
   * aucun autre instrument, au début comme à la fin du plan (rotation lente comprise).
   */
  const clearAngle = (k, center, angle, dist, height, duration) => {
    for (const da of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
      const a = angle + da;
      const ok = [a - 0.06 * duration, a, a + 0.06 * duration].every((b) => {
        const p = eye(center, b, dist, height);
        p[1] = Math.max(p[1], minCameraHeight(obstacles, p[0], p[2]));
        return !blocked(obstacles, p, center, own[k]);
      });
      if (ok) return a;
    }
    return angle;
  };

  /** Plan cadré sur un instrument, d'un type tiré au sort. */
  const framed = (k, duration) => {
    const ins = inst[k];
    const { center, radius } = ins.focus;
    const cam = { distScale: 1.7, minHeight: 0, allowLow: true, ...ins.camera };
    const r = random();
    const dist = radius * cam.distScale + 1.5;
    const height = Math.max(cam.minHeight, radius * 0.45 + 0.8);
    const angle = clearAngle(k, center, (ins.front ?? 0) + (random() - 0.5) * 1.1, dist, height, duration);
    const base = { subject: k, center, angle };
    if (cam.allowLow && r < 0.22) return { ...base, type: 'low', dist: radius * 1.3 + 1.5, height: 0.6 - center[1] * 0.5 };
    if (r < 0.42) return { ...base, type: 'dolly', dist: dist * 0.9, height, travel: (random() < 0.5 ? -1 : 1) * Math.min(3.5, radius * 1.4) };
    if (r < 0.58) {
      const up = random() < 0.5;
      return { ...base, type: 'crane', dist, height: up ? Math.max(cam.minHeight, 0.4) : height + 2.2, height2: up ? height + 2.2 : Math.max(cam.minHeight, height * 0.7) };
    }
    return { ...base, type: 'close', dist, height };
  };

  /** Dialogue : deux instruments cadrés ensemble, de face, à mi-chemin. */
  const duo = (a, b, duration) => {
    const ca = inst[a].focus.center;
    const cb = inst[b].focus.center;
    const center = ca.map((v, i) => (v + cb[i]) / 2);
    const sep = Math.hypot(ca[0] - cb[0], ca[2] - cb[2]);
    const span = sep + Math.max(inst[a].focus.radius, inst[b].focus.radius) * 1.2;
    // Champ horizontal ≈ 1,2 × la distance (objectif 40°, image 16:9) : les deux tiennent.
    const dist = Math.max(6, span / 1.1 + 1);
    const toAudience = Math.atan2(-center[0], R * 0.8 - center[2]);
    const angle = clearAngle(a, center, toAudience + (random() - 0.5) * 0.4, dist, dist * 0.32 + 1, duration);
    return { type: 'duo', subject: a, partner: b, center, angle, dist, height: dist * 0.32 + 1 };
  };

  // --- Écoute : ligne mélodique, phrases et réponses.
  const lines = inst.map((ins) => ins.line ?? []);
  const lineTimes = lines.map((l) => l.map((n) => n.time));
  /** Notes d'un instrument dans [a, b). */
  const notesIn = (k, a, b) => lines[k].slice(lowerBound(lineTimes[k], a), lowerBound(lineTimes[k], b));
  /**
   * Saillance mélodique d'un instrument sur [a, b) : on écoute la voix la plus aiguë, la
   * plus chantante (peu d'accords), jouée fort ; un break de batterie (plus dense que
   * d'habitude) passe devant ; la basse et l'orgue ne sont filmés que s'ils sont seuls.
   */
  const salience = (k, a, b) => {
    const ins = inst[k];
    const n = countOnsets(ins.onsets, a, b);
    if (!n) return 0;
    if (ins.kind === 'drums') {
      const ratio = n / (rate[k] * (b - a) + 1);
      return ratio > 1.3 ? 2.2 * (ratio - 0.8) : 0.25 * ratio;
    }
    if (!MELODIC.has(ins.kind)) return 0.35 * Math.sqrt(n / (rate[k] * (b - a) + 1));
    const notes = notesIn(k, a, b);
    if (!notes.length) return 0.3;
    let pitch = 0;
    let vel = 0;
    for (const x of notes) {
      pitch += x.midi;
      vel += x.velocity;
    }
    pitch /= notes.length;
    vel /= notes.length;
    const chords = notes.length / new Set(notes.map((x) => Math.round(x.time * 20))).size; // notes par attaque
    const register = clamp(0.6 + (pitch - 55) / 30, 0.4, 1.6);
    return Math.sqrt(Math.min(notes.length, 24)) * register * (0.5 + vel) / Math.sqrt(chords);
  };
  /** Début de phrase dans [a, b) : une note après au moins `phraseGap` de silence. */
  const phraseStart = (k, a, b) => {
    const on = inst[k].onsets;
    for (let i = lowerBound(on, a); i < on.length && on[i] < b; i++) if (i === 0 || on[i] - on[i - 1] >= o.phraseGap) return on[i];
    return null;
  };
  /** Fin de la phrase en cours du sujet, si elle tombe dans [a, b]. */
  const phraseEnd = (k, a, b) => {
    const on = inst[k].onsets;
    for (let i = lowerBound(on, a); i < on.length && on[i] <= b; i++) if (i === on.length - 1 || on[i + 1] - on[i] >= o.phraseGap) return on[i];
    return null;
  };
  /** Les deux instruments jouent-ils en alternance (peu de recouvrement) dans [a, b) ? */
  const alternate = (p, q, a, b) => {
    const sp = notesIn(p, a, b);
    const sq = notesIn(q, a, b);
    if (sp.length < 2 || sq.length < 2) return false;
    const span = (ns) => [ns[0].time, ns[ns.length - 1].time + ns[ns.length - 1].duration];
    const [p0, p1] = span(sp);
    const [q0, q1] = span(sq);
    const overlap = Math.max(0, Math.min(p1, q1) - Math.max(p0, q0));
    return overlap < 0.35 * Math.min(p1 - p0, q1 - q0) + 0.3;
  };

  /** Bille à suivre : lancée dans les premières secondes du plan, la plus forte (note accentuée). */
  const followBall = (t) => {
    if (!ballsModel) return -1;
    const balls = ballsModel.balls;
    let best = -1;
    let bestScore = 0.8; // au moins 0,8 s de vol
    for (let i = lowerBound(balls, t + 0.2, (b) => b.launch); i < balls.length && balls[i].launch < t + 1.2; i++) {
      const b = balls[i];
      const score = b.lastImpact - b.launch + 0.5 * b.velocity;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  };

  const shots = [];
  let t = t0;
  let lastSubject = -2;
  let repeat = 0; // plans consécutifs sur le même sujet
  const seen = inst.map(() => t0); // dernier passage à l'écran de chaque instrument
  let sinceWide = 0;
  let entry = 0;
  let cutPending = false; // le plan précédent s'est terminé sur un temps fort : coupe franche
  while (t < t1) {
    const cut = cutPending && shots.length > 0;
    cutPending = false;
    let end = Math.min(t1, t + lerp(o.minShot, o.maxShot, random()));
    let shot = null;
    while (entry < entries.length && entries[entry].time < t - 0.6) entry++;
    const e = entries[entry];
    if (e && e.time <= t + 0.6) {
      // Entrée en scène : l'instrument monte du sol, on le cadre jusqu'après sa première note.
      const ins = inst[e.k];
      const { center, radius } = ins.focus;
      shot = {
        type: 'crane',
        entry: true,
        subject: e.k,
        center,
        angle: (ins.front ?? 0) + (random() - 0.5) * 0.5,
        dist: radius * 1.5 + 2,
        height: Math.max(0.6, radius * 0.6 + 1.4),
        height2: Math.max(0.5, radius * 0.35 + 0.6),
      };
      end = Math.min(t1, Math.max(t + 3, e.time + rise + 2.2));
      entry++;
      // Entrées rapprochées : on enchaîne sur la suivante.
      const following = entries[entry];
      if (following && following.time < end) end = Math.max(t + 2.4, following.time);
    } else {
      // Une entrée imminente impose la fin du plan.
      const imminent = e && e.time < end + 1.5;
      if (imminent) end = Math.max(t + 1.5, e.time);
      else {
        // Fin de plan calée sur le temps fort le plus proche.
        const i = lowerBound(beats, end);
        const near = [beats[i - 1], beats[i]].filter((b) => b !== undefined && Math.abs(b - end) <= o.snap && b > t + o.minShot * 0.6);
        if (near.length) {
          end = Math.min(t1, near.sort((a, b) => Math.abs(a - end) - Math.abs(b - end))[0]);
          cutPending = random() < o.cutChance;
        }
      }
      // Sujet : la voix qu'on écoute. Bonus d'entrée (premières notes) et de réponse
      // (début de phrase dans la première moitié du plan).
      const scores = inst.map((ins, k) => {
        let score = salience(k, t, end);
        if (!score) return 0;
        if (first[k] >= t && first[k] < end) score += 2;
        const ph = phraseStart(k, t - 0.2, (t + end) / 2);
        if (ph !== null && ph > first[k]) score += 0.6;
        if (ins.kind === 'balls') score *= 1.25; // l'instrument vedette, le plus lisible
        // Un instrument qui joue sans avoir été montré depuis longtemps finit par l'être.
        score += Math.min(1.2, (t - seen[k]) / 25);
        if (k === lastSubject) score *= repeat >= 2 ? 0.45 : 0.85; // variété, sans quitter la mélodie
        return score;
      });
      let best = -1;
      let bestScore = 0;
      scores.forEach((score, k) => {
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      });
      // Plan calé sur la phrase du sujet : il finit avec elle (si elle finit assez tard).
      if (best >= 0 && !cutPending && !imminent) {
        const pe = phraseEnd(best, t + o.minShot * 0.8, end + 1.5);
        if (pe !== null) end = Math.min(t1, pe + 0.35);
      }

      if (best < 0 || sinceWide >= 4 || (shots.length === 0 && inst.length > 1)) {
        shot = wide();
        sinceWide = 0;
      } else {
        const ball = best === ballsIndex && random() < o.followChance ? followBall(t) : -1;
        // Partenaire de dialogue : une autre voix mélodique presque aussi présente, qui alterne avec le sujet.
        let partner = -1;
        if (MELODIC.has(inst[best].kind)) {
          scores.forEach((score, k) => {
            if (k === best || !MELODIC.has(inst[k].kind) || score < 0.45 * bestScore) return;
            // Assez proches pour tenir dans un même plan sans devenir un plan d'ensemble.
            const [ca, cb] = [inst[best].focus.center, inst[k].focus.center];
            if (Math.hypot(ca[0] - cb[0], ca[2] - cb[2]) > o.duoSpan) return;
            if (partner < 0 || score > scores[partner]) partner = k;
          });
          if (partner >= 0 && !(alternate(best, partner, t, end) && random() < o.duoChance)) partner = -1;
        }
        if (ball >= 0) {
          const b = ballsModel.balls[ball];
          shot = { type: 'follow', subject: best, ball, center: inst[best].focus.center, side: random() < 0.5 ? -1 : 1 };
          end = Math.min(t1, Math.max(end, b.lastImpact + 0.7));
          cutPending = false;
        } else if (partner >= 0) shot = duo(best, partner, end - t);
        else shot = framed(best, end - t);
        sinceWide++;
      }
    }
    repeat = shot.subject === lastSubject ? repeat + 1 : 0;
    for (const k of [shot.subject, shot.partner]) if (k >= 0) seen[k] = end;
    shot.start = t;
    shot.end = end;
    shot.spin = (random() < 0.5 ? -1 : 1) * o.orbitSpeed;
    shot.cut = cut;
    shots.push(shot);
    lastSubject = shot.subject;
    t = end;
  }
  return { shots, options: o, balls: ballsModel, obstacles };
}

const tmp = [0, 0, 0];
/** Position lissée d'une bille (moyenne sur ±0,25 s, bornée à sa durée de vie). */
function smoothBall(ch, b, t, out) {
  out[0] = out[1] = out[2] = 0;
  const n = 7;
  for (let k = 0; k < n; k++) {
    const tk = clamp(t + (k - 3) * 0.08, b.launch, b.end);
    ballPosition(ch, b, tk, tmp);
    out[0] += tmp[0] / n;
    out[1] += tmp[1] / n;
    out[2] += tmp[2] / n;
  }
  return out;
}

function shotPose(plan, shot, t) {
  const u = clamp((t - shot.start) / Math.max(1e-3, shot.end - shot.start), 0, 1);
  if (shot.type === 'follow' && plan.balls) {
    const ch = plan.balls;
    const b = ch.balls[shot.ball];
    const target = smoothBall(ch, b, clamp(t, b.launch, b.lastImpact + 0.5), [0, 0, 0]);
    // Caméra à l'intérieur de l'arc, dans l'axe de la bille, un peu de côté et en hauteur.
    const a = Math.atan2(target[0], -target[2]) + shot.side * 0.35;
    const r = ch.radius * 0.42;
    return { position: [Math.sin(a) * r, 2.1 + target[1] * 0.3, -Math.cos(a) * r], target, aperture: 1 };
  }
  const [cx, cy, cz] = shot.center;
  const a = shot.angle + shot.spin * (t - shot.start);
  let height = shot.height;
  let px = cx + Math.sin(a) * shot.dist;
  let pz = cz + Math.cos(a) * shot.dist;
  let target = shot.center;
  if (shot.type === 'dolly') {
    // Travelling : la caméra glisse sur un rail perpendiculaire à l'axe de visée.
    const s = (smoothstep(u) - 0.5) * shot.travel;
    px += Math.cos(a) * s;
    pz -= Math.sin(a) * s;
    target = [cx + Math.cos(a) * s * 0.3, cy, cz - Math.sin(a) * s * 0.3];
  } else if (shot.type === 'crane') {
    height = lerp(shot.height, shot.height2, smoothstep(u));
  }
  const aperture = shot.type === 'wide' ? 0.25 : shot.type === 'duo' ? 0.35 : shot.type === 'low' ? 0.9 : 0.7;
  return { position: [px, cy + height, pz], target, aperture };
}

/**
 * Pose de la caméra à l'instant t : position, point visé, distance de mise au point
 * (`focus`) et ouverture relative du diaphragme (`aperture`, 0 = tout net).
 */
export function cameraAt(plan, t) {
  const { shots, options } = plan;
  if (!shots.length) return { position: [0, 8, 14], target: [0, 1, 0], focus: 15, aperture: 0 };
  let i = shots.findIndex((s) => t < s.end);
  if (i < 0) i = shots.length - 1;
  let pose = shotPose(plan, shots[i], t);
  if (i > 0 && !shots[i].cut && t < shots[i].start + options.blend) {
    // Glissement depuis le plan précédent (qui continue son mouvement pendant le fondu).
    const prev = shotPose(plan, shots[i - 1], t);
    const s = smoothstep((t - shots[i].start) / options.blend);
    const mix = (a, b) => a.map((v, k) => lerp(v, b[k], s));
    pose = { position: mix(prev.position, pose.position), target: mix(prev.target, pose.target), aperture: lerp(prev.aperture, pose.aperture, s) };
  }
  // Jamais à travers un instrument : la caméra le survole (rampe douce à l'approche).
  if (plan.obstacles) {
    const [x, y, z] = pose.position;
    const floor = minCameraHeight(plan.obstacles, x, z, options.clearance);
    if (y < floor) pose = { ...pose, position: [x, floor, z] };
  }
  const focus = Math.hypot(...pose.position.map((v, k) => v - pose.target[k]));
  return { ...pose, focus };
}
