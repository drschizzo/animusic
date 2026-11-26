import * as Tone from 'tone';
import { WorkletSynthesizer } from 'spessasynth_lib';
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url';
import { DRUM_CHANNEL } from './synthEvents.js';

// Banque General MIDI (MuseScore General, licence MIT, voir public/soundfonts/LICENSE.md).
const BANK_URL = `${import.meta.env?.BASE_URL ?? './'}soundfonts/MuseScore_General.sf3`;

/**
 * Lecteur SoundFont (SpessaSynth, dans un AudioWorklet) : joue les messages MIDI
 * préparés par synthEvents.js, programmés à l'instant exact donné par le transport Tone.
 * Boucles, enveloppes, couches de vélocité, pédale, bends, panoramique, réverbération
 * et chorus sont ceux de la banque.
 */
export class SoundFontEngine {
  /** @param output nœud Tone dans lequel le synthé se déverse */
  constructor(output) {
    this.output = output;
    this.synth = null;
    this.loading = null;
    // Attaques envoyées en avance (le transport programme ~0,1 s à l'avance) :
    // la file du synthé les jouerait même après une pause ou un saut.
    this.pending = [];
  }

  /** Charge le processeur et la banque (une seule fois). Rejette en cas d'échec. */
  load() {
    this.loading ??= (async () => {
      const ctx = Tone.getContext().rawContext;
      await ctx.audioWorklet.addModule(processorUrl);
      const synth = new WorkletSynthesizer(ctx);
      const res = await fetch(BANK_URL);
      if (!res.ok) throw new Error(`banque SoundFont : HTTP ${res.status}`);
      await synth.soundBankManager.addSoundBank(await res.arrayBuffer(), 'main');
      await synth.isReady;
      const tap = ctx.createGain();
      synth.connect(tap);
      Tone.connect(tap, this.output);
      this.synth = synth;
      return synth;
    })();
    return this.loading;
  }

  get ready() {
    return !!this.synth;
  }

  /** Remet les canaux à zéro et leur attribue leur instrument. */
  setup(channels) {
    const s = this.synth;
    if (!s) return;
    s.stopAll(true);
    s.reset();
    const needed = Math.max(DRUM_CHANNEL, ...channels.map((c) => c.channel)) + 1;
    while (s.midiChannels.length < needed) s.addNewChannel();
    for (const { channel, program } of channels) s.programChange(channel, program);
  }

  /** Envoie une trame de messages (voir buildSynthEvents) à l'instant time (horloge AudioContext). */
  send(msgs, time) {
    const s = this.synth;
    if (!s) return;
    const opt = time === undefined ? undefined : { time };
    if (time !== undefined) this.queuedUntil = Math.max(this.queuedUntil ?? 0, time);
    if (this.pending.length > 64) this.pending = this.pending.filter((p) => p.time > s.currentTime - 0.5);
    for (const m of msgs) {
      switch (m[0]) {
        case 'on':
          s.noteOn(m[1], m[2], m[3], opt);
          if (time !== undefined) this.pending.push({ channel: m[1], note: m[2], time });
          break;
        case 'off':
          s.noteOff(m[1], m[2], opt);
          break;
        case 'cc':
          s.controllerChange(m[1], m[2], m[3], opt);
          break;
        case 'bend':
          s.pitchWheel(m[1], m[2], opt);
          break;
      }
    }
  }

  /** Coupe tout ce qui sonne (pause, saut, arrêt), avec le relâché naturel des notes. */
  silence(force = false) {
    const s = this.synth;
    if (!s) return;
    // La pédale de sustain retiendrait les notes relâchées : on la relève (restoreControllers
    // la remet à la reprise).
    // Aussi après les messages encore en file, qui pourraient la renfoncer.
    const later = Math.max(s.currentTime, this.queuedUntil ?? 0) + 0.002;
    for (let ch = 0; ch < s.midiChannels.length; ch++) {
      s.controllerChange(ch, 64, 0);
      s.controllerChange(ch, 64, 0, { time: later });
    }
    s.stopAll(force);
    // Les attaques récentes reçoivent un relâché : celles encore en file, mais aussi celles
    // dont l'heure vient de passer (le processeur peut ne les jouer qu'après stopAll).
    for (const p of this.pending) s.noteOff(p.channel, p.note, { time: later });
    this.pending = [];
  }
}
