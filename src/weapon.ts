import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { glowTexture, grimeTextures } from "./textures";

export type ViewState = {
  ads: number;
  /** 0..1: looking through the scope, so the rifle itself is out of view. */
  scope: number;
  moving: boolean;
  sprinting: boolean;
  grounded: boolean;
  crouch: number;
  reload: number | null;
  throwing: number | null;
  lookX: number;
  lookY: number;
  bob: number;
};

/** First-person DC-15A with clone gauntlets. Lives in camera space. */
export class Viewmodel {
  readonly root = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  private readonly gun = new THREE.Group();
  private readonly cell: THREE.Group;
  private readonly flash: THREE.Sprite;
  private readonly flashCross: THREE.Mesh;
  private readonly light = new THREE.PointLight(0x6fd2ff, 0, 7, 2);
  private readonly display: CanvasRenderingContext2D;
  private readonly displayTexture: THREE.CanvasTexture;
  private kick = 0;
  private kickSide = 0;
  private readonly sway = new THREE.Vector2();
  private readonly swayVelocity = new THREE.Vector2();
  private landing = 0;
  private time = 0;

  readonly hip = new THREE.Vector3(.2, -.215, -.46);
  readonly aim = new THREE.Vector3(0, -.128, -.33);

  constructor() {
    const white = grimeTextures(911, [222, 226, 224], .8);
    const gunmetal = new THREE.MeshStandardMaterial({ color: 0x23282c, metalness: .85, roughness: .34 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x5c656c, metalness: .8, roughness: .3 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0c0e10, metalness: .3, roughness: .7 });
    const armor = new THREE.MeshStandardMaterial({ ...white, color: 0xc4c8c6, metalness: .12, roughness: 1 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x121417, metalness: .05, roughness: .85 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x0b1a22, emissive: 0x52c8ff, emissiveIntensity: 1.1 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x061018, metalness: 1, roughness: .02, emissive: 0x0d3446, emissiveIntensity: 1 });

    const g = this.gun;
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, parent: THREE.Object3D = g) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      parent.add(mesh);
      return mesh;
    };
    const cyl = (r0: number, r1: number, h: number, seg = 18) => new THREE.CylinderGeometry(r0, r1, h, seg).rotateX(Math.PI / 2);

    add(new RoundedBoxGeometry(.066, .11, .44, 2, .012), gunmetal, 0, 0, 0);
    add(new THREE.BoxGeometry(.072, .03, .3), grey, 0, -.035, -.02);
    add(new THREE.BoxGeometry(.03, .016, .34), black, 0, .063, -.02);
    for (let z = -.17; z <= .13; z += .03) add(new THREE.BoxGeometry(.034, .008, .012), gunmetal, 0, .074, z);
    // Scope.
    add(new THREE.BoxGeometry(.02, .03, .03), gunmetal, 0, .085, -.08);
    add(new THREE.BoxGeometry(.02, .03, .03), gunmetal, 0, .085, .05);
    add(cyl(.021, .021, .2), gunmetal, 0, .108, -.015);
    add(cyl(.026, .022, .04), gunmetal, 0, .108, -.13);
    add(cyl(.024, .021, .03), black, 0, .108, .1);
    add(new THREE.CircleGeometry(.019, 18), lens, 0, .108, -.151, 0, Math.PI);
    add(new THREE.CircleGeometry(.017, 18), lens, 0, .108, .116);
    // Barrel shroud with cooling rings.
    add(cyl(.029, .03, .52), grey, 0, .012, -.47);
    for (let z = -.27; z >= -.7; z -= .045) add(new THREE.TorusGeometry(.031, .006, 6, 18), gunmetal, 0, .012, z);
    for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(.008, .012, .035), black, Math.cos(i) * .03, .012 + Math.sin(i) * .03, -.5);
    add(cyl(.036, .033, .08), gunmetal, 0, .012, -.76);
    add(cyl(.02, .02, .02), black, 0, .012, -.8);
    this.muzzle.position.set(0, .012, -.82);
    g.add(this.muzzle);
    // Handguard, grip, trigger guard.
    add(new RoundedBoxGeometry(.07, .05, .22, 1, .01), black, 0, -.055, -.29);
    add(new RoundedBoxGeometry(.044, .13, .06, 1, .01), black, 0, -.1, .1, .32);
    add(new THREE.TorusGeometry(.03, .005, 6, 14, Math.PI), gunmetal, 0, -.066, .035, 0, Math.PI / 2);
    // Energy cell.
    this.cell = new THREE.Group();
    this.cell.position.set(0, -.085, -.09);
    g.add(this.cell);
    add(new RoundedBoxGeometry(.046, .12, .075, 1, .01), grey, 0, -.04, 0, 0, 0, 0, this.cell);
    add(new THREE.BoxGeometry(.048, .012, .077), blue, 0, -.07, 0, 0, 0, 0, this.cell);
    // Folding stock.
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(.008, .014, .24), gunmetal, s * .024, -.01, .33);
    add(new RoundedBoxGeometry(.05, .1, .02, 1, .006), black, 0, -.03, .45);
    // Status lights.
    add(new THREE.BoxGeometry(.004, .008, .03), blue, -.034, .03, .12);
    add(new THREE.BoxGeometry(.004, .008, .03), blue, -.034, .03, .16);

    // Ammo counter display on the rear of the receiver, tilted toward the eye.
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 64;
    this.display = canvas.getContext("2d")!;
    this.displayTexture = new THREE.CanvasTexture(canvas);
    this.displayTexture.colorSpace = THREE.SRGBColorSpace;
    const screen = add(new THREE.PlaneGeometry(.05, .025), new THREE.MeshBasicMaterial({ map: this.displayTexture, toneMapped: false }), -.0345, .015, .16, 0, -Math.PI / 2);
    screen.rotation.order = "YXZ";

    // Gauntlets and gloves.
    const rightHand = new THREE.Group();
    rightHand.position.set(.004, -.12, .11);
    rightHand.rotation.set(.32, 0, 0);
    g.add(rightHand);
    add(new RoundedBoxGeometry(.06, .085, .1, 2, .02), glove, .012, -.01, .0, 0, 0, 0, rightHand);
    add(new RoundedBoxGeometry(.02, .02, .07, 1, .008), glove, -.024, .03, -.04, 0, 0, 0, rightHand);
    const rightArm = add(new RoundedBoxGeometry(.085, .085, .3, 2, .025), armor, .045, -.08, .2, .6, .25, 0, rightHand);
    rightArm.scale.set(1, 1, 1);
    add(new RoundedBoxGeometry(.075, .07, .06, 1, .02), glove, .03, -.03, .08, .6, .25, 0, rightHand);
    const leftHand = new THREE.Group();
    leftHand.position.set(-.012, -.07, -.32);
    g.add(leftHand);
    add(new RoundedBoxGeometry(.075, .06, .1, 2, .02), glove, -.02, -.02, 0, 0, 0, .3, leftHand);
    // Wrist and gauntlet angle down-left, out of the line of sight.
    add(new RoundedBoxGeometry(.07, .065, .08, 1, .02), glove, -.04, -.07, .05, .9, -.5, .4, leftHand);
    add(new RoundedBoxGeometry(.08, .085, .26, 2, .025), armor, -.1, -.17, .17, .9, -.5, .4, leftHand);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(2.2, 4.5, 8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.flash.scale.setScalar(.22);
    this.flash.visible = false;
    this.muzzle.add(this.flash);
    const crossGeometry = new THREE.PlaneGeometry(.05, .26);
    this.flashCross = new THREE.Mesh(crossGeometry, new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(1.5, 3.5, 7), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.flashCross.rotation.x = Math.PI / 2;
    this.flashCross.position.z = -.08;
    this.flashCross.visible = false;
    this.muzzle.add(this.flashCross);
    this.light.position.set(0, .05, -.85);
    g.add(this.light);

    g.traverse((object) => {
      if (object instanceof THREE.Mesh) { object.castShadow = false; object.receiveShadow = false; object.frustumCulled = false; }
    });
    this.root.add(g);
    this.root.position.copy(this.hip);
    this.setAmmo(50, 50);
  }

  setAmmo(ammo: number, capacity: number): void {
    const ctx = this.display;
    ctx.fillStyle = "#020a0e";
    ctx.fillRect(0, 0, 128, 64);
    const low = ammo / capacity < .25;
    ctx.fillStyle = low ? "#ff5a3c" : "#7fe0ff";
    ctx.font = "700 44px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(ammo).padStart(2, "0"), 64, 30);
    ctx.fillRect(10, 54, 108 * ammo / capacity, 5);
    this.displayTexture.needsUpdate = true;
  }

  fire(): void {
    this.kick = 1;
    this.kickSide = (Math.random() - .5) * 2;
    this.flash.visible = true;
    this.flashCross.visible = true;
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flashCross.rotation.y = Math.random() * Math.PI;
    this.flash.scale.setScalar(.16 + Math.random() * .12);
    this.light.intensity = 16;
  }

  land(strength: number): void { this.landing = Math.min(1, this.landing + strength); }

  update(delta: number, state: ViewState): void {
    this.time += delta;
    this.kick = Math.max(0, this.kick - delta * 10);
    this.landing = Math.max(0, this.landing - delta * 4);
    this.light.intensity = Math.max(0, this.light.intensity - delta * 160);
    this.flash.visible = this.flashCross.visible = this.light.intensity > 6;

    // Spring-damped lag behind mouse movement.
    const stiffness = 90, damping = 14;
    this.swayVelocity.x += (-state.lookX * .0009 - this.sway.x) * stiffness * delta;
    this.swayVelocity.y += (-state.lookY * .0009 - this.sway.y) * stiffness * delta;
    this.swayVelocity.multiplyScalar(Math.max(0, 1 - damping * delta));
    this.sway.addScaledVector(this.swayVelocity, delta);
    this.sway.clampScalar(-.08, .08);

    const ads = state.ads;
    const sprint = state.sprinting && ads < .1 ? 1 : 0;
    const bobAmount = state.moving && state.grounded ? (sprint ? 1.6 : 1) * (1 - ads * .85) : 0;
    const breathe = Math.sin(this.time * 1.6) * .0025 * (1 - ads * .7);
    const base = this.hip.clone().lerp(this.aim, ads);
    const pos = base.clone();
    pos.x += Math.sin(state.bob * .5) * .012 * bobAmount + this.sway.x * (1 - ads * .6);
    pos.y += -Math.abs(Math.cos(state.bob * .5)) * .012 * bobAmount + breathe + this.sway.y * (1 - ads * .6) - this.landing * .04;
    pos.z += this.kick * (.045 - ads * .02);
    pos.x += sprint * .04;
    pos.y -= sprint * .05 + state.crouch * .01;

    let rx = this.kick * (.07 - ads * .04) - sprint * .45 + this.sway.y * 2;
    let ry = sprint * .6 + this.sway.x * 2 + this.kickSide * this.kick * .02;
    let rz = sprint * .25 + Math.sin(state.bob * .5) * .02 * bobAmount;

    if (state.reload !== null) {
      const t = state.reload;
      const dip = Math.sin(Math.min(1, t * 1.25) * Math.PI);
      rz += dip * .55;
      rx += dip * .28;
      pos.y -= dip * .07;
      pos.x -= dip * .03;
      const out = THREE.MathUtils.smoothstep(t, .18, .4) * (1 - THREE.MathUtils.smoothstep(t, .5, .72));
      this.cell.position.y = -.085 - out * .2;
      this.cell.visible = out < .9;
    } else {
      this.cell.position.y = -.085;
      this.cell.visible = true;
    }
    if (state.throwing !== null) {
      const dip = Math.sin(state.throwing * Math.PI);
      pos.y -= dip * .16;
      rx -= dip * .5;
    }
    this.root.position.lerp(pos, Math.min(1, delta * 18));
    this.gun.visible = state.scope < .5;
    this.gun.rotation.x = THREE.MathUtils.lerp(this.gun.rotation.x, rx, Math.min(1, delta * 14));
    this.gun.rotation.y = THREE.MathUtils.lerp(this.gun.rotation.y, ry, Math.min(1, delta * 12));
    this.gun.rotation.z = THREE.MathUtils.lerp(this.gun.rotation.z, rz, Math.min(1, delta * 12));
  }
}
