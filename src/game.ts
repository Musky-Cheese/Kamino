import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import type { ActorKind } from "./actors";
import { GameAudio } from "./audio";
import { Actor, Battle, type Target } from "./battle";
import { BRIDGES, LANDER, PHASES, PLAYER_START, ZONES, type PhaseSpec, type Quality } from "./config";
import { BOLT_COLORS, Effects } from "./effects";
import { Environment } from "./environment";
import { Materials } from "./materials";
import { WetReflections } from "./reflections";
import { STEP_HEIGHT } from "./navigation";
import { Viewmodel } from "./weapon";
import { World } from "./world";

const EYE_HEIGHT = 1.66;
const CROUCH_EYE = 1.08;
const PLAYER_RADIUS = .36;
const MAGAZINE = 50;
const FIRE_INTERVAL = .118;
const RELOAD_TIME = 1.65;
const MAX_GRENADES = 4;
const SQUAD_SIZE = 4;

type PhaseRuntime = {
  index: number;
  spec: PhaseSpec;
  spawned: number;
  supers: number;
  killed: number;
  state: "fight" | "capture" | "secured";
  reinforceTimer: number;
  capture: number;
  nextDeployed: boolean;
};

type Grenade = { mesh: THREE.Group; light: THREE.Mesh; velocity: THREE.Vector3; fuse: number; beep: number };

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uDamage: { value: 0 },
    uLowHealth: { value: 0 },
    uFlash: { value: 0 },
    uAds: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uDamage, uLowHealth, uFlash, uAds;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 7.31) * 43758.5453); }
    void main() {
      vec2 c = vUv - .5;
      float r2 = dot(c, c);
      float ca = (.0012 + uDamage * .006) * (1. + r2 * 4.);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + c * ca).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - c * ca).b;
      float luma = dot(col, vec3(.299, .587, .114));
      // Cool shadows, slightly warm highlights.
      col += vec3(-.006, .004, .014) * (1. - luma);
      col = mix(col, col * vec3(1.03, 1., .96), smoothstep(.4, .9, luma));
      float desat = uLowHealth * .55;
      col = mix(col, vec3(luma), desat);
      col += vec3(.55, .02, 0.) * uLowHealth * smoothstep(.12, .5, r2) * (.55 + .45 * sin(uTime * 7.));
      col *= 1. - smoothstep(.18, .75, r2) * (.55 + uAds * .25);
      col += uFlash * vec3(.05, .07, .09);
      col += (hash(vUv * 931.) - .5) * .028;
      gl_FragColor = vec4(col, 1.);
    }`,
};

/** Yield so the loading screen can repaint. Timer-based so it still progresses in a background tab. */
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

export class KaminoGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, .03, 2600);
  private readonly renderer: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private grade!: ShaderPass;
  private readonly controls: PointerLockControls;
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly audio = new GameAudio();
  private readonly viewmodel = new Viewmodel();
  private readonly reflections = new WetReflections();
  private readonly keys = new Set<string>();
  private readonly fog = new THREE.FogExp2(0x0b1b25, .0085);
  private readonly hemi = new THREE.HemisphereLight(0x7aa4bb, 0x06090c, .55);
  private readonly moon = new THREE.DirectionalLight(0xa9d2ff, 1.35);
  private materials!: Materials;
  private world!: World;
  private env!: Environment;
  private effects!: Effects;
  private battle!: Battle;

  // Player state.
  private readonly feet = PLAYER_START.clone();
  private readonly velocity = new THREE.Vector3();
  private readonly player: Target = { position: this.feet, velocity: this.velocity, height: 1.78, radius: .4, alive: true, team: "republic", isPlayer: true };
  private grounded = true;
  private crouch = 0;
  private health = 100;
  private lastHurt = -10;
  private ammo = MAGAZINE;
  private reloadStart = -1;
  private nextShot = 0;
  private firing = false;
  private aiming = false;
  private ads = 0;
  private bloomSpread = 0;
  private recoilPitch = 0;
  private grenades = 3;
  private readonly thrown: Grenade[] = [];
  private throwStart = -10;
  private bob = 0;
  private lastStep = 0;
  private lookX = 0;
  private lookY = 0;
  private time = 0;
  private missionTime = 0;
  private dead = false;
  private deathTime = 0;

  // Mission state.
  private started = false;
  private ended = false;
  private paused = false;
  private phase!: PhaseRuntime;
  private front = 0;
  private kills = 0;
  private headshots = 0;
  private shotsFired = 0;
  private shotsHit = 0;
  private alliesLost = 0;
  private quality: Quality;
  private testMode = new URLSearchParams(location.search).has("test");
  private radioQueue: Array<{ from: string; text: string }> = [];
  private radioTimer = 0;
  private bannerTimer = 0;
  private hitMarkerTimer = 0;
  private lowHealthWarned = false;
  private readonly scheduled: Array<{ at: number; task: () => void }> = [];
  private ambientTimer = 1.5;
  private readonly perf = { frames: 0, elapsed: 0, checked: false, last: -1 };

  private readonly $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

  constructor(private readonly root: HTMLElement) {
    // Default to High; the performance watchdog steps down once if the machine struggles.
    this.quality = (localStorage.getItem("kamino.quality") as Quality | null) ?? "high";
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = .85;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.root.prepend(this.renderer.domElement);
    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);
    this.camera.rotation.order = "YXZ";
  }

  async initialize(): Promise<void> {
    const progress = async (fraction: number, text: string) => {
      this.$("#load-bar").style.width = `${fraction * 100}%`;
      this.$("#load-text").textContent = text;
      await nextFrame();
    };
    await progress(.05, "Forging hull plating…");
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x05101a);
    this.materials = new Materials(this.renderer.capabilities.getMaxAnisotropy());
    this.reflections.patch(this.materials.deck);
    this.reflections.patch(this.materials.deckDark);
    await progress(.35, "Raising Tipoca City…");
    this.world = new World(this.scene, this.materials);
    this.world.build();
    await progress(.6, "Summoning the storm…");
    this.env = new Environment(this.scene, (x, z) => this.world.nav.groundAt(x, z));
    this.scene.environment = this.env.createEnvironmentMap(this.renderer);
    this.scene.environmentIntensity = .65;
    this.env.onThunder = (distance, strength) => this.audio.thunder(distance, strength);
    this.buildLighting();
    this.effects = new Effects(this.scene, this.world.nav);
    this.battle = new Battle(this.scene, this.world, this.effects, this.audio, this.player, {
      droidKilled: (actor, byPlayer, headshot) => this.onDroidKilled(actor, byPlayer, headshot),
      cloneKilled: () => this.onCloneKilled(),
      playerHit: (damage, from) => this.hurt(damage, from),
      nearMiss: (position) => { this.effects.addShake(.08); this.audio.whizz(position); },
      droidHitByPlayer: () => undefined,
    });
    await progress(.75, "Deploying the clone army…");
    this.camera.add(this.viewmodel.root);
    this.scene.add(this.camera);
    this.camera.position.copy(this.feet).setY(this.feet.y + EYE_HEIGHT);
    this.camera.lookAt(0, 1.5, 30);
    this.setupMission();
    await progress(.88, "Compiling shaders…");
    this.createPostProcessing();
    this.applyQuality(this.quality);
    this.renderer.compile(this.scene, this.camera);
    this.bindEvents();
    this.buildFrontHud();
    this.updateHud();
    await progress(1, "Ready");
    this.renderer.setAnimationLoop(() => this.frame());
    this.$("#loading").classList.add("fade");
    setTimeout(() => this.$("#loading").classList.add("hidden"), 700);
    if (this.testMode) this.start();
    else this.$("#menu").classList.remove("hidden");
    (window as unknown as { kamino: unknown }).kamino = this;
  }

  // ------------------------------------------------------------------ setup

  private buildLighting(): void {
    this.scene.add(this.hemi);
    this.moon.position.set(-60, 90, 40);
    this.moon.castShadow = true;
    this.moon.shadow.bias = -.0004;
    this.moon.shadow.normalBias = .04;
    const cam = this.moon.shadow.camera;
    cam.left = -48; cam.right = 48; cam.top = 48; cam.bottom = -48; cam.near = 10; cam.far = 260;
    this.scene.add(this.moon, this.moon.target);
  }

  private createPostProcessing(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.quality === "low" ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Very glossy wet metal under bright lights can overflow half floats; one Inf/NaN pixel would
    // otherwise be smeared across the whole frame by bloom.
    this.composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: GRADE_SHADER.vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          // isnan() can be compiled away on some drivers, so also test the bit pattern range.
          bool bad = any(isnan(c)) || any(isinf(c)) || !(c.r <= 65000. && c.g <= 65000. && c.b <= 65000.);
          if (bad) c = vec4(0., 0., 0., 1.);
          gl_FragColor = vec4(clamp(c.rgb, vec3(0.), vec3(40.)), c.a);
        }`,
    }));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), .38, .45, 1);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GRADE_SHADER);
    this.composer.addPass(this.grade);
  }

  private applyQuality(quality: Quality): void {
    this.quality = quality;
    localStorage.setItem("kamino.quality", quality);
    document.querySelectorAll<HTMLSelectElement>(".quality-select").forEach((select) => select.value = quality);
    const ratio = quality === "high" ? Math.min(devicePixelRatio * 1.25, 2) : quality === "medium" ? Math.min(devicePixelRatio, 1.25) : Math.min(devicePixelRatio, 1) * .8;
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.reflections.enabled = quality !== "low";
    this.reflections.scale = quality === "high" ? .5 : .33;
    this.viewSize = { width: -1, height: -1 };
    this.syncSize();
    const shadow = quality === "high" ? 4096 : quality === "medium" ? 2048 : 1024;
    if (this.moon.shadow.mapSize.x !== shadow) {
      this.moon.shadow.mapSize.set(shadow, shadow);
      this.moon.shadow.map?.dispose();
      this.moon.shadow.map = null;
    }
    this.renderer.shadowMap.type = quality === "low" ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.needsUpdate = true;
  }

  private setupMission(): void {
    // Squad on Aurek pad.
    const allyStarts = [[-2, 67], [2.5, 67.5], [-3.5, 71], [8.5, 68.5]];
    allyStarts.forEach(([x, z]) => this.battle.spawnClone(new THREE.Vector2(x, z), 0));
    this.front = 0;
    this.startPhase(0);
  }

  private startPhase(index: number): void {
    const spec = PHASES[index];
    const already = this.battle.aliveCount("separatist", spec.enemyZone);
    this.phase = { index, spec, spawned: already, supers: 0, killed: 0, state: "fight", reinforceTimer: 3, capture: 0, nextDeployed: false };
    for (let i = already; i < spec.initial; i++) this.deployDefender();
    this.showObjective();
    this.updateFrontHud();
  }

  private nextKind(): ActorKind {
    const p = this.phase;
    const remaining = p.spec.quota - p.spawned;
    const supersLeft = p.spec.superDroids - p.supers;
    if (supersLeft > 0 && p.spawned >= 2 && (Math.random() < supersLeft / Math.max(1, remaining) * 1.4 || remaining <= supersLeft)) {
      p.supers++;
      return "b2";
    }
    return "b1";
  }

  private deployDefender(): void {
    this.battle.deployDefender(this.nextKind(), this.phase.spec.enemyZone);
    this.phase.spawned++;
  }

  private reinforce(): void {
    const zone = this.phase.spec.enemyZone;
    let from: THREE.Vector2, fromZone: number;
    if (zone >= 2) {
      from = LANDER.ramp.clone().add(new THREE.Vector2((Math.random() - .5) * 2, Math.random() * 2));
      fromZone = 3;
    } else {
      const bridge = BRIDGES.filter((b) => b.from === zone)[Math.floor(Math.random() * 2)];
      const center = ZONES[zone + 1].center;
      from = bridge.b.clone().lerp(center, .35);
      fromZone = zone + 1;
    }
    this.battle.deployReinforcement(this.nextKind(), from, fromZone, zone);
    this.phase.spawned++;
  }

  // ------------------------------------------------------------------ events

  private bindEvents(): void {
    this.$("#start").addEventListener("click", () => {
      this.battle.difficulty = Number(this.$<HTMLSelectElement>("#difficulty").value);
      this.start();
    });
    this.$("#resume").addEventListener("click", () => this.resume());
    this.$("#restart").addEventListener("click", () => location.reload());
    this.$("#restart-pause").addEventListener("click", () => location.reload());
    document.querySelectorAll<HTMLSelectElement>(".quality-select").forEach((select) => {
      select.addEventListener("change", () => this.applyQuality(select.value as Quality));
    });
    const sensitivity = this.$<HTMLInputElement>("#sensitivity");
    sensitivity.value = localStorage.getItem("kamino.sensitivity") ?? "1";
    this.controls.pointerSpeed = Number(sensitivity.value);
    sensitivity.addEventListener("input", () => {
      this.controls.pointerSpeed = Number(sensitivity.value);
      localStorage.setItem("kamino.sensitivity", sensitivity.value);
    });
    const volume = this.$<HTMLInputElement>("#volume");
    volume.value = localStorage.getItem("kamino.volume") ?? ".8";
    this.audio.setVolume(Number(volume.value));
    volume.addEventListener("input", () => {
      this.audio.setVolume(Number(volume.value));
      localStorage.setItem("kamino.volume", volume.value);
    });

    this.controls.addEventListener("lock", () => {
      this.paused = false;
      this.$("#pause").classList.add("hidden");
      this.$("#menu").classList.add("hidden");
      this.$("#hud").classList.remove("hidden");
      this.$("#start").textContent = "Deploy";
      this.$("#resume").textContent = "Resume";
    });
    this.controls.addEventListener("unlock", () => {
      if (this.started && !this.ended) {
        this.paused = true;
        this.firing = false;
        this.aiming = false;
        this.keys.clear();
        this.$("#pause").classList.remove("hidden");
      }
    });
    document.addEventListener("pointerlockerror", () => {
      // Browsers refuse a re-lock for about a second after Escape; let the player simply try again.
      this.$("#start").textContent = "Click again to deploy";
      this.$("#resume").textContent = "Click again to resume";
    });
    this.renderer.domElement.addEventListener("click", () => {
      if (this.started && !this.ended && !this.controls.isLocked && !this.testMode) this.resume();
    });

    addEventListener("keydown", (event) => {
      if (event.code === "Tab") event.preventDefault();
      this.keys.add(event.code);
      if (!this.running) return;
      if (event.code === "KeyR") this.reload();
      if (event.code === "KeyG") this.throwGrenade();
      if (event.code === "Space") this.jump();
    });
    addEventListener("keyup", (event) => this.keys.delete(event.code));
    addEventListener("mousedown", (event) => {
      if (!this.running) return;
      if (event.button === 0) { this.firing = true; this.shoot(); }
      if (event.button === 2) this.aiming = true;
    });
    addEventListener("mouseup", (event) => {
      if (event.button === 0) this.firing = false;
      if (event.button === 2) this.aiming = false;
    });
    addEventListener("contextmenu", (event) => event.preventDefault());
    addEventListener("mousemove", (event) => {
      if (!this.controls.isLocked) return;
      this.lookX += event.movementX;
      this.lookY += event.movementY;
    });
    addEventListener("resize", () => this.syncSize());
  }

  private viewSize = { width: -1, height: -1 };

  /**
   * Match the canvas to the window. Also polled every frame: a page opened in a background tab can
   * start at 0×0 (NaN aspect, black screen) without ever receiving a resize event.
   */
  private syncSize(): void {
    const width = Math.max(1, innerWidth), height = Math.max(1, innerHeight);
    if (width === this.viewSize.width && height === this.viewSize.height) return;
    this.viewSize = { width, height };
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.reflections.setSize(width * this.renderer.getPixelRatio(), height * this.renderer.getPixelRatio());
  }

  private get running(): boolean {
    return this.started && !this.ended && !this.paused && !this.dead;
  }

  private start(): void {
    // Test mode (automation) stays silent; real players start audio with the Deploy click.
    if (!this.testMode) this.audio.init();
    if (!this.started) {
      this.started = true;
      this.placePlayerCamera();
      this.radio("Command · Tipoca", "All units: droids have overrun Besh Junction. Push across the bridges and drive them back!");
      this.radio("Sergeant", "On me, trooper. Watch those bridges—there's no cover out there.");
      this.radio("Sergeant", "Aim with right click, and crouch behind the barricades with C. Your armor recovers if you stay out of fire.");
      this.banner("The Battle of Kamino", "Push them back");
    }
    if (this.testMode) {
      this.$("#menu").classList.add("hidden");
      this.$("#hud").classList.remove("hidden");
      return;
    }
    // Hold the simulation until pointer lock is actually granted (the "lock" event unpauses).
    if (!this.controls.isLocked) this.paused = true;
    this.controls.lock();
  }

  /** Slow flyover of Tipoca City behind the main menu. */
  private menuCamera(): void {
    const t = this.time * .025 + 1.9;
    this.camera.position.set(14 + Math.cos(t) * 62, 16 + Math.sin(this.time * .07) * 3, -12 + Math.sin(t) * 62);
    this.camera.lookAt(20 + Math.cos(t + 2) * 10, 2, -18 + Math.sin(t + 2) * 10);
    this.viewmodel.root.visible = false;
  }

  /** Put the camera back behind the trooper's eyes when the mission begins. */
  private placePlayerCamera(): void {
    this.camera.position.copy(this.feet).setY(this.feet.y + EYE_HEIGHT);
    this.camera.lookAt(0, 1.5, 30);
    this.viewmodel.root.visible = true;
  }

  private resume(): void {
    this.audio.init();
    this.controls.lock();
  }

  // ------------------------------------------------------------------ main loop

  private frame(): void {
    this.syncSize();
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), .05);
    const simulating = this.started && !this.ended && !this.paused;
    // Game time stands still while paused so scheduled mission events wait too.
    if (simulating || !this.started) this.time += delta;
    if (simulating || !this.started) this.runScheduled();

    if (this.running) {
      this.missionTime += delta;
      this.updatePlayer(delta);
      this.battle.update(delta, this.time);
      this.updateGrenades(delta);
      this.updatePhase(delta);
      if (this.firing) this.shoot();
    } else if (this.dead) {
      this.updateDeath(delta);
      this.battle.update(delta, this.time);
    } else if (!this.started) this.menuCamera();

    this.world.update(delta, this.time);
    this.env.update(delta, this.time, this.camera, this.fog);
    this.effects.update(delta, this.camera);
    this.updateLighting();
    this.viewmodel.update(delta, {
      ads: this.ads,
      moving: this.velocity.lengthSq() > .5,
      sprinting: this.isSprinting(),
      grounded: this.grounded,
      crouch: this.crouch,
      reload: this.reloadStart >= 0 ? (this.time - this.reloadStart) / RELOAD_TIME : null,
      throwing: this.time - this.throwStart < .55 ? (this.time - this.throwStart) / .55 : null,
      lookX: this.lookX,
      lookY: this.lookY,
      bob: this.bob,
    });
    this.lookX = this.lookY = 0;
    this.audio.setListener(this.camera.position, this.camera.quaternion);
    this.audio.update(delta, this.health);
    if (simulating || !this.started) this.updateAmbientBattle(delta);
    this.updateHudFrame(delta);
    this.render();
    this.watchPerformance();
  }

  private render(): void {
    const shake = this.effects.shake;
    const saved = this.camera.quaternion.clone();
    if (shake > 0) {
      const t = this.time * 38;
      this.camera.rotateX((Math.sin(t) * .6 + Math.sin(t * 2.3) * .4) * shake * .012);
      this.camera.rotateY((Math.cos(t * 1.3) * .6 + Math.sin(t * 3.1) * .4) * shake * .012);
      this.camera.rotateZ(Math.sin(t * .7) * shake * .01);
    }
    const flash = this.env.flash.strength;
    (this.grade.uniforms.uTime as THREE.IUniform).value = this.time;
    (this.grade.uniforms.uFlash as THREE.IUniform).value = flash;
    (this.grade.uniforms.uAds as THREE.IUniform).value = this.ads;
    const damage = Math.max(0, 1 - (this.time - this.lastHurt) * 2);
    (this.grade.uniforms.uDamage as THREE.IUniform).value = damage;
    (this.grade.uniforms.uLowHealth as THREE.IUniform).value = this.dead ? 1 : THREE.MathUtils.clamp((40 - this.health) / 40, 0, 1);
    this.camera.updateMatrixWorld();
    this.reflections.render(this.renderer, this.scene, this.camera, [this.viewmodel.root, ...this.env.reflectionHidden]);
    this.composer.render();
    this.camera.quaternion.copy(saved);
  }

  private updateLighting(): void {
    const flash = this.env.flash.strength;
    this.hemi.intensity = .32 + flash * 2.4;
    this.moon.intensity = 1.1 + flash * 5;
    this.fog.color.setRGB(.024 + flash * .1, .058 + flash * .14, .082 + flash * .17);
    // Keep the shadow frustum centred on the player, snapped to texels to avoid shimmering.
    const texel = 96 / this.moon.shadow.mapSize.x;
    const cx = Math.round(this.feet.x / texel) * texel, cz = Math.round(this.feet.z / texel) * texel;
    this.moon.target.position.set(cx, 0, cz);
    this.moon.position.set(cx - 60, 90, cz + 40);
  }

  // ------------------------------------------------------------------ player

  private isSprinting(): boolean {
    return (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) && this.keys.has("KeyW") && !this.aiming && this.crouch < .3 && this.reloadStart < 0;
  }

  private updatePlayer(delta: number): void {
    const nav = this.world.nav;
    // C only: Ctrl would turn Ctrl+W into "close tab" mid-fight.
    const wantCrouch = this.keys.has("KeyC");
    this.crouch = THREE.MathUtils.lerp(this.crouch, wantCrouch ? 1 : 0, Math.min(1, delta * 10));
    this.ads = THREE.MathUtils.lerp(this.ads, this.aiming && !this.isSprinting() ? 1 : 0, Math.min(1, delta * 12));
    const sprint = this.isSprinting();
    const speed = sprint ? 7.2 : this.crouch > .5 ? 2.4 : this.ads > .5 ? 2.9 : 4.6;

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const input = new THREE.Vector3()
      .addScaledVector(forward, Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS")))
      .addScaledVector(right, Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")));
    if (input.lengthSq() > 0) input.normalize().multiplyScalar(speed);
    const accel = this.grounded ? 14 : 3;
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, input.x, Math.min(1, delta * accel));
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, input.z, Math.min(1, delta * accel));

    nav.move(this.feet, this.velocity.x * delta, this.velocity.z * delta, PLAYER_RADIUS);
    const support = nav.supportAt(this.feet.x, this.feet.z, PLAYER_RADIUS) ?? this.feet.y;
    if (!this.grounded) {
      this.velocity.y -= 17 * delta;
      this.feet.y += this.velocity.y * delta;
      if (this.feet.y <= support) {
        this.viewmodel.land(Math.min(1, -this.velocity.y / 8));
        if (this.velocity.y < -4) this.audio.footstep(true);
        this.feet.y = support;
        this.velocity.y = 0;
        this.grounded = true;
      }
    } else if (support < this.feet.y - STEP_HEIGHT) {
      this.grounded = false;
      this.velocity.y = 0;
    } else this.feet.y = THREE.MathUtils.lerp(this.feet.y, support, Math.min(1, delta * 16));

    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.grounded && horizontal > .5) {
      this.bob += delta * horizontal * 1.9;
      if (Math.floor(this.bob / Math.PI) !== this.lastStep) {
        this.lastStep = Math.floor(this.bob / Math.PI);
        this.audio.footstep(sprint);
      }
    }
    const eye = THREE.MathUtils.lerp(EYE_HEIGHT, CROUCH_EYE, this.crouch);
    this.player.height = eye + .12;
    const bobY = this.grounded ? Math.abs(Math.sin(this.bob)) * .045 * Math.min(1, horizontal / 4.6) * (1 - this.ads * .7) : 0;
    this.camera.position.set(this.feet.x, this.feet.y + eye - bobY, this.feet.z);

    const targetFov = (sprint ? 80 : 74) * (1 - this.ads * .32);
    if (Math.abs(this.camera.fov - targetFov) > .01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, delta * 10));
      this.camera.updateProjectionMatrix();
    }
    this.controls.pointerSpeed = Number(this.$<HTMLInputElement>("#sensitivity").value) * (1 - this.ads * .45);

    // Recoil recovery.
    const recover = this.recoilPitch * Math.min(1, delta * 7);
    this.recoilPitch -= recover;
    this.camera.rotation.x -= recover * .7;
    this.bloomSpread = Math.max(0, this.bloomSpread - delta * 3.5);

    if (this.reloadStart >= 0 && this.time - this.reloadStart >= RELOAD_TIME) {
      this.reloadStart = -1;
      this.ammo = MAGAZINE;
      this.viewmodel.setAmmo(this.ammo, MAGAZINE);
      this.audio.ui("reload-in");
      this.updateHud();
    }
    if (this.health < 100 && this.time - this.lastHurt > 4.5) {
      this.health = Math.min(100, this.health + delta * 16);
      if (this.health > 40) this.lowHealthWarned = false;
      this.updateHud();
    }
  }

  private jump(): void {
    if (!this.grounded || this.crouch > .5) return;
    this.grounded = false;
    this.velocity.y = 5.6;
  }

  private shoot(): void {
    if (!this.running || this.reloadStart >= 0 || this.time < this.nextShot || this.isSprinting()) return;
    if (this.ammo <= 0) {
      this.audio.ui("empty");
      this.nextShot = this.time + .3;
      this.reload();
      return;
    }
    this.nextShot = this.time + FIRE_INTERVAL;
    this.ammo--;
    this.shotsFired++;
    this.viewmodel.fire();
    this.viewmodel.setAmmo(this.ammo, MAGAZINE);
    this.audio.blaster("player", null);

    const moving = Math.min(1, Math.hypot(this.velocity.x, this.velocity.z) / 4.6);
    const spreadDeg = THREE.MathUtils.lerp(.85, .1, this.ads) + moving * .9 * (1 - this.ads * .6) + (this.grounded ? 0 : 2.5) + this.bloomSpread * (1 - this.ads * .6);
    this.bloomSpread = Math.min(2, this.bloomSpread + .28);
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const spread = THREE.MathUtils.degToRad(spreadDeg) * Math.sqrt(Math.random());
    const theta = Math.random() * Math.PI * 2;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    direction.addScaledVector(side, Math.cos(theta) * Math.tan(spread)).addScaledVector(up, Math.sin(theta) * Math.tan(spread)).normalize();

    this.battle.refreshHitboxes();
    this.raycaster.set(this.camera.position, direction);
    this.raycaster.far = 400;
    this.raycaster.firstHitOnly = true;
    const hits = this.raycaster.intersectObjects([...this.battle.targetMeshes, ...this.world.shootables], false);
    const hit = hits[0];
    const end = hit ? hit.point.clone() : this.camera.position.clone().addScaledVector(direction, 300);
    const muzzle = this.viewmodel.muzzle.getWorldPosition(new THREE.Vector3());
    this.battle.tracer(muzzle, end, "republic");
    this.effects.flash(muzzle, 0x6fd2ff, 6, .06, 8);

    if (hit) {
      const actor = hit.object.userData.actor as Actor | undefined;
      if (actor && actor.alive && actor.team === "separatist") {
        const headshot = Boolean(hit.object.userData.head);
        this.shotsHit++;
        const wasAlive = actor.alive;
        this.effects.impact(hit.point, direction.clone().negate(), new THREE.Color(5, 2.6, .9), false);
        this.audio.impact(hit.point, true);
        this.battle.damageActor(actor, headshot ? 80 : 34, direction, true, headshot);
        if (wasAlive && actor.alive) this.hitMarker(headshot ? "head" : "hit");
      } else {
        const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : direction.clone().negate();
        this.effects.impact(hit.point, normal, BOLT_COLORS.blue, true);
        this.audio.impact(hit.point);
      }
    }

    const kick = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(.75, .4, this.ads) * (this.crouch > .5 ? .7 : 1));
    this.camera.rotation.x = Math.min(Math.PI / 2 - .01, this.camera.rotation.x + kick);
    this.camera.rotation.y += (Math.random() - .5) * kick * .5;
    this.recoilPitch += kick;
    this.updateHud();
    if (this.ammo === 0) this.reload();
  }

  private reload(): void {
    if (this.reloadStart >= 0 || this.ammo === MAGAZINE || !this.running) return;
    this.reloadStart = this.time;
    this.audio.ui("reload-out");
    this.updateHud();
  }

  private throwGrenade(): void {
    if (this.grenades <= 0 || this.time - this.throwStart < 1) return;
    this.grenades--;
    this.throwStart = this.time;
    this.audio.ui("throw");
    const group = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(.07, 16, 12), new THREE.MeshStandardMaterial({ color: 0xa9b2b8, metalness: .9, roughness: .25 }));
    const band = new THREE.Mesh(new THREE.TorusGeometry(.071, .012, 6, 20), new THREE.MeshStandardMaterial({ color: 0x220303, emissive: 0xff2a10, emissiveIntensity: 6 }));
    band.rotation.x = Math.PI / 2;
    group.add(shell, band);
    shell.castShadow = true;
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    group.position.copy(this.camera.position).addScaledVector(direction, .4).addScaledVector(right, .2).add(new THREE.Vector3(0, -.15, 0));
    const velocity = direction.multiplyScalar(15).add(new THREE.Vector3(0, 3.6, 0)).add(this.velocity.clone().setY(0));
    this.scene.add(group);
    this.thrown.push({ mesh: group, light: band, velocity, fuse: 2.3, beep: 0 });
    this.updateHud();
  }

  private updateGrenades(delta: number): void {
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const g = this.thrown[i];
      g.fuse -= delta;
      g.beep -= delta;
      if (g.beep <= 0) {
        g.beep = Math.max(.08, g.fuse * .22);
        g.light.visible = !g.light.visible;
      }
      g.velocity.y -= 16 * delta;
      const step = g.velocity.length() * delta;
      if (step > 1e-4) {
        const direction = g.velocity.clone().normalize();
        this.raycaster.set(g.mesh.position, direction);
        this.raycaster.far = step + .07;
        this.raycaster.firstHitOnly = true;
        const hit = this.raycaster.intersectObjects(this.world.shootables, false)[0];
        if (hit && hit.face) {
          const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
          g.mesh.position.copy(hit.point).addScaledVector(normal, .075);
          g.velocity.reflect(normal).multiplyScalar(.42);
          if (g.velocity.length() > 1.5) this.audio.impact(g.mesh.position);
        } else g.mesh.position.addScaledVector(g.velocity, delta);
      }
      g.mesh.rotation.x += delta * g.velocity.length() * 3;
      if (g.fuse <= 0 || g.mesh.position.y < -40) {
        if (g.fuse <= 0) this.battle.explode(g.mesh.position.clone(), 7.5, 260, true);
        this.scene.remove(g.mesh);
        this.thrown.splice(i, 1);
      }
    }
  }

  private hurt(damage: number, from: THREE.Vector3): void {
    if (!this.running) return;
    const reduced = damage * (this.crouch > .5 ? .85 : 1);
    this.health = Math.max(0, this.health - reduced);
    this.lastHurt = this.time;
    this.effects.addShake(.18 + damage * .02);
    this.audio.ui("hurt");
    this.damageFlash();
    this.damageArc(from);
    if (this.health < 35 && !this.lowHealthWarned) {
      this.lowHealthWarned = true;
      this.radio("Sergeant", "You're hit bad! Get behind cover and let your armor recover.");
    }
    this.updateHud();
    if (this.health <= 0) this.die();
  }

  private die(): void {
    this.dead = true;
    this.player.alive = false;
    this.deathTime = 0;
    this.firing = false;
    this.banner("Clone down", "Mission failed", true);
    this.schedule(2.6, () => this.finish(false));
  }

  private updateDeath(delta: number): void {
    this.deathTime += delta;
    const t = Math.min(1, this.deathTime / 1.1);
    const eased = 1 - (1 - t) ** 3;
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, this.feet.y + .35, eased * .2);
    this.camera.rotation.z = THREE.MathUtils.lerp(this.camera.rotation.z, .9, delta * 2.5);
    this.viewmodel.root.visible = false;
  }

  // ------------------------------------------------------------------ mission flow

  private updatePhase(delta: number): void {
    const p = this.phase;
    const spec = p.spec;
    const zone = spec.enemyZone;
    const final = p.index === PHASES.length - 1;
    if (p.state === "fight") {
      const alive = this.battle.aliveCount("separatist", zone);
      p.reinforceTimer -= delta;
      if (p.spawned < spec.quota && alive < spec.maxAlive && p.reinforceTimer <= 0) {
        this.reinforce();
        p.reinforceTimer = 1.4 + Math.random() * 2.2;
      }
      if (p.spawned >= spec.quota) {
        if (final && alive === 0) this.victory();
        else if (!final && alive <= 2) {
          const fled = alive > 0 ? this.battle.retreat(zone, zone + 1) : 0;
          if (fled) this.radio("Sergeant", "They're falling back! Don't let them regroup!");
          this.banner(fled ? "Droids falling back" : "Sector clear", `Secure ${ZONES[zone].name}`);
          p.state = "capture";
          this.deployNextDefenders();
          this.battle.moveAllies(zone);
          this.audio.ui("alert");
          this.showObjective();
        }
      }
    } else if (p.state === "capture") {
      const capture = ZONES[zone].capture;
      const distance = Math.hypot(this.feet.x - capture.x, this.feet.z - capture.y);
      const inside = distance < 4.4;
      const allies = this.battle.actors.filter((a) => a.alive && a.team === "republic" && Math.hypot(a.position.x - capture.x, a.position.z - capture.y) < 6).length;
      if (inside) {
        const before = Math.floor(p.capture * 10);
        p.capture = Math.min(1, p.capture + delta / 4.5 * (1 + allies * .15));
        if (Math.floor(p.capture * 10) !== before) this.audio.ui("capture");
      } else p.capture = Math.max(0, p.capture - delta * .15);
      if (p.capture >= 1) this.secure();
      this.updateCaptureVisual();
    }
  }

  private deployNextDefenders(): void {
    const next = PHASES[this.phase.index + 1];
    if (!next || this.phase.nextDeployed) return;
    this.phase.nextDeployed = true;
    const present = this.battle.aliveCount("separatist", next.enemyZone);
    for (let i = present; i < next.initial; i++) {
      const kind: ActorKind = i === next.initial - 1 && next.superDroids > 0 ? "b2" : "b1";
      this.battle.deployDefender(kind, next.enemyZone);
    }
  }

  private secure(): void {
    const p = this.phase;
    p.state = "secured";
    const zone = p.spec.enemyZone;
    this.front = zone;
    this.world.captureMarkers[zone].group.visible = false;
    this.audio.ui("secured");
    this.banner("Sector secured", ZONES[zone].name);
    this.health = Math.min(100, this.health + 35);
    this.grenades = Math.min(MAX_GRENADES, this.grenades + 2);
    this.updateFrontHud();
    this.updateHud();
    const lines = [
      ["Command · Tipoca", "Besh Junction is ours. Keep pushing—Cresh Plaza is next. Expect super battle droids."],
      ["Command · Tipoca", "Cresh Plaza secure. Their landing craft is on Dorn platform. Clear it and Kamino is ours."],
    ];
    const line = lines[p.index];
    if (line) this.radio(line[0], line[1]);
    if (p.index === 0) this.radio("Sergeant", "Supers shrug off blaster fire. Crack them open with a thermal detonator: G.");
    // Reinforce the squad.
    const living = this.battle.aliveCount("republic");
    const back = ZONES[Math.max(0, zone - 1)].center;
    for (let i = living; i < SQUAD_SIZE; i++) {
      const clone = this.battle.spawnClone(back.clone().add(new THREE.Vector2((Math.random() - .5) * 6, (Math.random() - .5) * 6)), zone);
      void clone;
    }
    if (living < SQUAD_SIZE) this.radio("Sergeant", "Reinforcements are moving up to join us.");
    this.battle.moveAllies(zone);
    this.schedule(3, () => {
      if (this.ended || this.dead) return;
      this.startPhase(p.index + 1);
      this.banner("Push forward", ZONES[this.phase.spec.enemyZone].name, true);
      this.audio.ui("alert");
    });
  }

  /**
   * The wider battle for Tipoca City: volleys between outlying platforms, gunship strafing runs and
   * distant explosions, seen and heard around the player's own fight.
   */
  private updateAmbientBattle(delta: number): void {
    if (this.ended) return;
    // Vulture droids: whoosh as they pass close, strafe the decks below.
    for (const vulture of this.world.vultures) {
      const position = vulture.group.position;
      const distance = position.distanceTo(this.camera.position);
      const cooldown = (vulture.group.userData.flybyAt as number | undefined) ?? -10;
      if (distance < 55 && this.time - cooldown > 5) {
        vulture.group.userData.flybyAt = this.time;
        this.audio.flyby(position);
      }
      const strafeAt = (vulture.group.userData.strafeAt as number | undefined) ?? 0;
      if (position.y < 30 && distance < 110 && this.time > strafeAt) {
        vulture.group.userData.strafeAt = this.time + 3 + Math.random() * 3;
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(vulture.group.quaternion);
        for (let i = 0; i < 6; i++) {
          this.schedule(i * .09, () => {
            const gun = vulture.guns[i % vulture.guns.length].getWorldPosition(new THREE.Vector3());
            const aim = gun.clone().addScaledVector(forward, 30 + i * 4).setY(0);
            aim.x += (Math.random() - .5) * 6; aim.z += (Math.random() - .5) * 6;
            this.battle.tracer(gun, aim, "separatist", 120);
            if (i % 2 === 0) this.audio.blaster("super", gun);
            this.schedule(gun.distanceTo(aim) / 120, () => {
              if (this.world.nav.groundAt(aim.x, aim.z) !== null) {
                this.effects.impact(aim, new THREE.Vector3(0, 1, 0), BOLT_COLORS.red, true);
                if (aim.distanceTo(this.feet) < 3) this.hurt(6, gun);
              }
            });
          });
        }
      }
    }
    this.ambientTimer -= delta;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = .4 + Math.random() * 1.3;
    const points = this.world.ambientPoints.filter((p) => p.distanceTo(this.feet) > 40);
    if (points.length < 2) return;
    const pick = () => points[Math.floor(Math.random() * points.length)];
    const roll = Math.random();
    const volley = (from: THREE.Vector3, to: THREE.Vector3, team: "republic" | "separatist", shots: number) => {
      for (let i = 0; i < shots; i++) {
        this.schedule(i * (team === "separatist" ? .2 : .14), () => {
          const end = to.clone().add(new THREE.Vector3((Math.random() - .5) * 4, Math.random() * 2, (Math.random() - .5) * 4));
          this.battle.tracer(from, end, team, 85);
          this.audio.blaster(team === "separatist" ? "droid" : "clone", from);
          const travel = from.distanceTo(end) / 85;
          this.schedule(travel, () => {
            this.effects.sparksAt(end, new THREE.Vector3(0, 1, 0), team === "separatist" ? BOLT_COLORS.red : BOLT_COLORS.blue, 6, 4);
            this.effects.glow(end, (team === "separatist" ? BOLT_COLORS.red : BOLT_COLORS.blue).clone().multiplyScalar(.2), 1.2, .15);
          });
        });
      }
    };
    if (roll < .1) {
      const where = pick().clone();
      this.effects.explosion(where, .9);
      this.audio.explosion(where, .8);
    } else if (roll < .22) {
      const guns = this.world.gunshipGuns();
      const gun = guns[Math.floor(Math.random() * guns.length)];
      volley(gun, pick(), "republic", 5);
    } else {
      const a = pick(), b = pick();
      if (a.distanceTo(b) < 15) return;
      volley(a, b, Math.random() < .55 ? "separatist" : "republic", 2 + Math.floor(Math.random() * 3));
      if (Math.random() < .5) this.schedule(.5, () => volley(b, a, Math.random() < .5 ? "republic" : "separatist", 2 + Math.floor(Math.random() * 2)));
    }
  }

  /**
   * After a few seconds of real play, step graphics down once if the machine can't hold ~40 fps,
   * so the default preset never leaves someone with a slideshow.
   */
  private watchPerformance(): void {
    if (this.perf.checked || !this.running || this.testMode) return;
    const now = performance.now();
    const last = this.perf.last;
    this.perf.last = now;
    if (last < 0 || now - last > 250) return;
    this.perf.frames++;
    this.perf.elapsed += now - last;
    if (this.perf.elapsed < 5000) return;
    this.perf.checked = true;
    const fps = this.perf.frames / (this.perf.elapsed / 1000);
    if (fps < 40 && this.quality !== "low") {
      this.applyQuality(this.quality === "high" ? "medium" : "low");
      this.radio("System", `Graphics lowered to ${this.quality} to keep the battle smooth (${Math.round(fps)} fps). Change it any time from the pause menu.`);
    }
  }

  /** Run `task` after `delay` seconds of game time (pauses with the game). */
  private schedule(delay: number, task: () => void): void {
    this.scheduled.push({ at: this.time + delay, task });
  }

  private runScheduled(): void {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      if (this.scheduled[i].at > this.time) continue;
      const { task } = this.scheduled[i];
      this.scheduled.splice(i, 1);
      task();
    }
  }

  private victory(): void {
    if (this.ended) return;
    this.phase.state = "secured";
    this.front = 3;
    this.updateFrontHud();
    this.audio.ui("secured");
    this.banner("Victory", "Tipoca City holds");
    this.radio("Command · Tipoca", "Dorn platform is clear. The droid army is broken—Tipoca City holds. Outstanding work, trooper.");
    this.schedule(5.2, () => this.finish(true));
  }

  private finish(victory: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.controls.unlock();
    this.$("#hud").classList.add("hidden");
    this.$("#pause").classList.add("hidden");
    this.$("#result-kicker").textContent = victory ? "Mission complete" : "Mission failed";
    this.$("#result-title").textContent = victory ? "TIPOCA CITY HOLDS" : "CLONE DOWN";
    this.$("#result-copy").textContent = victory
      ? "You fought from Aurek pad to the Separatist landing craft and pushed the droid army off Tipoca City."
      : `You fell holding the line at ${ZONES[Math.min(3, this.front + 1)].name}. The clones will need you back in the fight.`;
    const minutes = Math.floor(this.missionTime / 60), seconds = Math.floor(this.missionTime % 60);
    const accuracy = this.shotsFired ? Math.round(this.shotsHit / this.shotsFired * 100) : 0;
    this.$("#result-stats").innerHTML = [
      [this.kills, "Droids destroyed"], [this.headshots, "Headshots"], [`${accuracy}%`, "Accuracy"], [`${minutes}:${String(seconds).padStart(2, "0")}`, "Time"],
    ].map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
    this.$("#result").classList.remove("hidden");
  }

  private onDroidKilled(actor: Actor, byPlayer: boolean, headshot: boolean): void {
    this.phase.killed++;
    if (!byPlayer) return;
    this.kills++;
    if (headshot) this.headshots++;
    this.hitMarker("kill");
    this.audio.ui(headshot ? "headshot" : "kill");
    const name = actor.kind === "b2" ? "Super battle droid" : "B1 battle droid";
    this.killfeed(`${name} destroyed${headshot ? " <em>· headshot</em>" : ""}`, headshot ? "head" : "");
  }

  private onCloneKilled(): void {
    this.alliesLost++;
    this.killfeed("Trooper down", "ally");
    if (Math.random() < .6) this.radio("Sergeant", ["Man down!", "We lost one—keep firing!", "Trooper down! Cover that flank!"][Math.floor(Math.random() * 3)]);
    this.updateHud();
  }

  // ------------------------------------------------------------------ HUD

  private buildFrontHud(): void {
    const front = this.$("#front");
    front.innerHTML = ZONES.map((zone, i) => `${i ? `<div class="link"><i></i></div>` : ""}<div class="node" data-zone="${i}"><span>${zone.id}</span><small class="label">${zone.name.split(" ")[0]}</small></div>`).join("");
    this.updateFrontHud();
  }

  private updateFrontHud(): void {
    const contested = this.phase?.spec.enemyZone ?? 1;
    document.querySelectorAll<HTMLElement>("#front .node").forEach((node, i) => {
      node.classList.toggle("ours", i <= this.front);
      node.classList.toggle("contested", i === contested && i > this.front);
    });
    document.querySelectorAll<HTMLElement>("#front .link i").forEach((link, i) => {
      link.style.width = i < this.front ? "100%" : i === this.front && this.phase?.state === "capture" ? "50%" : "0";
    });
  }

  private showObjective(): void {
    const p = this.phase;
    const zone = ZONES[p.spec.enemyZone];
    if (p.state === "fight") {
      this.$("#obj-kicker").textContent = `Sector ${zone.id} · ${p.index + 1} of ${PHASES.length}`;
      this.$("#obj-title").textContent = p.index === PHASES.length - 1 ? `Destroy the droids on ${zone.name}` : `Push the droids off ${zone.name}`;
      this.$("#capture-meter").classList.add("hidden");
    } else {
      this.$("#obj-kicker").textContent = "Droids falling back";
      this.$("#obj-title").textContent = `Secure ${zone.name}`;
      this.$("#capture-meter").classList.remove("hidden");
      const marker = this.world.captureMarkers[p.spec.enemyZone];
      marker.group.visible = true;
    }
    this.updateFrontHud();
  }

  private updateCaptureVisual(): void {
    const p = this.phase;
    const marker = this.world.captureMarkers[p.spec.enemyZone];
    marker.fill.geometry.dispose();
    marker.fill.geometry = new THREE.RingGeometry(0, 4.3, 64, 1, Math.PI / 2, -Math.max(.001, p.capture) * Math.PI * 2).rotateX(-Math.PI / 2);
    marker.ring.rotation.y = this.time * .4;
    (this.$("#capture-fill")).style.width = `${p.capture * 100}%`;
  }

  private updateHud(): void {
    const health = Math.ceil(this.health);
    this.$("#health").textContent = String(health);
    const bar = this.$("#health-bar");
    bar.style.width = `${this.health}%`;
    bar.style.background = this.health < 35 ? "#ff5448" : "linear-gradient(90deg, #5bd2ff, #d7f8ff)";
    const ammo = this.$("#ammo");
    ammo.textContent = this.reloadStart >= 0 ? "--" : String(this.ammo).padStart(2, "0");
    ammo.classList.toggle("low", this.ammo < MAGAZINE * .25);
    this.$("#grenades").innerHTML = Array.from({ length: MAX_GRENADES }, (_, i) => `<i class="${i < this.grenades ? "" : "used"}"></i>`).join("");
    if (this.battle) {
      const living = this.battle.aliveCount("republic");
      this.$("#squad").innerHTML = Array.from({ length: SQUAD_SIZE }, (_, i) => `<i class="${i < living ? "" : "down"}"></i>`).join("");
    }
  }

  private updateHudFrame(delta: number): void {
    if (!this.started || this.ended) return;
    const p = this.phase;
    const zone = ZONES[p.spec.enemyZone];
    if (p.state === "fight") {
      const left = p.spec.quota - p.killed;
      this.$("#obj-detail").textContent = `${Math.max(0, left)} droid${left === 1 ? "" : "s"} holding the sector`;
    } else if (p.state === "capture") {
      this.$("#obj-detail").textContent = p.capture > 0 ? `Securing… ${Math.floor(p.capture * 100)}%` : "Stand in the marked zone";
    } else this.$("#obj-detail").textContent = "Regrouping";

    // World-space objective marker.
    const marker = this.$("#marker");
    let target = p.state === "capture" ? new THREE.Vector3(zone.capture.x, 2.4, zone.capture.y) : new THREE.Vector3(zone.center.x, 3, zone.center.y);
    // Once reinforcements are spent, point at the nearest straggler so the last droids are never lost.
    if (p.state === "fight" && p.spawned >= p.spec.quota) {
      const stragglers = this.battle.actors.filter((a) => a.alive && a.team === "separatist");
      if (stragglers.length && stragglers.length <= 3) {
        stragglers.sort((a, b) => a.position.distanceToSquared(this.feet) - b.position.distanceToSquared(this.feet));
        target = stragglers[0].position.clone().setY(stragglers[0].position.y + 2.3);
      }
    }
    const projected = target.clone().project(this.camera);
    const behind = projected.z > 1;
    let sx = (projected.x * .5 + .5) * innerWidth, sy = (-projected.y * .5 + .5) * innerHeight;
    if (behind) { sx = innerWidth - sx; sy = innerHeight - 60; }
    sx = THREE.MathUtils.clamp(sx, 40, innerWidth - 40);
    sy = THREE.MathUtils.clamp(sy, 90, innerHeight - 60);
    marker.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
    marker.classList.toggle("enemy", p.state === "fight");
    const distance = Math.hypot(this.feet.x - target.x, this.feet.z - target.z);
    this.$("#marker-dist").textContent = `${Math.round(distance)} m`;
    marker.style.opacity = this.ads > .5 || (p.state === "capture" && distance < 4.4) ? ".25" : "1";

    // Reticle spread and enemy highlight.
    const reticle = this.$("#reticle");
    const moving = Math.min(1, Math.hypot(this.velocity.x, this.velocity.z) / 4.6);
    const gap = 6 + (moving * 9 + this.bloomSpread * 6 + (this.grounded ? 0 : 14)) * (1 - this.ads * .7);
    const lines = reticle.querySelectorAll<HTMLElement>("i");
    lines[0].style.transform = `translateX(${-gap - 9}px)`;
    lines[1].style.transform = `translateX(${gap}px)`;
    lines[2].style.transform = `translateY(${-gap - 9}px)`;
    lines[3].style.transform = `translateY(${gap}px)`;
    reticle.style.opacity = this.isSprinting() || this.reloadStart >= 0 ? ".2" : "1";
    this.raycaster.setFromCamera(new THREE.Vector2(), this.camera);
    this.raycaster.far = 120;
    this.raycaster.firstHitOnly = true;
    const look = this.raycaster.intersectObjects([...this.battle.targetMeshes, ...this.world.shootables], false)[0];
    reticle.classList.toggle("enemy", Boolean(look?.object.userData.actor));

    const reloadBar = this.$("#reload-bar");
    reloadBar.classList.toggle("show", this.reloadStart >= 0);
    if (this.reloadStart >= 0) (reloadBar.firstElementChild as HTMLElement).style.width = `${Math.min(1, (this.time - this.reloadStart) / RELOAD_TIME) * 100}%`;

    this.hitMarkerTimer -= delta;
    if (this.hitMarkerTimer <= 0) this.$("#hit-marker").className = "";
    this.bannerTimer -= delta;
    if (this.bannerTimer <= 0) this.$("#banner").classList.remove("show");
    this.radioTimer -= delta;
    if (this.radioTimer <= 0) {
      const next = this.radioQueue.shift();
      const radio = this.$("#radio");
      if (next) {
        radio.querySelector(".radio-from")!.textContent = next.from;
        radio.querySelector("p")!.textContent = next.text;
        radio.classList.add("show");
        this.radioTimer = 2.2 + next.text.length * .045;
        this.audio.ui("beep");
      } else radio.classList.remove("show");
    }
    if (p.state === "capture") this.updateCaptureVisual();
  }

  private hitMarker(kind: "hit" | "head" | "kill"): void {
    const marker = this.$("#hit-marker");
    marker.className = `show ${kind === "hit" ? "" : kind}`;
    this.hitMarkerTimer = kind === "kill" ? .3 : .12;
    if (kind !== "kill") this.audio.ui(kind === "head" ? "headshot" : "hit");
  }

  private killfeed(html: string, kind: string): void {
    const feed = this.$("#killfeed");
    const item = document.createElement("div");
    item.className = kind;
    item.innerHTML = html;
    feed.prepend(item);
    setTimeout(() => item.remove(), 4000);
    while (feed.children.length > 5) feed.lastElementChild?.remove();
  }

  private banner(kicker: string, title: string, enemy = false): void {
    const banner = this.$("#banner");
    banner.querySelector("small")!.textContent = kicker;
    banner.querySelector("strong")!.textContent = title.toUpperCase();
    banner.classList.toggle("enemy", enemy);
    banner.classList.add("show");
    this.bannerTimer = 3.2;
  }

  private radio(from: string, text: string): void {
    this.radioQueue.push({ from, text });
  }

  private damageFlash(): void {
    const flash = this.$("#damage-flash");
    flash.classList.add("show");
    requestAnimationFrame(() => setTimeout(() => flash.classList.remove("show"), 60));
  }

  private damageArc(from: THREE.Vector3): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const toSource = from.clone().sub(this.camera.position);
    const angle = Math.atan2(toSource.x, toSource.z) - Math.atan2(forward.x, forward.z);
    const arc = document.createElement("div");
    arc.style.transform = `rotate(${-angle}rad)`;
    this.$("#damage-arcs").append(arc);
    setTimeout(() => arc.remove(), 1200);
  }
}
