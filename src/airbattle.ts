import * as THREE from "three";
import type { GameAudio } from "./audio";
import type { Battle } from "./battle";
import { OCEAN_LEVEL } from "./config";
import { BOLT_COLORS, type Effects } from "./effects";
import type { Materials } from "./materials";
import { buildArc170, buildTriFighter, buildV19, buildVulture } from "./vehicles";
import type { World } from "./world";

type Side = "republic" | "separatist";
export type CraftKind = "arc170" | "v19" | "vulture" | "trifighter";

/** Per-type handling: heavy ARC-170s soak hits, V-19s and tri-fighters are quick and fragile. */
const KINDS: Record<CraftKind, { team: Side; name: string; speed: number; turnRate: number; hp: number; radius: number; build: typeof buildVulture }> = {
  arc170: { team: "republic", name: "ARC-170", speed: 36, turnRate: .9, hp: 260, radius: 6.5, build: buildArc170 },
  v19: { team: "republic", name: "V-19 Torrent", speed: 44, turnRate: 1.15, hp: 140, radius: 4.5, build: buildV19 },
  vulture: { team: "separatist", name: "Vulture droid", speed: 40, turnRate: 1, hp: 100, radius: 4.2, build: buildVulture },
  trifighter: { team: "separatist", name: "Droid tri-fighter", speed: 46, turnRate: 1.2, hp: 120, radius: 3.8, build: buildTriFighter },
};
const ROSTER: CraftKind[] = ["arc170", "arc170", "v19", "v19", "v19", "vulture", "vulture", "vulture", "vulture", "trifighter", "trifighter"];

export type Craft = {
  kind: CraftKind;
  /** Display name for the killfeed. */
  name: string;
  team: Side;
  group: THREE.Group;
  guns: THREE.Object3D[];
  /** Unit vector the nose points along. */
  heading: THREE.Vector3;
  speed: number;
  turnRate: number;
  hp: number;
  maxHp: number;
  /** Hit sphere radius. */
  radius: number;
  state: "flying" | "falling" | "gone";
  target: Craft | null;
  retargetAt: number;
  nextBurst: number;
  gunIndex: number;
  roll: number;
  /** Lateral dodge while someone is on this craft's tail. */
  jink: THREE.Vector3;
  jinkAt: number;
  /** Falling wrecks: velocity and spin. */
  fall: THREE.Vector3;
  spin: number;
  trailAt: number;
  respawnAt: number;
  /** Vultures: a strafing run on the player's platforms is under way until this time. */
  runUntil: number;
  nextRun: number;
  runGoal: THREE.Vector3;
};

export type AirEvents = {
  /** A craft went down; `byPlayer` when the player landed the final hit. */
  shotDown: (craft: Craft, byPlayer: boolean) => void;
  /** A wreck hit a platform, building or the sea. */
  crashed: (position: THREE.Vector3, onDeck: boolean) => void;
};

/** Airspace over Tipoca City: a cylinder around the central platforms. */
const CENTER = new THREE.Vector3(10, 0, -20);
const RADIUS = 175;
/** Dogfights stay above 30 m; only strafing runs come lower, over the decks. */
const MIN_ALT = 34;
const RUN_ALT = 20;
const MAX_ALT = 95;
const BOLT_SPEED = 170;
const FIRE_RANGE = 120;

const up = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const identity = new THREE.Quaternion();
const raycaster = new THREE.Raycaster();

/**
 * The dogfight over the city: Republic fighters and vulture droids pick targets, chase, lead their
 * shots and trade fire. Damaged craft burn, spiral down and crash; replacements fly in from the edge.
 */
export class AirBattle {
  readonly craft: Craft[] = [];
  private time = 0;
  private readonly pending: Array<{ at: number; task: () => void }> = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly materials: Materials,
    private readonly world: World,
    private readonly battle: Battle,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
    private readonly events: AirEvents,
  ) {
    ROSTER.forEach((kind, i) => this.spawn(kind, i));
  }

  /** Flying droid fighters, for fly-by sounds and strafing runs on the decks. */
  get droidFighters(): Craft[] {
    return this.craft.filter((c) => c.team === "separatist" && c.state === "flying");
  }

  private spawn(kind: CraftKind, index: number): void {
    const spec = KINDS[kind];
    const team = spec.team;
    const built = spec.build(this.materials);
    this.scene.add(built.group);
    const craft: Craft = {
      kind, name: spec.name, team, group: built.group, guns: built.guns, heading: new THREE.Vector3(0, 0, -1),
      speed: spec.speed, turnRate: spec.turnRate, hp: 0, maxHp: spec.hp, radius: spec.radius,
      state: "flying", target: null, retargetAt: 0, nextBurst: 0, gunIndex: 0, roll: 0,
      jink: new THREE.Vector3(), jinkAt: 0, fall: new THREE.Vector3(), spin: 0, trailAt: 0, respawnAt: 0,
      runUntil: 0, nextRun: 8 + (index % 6) * 7 + Math.random() * 6, runGoal: new THREE.Vector3(),
    };
    this.craft.push(craft);
    // Start spread around the airspace instead of all arriving at once.
    const a = index * 2.4 + (team === "republic" ? 0 : Math.PI);
    this.enter(craft, new THREE.Vector3(CENTER.x + Math.cos(a) * RADIUS * .6, 45 + Math.random() * 35, CENTER.z + Math.sin(a) * RADIUS * .6));
  }

  /** (Re)enter the fight at `position`, heading roughly toward the middle. */
  private enter(craft: Craft, position: THREE.Vector3): void {
    craft.group.position.copy(position);
    craft.heading.copy(CENTER).setY(position.y).sub(position).normalize();
    craft.heading.applyAxisAngle(up, (Math.random() - .5) * 1.2);
    craft.hp = craft.maxHp;
    craft.state = "flying";
    craft.target = null;
    craft.roll = 0;
    craft.runUntil = 0;
    craft.group.visible = true;
    this.orient(craft);
  }

  private orient(craft: Craft): void {
    const position = craft.group.position;
    craft.group.lookAt(position.x - craft.heading.x, position.y - craft.heading.y, position.z - craft.heading.z);
    craft.group.rotateZ(craft.roll);
  }

  update(delta: number, player: THREE.Vector3): void {
    if (delta <= 0) return;
    this.time += delta;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at > this.time) continue;
      const { task } = this.pending[i];
      this.pending.splice(i, 1);
      task();
    }
    for (const craft of this.craft) {
      if (craft.state === "flying") this.fly(craft, delta, player);
      else if (craft.state === "falling") this.fallDown(craft, delta);
      else if (this.time > craft.respawnAt) {
        const a = Math.random() * Math.PI * 2;
        this.enter(craft, new THREE.Vector3(CENTER.x + Math.cos(a) * RADIUS * 1.1, 50 + Math.random() * 35, CENTER.z + Math.sin(a) * RADIUS * 1.1));
      }
    }
  }

  private after(delay: number, task: () => void): void {
    this.pending.push({ at: this.time + delay, task });
  }

  private pickTarget(craft: Craft): void {
    const position = craft.group.position;
    let best: Craft | null = null;
    let bestScore = Infinity;
    for (const other of this.craft) {
      if (other.team === craft.team || other.state !== "flying") continue;
      const offset = other.group.position.clone().sub(position);
      const distance = offset.length();
      // Prefer enemies ahead of the nose, and spread out so not everyone chases the same one.
      const ahead = craft.heading.dot(offset.divideScalar(Math.max(distance, 1e-3)));
      const crowd = this.craft.filter((c) => c.target === other && c !== craft).length;
      const score = distance * (1.6 - ahead * .6) * (1 + crowd * .7);
      if (score < bestScore) { bestScore = score; best = other; }
    }
    craft.target = best;
    craft.retargetAt = this.time + 6 + Math.random() * 5;
  }

  private fly(craft: Craft, delta: number, player: THREE.Vector3): void {
    const position = craft.group.position;
    if (!craft.target || craft.target.state !== "flying" || this.time > craft.retargetAt) this.pickTarget(craft);

    const desired = new THREE.Vector3();
    let lead: THREE.Vector3 | null = null;
    const strafing = craft.team === "separatist" && this.time < craft.runUntil;
    if (craft.team === "separatist" && !strafing && this.time > craft.nextRun) {
      // Dive on the platforms the player is fighting on.
      craft.runUntil = this.time + 9;
      craft.nextRun = this.time + 22 + Math.random() * 18;
      craft.runGoal.copy(player).add(new THREE.Vector3((Math.random() - .5) * 30, 0, (Math.random() - .5) * 30)).setY(RUN_ALT);
    }
    if (strafing) {
      desired.copy(craft.runGoal).sub(position).normalize();
      const flat = Math.hypot(craft.runGoal.x - position.x, craft.runGoal.z - position.z);
      if (flat < 20) craft.runUntil = 0;
    } else if (craft.target) {
      const target = craft.target;
      const distance = target.group.position.distanceTo(position);
      lead = target.group.position.clone().addScaledVector(target.heading, target.speed * distance / BOLT_SPEED);
      desired.copy(lead).sub(position).normalize();
      // Overshooting: break away rather than ramming.
      if (distance < 18 && craft.heading.dot(desired) > .3) desired.addScaledVector(new THREE.Vector3().crossVectors(craft.heading, up).normalize(), 1.5).normalize();
    } else desired.copy(craft.heading);

    // Someone on our tail: weave.
    const chased = this.craft.some((c) => c.target === craft && c.state === "flying" && c.group.position.distanceTo(position) < 80);
    if (chased && this.time > craft.jinkAt) {
      craft.jink.set(Math.random() - .5, (Math.random() - .5) * .6, Math.random() - .5).normalize().multiplyScalar(.9);
      craft.jinkAt = this.time + .7 + Math.random() * .8;
    } else if (!chased) craft.jink.multiplyScalar(Math.max(0, 1 - delta * 2));
    desired.add(craft.jink);

    // Stay over the city, between the floor and the clouds.
    const flat = new THREE.Vector3(position.x - CENTER.x, 0, position.z - CENTER.z);
    const out = flat.length();
    if (out > RADIUS * .8) desired.addScaledVector(flat.normalize(), -3 * THREE.MathUtils.smoothstep(out, RADIUS * .8, RADIUS * 1.05));
    // Pull up early: look at where the dive will be in a couple of seconds.
    const floor = strafing ? RUN_ALT - 4 : MIN_ALT;
    const ahead = position.y + Math.min(0, craft.heading.y) * craft.speed * 2;
    if (ahead < floor + 8) desired.y += (floor + 8 - ahead) * .3;
    if (position.y > MAX_ALT) desired.y -= (position.y - MAX_ALT) * .1;
    desired.normalize();

    // Turn toward the desired heading at a limited rate, banking into the turn.
    const before = craft.heading.clone();
    const angle = craft.heading.angleTo(desired);
    if (angle > 1e-4) {
      tmpQ.setFromUnitVectors(craft.heading, desired);
      craft.heading.applyQuaternion(identity.clone().slerp(tmpQ, Math.min(1, craft.turnRate * delta / angle))).normalize();
    }
    const yawRate = new THREE.Vector3().crossVectors(before, craft.heading).y / delta;
    craft.roll = THREE.MathUtils.lerp(craft.roll, THREE.MathUtils.clamp(yawRate * 1.4, -1.3, 1.3), Math.min(1, delta * 3));
    position.addScaledVector(craft.heading, craft.speed * delta);
    // Never skim the decks or clip a platform, whatever the steering wants.
    if (position.y < floor - 4) {
      position.y = floor - 4;
      craft.heading.y = Math.max(craft.heading.y, 0);
      craft.heading.normalize();
    }
    this.orient(craft);

    // Fire when the lead point sits in front of the nose.
    if (lead && craft.target && this.time > craft.nextBurst) {
      const distance = lead.distanceTo(position);
      const aimError = craft.heading.angleTo(lead.clone().sub(position));
      if (distance < FIRE_RANGE && aimError < THREE.MathUtils.degToRad(7)) {
        craft.nextBurst = this.time + .9 + Math.random() * 1.1;
        const shots = craft.team === "republic" ? 4 : 5;
        for (let i = 0; i < shots; i++) this.after(i * .11, () => this.fireBolt(craft, i === 0));
      }
    }
  }

  private fireBolt(craft: Craft, sound: boolean): void {
    const target = craft.target;
    if (craft.state !== "flying" || !target) return;
    const gun = craft.guns[craft.gunIndex++ % craft.guns.length].getWorldPosition(new THREE.Vector3());
    const distance = target.group.position.distanceTo(gun);
    const aimError = craft.heading.angleTo(target.group.position.clone().sub(gun));
    // Better odds up close and dead astern; jinking targets are harder to hit.
    const chance = THREE.MathUtils.clamp((1 - distance / FIRE_RANGE) * .55 + .12 - aimError * 1.5 - target.jink.length() * .12, .04, .6);
    const hit = target.state === "flying" && Math.random() < chance;
    const travel = distance / BOLT_SPEED;
    const end = target.group.position.clone().addScaledVector(target.heading, target.speed * travel);
    if (!hit) end.add(new THREE.Vector3(Math.random() - .5, Math.random() - .5, Math.random() - .5).multiplyScalar(10)).addScaledVector(craft.heading, 40);
    this.battle.tracer(gun, end, craft.team, BOLT_SPEED);
    if (sound) this.audio.blaster(craft.team === "republic" ? "clone" : "droid", gun);
    if (hit) this.after(travel, () => {
      if (target.state !== "flying") return;
      const at = target.group.position.clone();
      this.effects.sparksAt(at, craft.heading.clone().negate(), craft.team === "republic" ? BOLT_COLORS.blue : BOLT_COLORS.red, 12, 6);
      this.effects.glow(at, new THREE.Color(3, 1.6, .6), 2.2, .15);
      this.damage(target, 40, false);
    });
  }

  /** Damage a flying craft. Returns true if this hit brought it down. */
  damage(craft: Craft, amount: number, byPlayer: boolean): boolean {
    if (craft.state !== "flying") return false;
    craft.hp -= amount;
    if (craft.hp > 0) return false;
    craft.state = "falling";
    craft.fall.copy(craft.heading).multiplyScalar(craft.speed * .8);
    craft.fall.y = Math.min(craft.fall.y, 2);
    craft.spin = (Math.random() < .5 ? -1 : 1) * (2.5 + Math.random() * 2.5);
    craft.target = null;
    const at = craft.group.position.clone();
    this.effects.airburst(at, .7);
    this.audio.explosion(at, .7);
    this.events.shotDown(craft, byPlayer);
    return true;
  }

  private fallDown(craft: Craft, delta: number): void {
    const position = craft.group.position;
    const from = position.clone();
    craft.fall.y -= 15 * delta;
    craft.fall.multiplyScalar(Math.max(0, 1 - delta * .15));
    position.addScaledVector(craft.fall, delta);
    craft.heading.copy(craft.fall).normalize();
    craft.roll += craft.spin * delta;
    this.orient(craft);

    // Burning trail.
    if (this.time > craft.trailAt) {
      craft.trailAt = this.time + .045;
      this.effects.smoke(position.clone(), 1.6 + Math.random(), 3.5, 0x16181a, .4, .75);
      this.effects.glow(position.clone(), new THREE.Color(4, 1.6, .4), 2.4 + Math.random(), .18);
    }

    // Did the wreck hit something?
    const step = position.clone().sub(from);
    const length = step.length();
    raycaster.set(from, step.divideScalar(Math.max(length, 1e-5)));
    raycaster.far = length + craft.radius * .4;
    raycaster.firstHitOnly = true;
    const struck = raycaster.intersectObjects(this.world.shootables, false)[0];
    const ground = this.world.nav.groundAt(position.x, position.z);
    if (struck) this.crash(craft, struck.point, true);
    else if (ground !== null && position.y <= ground + .8) this.crash(craft, position.clone().setY(ground), true);
    else if (position.y <= OCEAN_LEVEL + .5) {
      const at = position.clone().setY(OCEAN_LEVEL);
      this.effects.splash(at, 1.2);
      this.audio.explosion(at, .6);
      this.retire(craft);
      this.events.crashed(at, false);
    }
  }

  private crash(craft: Craft, at: THREE.Vector3, onDeck: boolean): void {
    this.effects.explosion(at, 1.8);
    this.effects.airburst(at.clone().setY(at.y + 2), .8);
    this.audio.explosion(at, 1.2);
    this.retire(craft);
    this.events.crashed(at, onDeck);
  }

  private retire(craft: Craft): void {
    craft.state = "gone";
    craft.group.visible = false;
    craft.respawnAt = this.time + 7 + Math.random() * 8;
  }

  /** Nearest flying craft along a ray, for the player's shots. */
  rayHit(origin: THREE.Vector3, direction: THREE.Vector3, far: number): { craft: Craft; distance: number } | null {
    let best: { craft: Craft; distance: number } | null = null;
    const offset = new THREE.Vector3();
    for (const craft of this.craft) {
      if (craft.state !== "flying") continue;
      offset.copy(craft.group.position).sub(origin);
      const along = offset.dot(direction);
      if (along < 0 || along > far) continue;
      const miss = offset.addScaledVector(direction, -along).length();
      if (miss > craft.radius) continue;
      const distance = along - Math.sqrt(craft.radius * craft.radius - miss * miss);
      if (!best || distance < best.distance) best = { craft, distance };
    }
    return best;
  }
}
