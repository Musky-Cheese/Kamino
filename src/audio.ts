import * as THREE from "three";

export type BlasterVoice = "player" | "clone" | "droid" | "super";
export type DroidLine = "roger" | "retreat" | "uhoh";

/**
 * Recorded samples in public/audio/ (see the Credits in README.md), each with a few takes so
 * repeats don't sound identical. Anything not yet loaded, or that fails to decode, falls back to
 * the procedural synth below.
 */
const SAMPLES: Record<string, string[]> = {
  // One recorded shot per side; take-to-take variety comes from pitch jitter and the synth layers below.
  blaster: ["clone-blaster.mp3"],
  droidBlaster: ["droid-blaster.mp3"],
  hitMetal: ["hit-metal-1.ogg", "hit-metal-2.ogg", "hit-metal-3.ogg"],
  hitArmor: ["hit-armor-1.ogg", "hit-armor-2.ogg", "hit-armor-3.ogg"],
  break: ["break-1.ogg", "break-2.ogg", "break-3.ogg"],
  clatter: ["clatter-1.ogg", "clatter-2.ogg"],
  step: ["step-1.ogg", "step-2.ogg", "step-3.ogg", "step-4.ogg", "step-5.ogg"],
  roger: ["droid-roger.wav"],
  retreat: ["droid-retreat.wav"],
  uhoh: ["droid-uhoh.wav"],
};

/** Overlapping shots beyond this are dropped (distant ones first) so big firefights don't swamp the mix. */
const MAX_SHOTS = 14;

/** Web Audio sound: recorded samples for weapons and droids, synthesis for ambience and UI. */
export class GameAudio {
  private ctx?: AudioContext;
  private readonly samples = new Map<string, AudioBuffer[]>();
  private readonly lastTake = new Map<string, number>();
  private activeShots = 0;
  private driveCurve?: Float32Array<ArrayBuffer>;
  private master!: GainNode;
  private sfx!: GainNode;
  private reverbSend!: GainNode;
  /** Rain, wind, sea and thunder: muffled through the walls when the player is indoors. */
  private outdoor!: GainNode;
  private outdoorTone!: BiquadFilterNode;
  /** Hard-walled room reverb, faded in indoors. */
  private roomSend!: GainNode;
  private room!: GainNode;
  private indoor = 0;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private readonly listener = new THREE.Vector3();
  private readonly right = new THREE.Vector3(1, 0, 0);
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

    this.outdoorTone = ctx.createBiquadFilter();
    this.outdoorTone.type = "lowpass";
    this.outdoorTone.frequency.value = 18000;
    this.outdoor = ctx.createGain();
    this.outdoorTone.connect(this.outdoor).connect(this.master);

    // Indoor room: a short, bright decay built from noise, so shots ring off the walls.
    const convolver = ctx.createConvolver();
    const length = Math.floor(ctx.sampleRate * 1.3);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6;
    }
    convolver.buffer = impulse;
    this.roomSend = ctx.createGain();
    this.room = ctx.createGain();
    this.room.gain.value = 0;
    this.roomSend.connect(convolver).connect(this.room).connect(this.master);

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
    void this.loadSamples(ctx);
  }

  private async loadSamples(ctx: AudioContext): Promise<void> {
    await Promise.all(Object.entries(SAMPLES).map(async ([name, files]) => {
      const takes = await Promise.all(files.map(async (file) => {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}audio/${file}`);
          if (!response.ok) return null;
          return await ctx.decodeAudioData(await response.arrayBuffer());
        } catch {
          return null;
        }
      }));
      const loaded = takes.filter((take): take is AudioBuffer => !!take);
      if (loaded.length) this.samples.set(name, loaded);
    }));
  }

  /** Play a random take of `name` (never the same take twice running); null if it isn't loaded. */
  private sample(name: string, out: AudioNode, rate = 1, gain = 1, at = 0, vary = .06): AudioBufferSourceNode | null {
    const takes = this.samples.get(name);
    if (!takes) return null;
    const ctx = this.ctx!;
    let index = Math.floor(Math.random() * takes.length);
    if (takes.length > 1 && index === this.lastTake.get(name)) index = (index + 1) % takes.length;
    this.lastTake.set(name, index);
    const source = ctx.createBufferSource();
    source.buffer = takes[index];
    source.playbackRate.value = rate * (1 + (Math.random() - .5) * vary);
    const level = ctx.createGain();
    level.gain.value = gain;
    source.connect(level).connect(out);
    source.start(ctx.currentTime + at);
    return source;
  }

  setVolume(value: number): void {
    this.volume = value;
    if (this.master) this.master.gain.value = value;
  }

  setListener(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.listener.copy(position);
    this.right.set(1, 0, 0).applyQuaternion(quaternion);
  }

  /** 0 outside, 1 under a roof: muffles the storm and brings up the room reverb. */
  setIndoor(amount: number): void {
    this.indoor = amount;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.outdoorTone.frequency.setTargetAtTime(THREE.MathUtils.lerp(18000, 650, amount), t, .1);
    this.outdoor.gain.setTargetAtTime(1 - amount * .55, t, .1);
    this.room.gain.setTargetAtTime(amount * .5, t, .1);
  }

  /** Heavy blast door grinding open. */
  door(position: THREE.Vector3): void {
    const out = this.spatial(position, 60, .5);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const rumble = this.noiseSource(this.brown);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 260;
    rumble.connect(lp);
    this.envelope(lp, 1.6, .25, 2.2).connect(out);
    rumble.start(t); rumble.stop(t + 2.6);
    const hiss = this.noiseSource(this.noise);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = .8;
    hiss.connect(bp);
    this.envelope(bp, .25, .02, .6).connect(out);
    hiss.start(t); hiss.stop(t + .8);
    const clunk = ctx.createOscillator();
    clunk.type = "triangle";
    clunk.frequency.setValueAtTime(70, t + 2.1);
    clunk.frequency.exponentialRampToValueAtTime(38, t + 2.4);
    this.envelope(clunk, .7, .01, .35, 2.1).connect(out);
    clunk.start(t + 2.1); clunk.stop(t + 2.6);
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
    send.gain.value = wet * (.4 + Math.min(1, distance / 40)) * (1 - this.indoor * .6);
    pan.connect(send).connect(this.reverbSend);
    if (this.indoor > .05) {
      const roomSend = ctx.createGain();
      roomSend.gain.value = (wet + .15) * this.indoor;
      pan.connect(roomSend).connect(this.roomSend);
    }
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
    if (this.activeShots >= MAX_SHOTS && voice !== "player") return;
    const out = this.spatial(position, voice === "player" ? 80 : 70, .3);
    if (!out) return;
    // Under load, distant shots give way so the nearby ones stay clear.
    if (this.activeShots >= MAX_SHOTS / 2 && voice !== "player" && (out as GainNode).gain.value < .25) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // Clones and the player fire the DC-15 recording; B1 rifles the E-5 one, B2 wrist guns the same pitched down.
    const [rate, level] = { player: [1, .55], clone: [1.05, .42], droid: [1, .48], super: [.8, .55] }[voice];
    const shot = this.sample(voice === "droid" || voice === "super" ? "droidBlaster" : "blaster", out, rate, level, 0, .14);
    if (shot) {
      this.activeShots++;
      shot.onended = () => this.activeShots--;
      // A sharp muzzle crack on top of the bolt, and some weight under the heavier guns.
      const crack = this.noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 3000;
      crack.connect(hp);
      this.envelope(hp, .08, .001, .025).connect(out);
      crack.start(t, Math.random()); crack.stop(t + .05);
      if (voice === "player" || voice === "super") {
        const body = ctx.createOscillator();
        body.frequency.setValueAtTime(130, t);
        body.frequency.exponentialRampToValueAtTime(48, t + .08);
        this.envelope(body, voice === "player" ? .35 : .25, .002, .09).connect(out);
        body.start(t); body.stop(t + .12);
      }
      return;
    }
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
    if (this.sample(flesh ? "hitArmor" : "hitMetal", out, .9 + Math.random() * .25, flesh ? .55 : .3, 0, .1)) return;
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
  droidBreak(position: THREE.Vector3, heavy = false): void {
    const out = this.spatial(position, 40, .25);
    if (!out) return;
    if (this.sample("break", out, heavy ? .75 : 1, .65)) {
      // Limbs and plating rattling onto the deck.
      this.sample("clatter", out, 1 + Math.random() * .3, .4, .07 + Math.random() * .05, .15);
      this.sample("hitMetal", out, .7 + Math.random() * .3, .25, .18 + Math.random() * .1, .2);
      return;
    }
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
    source.connect(lp).connect(gain).connect(this.outdoorTone);
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

  /** A bolt snapping past the helmet. */
  whizz(position: THREE.Vector3): void {
    const out = this.spatial(position, 20, .1);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(2600 + Math.random() * 800, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + .16);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass"; band.frequency.value = 2200; band.Q.value = 1.4;
    osc.connect(band);
    this.envelope(band, .16, .004, .16).connect(out);
    osc.start(t); osc.stop(t + .2);
  }

  /** Starfighter passing overhead: a falling engine whine over a rushing roar. */
  flyby(position: THREE.Vector3): void {
    const out = this.spatial(position, 220, .35);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const roar = this.noiseSource(this.brown);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = .9;
    band.frequency.setValueAtTime(1400, t);
    band.frequency.exponentialRampToValueAtTime(260, t + 2.2);
    roar.connect(band);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(.0001, t);
    gain.gain.exponentialRampToValueAtTime(1.1, t + .7);
    gain.gain.exponentialRampToValueAtTime(.0001, t + 2.4);
    band.connect(gain).connect(out);
    roar.start(t, Math.random()); roar.stop(t + 2.5);
    const whine = ctx.createOscillator();
    whine.type = "sawtooth";
    whine.frequency.setValueAtTime(820, t);
    whine.frequency.exponentialRampToValueAtTime(330, t + 2);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1800;
    whine.connect(lp);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(.0001, t);
    wg.gain.exponentialRampToValueAtTime(.08, t + .6);
    wg.gain.exponentialRampToValueAtTime(.0001, t + 2.1);
    lp.connect(wg).connect(out);
    whine.start(t); whine.stop(t + 2.2);
  }

  /** One droid foot hitting the deck: a tinny tap for B1s, a heavy clank for B2s. */
  droidStep(position: THREE.Vector3, heavy: boolean): void {
    const out = this.spatial(position, 18, .15);
    if (!out) return;
    if (!this.sample("step", out, heavy ? .6 : 1.3, heavy ? .55 : .3, 0, .12)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const ring = ctx.createOscillator();
    ring.type = "triangle";
    ring.frequency.value = heavy ? 220 + Math.random() * 40 : 1300 + Math.random() * 400;
    this.envelope(ring, heavy ? .06 : .025, .001, heavy ? .12 : .04).connect(out);
    ring.start(t); ring.stop(t + .15);
  }

  /**
   * B1 radio chatter: recorded speech (see README) pitched up and pushed through a nasal band
   * and a little saturation. Falls back to the formant synth for "roger".
   */
  droidLine(line: DroidLine, position: THREE.Vector3): void {
    const out = this.spatial(position, 35, .3);
    if (!out) return;
    if (!this.samples.has(line)) {
      if (line === "roger") this.rogerSynth(out);
      return;
    }
    const ctx = this.ctx!;
    if (!this.driveCurve) {
      this.driveCurve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) this.driveCurve[i] = Math.tanh((i / 511.5 - 1) * 2.6);
    }
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass"; highpass.frequency.value = 480;
    const nasal = ctx.createBiquadFilter();
    nasal.type = "peaking"; nasal.frequency.value = 1700; nasal.Q.value = 1.4; nasal.gain.value = 9;
    const drive = ctx.createWaveShaper();
    drive.curve = this.driveCurve;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass"; lowpass.frequency.value = 4500;
    highpass.connect(nasal).connect(drive).connect(lowpass).connect(out);
    this.sample(line, highpass, 1.2, .8, 0, .05);
  }

  /** "Roger, roger." – a glottal buzz through moving formant filters. */
  private rogerSynth(out: AudioNode): void {
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

  /** Six seconds of stereo rain, built drop by drop so it loops without an audible seam. */
  private rainBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const buffer = ctx.createBuffer(2, rate * 6, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      const length = data.length;
      const drop = (start: number, frequency: number, decay: number, amplitude: number) => {
        const w = 2 * Math.PI * frequency / rate;
        const n = Math.ceil(decay * rate * 5);
        for (let i = 0; i < n; i++) data[(start + i) % length] += amplitude * Math.sin(w * i) * Math.exp(-i / (decay * rate));
      };
      // Fine patter, most drops faint: amplitude falls off with a power law.
      for (let i = 0; i < 6 * 420; i++) drop(Math.floor(Math.random() * length), 2200 + Math.random() * 5500, .0012 + Math.random() * .002, .5 * Math.random() ** 3);
      // Heavier drips off railings and hull plates.
      for (let i = 0; i < 6 * 5; i++) drop(Math.floor(Math.random() * length), 900 + Math.random() * 1800, .012 + Math.random() * .02, .12 + Math.random() * .2);
      // A soft wash underneath so the gaps aren't dead silence.
      let low = 0;
      for (let i = 0; i < length; i++) {
        low += .35 * ((Math.random() * 2 - 1) - low);
        data[i] += low * .05;
      }
    }
    return buffer;
  }

  private startAmbience(): void {
    const ctx = this.ctx!;
    // Steady drizzle: thousands of tiny droplet ticks plus the odd fat drip ringing on metal,
    // breathing with the wind gusts instead of a flat hiss.
    const rain = this.noiseSource(this.rainBuffer(), true);
    const rainTone = ctx.createBiquadFilter();
    rainTone.type = "lowpass"; rainTone.frequency.value = 9000;
    const rainGain = ctx.createGain();
    rainGain.gain.value = .12;
    const gust = ctx.createOscillator();
    gust.frequency.value = .07;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = .035;
    gust.connect(gustDepth).connect(rainGain.gain);
    rain.connect(rainTone).connect(rainGain).connect(this.outdoorTone);
    rain.start(); gust.start();

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
    sea.connect(seaLp).connect(seaGain).connect(this.outdoorTone);
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
    wind.connect(windBand).connect(windGain).connect(this.outdoorTone);
    wind.start(); windLfo.start();
  }

  /** Heartbeat when badly hurt. (Distant battle sounds are driven by the game's ambient battle.) */
  update(delta: number, health: number): void {
    if (!this.ready) return;
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
