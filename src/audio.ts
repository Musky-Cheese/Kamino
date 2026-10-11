import * as THREE from "three";

export type BlasterVoice = "player" | "clone" | "droid" | "super";

/** Fully procedural sound: every effect is synthesised with Web Audio, no samples. */
export class GameAudio {
  private ctx?: AudioContext;
  private master!: GainNode;
  private sfx!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private readonly listener = new THREE.Vector3();
  private readonly right = new THREE.Vector3(1, 0, 0);
  private distantTimer = 2;
  private heartbeatTimer = 0;
  volume = .8;

  get ready(): boolean { return !!this.ctx && this.ctx.state === "running"; }

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 4;
    this.master.connect(compressor).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);

    // Metal-city slapback: two filtered feedback delays.
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = .55;
    for (const [time, feedback] of [[.137, .42], [.229, .35]] as const) {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = time;
      const fb = ctx.createGain();
      fb.gain.value = feedback;
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 1800;
      this.reverbSend.connect(delay);
      delay.connect(tone).connect(fb).connect(delay);
      tone.connect(this.master);
    }

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const white = this.noise.getChannelData(0);
    for (let i = 0; i < white.length; i++) white[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const brown = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < brown.length; i++) {
      last = (last + .02 * (Math.random() * 2 - 1)) / 1.02;
      brown[i] = last * 3.5;
    }
    this.startAmbience();
  }

  setVolume(value: number): void {
    this.volume = value;
    if (this.master) this.master.gain.value = value;
  }

  setListener(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.listener.copy(position);
    this.right.set(1, 0, 0).applyQuaternion(quaternion);
  }

  /** Output node for a sound at `position` with distance attenuation, panning and air absorption. */
  private spatial(position: THREE.Vector3 | null, reach = 60, wet = .25): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return null;
    if (!position) {
      const gain = ctx.createGain();
      gain.connect(this.sfx);
      return gain;
    }
    const offset = position.clone().sub(this.listener);
    const distance = offset.length();
    const attenuation = 1 / (1 + (distance / (reach * .15)) ** 1.6);
    if (attenuation < .01) return null;
    const pan = ctx.createStereoPanner();
    pan.pan.value = THREE.MathUtils.clamp(offset.normalize().dot(this.right) * .85, -1, 1);
    const air = ctx.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = THREE.MathUtils.clamp(16000 / (1 + distance * .08), 700, 16000);
    const gain = ctx.createGain();
    gain.gain.value = attenuation;
    gain.connect(air).connect(pan).connect(this.sfx);
    const send = ctx.createGain();
    send.gain.value = wet * (.4 + Math.min(1, distance / 40));
    pan.connect(send).connect(this.reverbSend);
    return gain;
  }

  private envelope(node: AudioNode, peak: number, attack: number, decay: number, at = 0): GainNode {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(.0001, t + attack + decay);
    node.connect(gain);
    return gain;
  }

  private noiseSource(buffer = this.noise, loop = false): AudioBufferSourceNode {
    const source = this.ctx!.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    if (!loop) source.loopStart = 0;
    return source;
  }

  blaster(voice: BlasterVoice, position: THREE.Vector3 | null): void {
    const out = this.spatial(position, voice === "player" ? 80 : 70, .3);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const settings = {
      player: { f0: 1950, f1: 230, dur: .24, gain: .32, detune: .503 },
      clone: { f0: 1750, f1: 210, dur: .24, gain: .3, detune: .497 },
      droid: { f0: 1250, f1: 170, dur: .27, gain: .3, detune: .51 },
      super: { f0: 880, f1: 140, dur: .2, gain: .32, detune: .52 },
    }[voice];
    const jitter = 1 + (Math.random() - .5) * .08;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 3;
    filter.frequency.setValueAtTime(7000, t);
    filter.frequency.exponentialRampToValueAtTime(700, t + settings.dur);
    for (const [type, ratio, level] of [["sawtooth", 1, 1], ["square", settings.detune, .5]] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(settings.f0 * ratio * jitter, t);
      osc.frequency.exponentialRampToValueAtTime(settings.f1 * ratio, t + settings.dur);
      const mod = ctx.createOscillator();
      mod.frequency.value = 55 + Math.random() * 30;
      const depth = ctx.createGain();
      depth.gain.value = settings.f0 * .18 * ratio;
      mod.connect(depth).connect(osc.frequency);
      const level_ = ctx.createGain();
      level_.gain.value = level;
      osc.connect(level_).connect(filter);
      osc.start(t); osc.stop(t + settings.dur + .02);
      mod.start(t); mod.stop(t + settings.dur + .02);
    }
    this.envelope(filter, settings.gain, .003, settings.dur).connect(out);
    const click = this.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    click.connect(hp);
    this.envelope(hp, settings.gain * .5, .001, .04).connect(out);
    click.start(t, Math.random()); click.stop(t + .06);
  }

  impact(position: THREE.Vector3, flesh = false): void {
    const out = this.spatial(position, 30, .2);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const source = this.noiseSource();
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = flesh ? 900 : 3200;
    band.Q.value = 1.2;
    source.connect(band);
    this.envelope(band, flesh ? .35 : .25, .001, flesh ? .09 : .12).connect(out);
    source.start(t, Math.random()); source.stop(t + .2);
    if (!flesh) {
      const ping = ctx.createOscillator();
      ping.type = "sine";
      ping.frequency.setValueAtTime(2400 + Math.random() * 1600, t);
      ping.frequency.exponentialRampToValueAtTime(1500, t + .12);
      this.envelope(ping, .04, .001, .12).connect(out);
      ping.start(t); ping.stop(t + .15);
    }
  }

  /** Metallic clatter when a droid falls apart. */
  droidBreak(position: THREE.Vector3): void {
    const out = this.spatial(position, 40, .25);
    if (!out) return;
    const ctx = this.ctx!;
    for (let i = 0; i < 5; i++) {
      const at = i * (.05 + Math.random() * .08);
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const f = 600 + Math.random() * 1800;
      osc.frequency.setValueAtTime(f, ctx.currentTime + at);
      osc.frequency.exponentialRampToValueAtTime(f * .7, ctx.currentTime + at + .1);
      this.envelope(osc, .07, .001, .12, at).connect(out);
      osc.start(ctx.currentTime + at); osc.stop(ctx.currentTime + at + .2);
    }
    const crunch = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = .8;
    crunch.connect(bp);
    this.envelope(bp, .3, .002, .25).connect(out);
    crunch.start(ctx.currentTime, Math.random()); crunch.stop(ctx.currentTime + .4);
  }

  explosion(position: THREE.Vector3, size = 1): void {
    const out = this.spatial(position, 160, .5);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const source = this.noiseSource(this.brown);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 1.8);
    source.connect(lp);
    this.envelope(lp, 1.4 * size, .005, 2.2).connect(out);
    source.start(t, Math.random() * 2); source.stop(t + 2.5);
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(90, t);
    thump.frequency.exponentialRampToValueAtTime(28, t + .6);
    this.envelope(thump, .9 * size, .003, .7).connect(out);
    thump.start(t); thump.stop(t + .8);
  }

  thunder(distance: number, strength: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const delay = Math.min(5, distance / 343);
    const t = ctx.currentTime + delay;
    const source = this.noiseSource(this.brown);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(distance < 350 ? 900 : 380, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.setValueAtTime(0, t);
    const peak = strength * (distance < 350 ? 1.1 : .6);
    gain.gain.linearRampToValueAtTime(peak, t + .08);
    for (let k = 1; k < 9; k++) gain.gain.linearRampToValueAtTime(peak * (.3 + Math.random() * .7) * (1 - k / 10), t + k * .45);
    gain.gain.exponentialRampToValueAtTime(.0001, t + 5.5);
    source.connect(lp).connect(gain).connect(this.master);
    source.start(t, Math.random()); source.stop(t + 6);
  }

  footstep(sprint: boolean): void {
    const out = this.spatial(null);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const source = this.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = "bandpass";
    hp.frequency.value = 2600 + Math.random() * 1500;
    hp.Q.value = .7;
    source.connect(hp);
    this.envelope(hp, sprint ? .09 : .06, .002, .09).connect(out);
    source.start(t, Math.random()); source.stop(t + .15);
    const clank = ctx.createOscillator();
    clank.type = "triangle";
    clank.frequency.setValueAtTime(190 + Math.random() * 40, t);
    clank.frequency.exponentialRampToValueAtTime(110, t + .07);
    this.envelope(clank, sprint ? .09 : .06, .002, .07).connect(out);
    clank.start(t); clank.stop(t + .1);
  }

  ui(kind: "hit" | "headshot" | "kill" | "hurt" | "reload-out" | "reload-in" | "capture" | "secured" | "alert" | "empty" | "throw" | "beep"): void {
    const out = this.spatial(null);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const tone = (type: OscillatorType, f0: number, f1: number, peak: number, dur: number, at = 0) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t + at);
      osc.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      this.envelope(osc, peak, .002, dur, at).connect(out);
      osc.start(t + at); osc.stop(t + at + dur + .05);
    };
    const burst = (frequency: number, q: number, peak: number, dur: number, at = 0, type: BiquadFilterType = "bandpass") => {
      const source = this.noiseSource();
      const filter = ctx.createBiquadFilter();
      filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
      source.connect(filter);
      this.envelope(filter, peak, .002, dur, at).connect(out);
      source.start(t + at, Math.random()); source.stop(t + at + dur + .05);
    };
    switch (kind) {
      case "hit": tone("square", 2200, 1900, .035, .035); break;
      case "headshot": tone("square", 2600, 2400, .045, .04); tone("sine", 3800, 3600, .04, .08, .03); break;
      case "kill": tone("triangle", 900, 880, .06, .06); tone("triangle", 1350, 1300, .06, .1, .06); break;
      case "hurt": tone("sine", 140, 60, .4, .25); burst(500, .6, .25, .15); break;
      case "reload-out": burst(1800, 2, .15, .05); tone("square", 300, 180, .05, .08, .02); break;
      case "reload-in": burst(2400, 2, .18, .04); tone("square", 520, 900, .05, .1, .05); tone("sine", 1500, 1500, .04, .12, .16); break;
      case "capture": tone("sine", 880, 880, .05, .07); break;
      case "secured": [0, .12, .24].forEach((at, i) => tone("triangle", [660, 880, 1320][i], [660, 880, 1320][i], .09, .22, at)); break;
      case "alert": [0, .28].forEach((at) => tone("sawtooth", 520, 380, .07, .25, at)); break;
      case "empty": tone("square", 400, 300, .05, .05); break;
      case "throw": burst(900, 1, .2, .18, 0, "lowpass"); break;
      case "beep": tone("sine", 2100, 2100, .05, .05); break;
    }
  }

  /** B1 "Roger, roger." – a glottal buzz through moving formant filters. */
  rogerRoger(position: THREE.Vector3): void {
    const out = this.spatial(position, 35, .3);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const glottal = ctx.createOscillator();
    glottal.type = "sawtooth";
    const syllables: Array<[number, number, number, number]> = [
      [175, 520, 1150, .13], [190, 430, 1550, .12], [0, 0, 0, .07], [180, 520, 1150, .13], [168, 430, 1500, .17],
    ];
    const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter();
    f1.type = f2.type = "bandpass";
    f1.Q.value = 7; f2.Q.value = 9;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    let cursor = t;
    for (const [pitch, a, b, dur] of syllables) {
      if (pitch) {
        glottal.frequency.setValueAtTime(pitch, cursor);
        glottal.frequency.linearRampToValueAtTime(pitch * .92, cursor + dur);
        f1.frequency.setValueAtTime(a, cursor);
        f2.frequency.setValueAtTime(b, cursor);
        amp.gain.setTargetAtTime(.5, cursor, .012);
        amp.gain.setTargetAtTime(.05, cursor + dur * .8, .015);
      } else amp.gain.setTargetAtTime(0, cursor, .01);
      cursor += dur;
    }
    amp.gain.setTargetAtTime(0, cursor, .02);
    glottal.connect(f1); glottal.connect(f2);
    const mix = ctx.createGain();
    mix.gain.value = .9;
    f1.connect(mix); f2.connect(mix);
    const radio = ctx.createBiquadFilter();
    radio.type = "highpass"; radio.frequency.value = 380;
    mix.connect(amp).connect(radio).connect(out);
    glottal.start(t); glottal.stop(cursor + .2);
  }

  private startAmbience(): void {
    const ctx = this.ctx!;
    const rain = this.noiseSource(this.noise, true);
    const rainBand = ctx.createBiquadFilter();
    rainBand.type = "highpass"; rainBand.frequency.value = 900;
    const rainGain = ctx.createGain();
    rainGain.gain.value = .07;
    rain.connect(rainBand).connect(rainGain).connect(this.master);
    rain.start();

    const sea = this.noiseSource(this.brown, true);
    const seaLp = ctx.createBiquadFilter();
    seaLp.type = "lowpass"; seaLp.frequency.value = 420;
    const seaGain = ctx.createGain();
    seaGain.gain.value = .16;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = .09;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = .09;
    lfo.connect(lfoDepth).connect(seaGain.gain);
    sea.connect(seaLp).connect(seaGain).connect(this.master);
    sea.start(); lfo.start();

    const wind = this.noiseSource(this.noise, true);
    const windBand = ctx.createBiquadFilter();
    windBand.type = "bandpass"; windBand.frequency.value = 500; windBand.Q.value = 2.5;
    const windLfo = ctx.createOscillator();
    windLfo.frequency.value = .05;
    const windDepth = ctx.createGain();
    windDepth.gain.value = 260;
    windLfo.connect(windDepth).connect(windBand.frequency);
    const windGain = ctx.createGain();
    windGain.gain.value = .045;
    wind.connect(windBand).connect(windGain).connect(this.master);
    wind.start(); windLfo.start();
  }

  /** Distant battle elsewhere in Tipoca City, and a heartbeat when hurt. */
  update(delta: number, health: number, inCombat: boolean): void {
    if (!this.ready) return;
    this.distantTimer -= delta;
    if (this.distantTimer <= 0) {
      this.distantTimer = .35 + Math.random() * (inCombat ? 2.2 : 1.2);
      const angle = Math.random() * Math.PI * 2;
      const where = this.listener.clone().add(new THREE.Vector3(Math.cos(angle) * 140, 10, Math.sin(angle) * 140));
      if (Math.random() < .12) this.explosion(where, .7);
      else {
        const burst = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < burst; i++) setTimeout(() => this.blaster(Math.random() < .5 ? "droid" : "clone", where), i * 140);
      }
    }
    if (health < 35 && health > 0) {
      this.heartbeatTimer -= delta;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = .85;
        const out = this.spatial(null);
        if (out) {
          const ctx = this.ctx!;
          for (const at of [0, .16]) {
            const osc = ctx.createOscillator();
            osc.frequency.setValueAtTime(65, ctx.currentTime + at);
            osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + at + .12);
            this.envelope(osc, .5, .005, .13, at).connect(out);
            osc.start(ctx.currentTime + at); osc.stop(ctx.currentTime + at + .2);
          }
        }
      }
    }
  }
}
