import * as THREE from "three";
import type { Navigation } from "./navigation";
import { glowTexture, scorchTexture, smokeTexture } from "./textures";

type PooledLight = { light: THREE.PointLight; ttl: number; life: number; peak: number };
type Spark = { velocity: THREE.Vector3; position: THREE.Vector3; ttl: number; life: number; color: THREE.Color; gravity: number };
type Decal = { mesh: THREE.Mesh; ttl: number };
type Billboard = { sprite: THREE.Sprite; ttl: number; life: number; grow: number; startScale: number; velocity: THREE.Vector3; fade: number };
type Debris = { mesh: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3; ttl: number; resting: boolean; radius: number };

export const BOLT_COLORS = {
  red: new THREE.Color(9, .9, .55),
  blue: new THREE.Color(.8, 3.2, 9),
};

/**
 * Pooled particle and lighting effects. Every effect lives in fixed pools so combat never
 * allocates GPU resources mid-fight and the light count (and shader permutations) stays fixed.
 */
export class Effects {
  /** Heat shimmer hook (the post stack owns it): position, width, height, strength, life, rise. */
  heat: ((position: THREE.Vector3, width: number, height: number, strength: number, life: number, rise: number) => void) | null = null;
  private readonly lights: PooledLight[] = [];
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly sparks: Spark[] = [];
  private readonly decals: Decal[] = [];
  private readonly glows: Billboard[] = [];
  private readonly smokes: Billboard[] = [];
  private readonly debris: Debris[] = [];
  private readonly glowMap = glowTexture();
  private readonly smokeMap = smokeTexture(5);
  private readonly decalMaterial: THREE.MeshBasicMaterial;
  private readonly decalGeometry = new THREE.PlaneGeometry(1, 1);
  private decalCursor = 0;
  private shakeAmount = 0;
  private readonly sparkLimit = 600;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly z = new THREE.Vector3(0, 0, 1);

  constructor(private readonly scene: THREE.Scene, private readonly nav: Navigation) {
    for (let i = 0; i < 6; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.position.set(0, -500, 0);
      scene.add(light);
      this.lights.push({ light, ttl: 0, life: 1, peak: 0 });
    }
    const sparkMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.sparkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(.018, .018, 1), sparkMaterial, this.sparkLimit);
    this.sparkMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.sparkLimit * 3), 3);
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.count = 0;
    scene.add(this.sparkMesh);

    this.decalMaterial = new THREE.MeshBasicMaterial({
      map: scorchTexture(13), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    for (let i = 0; i < 90; i++) {
      const mesh = new THREE.Mesh(this.decalGeometry, this.decalMaterial);
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.decals.push({ mesh, ttl: 0 });
    }
  }

  get shake(): number { return this.shakeAmount; }

  /** Currently lit pooled lights (explosions, impacts, muzzle flashes), brightest first. */
  activeLights(): THREE.PointLight[] {
    return this.lights.filter((slot) => slot.ttl > 0 && slot.light.intensity > 1).map((slot) => slot.light).sort((a, b) => b.intensity - a.intensity);
  }

  addShake(amount: number): void { this.shakeAmount = Math.min(1.4, this.shakeAmount + amount); }

  flash(position: THREE.Vector3, color: THREE.ColorRepresentation, intensity: number, life: number, distance = 12): void {
    let slot = this.lights[0];
    for (const candidate of this.lights) {
      if (candidate.ttl <= 0) { slot = candidate; break; }
      if (candidate.ttl < slot.ttl) slot = candidate;
    }
    slot.light.position.copy(position);
    slot.light.color.set(color);
    slot.light.distance = distance;
    slot.ttl = slot.life = life;
    slot.peak = intensity;
    slot.light.intensity = intensity;
  }

  sparksAt(position: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, count: number, speed = 4, gravity = 9): void {
    for (let i = 0; i < count; i++) {
      if (this.sparks.length >= this.sparkLimit) this.sparks.shift();
      const velocity = new THREE.Vector3(Math.random() - .5, Math.random() - .5, Math.random() - .5).multiplyScalar(1.4).add(normal).normalize()
        .multiplyScalar(speed * (.4 + Math.random()));
      const life = .18 + Math.random() * .35;
      this.sparks.push({ position: position.clone(), velocity, ttl: life, life, color, gravity });
    }
  }

  glow(position: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life: number, grow = 0): void {
    const material = new THREE.SpriteMaterial({ map: this.glowMap, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.setScalar(size);
    this.scene.add(sprite);
    this.glows.push({ sprite, ttl: life, life, grow, startScale: size, velocity: new THREE.Vector3(), fade: 1 });
  }

  smoke(position: THREE.Vector3, size: number, life: number, color = 0x2a2d30, rise = .9, opacity = .55): void {
    const material = new THREE.SpriteMaterial({ map: this.smokeMap, color, transparent: true, depthWrite: false, opacity });
    material.rotation = Math.random() * Math.PI * 2;
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.setScalar(size);
    this.scene.add(sprite);
    this.smokes.push({ sprite, ttl: life, life, grow: size * 1.6, startScale: size, velocity: new THREE.Vector3((Math.random() - .5) * .6, rise, (Math.random() - .5) * .6), fade: opacity });
  }

  scorch(position: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    const decal = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % this.decals.length;
    decal.mesh.visible = true;
    decal.mesh.position.copy(position).addScaledVector(normal, .01);
    decal.mesh.quaternion.setFromUnitVectors(this.z, normal);
    decal.mesh.rotateZ(Math.random() * Math.PI * 2);
    decal.mesh.scale.setScalar(size);
    decal.ttl = 25;
  }

  /** Blaster bolt hitting a surface. */
  impact(position: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, surface: boolean): void {
    this.sparksAt(position, normal, color, surface ? 9 : 14, 5);
    this.glow(position.clone().addScaledVector(normal, .05), color.clone().multiplyScalar(.2), .9, .12);
    this.flash(position.clone().addScaledVector(normal, .3), color.clone().multiplyScalar(.12), 4, .12, 6);
    if (surface) {
      this.scorch(position, normal, .32 + Math.random() * .15);
      if (Math.random() < .35) this.smoke(position.clone().addScaledVector(normal, .1), .45, 1.1, 0x4a5056, .5, .35);
    }
  }

  explosion(position: THREE.Vector3, scale = 1): void {
    this.flash(position.clone().add(new THREE.Vector3(0, .8, 0)), 0xff8a3a, 900 * scale, .45, 22 * scale);
    this.glow(position, new THREE.Color(5, 2.2, .7), 3 * scale, .32, 7 * scale);
    this.glow(position, new THREE.Color(2, 2.2, 2.4), 1.5 * scale, .12, 5 * scale);
    for (let i = 0; i < 10; i++) {
      const offset = new THREE.Vector3((Math.random() - .5) * 1.6, Math.random() * 1.2, (Math.random() - .5) * 1.6).multiplyScalar(scale);
      this.smoke(position.clone().add(offset), (1.4 + Math.random() * 1.4) * scale, 2.5 + Math.random() * 2, 0x1f2124, 1.2, .75);
    }
    this.sparksAt(position, new THREE.Vector3(0, 1, 0), new THREE.Color(6, 3, 1), 60, 11, 14);
    this.scorch(position.clone().setY(position.y + .02), new THREE.Vector3(0, 1, 0), 3.2 * scale);
    this.heat?.(position, 3.2 * scale, 5.5 * scale, 1.3, 1.6, 1.8);
  }

  /** Fireball in open air: no scorch mark, debris sparks fall away. */
  airburst(position: THREE.Vector3, scale = 1): void {
    this.flash(position, 0xff8a3a, 1400 * scale, .5, 40 * scale);
    this.glow(position, new THREE.Color(5, 2.2, .7), 4 * scale, .4, 10 * scale);
    this.glow(position, new THREE.Color(2, 2.2, 2.4), 2 * scale, .14, 7 * scale);
    for (let i = 0; i < 8; i++) {
      const offset = new THREE.Vector3(Math.random() - .5, Math.random() - .5, Math.random() - .5).multiplyScalar(2.4 * scale);
      this.smoke(position.clone().add(offset), (2 + Math.random() * 2) * scale, 3 + Math.random() * 2, 0x1f2124, .6, .8);
    }
    this.sparksAt(position, new THREE.Vector3(0, .3, 0), new THREE.Color(6, 3, 1), 70, 16, 12);
  }

  /** Wreck hitting the sea: a column of spray. */
  splash(position: THREE.Vector3, scale = 1): void {
    this.flash(position.clone().setY(position.y + 3), 0xffa060, 500 * scale, .3, 30 * scale);
    for (let i = 0; i < 10; i++) {
      const offset = new THREE.Vector3((Math.random() - .5) * 4, Math.random() * 6, (Math.random() - .5) * 4).multiplyScalar(scale);
      this.smoke(position.clone().add(offset), (3 + Math.random() * 3) * scale, 2 + Math.random() * 1.5, 0xb8c6cf, 2.5, .6);
    }
    this.sparksAt(position, new THREE.Vector3(0, 1, 0), new THREE.Color(1.6, 1.8, 2), 40, 14, 18);
  }

  /** Break a droid into tumbling pieces. */
  shatter(meshes: THREE.Mesh[], impulse: THREE.Vector3, power: number): void {
    for (const mesh of meshes) {
      const holder = new THREE.Group();
      mesh.updateWorldMatrix(true, false);
      mesh.matrixWorld.decompose(holder.position, holder.quaternion, holder.scale);
      mesh.removeFromParent();
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      holder.add(mesh);
      this.scene.add(holder);
      const velocity = impulse.clone().multiplyScalar(power * (.4 + Math.random() * .8))
        .add(new THREE.Vector3((Math.random() - .5) * 3, 1.5 + Math.random() * 3.5, (Math.random() - .5) * 3).multiplyScalar(power * .6));
      const spin = new THREE.Vector3((Math.random() - .5) * 14, (Math.random() - .5) * 14, (Math.random() - .5) * 14);
      mesh.geometry.computeBoundingSphere();
      this.debris.push({ mesh: holder, velocity, spin, ttl: 14 + Math.random() * 6, resting: false, radius: Math.min(.12, mesh.geometry.boundingSphere?.radius ?? .05) });
    }
  }

  /** Dynamic objects that should collide with debris aren't modelled; debris rests on navigable floor. */
  update(delta: number, camera: THREE.Camera): void {
    this.shakeAmount = Math.max(0, this.shakeAmount - delta * 2.2);
    for (const slot of this.lights) {
      if (slot.ttl <= 0) continue;
      slot.ttl -= delta;
      const t = Math.max(0, slot.ttl / slot.life);
      slot.light.intensity = slot.peak * t * t;
      if (slot.ttl <= 0) { slot.light.intensity = 0; slot.light.position.y = -500; }
    }

    let count = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      spark.ttl -= delta;
      if (spark.ttl <= 0) { this.sparks.splice(i, 1); continue; }
      spark.velocity.y -= spark.gravity * delta;
      spark.position.addScaledVector(spark.velocity, delta);
      const ground = this.nav.groundAt(spark.position.x, spark.position.z);
      if (ground !== null && spark.position.y < ground + .01 && spark.velocity.y < 0) {
        spark.position.y = ground + .01;
        spark.velocity.y *= -.35;
        spark.velocity.x *= .6; spark.velocity.z *= .6;
      }
    }
    for (const spark of this.sparks) {
      const speed = spark.velocity.length();
      const length = Math.min(.5, .02 + speed * .025) * (spark.ttl / spark.life + .2);
      this.quaternion.setFromUnitVectors(this.z, spark.velocity.clone().divideScalar(speed || 1));
      this.scale.set(1, 1, length);
      this.matrix.compose(spark.position, this.quaternion, this.scale);
      this.sparkMesh.setMatrixAt(count, this.matrix);
      const fade = Math.min(1, spark.ttl / spark.life * 1.6);
      this.sparkMesh.setColorAt(count, spark.color.clone().multiplyScalar(fade));
      count++;
    }
    this.sparkMesh.count = count;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;

    for (const decal of this.decals) {
      if (!decal.mesh.visible) continue;
      decal.ttl -= delta;
      if (decal.ttl <= 0) decal.mesh.visible = false;
    }
    this.updateBillboards(this.glows, delta, (b, t) => {
      b.sprite.scale.setScalar(b.startScale + b.grow * (1 - t));
      b.sprite.material.opacity = t * t;
    });
    this.updateBillboards(this.smokes, delta, (b, t) => {
      b.sprite.position.addScaledVector(b.velocity, delta);
      b.velocity.multiplyScalar(1 - delta * .4);
      b.sprite.scale.setScalar(b.startScale + b.grow * (1 - t));
      b.sprite.material.opacity = b.fade * Math.min(1, t * 2) * Math.min(1, (1 - t) * 6);
    });

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const piece = this.debris[i];
      piece.ttl -= delta;
      if (piece.ttl <= 0 || piece.mesh.position.y < -45) {
        this.scene.remove(piece.mesh);
        this.debris.splice(i, 1);
        continue;
      }
      if (piece.ttl < 1.5) piece.mesh.position.y -= delta * .15;
      if (piece.resting) continue;
      piece.velocity.y -= 14 * delta;
      piece.mesh.position.addScaledVector(piece.velocity, delta);
      piece.mesh.rotation.x += piece.spin.x * delta;
      piece.mesh.rotation.y += piece.spin.y * delta;
      piece.mesh.rotation.z += piece.spin.z * delta;
      const ground = this.nav.groundAt(piece.mesh.position.x, piece.mesh.position.z);
      if (ground !== null && piece.mesh.position.y < ground + piece.radius) {
        piece.mesh.position.y = ground + piece.radius;
        piece.velocity.y *= -.3;
        piece.velocity.x *= .55; piece.velocity.z *= .55;
        piece.spin.multiplyScalar(.5);
        if (Math.abs(piece.velocity.y) < .6 && piece.velocity.lengthSq() < .5) piece.resting = true;
      }
    }
    void camera;
  }

  private updateBillboards(list: Billboard[], delta: number, apply: (b: Billboard, t: number) => void): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.ttl -= delta;
      if (b.ttl <= 0) {
        this.scene.remove(b.sprite);
        b.sprite.material.dispose();
        list.splice(i, 1);
        continue;
      }
      apply(b, b.ttl / b.life);
    }
  }
}
