import * as Tone from 'tone';

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
    this.playDrum = createDrumSynths();
    this.parts = [];
    this.lead = 0;
    this.playing = false;
    this.lastDrum = new Map();
    this.transport.on('stop', () => this.lastDrum.clear());
  }

  /**
   * @param notes notes mélodiques [{midi,time,velocity}]
   * @param drumHits frappes [{piece,time,velocity}]
   * @param lead avance (s) laissée avant la première note
   */
  load(notes, drumHits, lead) {
    this.stop();
    this.parts.forEach((p) => p.dispose());
    this.lead = lead;

    const melodic = notes.map((n) => ({ time: n.time + lead, midi: n.midi, velocity: n.velocity }));
    const drums = drumHits.map((h) => ({ time: h.time + lead, piece: h.piece, velocity: h.velocity }));
    // Les synthés monophoniques refusent deux attaques au même instant (ex. 38 + 40 → caisse claire).
    const last = this.lastDrum;
    last.clear();
    this.parts = [
      new Tone.Part((time, ev) => {
        this.synth.triggerAttackRelease(Tone.Frequency(ev.midi, 'midi').toFrequency(), 0.4, time, ev.velocity);
      }, melodic).start(0),
      new Tone.Part((time, ev) => {
        // Si le navigateur prend du retard, Tone ramène les attaques passées à « maintenant » :
        // on décale légèrement pour garder des instants strictement croissants par synthé.
        const t = Math.max(time, Tone.now(), (last.get(ev.piece) ?? -1) + 0.005);
        last.set(ev.piece, t);
        try {
          this.playDrum(ev.piece, t, ev.velocity);
        } catch (err) {
          console.warn('Frappe ignorée :', err.message);
        }
      }, drums).start(0),
    ];
  }

  async play() {
    await Tone.start();
    this.transport.start('+0.05');
    this.playing = true;
  }

  pause() {
    this.transport.pause();
    this.playing = false;
  }

  stop() {
    this.transport.stop();
    this.transport.seconds = 0;
    this.playing = false;
  }

  /** Temps musical (secondes) : négatif pendant la pré-roll. */
  currentTime() {
    return this.transport.seconds - this.lead;
  }
}
