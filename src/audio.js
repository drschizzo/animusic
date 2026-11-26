import * as Tone from 'tone';

import { SoundFontEngine } from './soundfont.js';
import { buildSynthEvents, controllerStateAt } from './synthEvents.js';

/** Synthés de batterie, un par élément (voir drums.js). */
function createDrumSynths() {
  const out = new Tone.Volume(-4).toDestination();
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.05,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.1 },
  }).connect(out);
  const snareHp = new Tone.Filter(1200, 'highpass').connect(out);
  const snare = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.18, sustain: 0 } }).connect(snareHp);
  snare.volume.value = -8;
  const snareBody = new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 2, envelope: { attack: 0.001, decay: 0.12, sustain: 0 } }).connect(out);
  snareBody.volume.value = -10;
  const metal = (decay, freq, vol) => {
    const s = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay, release: 0.05 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5,
    }).connect(out);
    s.frequency.value = freq;
    s.volume.value = vol;
    return s;
  };
  const tom = (vol) => {
    const s = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3, envelope: { attack: 0.001, decay: 0.35, sustain: 0 } }).connect(out);
    s.volume.value = vol;
    return s;
  };
  const synths = {
    kick: kick,
    snare,
    snareBody,
    hihat: metal(0.07, 300, -22),
    crash: metal(1.2, 250, -20),
    ride: metal(0.6, 450, -24),
    tomHigh: tom(-6),
    tomMid: tom(-6),
    tomLow: tom(-6),
    perc: tom(-14),
  };
  const pitch = { kick: 'C1', tomHigh: 'E2', tomMid: 'C2', tomLow: 'G1', perc: 'E5' };
  return (piece, time, velocity) => {
    switch (piece) {
      case 'snare':
        synths.snare.triggerAttackRelease(0.15, time, velocity);
        synths.snareBody.triggerAttackRelease('G2', 0.1, time, velocity);
        break;
      case 'hihat':
      case 'crash':
      case 'ride':
        synths[piece].triggerAttackRelease(synths[piece].frequency.value, 0.1, time, velocity);
        break;
      default:
        synths[piece].triggerAttackRelease(pitch[piece], 0.2, time, velocity);
    }
  };
}

/**
 * Lecteur audio. L'horloge du transport Tone.js est la référence de temps
 * pour toute l'animation : la scène est dessinée à player.currentTime().
 */
export class Player {
  constructor() {
    // Contexte audio natif : l'enveloppe par défaut de Tone masque outputLatency et
    // getOutputTimestamp, indispensables pour caler l'image sur le son réellement entendu.
    const Native = window.AudioContext || window.webkitAudioContext;
    if (Native) Tone.setContext(new Tone.Context({ context: new Native({ latencyHint: 'interactive' }) }));
    this.rawContext = Tone.getContext().rawContext;
    this.transport = Tone.getTransport();
    this.reverb = new Tone.Reverb({ decay: 2.5, wet: 0.25 }).toDestination();
    // Son de marimba approximatif : FM avec attaque sèche et décroissance rapide.
    this.synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 4,
      modulationIndex: 2.5,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.7, sustain: 0, release: 0.6 },
      modulationEnvelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 },
    }).connect(this.reverb);
    this.synth.maxPolyphony = 64;
    this.synth.volume.value = -10;
    const bass = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: 'sawtooth' },
      filter: { Q: 2, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.001, decay: 0.25, sustain: 0.3, release: 0.3, baseFrequency: 110, octaves: 2.6 },
      envelope: { attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.25 },
    }).toDestination();
    bass.volume.value = -16;
    const pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fattriangle', count: 3, spread: 18 },
      envelope: { attack: 0.12, decay: 0.3, sustain: 0.8, release: 0.7 },
    }).connect(this.reverb);
    pad.maxPolyphony = 32;
    pad.volume.value = -20;
    // Un son par rôle d'instrument (remplacé par des échantillons quand ils sont disponibles).
    this.voices = { mallet: this.synth, bass, pad };
    this.playDrum = createDrumSynths();
    this.parts = [];
    this.lead = 0;
    this.playing = false;
    this.lastDrum = new Map();
    // Lecteur SoundFont (banque General MIDI complète) ; les synthés ci-dessus servent
    // tant qu'il n'est pas chargé, en cas d'échec, ou si l'utilisateur le désactive.
    this.useSamples = true;
    this.limiter = new Tone.Limiter(-1).toDestination();
    this.soundfont = new SoundFontEngine(this.limiter);
    this.sf = { channels: [], frames: [] };
    // Retard supplémentaire (s) réglable par l'utilisateur si le son arrive encore après l'image.
    this.manualOffset = 0;
    this.transport.on('stop', () => {
      this.lastDrum.clear();
      this.soundfont.silence();
      this.soundfont.setup(this.sf.channels);
    });
    this.transport.on('pause', () => this.soundfont.silence());
  }

  /** Le lecteur SoundFont joue-t-il (sinon : synthèse de secours) ? */
  get soundfontOn() {
    return this.useSamples && this.soundfont.ready;
  }

  /**
   * @param notes notes mélodiques [{track,midi,time,duration,held,velocity,voice}]
   *   voice (mallet | bass | pad) : son de synthèse de secours ; duration inclut la pédale,
   *   held est la durée réelle de la touche (le lecteur SoundFont gère la pédale lui-même)
   * @param drumHits frappes [{piece,midi,time,velocity}]
   * @param lead avance (s) laissée avant la première note
   * @param audio AudioBuffer de l'enregistrement original (import audio), ou null
   * @param tracks pistes du morceau (programme General MIDI, contrôleurs, bends)
   */
  load(notes, drumHits, lead, audio = null, tracks = []) {
    this.stop();
    this.parts.forEach((p) => p.dispose());
    this.lead = lead;

    // Enregistrement original : calé sur le transport (pause, saut et vidéo suivent).
    this.original?.dispose();
    this.original = null;
    if (audio) {
      this.original = new Tone.Player(audio).toDestination();
      this.original.sync().start(lead);
    }

    const melodic = notes.map((n) => ({ ...n, time: n.time + lead }));
    const drums = drumHits.map((h) => ({ time: h.time + lead, piece: h.piece, midi: h.midi, velocity: h.velocity }));
    // Les synthés monophoniques refusent deux attaques au même instant (ex. 38 + 40 → caisse claire).
    const last = this.lastDrum;
    last.clear();
    this.sf = buildSynthEvents(notes, drumHits, tracks, lead);
    this.soundfont.setup(this.sf.channels);
    this.parts = [
      new Tone.Part((time, frame) => {
        if (this.soundfontOn) this.soundfont.send(frame.msgs, time);
      }, this.sf.frames).start(0),
      new Tone.Part((time, ev) => {
        if (this.soundfontOn) return;
        const synth = this.voices[ev.voice] ?? this.synth;
        const dur = ev.voice === 'mallet' ? 0.4 : Math.max(0.05, ev.duration);
        synth.triggerAttackRelease(Tone.Frequency(ev.midi, 'midi').toFrequency(), dur, time, ev.velocity);
      }, melodic).start(0),
      new Tone.Part((time, ev) => {
        // Si le navigateur prend du retard, Tone ramène les attaques passées à « maintenant » :
        // on décale légèrement pour garder des instants strictement croissants par synthé.
        if (this.soundfontOn) return;
        const t = Math.max(time, Tone.now(), (last.get(ev.piece) ?? -1) + 0.005);
        last.set(ev.piece, t);
        try {
          this.playDrum(ev.piece, t, ev.velocity);
        } catch (err) {
          console.warn('Frappe ignorée :', err.message);
        }
      }, drums).start(0),
    ];
    this.setListenOriginal(!!audio);
  }

  /** Avec un enregistrement importé : l'entendre lui (true) ou la transcription jouée (false). */
  setListenOriginal(original) {
    this.listenOriginal = original && !!this.original;
    for (const p of this.parts) p.mute = this.listenOriginal;
    if (this.original) this.original.mute = !this.listenOriginal;
  }

  /** Charge le lecteur SoundFont ; renvoie false (synthèse de secours) en cas d'échec. */
  async prepareSounds() {
    try {
      await this.soundfont.load();
    } catch (err) {
      console.warn('Lecteur SoundFont indisponible, synthèse utilisée :', err?.message ?? err);
      return false;
    }
    this.soundfont.setup(this.sf.channels);
    this.restoreControllers();
    return true;
  }

  /** Renvoie au synthé l'état des contrôleurs (volume, pédale, bend…) à la position actuelle. */
  restoreControllers() {
    const msgs = controllerStateAt(this.sf.frames, this.transport.seconds);
    if (!msgs.length) return;
    // Après les messages déjà en file (dont la pédale relevée par silence()).
    this.soundfont.send(msgs, Math.max(Tone.now(), this.rawContext.currentTime, (this.soundfont.queuedUntil ?? 0) + 0.002) + 0.003);
  }

  async play() {
    await Tone.start();
    this.restoreControllers();
    this.transport.start('+0.05');
    this.playing = true;
  }

  pause() {
    // On repart de ce qui a réellement été entendu (et non de l'horloge en avance de Tone).
    const t = this.currentTime();
    this.transport.pause();
    this.transport.seconds = Math.max(0, t + this.lead);
    this.playing = false;
  }

  /** Saute à l'instant musical t (secondes), en lecture comme en pause. */
  seek(t) {
    this.transport.seconds = Math.max(0, t + this.lead);
    this.lastDrum.clear();
    this.soundfont.silence();
    this.restoreControllers();
  }

  stop() {
    this.transport.stop();
    this.transport.seconds = 0;
    this.playing = false;
  }

  /**
   * Instant (horloge AudioContext) actuellement entendu dans les haut-parleurs.
   * Attention : transport.seconds correspond à currentTime + lookAhead (≈ 0,1 s d'avance),
   * et le son met encore outputLatency à sortir (bien plus en Bluetooth).
   */
  audibleContextTime() {
    const ctx = this.rawContext;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      // Échantillon en cours de sortie, extrapolé jusqu'à maintenant (plus fluide que currentTime).
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /** Avance (s) de l'horloge de programmation sur le son entendu, pour information. */
  compensation() {
    return Tone.now() - this.audibleContextTime();
  }

  /**
   * Flux audio du mixage, pour l'enregistrement vidéo. Pendant l'enregistrement,
   * le son est capté à la source (sans latence de sortie) : l'image doit suivre
   * l'horloge de rendu audio et non ce qui sort des haut-parleurs.
   */
  startCapture() {
    this.captureDest ??= this.rawContext.createMediaStreamDestination();
    Tone.getDestination().connect(this.captureDest);
    this.recording = true;
    return this.captureDest.stream;
  }

  stopCapture() {
    if (this.captureDest) Tone.getDestination().disconnect(this.captureDest);
    this.recording = false;
  }

  /** Temps musical (secondes) tel qu'il est entendu : négatif pendant la pré-roll. */
  currentTime() {
    if (this.transport.state !== 'started') return this.transport.seconds - this.lead;
    const audible = this.recording ? this.rawContext.currentTime : this.audibleContextTime() - this.manualOffset;
    return this.transport.getSecondsAtTime(audible) - this.lead;
  }
}
