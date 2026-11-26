// Traduit les notes, frappes et contrôleurs du morceau en messages MIDI
// pour le lecteur SoundFont (voir soundfont.js) : un canal MIDI par piste.

export const DRUM_CHANNEL = 9;

/** Canaux mélodiques disponibles : tous sauf ceux de batterie (9, 25, 41…). */
function melodicChannel(k) {
  return k + Math.floor((k + 6) / 15);
}

/** Vélocité 0..1 → 1..127. */
const vel = (v) => Math.max(1, Math.min(127, Math.round((v ?? 0.8) * 127)));

/**
 * @param notes [{track, midi, time, held, velocity, program}] ; held = durée touche enfoncée (s)
 * @param drumHits [{midi, time, velocity}]
 * @param tracks pistes du morceau : [{program, ccs: [{time, number, value}], bends: [{time, value}]}]
 * @param lead décalage (s) ajouté à tous les temps
 * @returns { channels: [{channel, program, track}], frames: [{time, msgs}] }
 *   msgs : ['cc', ch, numéro, valeur] | ['bend', ch, 0..16383] | ['off', ch, note] | ['on', ch, note, vélocité]
 *   Dans une même trame : contrôleurs, puis relâchés, puis attaques.
 */
export function buildSynthEvents(notes, drumHits, tracks, lead = 0) {
  const used = [...new Set(notes.map((n) => n.track))].sort((a, b) => a - b);
  const channelOf = new Map(used.map((t, k) => [t, melodicChannel(k)]));
  const channels = used.map((t) => ({ channel: channelOf.get(t), program: tracks[t]?.program ?? 0, track: t }));

  const raw = []; // [time, rang, msg]
  const RANK = { cc: 0, bend: 0, off: 1, on: 2 };
  const push = (time, msg) => raw.push([time + lead, RANK[msg[0]], msg]);

  for (const n of notes) {
    const ch = channelOf.get(n.track);
    push(n.time, ['on', ch, n.midi, vel(n.velocity)]);
    push(n.time + Math.max(0.02, n.held ?? n.duration), ['off', ch, n.midi]);
  }
  for (const h of drumHits) {
    push(h.time, ['on', DRUM_CHANNEL, h.midi, vel(h.velocity)]);
    push(h.time + 0.2, ['off', DRUM_CHANNEL, h.midi]);
  }
  for (const t of used) {
    const ch = channelOf.get(t);
    for (const e of ccsOf(tracks[t])) push(e.time, ['cc', ch, e.number, e.value]);
    for (const e of tracks[t]?.bends ?? []) push(e.time, ['bend', ch, bendValue(e.value)]);
  }

  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const frames = [];
  for (const [time, , msg] of raw) {
    const last = frames[frames.length - 1];
    if (last && Math.abs(last.time - time) < 1e-6) last.msgs.push(msg);
    else frames.push({ time, msgs: [msg] });
  }
  return { channels, frames };
}

/** Contrôleurs bruts de la piste ; à défaut (morceau de démo), pédale et modulation. */
function ccsOf(track) {
  if (!track) return [];
  if (track.ccs) return track.ccs;
  return [
    ...(track.sustain ?? []).map((e) => ({ time: e.time, number: 64, value: e.on ? 127 : 0 })),
    ...(track.mod ?? []).map((e) => ({ time: e.time, number: 1, value: Math.round(e.value * 127) })),
  ];
}

/** Pitch bend −1..1 → 0..16383 (8192 = centre). */
export function bendValue(v) {
  return Math.max(0, Math.min(16383, Math.round(8192 + v * (v < 0 ? 8192 : 8191))));
}

/**
 * État des contrôleurs juste avant l'instant t (même échelle que frames) :
 * à renvoyer au synthé après un saut, pour que volume, pédale, bend… soient justes.
 */
export function controllerStateAt(frames, t) {
  const state = new Map(); // 'cc:ch:n' | 'bend:ch' → message
  for (const f of frames) {
    if (f.time >= t) break;
    for (const m of f.msgs) {
      if (m[0] === 'cc') state.set(`cc:${m[1]}:${m[2]}`, m);
      else if (m[0] === 'bend') state.set(`bend:${m[1]}`, m);
    }
  }
  return [...state.values()];
}
