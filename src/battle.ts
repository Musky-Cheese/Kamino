import * as THREE from "three";
import { buildRig, type ActorKind, type Rig } from "./actors";
import type { BlasterVoice, GameAudio } from "./audio";
import { ZONES } from "./config";
import { BOLT_COLORS, Effects } from "./effects";
import type { Navigation } from "./navigation";
import type { CoverPoint, World } from "./world";

export type Team = "republic" | "separatist";

export type Target = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  height: number;
  radius: number;
  alive: boolean;
  team: Team;
  isPlayer: boolean;
};

type ActorState = "path" | "hold" | "advance" | "retreat" | "dead";

const STATS: Record<ActorKind, { hp: number; walk: number; run: number; radius: number; burst: number; burstGap: number; cooldown: [number, number]; spread: number; damage: number; voice: BlasterVoice; boltSpeed: number }> = {
  b1: { hp: 70, walk: 2.3, run: 4.2, radius: .34, burst: 3, burstGap: .2, cooldown: [1.6, 3], spread: 3.1, damage: 5.5, voice: "droid", boltSpeed: 70 },
  b2: { hp: 320, walk: 1.9, run: 2.8, radius: .5, burst: 6, burstGap: .11, cooldown: [2.4, 3.4], spread: 3.4, damage: 5, voice: "super", boltSpeed: 75 },
  clone: { hp: 120, walk: 3, run: 4.6, radius: .34, burst: 3, burstGap: .16, cooldown: [.9, 1.8], spread: 1.5, damage: 24, voice: "clone", boltSpeed: 95 },
};

export class Actor implements Target {
  readonly position: THREE.Vector3;
  readonly velocity = new THREE.Vector3();
  readonly radius: number;
  height: number;
  hp: number;
  alive = true;
  state: ActorState = "hold";
  path: THREE.Vector2[] = [];
  cover: CoverPoint | null = null;
  target: Target | null = null;
  zone: number;
  walkPhase = Math.random() * 10;
  fireTimer: number;
  burstLeft = 0;
  retargetTimer = 0;
  noSightTimer = 0;
  crouch = 0;
  flinch = 0;
  aimPitch = 0;
  stuckTimer = 0;
  bestDistance = Infinity;
  peekTimer = Math.random() * 3;
  peekOffset = 0;
  deadTime = 0;
  aggressive = false;
  readonly lastPosition = new THREE.Vector3();

  constructor(readonly kind: ActorKind, readonly team: Team, readonly rig: Rig, zone: number) {
    this.position = rig.root.position;
    this.radius = STATS[kind].radius;
    this.height = rig.height;
    this.hp = STATS[kind].hp;
    this.zone = zone;
    this.fireTimer = 1 + Math.random() * 2;
  }

  get isPlayer(): boolean { return false; }
  get stats() { return STATS[this.kind]; }
}

type Bolt = {
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  team: Team;
  damage: number;
  ttl: number;
  fromPlayer: boolean;
  whizzed: boolean;
};

export type BattleEvents = {
  droidKilled: (actor: Actor, byPlayer: boolean, headshot: boolean) => void;
  cloneKilled: (actor: Actor) => void;
  playerHit: (damage: number, from: THREE.Vector3) => void;
  nearMiss: (position: THREE.Vector3) => void;
  droidHitByPlayer: (actor: Actor, headshot: boolean) => void;
};

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;

/** Droid and clone AI, projectile blaster bolts, damage and deaths. */
export class Battle {
  readonly actors: Actor[] = [];
  readonly targetMeshes: THREE.Mesh[] = [];
  private readonly bolts: Bolt[] = [];
  private readonly boltPools: Record<Team, THREE.Mesh[]> = { republic: [], separatist: [] };
  // Keep the coloured light close to the bolt. A broad additive capsule turns into a soft
  // smear once bloom is applied, especially against the pale storm sky.
  private readonly boltGeometry = new THREE.CapsuleGeometry(.024, 1.5, 4, 8).rotateX(Math.PI / 2);
  private readonly innerGlowGeometry = new THREE.CapsuleGeometry(.058, 1.62, 4, 8).rotateX(Math.PI / 2);
  private readonly outerGlowGeometry = new THREE.CapsuleGeometry(.105, 1.82, 4, 10).rotateX(Math.PI / 2);
  private readonly boltMaterials: Record<Team, { core: THREE.MeshBasicMaterial; inner: THREE.MeshBasicMaterial; outer: THREE.MeshBasicMaterial }>;
  private readonly nav: Navigation;
  private readonly tmp = new THREE.Vector3();
  private cloneVariant = 0;
  difficulty = 1;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
    private readonly player: Target,
    private readonly events: BattleEvents,
  ) {
    this.nav = world.nav;
    const glow = (color: THREE.Color, opacity: number) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.boltMaterials = {
      separatist: {
        core: new THREE.MeshBasicMaterial({ color: new THREE.Color(18, 9, 7), toneMapped: false }),
        inner: glow(BOLT_COLORS.red.clone().multiplyScalar(.55), .72),
        outer: glow(BOLT_COLORS.red.clone().multiplyScalar(.12), .28),
      },
      republic: {
        core: new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 13, 18), toneMapped: false }),
        inner: glow(BOLT_COLORS.blue.clone().multiplyScalar(.55), .72),
        outer: glow(BOLT_COLORS.blue.clone().multiplyScalar(.12), .28),
      },
    };
  }

  /** A thin, bright core keeps the bolt readable; two restrained coloured layers sell its energy. */
  private boltMesh(team: Team): THREE.Mesh {
    const pooled = this.boltPools[team].pop();
    if (pooled) return pooled;
    const mesh = new THREE.Mesh(this.boltGeometry, this.boltMaterials[team].core);
    const inner = new THREE.Mesh(this.innerGlowGeometry, this.boltMaterials[team].inner);
    const outer = new THREE.Mesh(this.outerGlowGeometry, this.boltMaterials[team].outer);
    inner.renderOrder = 6;
    outer.renderOrder = 5;
    mesh.add(inner, outer);
    return mesh;
  }

  // ------------------------------------------------------------- spawning

  spawn(kind: ActorKind, at: THREE.Vector2, zone: number): Actor {
    const team: Team = kind === "clone" ? "republic" : "separatist";
    const rig = buildRig(kind, kind === "clone" ? (this.cloneVariant++ % 4) - 1 : 0);
    const actor = new Actor(kind, team, rig, zone);
    actor.position.set(at.x, this.nav.heightAt(at.x, at.y) ?? 0, at.y);
    actor.lastPosition.copy(actor.position);
    rig.root.rotation.y = team === "separatist" ? 0 : Math.PI;
    rig.root.traverse((object) => { object.userData.actor = actor; });
    rig.head.traverse((object) => { object.userData.head = true; });
    this.scene.add(rig.root);
    this.actors.push(actor);
    if (team === "separatist") this.targetMeshes.push(...rig.meshes);
    return actor;
  }

  /** Place a droid directly in cover (dug-in defenders). */
  deployDefender(kind: ActorKind, zone: number): Actor | null {
    const cover = this.freeCover(this.world.enemyCover[zone], null);
    const point = cover?.position ?? this.randomPointInZone(zone, -1);
    const actor = this.spawn(kind, point, zone);
    if (cover) { cover.taken = true; actor.cover = cover; }
    actor.state = kind === "b2" ? "advance" : "hold";
    return actor;
  }

  /** Spawn a droid at `from` and march it into cover in `zone`. */
  deployReinforcement(kind: ActorKind, from: THREE.Vector2, fromZone: number, zone: number): Actor {
    const actor = this.spawn(kind, from, fromZone);
    this.sendTo(actor, zone, this.world.enemyCover[zone], Math.random() < .5);
    actor.aggressive = kind === "b2" || Math.random() < .2;
    if (Math.random() < .3) this.audio.rogerRoger(actor.position);
    return actor;
  }

  spawnClone(at: THREE.Vector2, zone: number): Actor {
    const actor = this.spawn("clone", at, zone);
    const cover = this.freeCover(this.world.allyCover[zone], at);
    if (cover) { cover.taken = true; actor.cover = cover; actor.path = [cover.position.clone()]; actor.state = "path"; }
    return actor;
  }

  /** Order every living clone to cover positions in `zone`. */
  moveAllies(zone: number): void {
    for (const actor of this.actors) {
      if (!actor.alive || actor.team !== "republic") continue;
      this.sendTo(actor, zone, this.world.allyCover[zone], false);
    }
  }

  /** Surviving droids in `fromZone` fall back to `toZone`. */
  retreat(fromZone: number, toZone: number): number {
    let count = 0;
    for (const actor of this.actors) {
      if (!actor.alive || actor.team !== "separatist" || actor.zone !== fromZone) continue;
      this.sendTo(actor, toZone, this.world.enemyCover[toZone], Math.random() < .5);
      actor.state = "retreat";
      count++;
      if (count === 1) this.audio.rogerRoger(actor.position);
    }
    return count;
  }

  private sendTo(actor: Actor, zone: number, covers: CoverPoint[], preferSide: boolean): void {
    if (actor.cover) actor.cover.taken = false;
    const here = new THREE.Vector2(actor.position.x, actor.position.z);
    const cover = this.freeCover(covers, actor.team === "separatist" ? null : here);
    const goal = cover?.position.clone() ?? this.randomPointInZone(zone, actor.team === "separatist" ? -1 : 1);
    if (cover) cover.taken = true;
    actor.cover = cover;
    const currentZone = this.nav.zoneAt(here.x, here.y);
    const fromZone = currentZone >= 0 ? currentZone : actor.zone;
    actor.path = fromZone === zone ? [goal] : [...this.nav.route(fromZone, zone, here, preferSide), goal];
    actor.zone = zone;
    actor.state = "path";
    actor.bestDistance = Infinity;
    actor.stuckTimer = 0;
  }

  private freeCover(covers: CoverPoint[], near: THREE.Vector2 | null): CoverPoint | null {
    const free = covers.filter((cover) => !cover.taken);
    if (!free.length) return null;
    if (near) {
      free.sort((a, b) => a.position.distanceToSquared(near) - b.position.distanceToSquared(near));
      return free[Math.floor(Math.random() * Math.min(3, free.length))];
    }
    return free[Math.floor(Math.random() * free.length)];
  }

  randomPointInZone(zone: number, side: number): THREE.Vector2 {
    const z = ZONES[zone];
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2, radius = Math.sqrt(Math.random()) * (z.radius - 2.5);
      const p = new THREE.Vector2(z.center.x + Math.cos(angle) * radius, z.center.y + Math.sin(angle) * radius * .6 + side * z.radius * .3);
      if (this.nav.canStand(p.x, p.y, .4, this.nav.groundAt(p.x, p.y) ?? 0)) return p;
    }
    return z.center.clone();
  }

  /** Bring droid hit meshes up to date with this frame's animation before raycasting against them. */
  refreshHitboxes(): void {
    for (const actor of this.actors) if (actor.alive && actor.team === "separatist") actor.rig.root.updateMatrixWorld(true);
  }

  aliveCount(team: Team, zone?: number): number {
    return this.actors.filter((actor) => actor.alive && actor.team === team && (zone === undefined || actor.zone === zone)).length;
  }

  // ------------------------------------------------------------- combat

  fireBolt(origin: THREE.Vector3, direction: THREE.Vector3, team: Team, damage: number, speed: number, fromPlayer: boolean, length = 1): void {
    const mesh = this.boltMesh(team);
    mesh.position.copy(origin);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    mesh.scale.set(1, 1, length);
    mesh.visible = true;
    this.scene.add(mesh);
    this.bolts.push({ mesh, position: origin.clone(), velocity: direction.clone().multiplyScalar(speed), team, damage, ttl: 2.2, fromPlayer, whizzed: false });
  }

  /** Visual-only bolt for hitscan player shots. Travels from the muzzle to the hit point. */
  tracer(origin: THREE.Vector3, end: THREE.Vector3, team: Team, speed = 240): void {
    const direction = end.clone().sub(origin);
    const distance = direction.length();
    if (distance < .5) return;
    direction.divideScalar(distance);
    const mesh = this.boltMesh(team);
    mesh.position.copy(origin);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    mesh.scale.set(1, 1, 1.2);
    mesh.visible = true;
    this.scene.add(mesh);
    this.bolts.push({ mesh, position: origin.clone(), velocity: direction.multiplyScalar(speed), team, damage: 0, ttl: distance / speed, fromPlayer: true, whizzed: true });
  }

  damageActor(actor: Actor, amount: number, direction: THREE.Vector3, byPlayer: boolean, headshot: boolean): void {
    if (!actor.alive) return;
    actor.hp -= amount;
    actor.flinch = 1;
    if (byPlayer && actor.team === "separatist") this.events.droidHitByPlayer(actor, headshot);
    if (actor.hp <= 0) this.kill(actor, direction, byPlayer, headshot, amount);
    else if (actor.state === "hold" && actor.team === "separatist" && Math.random() < .25) actor.peekTimer = 0;
  }

  private kill(actor: Actor, direction: THREE.Vector3, byPlayer: boolean, headshot: boolean, amount: number): void {
    actor.alive = false;
    actor.state = "dead";
    if (actor.cover) actor.cover.taken = false;
    const chest = actor.position.clone().setY(actor.position.y + actor.height * .65);
    if (actor.team === "separatist") {
      for (const mesh of actor.rig.meshes) {
        const index = this.targetMeshes.indexOf(mesh);
        if (index >= 0) this.targetMeshes.splice(index, 1);
      }
      this.effects.sparksAt(chest, new THREE.Vector3(0, 1, 0), new THREE.Color(5, 2.4, .8), actor.kind === "b2" ? 50 : 26, 6);
      this.effects.flash(chest, 0xff9a40, actor.kind === "b2" ? 120 : 40, .25, 9);
      this.effects.smoke(chest, .9, 2.2, 0x26292c, .7, .5);
      if (actor.kind === "b2") this.effects.explosion(chest, .55);
      this.effects.shatter(actor.rig.pieces(), direction.clone().setY(0).normalize(), Math.min(2.4, .8 + amount / 50));
      this.scene.remove(actor.rig.root);
      this.audio.droidBreak(chest);
      this.events.droidKilled(actor, byPlayer, headshot);
      this.actors.splice(this.actors.indexOf(actor), 1);
    } else {
      actor.deadTime = 0;
      this.events.cloneKilled(actor);
    }
  }

  explode(position: THREE.Vector3, radius: number, damage: number, byPlayer: boolean): void {
    this.effects.explosion(position, 1);
    this.audio.explosion(position, 1.2);
    for (const actor of this.actors.slice()) {
      if (!actor.alive) continue;
      const center = actor.position.clone().setY(actor.position.y + actor.height * .5);
      const distance = center.distanceTo(position);
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      this.damageActor(actor, damage * (.25 + .75 * falloff), center.sub(position).normalize(), byPlayer, false);
    }
    const playerCenter = this.player.position.clone().setY(this.player.position.y + 1);
    const pd = playerCenter.distanceTo(position);
    if (pd < radius) this.events.playerHit(damage * .45 * (1 - pd / radius), position);
    this.effects.addShake(THREE.MathUtils.clamp(1.4 - pd / 25, 0, 1.2));
  }

  // ------------------------------------------------------------- update

  update(delta: number, time: number): void {
    for (const actor of this.actors.slice()) {
      if (actor.alive) this.think(actor, delta, time);
      else this.animateDead(actor, delta);
    }
    this.separate();
    this.updateBolts(delta);
  }

  private chooseTarget(actor: Actor): Target | null {
    let best: Target | null = null, bestScore = Infinity;
    const consider = (candidate: Target, bias: number) => {
      if (!candidate.alive) return;
      const score = candidate.position.distanceTo(actor.position) * bias;
      if (score < bestScore && score < 85) { bestScore = score; best = candidate; }
    };
    if (actor.team === "separatist") {
      consider(this.player, .7);
      for (const other of this.actors) if (other.team === "republic" && other.alive) consider(other, 1 + Math.random() * .2);
    } else {
      for (const other of this.actors) if (other.team === "separatist" && other.alive) consider(other, other.state === "retreat" ? 1.3 : 1);
    }
    return best;
  }

  private think(actor: Actor, delta: number, time: number): void {
    const stats = actor.stats;
    actor.retargetTimer -= delta;
    if (actor.retargetTimer <= 0 || !actor.target?.alive) {
      actor.target = this.chooseTarget(actor);
      actor.retargetTimer = 1 + Math.random();
    }
    const target = actor.target;
    let speed = 0;
    let goal: THREE.Vector2 | null = null;

    if (actor.state === "path" || actor.state === "retreat") {
      goal = actor.path[0] ?? null;
      if (goal && Math.hypot(goal.x - actor.position.x, goal.y - actor.position.z) < (actor.path.length > 1 ? 1.4 : .5)) {
        actor.path.shift();
        actor.bestDistance = Infinity;
        goal = actor.path[0] ?? null;
      }
      if (!goal) {
        actor.state = actor.aggressive ? "advance" : "hold";
      } else speed = actor.state === "retreat" ? stats.run * 1.1 : actor.team === "republic" ? stats.run : stats.walk * 1.25;
    } else if (actor.state === "advance" && target) {
      const d = target.position.distanceTo(actor.position);
      if (d > (actor.kind === "b2" ? 9 : 14)) {
        goal = new THREE.Vector2(target.position.x, target.position.z);
        speed = stats.walk;
      }
    } else if (actor.state === "hold") {
      // Peek out from cover sideways now and then, crouch when not shooting.
      actor.peekTimer -= delta;
      if (actor.peekTimer <= 0) {
        actor.peekOffset = actor.peekOffset === 0 ? (Math.random() < .5 ? -1 : 1) * (.8 + Math.random() * .6) : 0;
        actor.peekTimer = actor.peekOffset === 0 ? 1.2 + Math.random() * 2 : 2 + Math.random() * 2.5;
      }
      if (actor.cover) {
        const side = actor.team === "separatist" ? 1 : -1;
        const g = actor.cover.position.clone().add(new THREE.Vector2(actor.peekOffset * side, 0));
        if (g.distanceTo(new THREE.Vector2(actor.position.x, actor.position.z)) > .25) { goal = g; speed = stats.walk * .7; }
        else actor.bestDistance = Infinity;
      }
      if (actor.noSightTimer > 5) {
        actor.noSightTimer = 0;
        if (actor.team === "separatist" && Math.random() < .5) actor.state = "advance";
        else this.sendTo(actor, actor.zone, actor.team === "separatist" ? this.world.enemyCover[actor.zone] : this.world.allyCover[actor.zone], false);
      }
    }

    // Locomotion.
    let moved = 0;
    if (goal && speed > 0) {
      const dx = goal.x - actor.position.x, dz = goal.y - actor.position.z;
      const distance = Math.hypot(dx, dz);
      const step = Math.min(distance, speed * delta);
      if (distance > 1e-3) {
        const before = actor.position.clone();
        if (!this.nav.move(actor.position, dx / distance * step, dz / distance * step, actor.radius)) {
          // Sidestep around whatever blocks the straight line.
          const sx = -dz / distance, sz = dx / distance;
          const dir = Math.sin(time * .7 + actor.walkPhase) > 0 ? 1 : -1;
          this.nav.move(actor.position, sx * dir * step, sz * dir * step, actor.radius);
        }
        moved = before.distanceTo(actor.position);
        actor.velocity.subVectors(actor.position, before).divideScalar(Math.max(delta, 1e-4));
      }
      // Progress check: if the goal isn't getting closer, give up on this waypoint.
      if (distance < actor.bestDistance - .3) {
        actor.bestDistance = distance;
        actor.stuckTimer = 0;
      } else {
        actor.stuckTimer += delta;
        if (actor.stuckTimer > 2.5) {
          actor.stuckTimer = 0;
          actor.bestDistance = Infinity;
          if (actor.path.length) actor.path.shift();
          else actor.peekOffset = 0;
        }
      }
    } else actor.velocity.set(0, 0, 0);
    const ground = this.nav.supportAt(actor.position.x, actor.position.z, actor.radius * .6) ?? actor.position.y;
    actor.position.y = THREE.MathUtils.lerp(actor.position.y, ground, Math.min(1, delta * 12));

    // Facing and aim.
    let facing = actor.rig.root.rotation.y;
    let aimPitch = 0;
    if (target && (actor.state !== "retreat" && actor.state !== "path" || moved < .02 || actor.team === "republic" || actor.aggressive)) {
      const dx = target.position.x - actor.position.x, dz = target.position.z - actor.position.z;
      facing = Math.atan2(dx, dz);
      const dy = target.position.y + target.height * .6 - (actor.position.y + actor.height * .75);
      aimPitch = -Math.atan2(dy, Math.hypot(dx, dz));
    } else if (goal) facing = Math.atan2(goal.x - actor.position.x, goal.y - actor.position.z);
    actor.rig.root.rotation.y = dampAngle(actor.rig.root.rotation.y, facing, delta * 8);
    actor.aimPitch = THREE.MathUtils.lerp(actor.aimPitch, aimPitch, Math.min(1, delta * 6));

    // Shooting.
    const canShoot = target && actor.state !== "retreat" && (actor.state !== "path" || actor.team === "republic" || actor.aggressive);
    actor.fireTimer -= delta;
    let firing = false;
    if (canShoot && actor.fireTimer <= 0 && target) {
      const muzzle = actor.rig.muzzle.getWorldPosition(new THREE.Vector3());
      const aimPoint = target.position.clone().setY(target.position.y + target.height * (.55 + Math.random() * .3));
      const flight = aimPoint.distanceTo(muzzle) / stats.boltSpeed;
      aimPoint.addScaledVector(target.velocity, flight * (.4 + Math.random() * .5));
      const distance = aimPoint.distanceTo(muzzle);
      if (distance < 80 && this.lineOfSight(muzzle, aimPoint)) {
        actor.noSightTimer = 0;
        const direction = aimPoint.sub(muzzle).normalize();
        const moving = target.velocity.lengthSq() > 4 ? 1.35 : 1;
        // Droids get sloppier at range; on harder difficulties they get sharper rather than looser.
        const range = 1 + Math.max(0, distance - 18) / 35;
        const skill = actor.team === "separatist" ? 1 / this.difficulty : 1;
        const spread = THREE.MathUtils.degToRad(stats.spread * moving * range * skill);
        jitter(direction, spread);
        const damage = stats.damage * (actor.team === "separatist" ? this.difficulty : 1);
        this.fireBolt(muzzle, direction, actor.team, damage, stats.boltSpeed, false);
        this.audio.blaster(stats.voice, muzzle);
        this.effects.glow(muzzle, actor.team === "separatist" ? BOLT_COLORS.red.clone().multiplyScalar(.25) : BOLT_COLORS.blue.clone().multiplyScalar(.25), .5, .06);
        firing = true;
        if (actor.burstLeft <= 0) actor.burstLeft = stats.burst;
        actor.burstLeft--;
        actor.fireTimer = actor.burstLeft > 0 ? stats.burstGap : THREE.MathUtils.randFloat(...stats.cooldown);
      } else {
        actor.noSightTimer += .35;
        actor.fireTimer = .35;
      }
    }

    // Animation.
    const stride = THREE.MathUtils.clamp(moved / Math.max(delta, 1e-4) / 3, 0, 1.3);
    actor.walkPhase += moved * 3.4;
    const wantCrouch = actor.state === "hold" && actor.peekOffset === 0 && !firing && actor.kind !== "b2" && actor.fireTimer > .4 ? 1 : 0;
    actor.crouch = THREE.MathUtils.lerp(actor.crouch, wantCrouch, Math.min(1, delta * 5));
    actor.height = actor.rig.height * (1 - actor.crouch * .3);
    actor.flinch = Math.max(0, actor.flinch - delta * 5);
    actor.rig.animate({ delta, time: time + actor.walkPhase, phase: actor.walkPhase, stride, aimPitch: actor.aimPitch, crouch: actor.crouch, flinch: actor.flinch, firing });
  }

  private animateDead(actor: Actor, delta: number): void {
    actor.deadTime += delta;
    actor.rig.animateDeath(actor.deadTime, delta);
    if (actor.deadTime > 30) {
      this.scene.remove(actor.rig.root);
      this.actors.splice(this.actors.indexOf(actor), 1);
    }
  }

  /** Keep actors from standing inside each other. */
  private separate(): void {
    const list = this.actors;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz), min = a.radius + b.radius + .15;
        if (d > 1e-4 && d < min) {
          const push = (min - d) * .5;
          this.nav.move(a.position, -dx / d * push, -dz / d * push, a.radius);
          this.nav.move(b.position, dx / d * push, dz / d * push, b.radius);
        }
      }
    }
  }

  lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const direction = to.clone().sub(from);
    const distance = direction.length();
    raycaster.set(from, direction.divideScalar(distance));
    raycaster.far = distance - .6;
    return raycaster.intersectObjects(this.world.shootables, false).length === 0;
  }

  private updateBolts(delta: number): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i];
      const step = bolt.velocity.length() * delta;
      const direction = this.tmp.copy(bolt.velocity).normalize();
      let hitT = Math.min(1, bolt.ttl / delta);
      let hitActor: Target | null = null;
      let hitNormal: THREE.Vector3 | null = null;
      let headshot = false;

      if (bolt.damage > 0) {
        raycaster.set(bolt.position, direction);
        raycaster.far = step;
        const hit = raycaster.intersectObjects(this.world.shootables, false)[0];
        if (hit) {
          hitT = hit.distance / step;
          hitNormal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : direction.clone().negate();
        }
        const candidates: Target[] = bolt.team === "separatist" ? [this.player, ...this.actors.filter((a) => a.team === "republic")] : this.actors.filter((a) => a.team === "separatist");
        for (const candidate of candidates) {
          if (!candidate.alive) continue;
          const t = capsuleHit(bolt.position, bolt.velocity, delta, candidate);
          if (t !== null && t < hitT) {
            hitT = t;
            hitActor = candidate;
            hitNormal = null;
            const y = bolt.position.y + bolt.velocity.y * delta * t;
            headshot = y > candidate.position.y + candidate.height * .82;
          }
        }
        if (!bolt.whizzed && bolt.team === "separatist" && hitActor !== this.player) {
          const head = this.player.position.clone().setY(this.player.position.y + this.player.height * .9);
          const toHead = head.clone().sub(bolt.position);
          const along = toHead.dot(direction);
          if (along > 0 && along < step * 1.5 && toHead.addScaledVector(direction, -along).length() < 1.6) {
            bolt.whizzed = true;
            this.events.nearMiss(head);
          }
        }
      }

      const end = bolt.position.clone().addScaledVector(bolt.velocity, delta * hitT);
      bolt.ttl -= delta;
      const finished = hitActor || hitNormal || bolt.ttl <= 0;
      bolt.position.copy(end);
      bolt.mesh.position.copy(end).addScaledVector(direction, -.8 * bolt.mesh.scale.z);
      if (!finished) continue;

      const color = bolt.team === "separatist" ? BOLT_COLORS.red : BOLT_COLORS.blue;
      if (hitActor) {
        if (hitActor === this.player) this.events.playerHit(bolt.damage, end.clone().addScaledVector(direction, -3));
        else {
          const actor = hitActor as Actor;
          this.effects.impact(end, direction.clone().negate(), actor.team === "separatist" ? new THREE.Color(5, 3, 1.2) : color, false);
          this.audio.impact(end, true);
          this.damageActor(actor, bolt.damage * (headshot ? 2 : 1), direction.clone(), false, headshot);
        }
      } else if (hitNormal) {
        this.effects.impact(end, hitNormal, color, true);
        if (Math.random() < .5) this.audio.impact(end);
      }
      this.scene.remove(bolt.mesh);
      this.boltPools[bolt.team].push(bolt.mesh);
      this.bolts.splice(i, 1);
    }
  }
}

/** Fraction of this frame's travel at which a bolt enters a target's vertical capsule, or null. */
function capsuleHit(origin: THREE.Vector3, velocity: THREE.Vector3, delta: number, target: Target): number | null {
  const sx = velocity.x * delta, sz = velocity.z * delta;
  const ox = origin.x - target.position.x, oz = origin.z - target.position.z;
  const a = sx * sx + sz * sz;
  const r = target.radius;
  let t: number;
  if (a < 1e-8) {
    if (ox * ox + oz * oz > r * r) return null;
    t = 0;
  } else {
    const b = 2 * (ox * sx + oz * sz);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) t = c < 0 ? 0 : -1;
    if (t < 0 || t > 1) return null;
  }
  const y = origin.y + velocity.y * delta * t;
  if (y < target.position.y + .05 || y > target.position.y + target.height) return null;
  return t;
}

function jitter(direction: THREE.Vector3, angle: number): void {
  const r = angle * Math.sqrt(Math.random());
  const theta = Math.random() * Math.PI * 2;
  const up = Math.abs(direction.y) > .95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(direction, up).normalize();
  const v = new THREE.Vector3().crossVectors(direction, u);
  direction.addScaledVector(u, Math.cos(theta) * Math.tan(r)).addScaledVector(v, Math.sin(theta) * Math.tan(r)).normalize();
}

function dampAngle(current: number, target: number, t: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * Math.min(1, t);
}
