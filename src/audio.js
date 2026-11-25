import * as Tone from 'tone';

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
    this.part = null;
    this.lead = 0;
    this.playing = false;
  }

  /** notes : [{midi,time,velocity}], lead : avance (s) laissée avant la 1re note. */
  load(notes, lead) {
    this.stop();
    if (this.part) this.part.dispose();
    this.lead = lead;
    const events = notes.map((n) => ({ time: n.time + lead, midi: n.midi, velocity: n.velocity }));
    this.part = new Tone.Part((time, ev) => {
      this.synth.triggerAttackRelease(Tone.Frequency(ev.midi, 'midi').toFrequency(), 0.4, time, ev.velocity);
    }, events).start(0);
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
