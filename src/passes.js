// Passes : par moments, la bille d'une note n'est pas crachée par la buse de son
// instrument mais tirée, d'un long lob, par un canon : celui dressé derrière l'instrument
// voisin de devant s'il y en a un bien placé, sinon le canon central de la tourelle du
// marimba, qui traverse la scène. Module pur (sans Three.js), en coordonnées de la scène.
//
// La cible (tube de cloche, corde) est un cylindre vertical : on choisit le point
// d'impact sur son pourtour pour que le rebond (loi de réflexion) retombe dans le cornet
// habituel de la cible, quel que soit l'angle d'arrivée. Trois inconnues (azimut du
// point d'impact, durée du lob, durée du rebond), trois équations (la parabole remontée
// depuis l'impact passe par la bouche du canon) : résolues par Newton.

import { GRAVITY, buildStation, stationBall, maxConcurrent } from './ballistics.js';
import { analyzeSong, deployAt } from './sections.js';
import { activeBallRange, ballPosition, ballScale } from './choreography.js';

export const PASS_DEFAULTS = {
  barrel: 0.6, // longueur du fût, de la rotule à la bouche
  pivotAbove: [0.75, 1.4, 2.1, 2.8], // hauteurs possibles de la rotule au-dessus de l'estrade de l'instrument qui tire (la plus basse qui convient)
  behind: 0.36, // distance du canon derrière le bord arrière de cette estrade
  minRange: 2, // portée (distance horizontale canon → cible), dans le repère de la cible
  maxRange: 9.5,
  hubRange: 26, // portée du canon central de la tourelle du marimba
  hubHeight: 1.9, // hauteur de sa rotule
  hubBase: 0.2, // hauteur du plateau de la tourelle, où son mât est boulonné
  maxAzimuth: 0.55, // écart latéral maximal (rad) du canon, vu de la cible
  cannonGap: 0.25, // délai minimal entre deux tirs d'un canon (le temps de viser)
  aimWindow: 0.3,
  hide: 0.3,
  clearance: 1.12, // distance minimale entre deux billes, en diamètres
  solvable: 0.5, // part minimale de cibles atteignables pour installer un canon
  windowMax: 12, // durée maximale (s) d'un échange dans une section
  windowOn: 8, // sans sections : durée (s) d'un échange…
  windowOff: 16, // … et de la pause qui le suit
};

const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Repère d'un instrument posé sur son estrade : passage local ↔ scène. */
export function frameOf(inst) {
  const [ox, , oz] = inst.model.origin ?? [0, 0, 0];
  const yaw = inst.model.yaw ?? 0;
  const oy = inst.riser ? inst.riser + 0.003 : 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    toWorld: ([x, y, z]) => [ox + x * c + z * s, oy + y, oz - x * s + z * c],
    dirToWorld: ([x, y, z]) => [x * c + z * s, y, -x * s + z * c],
    toLocal: ([x, y, z]) => [(x - ox) * c - (z - oz) * s, y - oy, (x - ox) * s + (z - oz) * c],
  };
}

/**
 * Passe d'un canon vers une cible cylindrique.
 * @param pivot rotule du canon
 * @param axis [x, z] de l'axe du cylindre ; y hauteur de l'impact ; rho rayon du cylindre + rayon de la bille
 * @param caught centre de la bouche du cornet
 * @returns frappe (comme planStrike), avec `dir` l'orientation du fût, ou null sans solution
 */
export function solvePass({ pivot, axis, y, rho, caught, restitution, barrel }) {
  const state = (phi, tau, T) => {
    const n = [Math.cos(phi), 0, Math.sin(phi)];
    const hit = [axis[0] + rho * n[0], y, axis[1] + rho * n[2]];
    const vOut = [(caught[0] - hit[0]) / tau, (caught[1] - hit[1] + 0.5 * GRAVITY * tau * tau) / tau, (caught[2] - hit[2]) / tau];
    const vn = dot(vOut, n);
    // Rebond inversé : la composante normale d'arrivée vaut −(celle de départ) / e.
    const vIn = add(vOut, n, -vn * (1 + 1 / restitution));
    const v0 = [vIn[0], vIn[1] + GRAVITY * T, vIn[2]];
    const dir = unit(v0);
    const mouth = add(pivot, dir, barrel);
    const start = [hit[0] - v0[0] * T, hit[1] - v0[1] * T + 0.5 * GRAVITY * T * T, hit[2] - v0[2] * T];
    return { n, hit, vOut, vn, vIn, v0, dir, mouth, residual: sub(start, mouth) };
  };
  // Départ : normale à mi-chemin entre le canon et le cornet, durées d'un tir de face.
  const toC = unit([pivot[0] - axis[0], 0, pivot[2] - axis[1]]);
  const toM = unit([caught[0] - axis[0], 0, caught[2] - axis[1]]);
  const range = Math.hypot(pivot[0] - axis[0], pivot[2] - axis[1]);
  const k = Math.max(0.05, Math.hypot(caught[0] - axis[0], caught[2] - axis[1]) - rho) / restitution;
  const drop = y - caught[1];
  const tau2 = (drop * range) / k - (pivot[1] - y);
  let u = [Math.atan2(toC[2] + toM[2], toC[0] + toM[0]), Math.sqrt(Math.max(0.01, tau2 / (0.5 * GRAVITY * (range / k + (range * range) / (k * k))))), 0];
  u[2] = (range * u[1]) / k;
  for (let it = 0; it < 40; it++) {
    const f = state(...u).residual;
    if (len(f) < 1e-9) break;
    // Jacobien par différences finies, système 3 × 3 résolu par la règle de Cramer.
    const J = [0, 1, 2].map((j) => {
      const v = [...u];
      v[j] += 1e-6;
      const g = state(...v).residual;
      return [(g[0] - f[0]) / 1e-6, (g[1] - f[1]) / 1e-6, (g[2] - f[2]) / 1e-6];
    }); // J[j] = colonne j
    const det3 = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
    const D = det3(J[0], J[1], J[2]);
    if (Math.abs(D) < 1e-12) return null;
    const step = [det3(f, J[1], J[2]) / D, det3(J[0], f, J[2]) / D, det3(J[0], J[1], f) / D];
    const damp = Math.min(1, 0.5 / Math.max(1e-9, Math.abs(step[0])), (0.5 * u[1]) / Math.max(1e-9, Math.abs(step[1])), (0.5 * u[2]) / Math.max(1e-9, Math.abs(step[2])));
    u = [u[0] - damp * step[0], Math.max(0.03, u[1] - damp * step[1]), Math.max(0.1, u[2] - damp * step[2])];
  }
  const [, tau, T] = u;
  const s = state(...u);
  if (!(len(s.residual) < 1e-6) || !(s.vn > 0)) return null;
  return {
    hit: s.hit,
    normal: s.n,
    vIn: s.vIn,
    v0: s.v0,
    mouth: s.mouth,
    vOut: s.vOut,
    catch: caught,
    vCatch: [s.vOut[0], s.vOut[1] - GRAVITY * tau, s.vOut[2]],
    flightIn: T,
    flightOut: tau,
    dir: s.dir,
  };
}

/**
 * Station de passe d'un canon vers la cible d'une rangée (voir ballRow.js), ou null si
 * le tir n'est pas propre : rebond trop rasant, entrée de biais dans le cornet, lob qui
 * frôle la rampe des buses ou le bord de l'estrade.
 */
/** Vrai si le point p (scène) survole de trop près l'un des encombrements. */
function tooLow(p, obstacles) {
  for (const g of obstacles) {
    const ox = p[0] - g.center[0];
    const oz = p[2] - g.center[1];
    const gc = Math.cos(g.yaw);
    const gs = Math.sin(g.yaw);
    if (p[1] < g.top + 0.4 && Math.abs(gc * ox - gs * oz) < g.halfW + 0.3 && Math.abs(gs * ox + gc * oz) < g.halfD + 0.3) return true;
  }
  return false;
}

/**
 * Station de passe vers une coupelle (rangées de notes tenues) : le lob y tombe à 45°
 * environ, la bille y reste le temps de la note, puis elle est éjectée vers son cornet
 * comme une bille de la rampe. Pas de rebond : seule la durée du lob est à choisir.
 */
function cupPassStation(pivot, receiver, target, o, obstacles) {
  const row = receiver.inst.model.row;
  const f = receiver.frame;
  const hit = f.toWorld(target.hit);
  const ramp = row.loop[row.loop.length - 1];
  const nozzle = target.mouth;
  let best = null;
  for (let T = 0.55; T <= 2.6; T += 0.05) {
    let dir = unit(sub(hit, pivot));
    let v0;
    let mouth;
    for (let it = 0; it < 4; it++) {
      mouth = add(pivot, dir, o.barrel);
      v0 = [(hit[0] - mouth[0]) / T, (hit[1] - mouth[1] + 0.5 * GRAVITY * T * T) / T, (hit[2] - mouth[2]) / T];
      dir = unit(v0);
    }
    const vIn = [v0[0], v0[1] - GRAVITY * T, v0[2]];
    const slope = Math.atan2(Math.hypot(vIn[0], vIn[2]), -vIn[1]); // angle d'arrivée, depuis la verticale
    if (slope < 0.6 || slope > 1.0 || f.toLocal(add(hit, vIn, -0.1))[2] * row.sign < f.toLocal(hit)[2] * row.sign) continue;
    let ok = true;
    const p = [0, 0, 0];
    for (let s = 0.02; s < T && ok; s += 0.01) {
      p[0] = hit[0] - vIn[0] * s;
      p[1] = hit[1] - vIn[1] * s - 0.5 * GRAVITY * s * s;
      p[2] = hit[2] - vIn[2] * s;
      const q = f.toLocal(p);
      if (tooLow(p, obstacles) || Math.hypot(q[1] - ramp[1], q[2] - ramp[2]) < 0.26 || Math.hypot(q[1] - nozzle[1], q[2] - nozzle[2]) < 0.19) ok = false;
    }
    if (ok && (!best || Math.abs(slope - 0.78) < Math.abs(best.slope - 0.78))) best = { T, v0, mouth, vIn, dir, slope };
  }
  if (!best) return o.debug?.('coupelle hors d\'atteinte') ?? null;
  const strike = {
    hit,
    normal: [0, 1, 0],
    vIn: best.vIn,
    v0: best.v0,
    mouth: best.mouth,
    vOut: f.dirToWorld(target.vOut),
    catch: f.toWorld(target.catch),
    vCatch: f.dirToWorld(target.vCatch),
    flightIn: best.T,
    flightOut: target.flightOut,
  };
  const station = buildStation(strike, { ballRadius: row.ballRadius, feed: [pivot, best.mouth], drain: target.drain.points.map(f.toWorld), hide: o.hide, hideOut: target.hideOut });
  Object.assign(station, { cup: true, cupTravel: target.cupTravel, out0: f.toWorld(target.out0), dir: best.dir });
  return station;
}

function passStation(pivot, receiver, target, o, obstacles = []) {
  const row = receiver.inst.model.row;
  if (row.kind === 'cups') return cupPassStation(pivot, receiver, target, o, obstacles);
  const f = receiver.frame;
  const local = target.hit; // centre de la bille du tir habituel : sur l'axe, à rho devant
  const rho = local[2];
  const [ax, , az] = f.toWorld([local[0], 0, 0]);
  const y = f.toWorld(local)[1];
  const caught = f.toWorld(target.catch);
  const strike = solvePass({ pivot, axis: [ax, az], y, rho, caught, restitution: row.options.restitution, barrel: o.barrel });
  if (!strike) return o.debug?.('pas de solution') ?? null;
  if (strike.flightOut < 0.045 || strike.flightOut > 0.5 || strike.flightIn < 0.45 || strike.flightIn > 2.6) return o.debug?.(`durées ${strike.flightIn.toFixed(2)} ${strike.flightOut.toFixed(2)}`) ?? null;
  // Rebond franc, sur la face avant du cylindre.
  const n = strike.normal;
  if (-dot(unit(strike.vIn), n) < 0.55) return o.debug?.('rasant') ?? null;
  const front = f.dirToWorld([0, 0, 1]);
  if (dot(n, front) < 0.6) return o.debug?.('face arrière') ?? null;
  // Entrée dans le cornet proche de son axe.
  const hornAxis = f.dirToWorld(target.drain.tangentAt(0));
  if (dot(unit(strike.vCatch), hornAxis) < Math.cos(0.3)) return o.debug?.(`cornet ${Math.acos(dot(unit(strike.vCatch), hornAxis)).toFixed(2)}`) ?? null;
  // Le lob passe franchement au-dessus de la rampe des buses et arrive par-dessus le bord de l'estrade.
  const ramp = row.loop[row.loop.length - 1]; // axe de la rampe : [x, y, z] local
  const nozzle = target.mouth; // bouche de la buse habituelle : [x, y, z] local
  const p = [0, 0, 0];
  for (let s = 0.02; s < strike.flightIn; s += 0.01) {
    p[0] = strike.hit[0] - strike.vIn[0] * s;
    p[1] = strike.hit[1] - strike.vIn[1] * s - 0.5 * GRAVITY * s * s;
    p[2] = strike.hit[2] - strike.vIn[2] * s;
    const q = f.toLocal(p);
    // Le lob survole franchement les instruments qu'il croise.
    if (tooLow(p, obstacles)) return o.debug?.('survol') ?? null;
    if (q[2] < 0) return o.debug?.('derrière') ?? null;
    if (q[2] < ramp[2] + 0.7 && (Math.hypot(q[1] - ramp[1], q[2] - ramp[2]) < 0.26 || Math.hypot(q[1] - nozzle[1], q[2] - nozzle[2]) < 0.19)) return o.debug?.('rampe') ?? null;
    if (q[2] < row.extent.maxZ + 0.9 && q[1] < 0.5) return o.debug?.(`bord ${q[2].toFixed(2)} ${q[1].toFixed(2)}`) ?? null;
  }
  const station = buildStation(strike, { ballRadius: row.ballRadius, feed: [pivot, strike.mouth], drain: target.drain.points.map(f.toWorld), hide: o.hide, hideOut: target.hideOut });
  station.dir = strike.dir;
  return station;
}

/** Fenêtres d'échange : une section sur deux, ou une alternance régulière s'il n'y en a qu'une. */
function exchangeWindows(song, ensemble, o) {
  const secs = song.sections;
  // Un échange reste un moment : le début d'une section sur deux, pas la section entière.
  if (secs.length >= 3) return secs.filter((s) => s.index % 2 === 1).map((s) => [s.start, Math.min(s.end, s.start + o.windowMax)]);
  const out = [];
  for (let t = ensemble.start + o.windowOn; t < ensemble.end; t += o.windowOn + o.windowOff) out.push([t, t + o.windowOn]);
  return out;
}

/**
 * Installe les canons de passe et choisit les notes qu'ils servent. Les frappes servies
 * sont retirées des billes habituelles de la rangée (row.shots, station.shots).
 * @returns { cannons: [{ sender, receiver, pivot, base, restDir, launches, shots, ballRadius, before, after, maxBalls }] }
 */
export function planPasses(ensemble, options = {}) {
  const o = { ...PASS_DEFAULTS, ...options };
  const inst = ensemble.instruments;
  const song = analyzeSong(ensemble);
  const windows = exchangeWindows(song, ensemble, o);
  const inWindow = (t) => windows.some(([a, b]) => t >= a && t < b);
  const cannons = [];
  const taken = []; // emplacements de canon déjà pris
  const mounts = new Map(); // un canon (mât, fût) peut servir plusieurs instruments : ses tirs sont communs
  const hub = inst.findIndex((i) => i.kind === 'balls');

  inst.forEach((recv, k) => {
    const row = recv.model.row;
    // Les touches d'un clavier, plates, renverraient la bille de travers : il ne reçoit pas de passes.
    if (!row || row.kind === 'keys') return;
    const frame = frameOf(recv);
    const receiver = { inst: recv, frame };
    const mid = (row.stations[0].hit[0] + row.stations[row.stations.length - 1].hit[0]) / 2;
    const aim = [mid, row.stations[0].hit[1], 0];

    // Instrument qui tire : celui dont l'arrière d'estrade est le mieux placé, devant la rangée.
    let best = null;
    inst.forEach((send, j) => {
      const fp = send.footprint;
      if (j === k || !fp) return;
      const c = Math.cos(fp.yaw);
      const s = Math.sin(fp.yaw);
      const place = (lx, lz) => [fp.center[0] + c * lx + s * lz, fp.center[1] - s * lx + c * lz];
      // Le long du bord arrière, au plus près de l'axe de la rangée visée.
      const target = frame.toWorld(aim);
      const dx = target[0] - fp.center[0];
      const dz = target[2] - fp.center[1];
      const lx = Math.max(-(fp.halfW - 0.3), Math.min(fp.halfW - 0.3, c * dx - s * dz));
      const [x, z] = place(lx, -(fp.halfD + o.behind));
      const q = frame.toLocal([x, 0, z]);
      const range = q[2];
      o.debug?.(`${recv.kind} ← ${send.kind} : portée ${range.toFixed(1)}, latéral ${(q[0] - mid).toFixed(1)}`);
      if (range < o.minRange || range > o.maxRange || Math.abs(Math.atan2(q[0] - mid, range)) > o.maxAzimuth) return;
      // Emplacement libre : hors de toute estrade, loin d'un autre canon.
      const blocked = inst.some((other) => {
        const g = other.footprint;
        if (!g) return false;
        const gc = Math.cos(g.yaw);
        const gs = Math.sin(g.yaw);
        const ox = x - g.center[0];
        const oz = z - g.center[1];
        return Math.abs(gc * ox - gs * oz) < g.halfW + 0.3 && Math.abs(gs * ox + gc * oz) < g.halfD + 0.3;
      });
      if (blocked) o.debug?.(`${send.kind} : emplacement occupé`);
      if (blocked || taken.some((t) => Math.hypot(t[0] - x, t[1] - z) < 0.8)) return;
      if (!best || range < best.range) best = { j, x, z, range };
    });
    // Sinon, le canon central de la tourelle du marimba, d'un bout à l'autre de la scène.
    if (!best && hub >= 0 && hub !== k) {
      const q = frame.toLocal([0, 0, 0]);
      o.debug?.(`${recv.kind} ← tourelle : portée ${q[2].toFixed(1)}, latéral ${(q[0] - mid).toFixed(1)}`);
      if (q[2] >= o.minRange && q[2] <= o.hubRange && Math.abs(Math.atan2(q[0] - mid, q[2])) <= o.maxAzimuth) best = { j: hub, x: 0, z: 0, range: q[2], hub: true };
    }
    if (!best) return;

    // Rotule à la plus petite hauteur d'où la plupart des cibles sont atteignables.
    const obstacles = inst.filter((other, i) => other.footprint && i !== k && i !== best.j).map((other) => other.footprint);
    let stations = null;
    for (const above of best.hub ? [o.hubHeight] : o.pivotAbove) {
      best.pivot = [best.x, (inst[best.j].riser ?? 0) + above, best.z];
      const tried = row.stations.map((target) => passStation(best.pivot, receiver, target, o, obstacles));
      if (tried.filter(Boolean).length >= o.solvable * tried.length) {
        stations = tried;
        break;
      }
    }
    if (!stations) return;
    taken.push([best.pivot[0], best.pivot[2]]);
    const key = best.hub ? 'hub' : cannons.length;
    if (!mounts.has(key)) mounts.set(key, { launches: [] });
    const mount = mounts.get(key);
    const toRow = unit(sub(frame.toWorld(aim), best.pivot));
    const cannon = {
      sender: best.j,
      receiver: k,
      pivot: best.pivot,
      mount: key,
      baseY: best.hub ? o.hubBase : 0,
      restDir: unit([toRow[0], 1.1, toRow[2]]),
      barrel: o.barrel,
      ballRadius: row.ballRadius,
      track: inst[best.j].mainTrack ?? inst[best.j].tracks?.[0] ?? 0,
      stations,
      launches: mount.launches,
      shots: [],
    };

    // Billes de la rangée à l'instant t, en coordonnées de la scène (pour les croisements).
    const p = [0, 0, 0];
    const q = [0, 0, 0];
    const ch = best.hub ? inst[hub].model : null;
    const clear = (station, time, hold) => {
      const need = 2 * row.ballRadius * o.clearance;
      const others = [
        ...row.shots.filter((s) => Math.abs(s.time - time) < 3 && s.time !== time).map((s) => ({ ...s, local: true })),
        ...cannon.shots.filter((s) => Math.abs(s.time - time) < 3),
      ];
      for (let dt = -station.before; dt < station.after + hold; dt += 1 / 120) {
        stationBall(station, dt, p, hold);
        for (const other of others) {
          if (!stationBall(other.station, time + dt - other.time, q, other.hold ?? 0)) continue;
          const w = other.local ? frame.toWorld(q) : q;
          if (Math.hypot(p[0] - w[0], p[1] - w[1], p[2] - w[2]) < need) return false;
        }
        // Le canon central tire au-dessus des billes du marimba : aucune ne doit être sur le passage.
        if (!best.hub) continue;
        const [a, b] = activeBallRange(ch, time + dt);
        for (let i = a; i < b; i++) {
          if (ballScale(ch.balls[i], time + dt) <= 0) continue;
          ballPosition(ch, ch.balls[i], time + dt, q);
          if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < (row.ballRadius + ch.options.ballRadius) * o.clearance) return false;
        }
      }
      return true;
    };

    for (const shot of [...row.shots]) {
      const station = stations[shot.index];
      if (!station || !inWindow(shot.time)) continue;
      const launch = shot.time - station.flightIn;
      if (mount.launches.some((l) => Math.abs(l.time - launch) < o.cannonGap)) continue;
      // Les deux instruments sont en place du tir à la capture.
      const live = (i, t) => deployAt(song, i, t) >= 1;
      if (!live(best.j, launch - o.aimWindow) || !live(k, launch - 0.2) || !live(k, shot.time + 0.5)) continue;
      if (!clear(station, shot.time, shot.hold ?? 0)) continue;
      mount.launches.push({ time: launch, dir: station.dir, velocity: shot.velocity });
      cannon.shots.push({ time: shot.time, track: shot.track, velocity: shot.velocity, station, index: shot.index, hold: shot.hold ?? 0 });
      // La buse habituelle ne tire pas cette note. Une coupelle garde la frappe en mémoire
      // (elle s'enfonce aussi sous une bille de passe), marquée pour que sa buse ne s'allume pas.
      row.shots.splice(row.shots.indexOf(shot), 1);
      const own = row.stations[shot.index].shots;
      const i = own.findIndex((h) => h.time === shot.time);
      if (i >= 0 && row.kind === 'cups') own[i].pass = true;
      else if (i >= 0) own.splice(i, 1);
    }
    if (!cannon.shots.length) return;
    const used = cannon.shots.map((s) => s.station);
    cannon.before = Math.max(...used.map((s) => s.before));
    cannon.after = Math.max(...cannon.shots.map((s) => s.station.after + s.hold));
    cannon.maxBalls = maxConcurrent(cannon.shots);
    cannons.push(cannon);
  });
  for (const mount of mounts.values()) mount.launches.sort((a, b) => a.time - b.time);
  return { options: o, cannons, windows };
}
