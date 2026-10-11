import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { grimeTextures } from "./textures";
import { buildModelRig } from "./characters";
import { taperedBox } from "./vehicles";

export type ActorKind = "b1" | "b2" | "clone";

/** What the AI tells a rig each frame. */
export type Pose = {
  delta: number;
  time: number;
  /** Distance-driven gait phase. */
  phase: number;
  /** Ground speed relative to a brisk walk (0 = standing, ~1.3 = running). */
  stride: number;
  /** Radians; negative aims up. */
  aimPitch: number;
  crouch: number;
  /** 1 on the frame a hit lands, decaying to 0. */
  flinch: number;
  firing: boolean;
};

/** A character the battle can drive: procedural primitives or a loaded, animated model. */
export type Rig = {
  root: THREE.Group;
  /** Subtree whose meshes count as head hits. */
  head: THREE.Object3D;
  muzzle: THREE.Object3D;
  /** Meshes bolts and the player's shots are tested against (may be invisible proxies). */
  meshes: THREE.Mesh[];
  hipHeight: number;
  height: number;
  animate(pose: Pose): void;
  /** Fall for actors that stay on the field (clones); `t` is seconds since death. */
  animateDeath(t: number, delta: number): void;
  /** Visible pieces for the droid shatter effect (detached from the rig by the caller). */
  pieces(): THREE.Mesh[];
};

type ProceduralRig = {
  root: THREE.Group;
  pelvis: THREE.Group;
  spine: THREE.Group;
  head: THREE.Group;
  hips: [THREE.Group, THREE.Group];
  knees: [THREE.Group, THREE.Group];
  shoulders: [THREE.Group, THREE.Group];
  elbows: [THREE.Group, THREE.Group];
  muzzle: THREE.Object3D;
  meshes: THREE.Mesh[];
  hipHeight: number;
  height: number;
  /** Arm joint rotations that put the hands on the weapon (solved once with IK). */
  armPose: { shoulder: [THREE.Quaternion, THREE.Quaternion]; elbow: [THREE.Quaternion, THREE.Quaternion] };
};

type Palette = {
  b1: THREE.MeshStandardMaterial; b1Dark: THREE.MeshStandardMaterial; b1Eye: THREE.MeshStandardMaterial;
  b2: THREE.MeshStandardMaterial; b2Dark: THREE.MeshStandardMaterial; b2Eye: THREE.MeshStandardMaterial;
  armor: THREE.MeshStandardMaterial; suit: THREE.MeshStandardMaterial; visor: THREE.MeshStandardMaterial;
  gun: THREE.MeshStandardMaterial; gunLight: THREE.MeshStandardMaterial;
  ranks: THREE.MeshStandardMaterial[];
};

let palette: Palette | null = null;

export function materials(): Palette {
  if (palette) return palette;
  const tan = grimeTextures(301, [196, 174, 128], 1.3);
  const steel = grimeTextures(317, [104, 116, 132], 1);
  const white = grimeTextures(331, [226, 230, 228], .3);
  palette = {
    b1: new THREE.MeshStandardMaterial({ ...tan, metalness: .45, roughness: 1 }),
    b1Dark: new THREE.MeshStandardMaterial({ color: 0x4b4438, metalness: .75, roughness: .45 }),
    b1Eye: new THREE.MeshStandardMaterial({ color: 0x0a0806, metalness: .9, roughness: .15 }),
    b2: new THREE.MeshStandardMaterial({ ...steel, metalness: .75, roughness: 1 }),
    b2Dark: new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: .8, roughness: .4 }),
    b2Eye: new THREE.MeshStandardMaterial({ color: 0x150404, emissive: 0xff2a10, emissiveIntensity: 2.5 }),
    armor: new THREE.MeshStandardMaterial({ ...white, metalness: .15, roughness: 1, envMapIntensity: 1.2 }),
    suit: new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: .1, roughness: .8 }),
    visor: new THREE.MeshStandardMaterial({ color: 0x06080a, metalness: .9, roughness: .08 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x1d2125, metalness: .85, roughness: .38 }),
    gunLight: new THREE.MeshStandardMaterial({ color: 0x1d2125, emissive: 0x4fc8ff, emissiveIntensity: .7 }),
    ranks: [0x2b5aa8, 0xb83a28, 0x4f7f3a].map((color) => new THREE.MeshStandardMaterial({ color, metalness: .2, roughness: .5 })),
  };
  return palette;
}

class RigBuilder {
  readonly meshes: THREE.Mesh[] = [];

  part(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    // Only the larger parts cast shadows; tiny details aren't visible in the shadow map and cost a draw call each.
    geometry.computeBoundingSphere();
    mesh.castShadow = (geometry.boundingSphere?.radius ?? 0) > .12;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  joint(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    parent.add(group);
    return group;
  }
}

const cyl = (r0: number, r1: number, h: number, seg = 10) => new THREE.CylinderGeometry(r0, r1, h, seg);

/** E-5 carbine, barrel along +Z. */
export function buildE5(): { group: THREE.Group; muzzle: THREE.Object3D; meshes: THREE.Mesh[] } {
  const p = materials();
  const b = new RigBuilder();
  const gun = new THREE.Group();
  b.part(gun, new THREE.BoxGeometry(.05, .07, .42), p.gun, 0, 0, 0);
  b.part(gun, cyl(.016, .016, .34), p.gun, 0, .012, .36, Math.PI / 2);
  b.part(gun, new THREE.BoxGeometry(.035, .1, .05), p.gun, 0, -.07, -.05, .3);
  b.part(gun, new THREE.BoxGeometry(.04, .05, .18), p.gun, 0, -.01, -.27);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, .012, .54);
  gun.add(muzzle);
  return { group: gun, muzzle, meshes: b.meshes };
}

/** DC-15A blaster rifle, barrel along +Z. */
export function buildDC15(): { group: THREE.Group; muzzle: THREE.Object3D; meshes: THREE.Mesh[] } {
  const p = materials();
  const b = new RigBuilder();
  const gun = new THREE.Group();
  b.part(gun, new THREE.BoxGeometry(.06, .08, .5), p.gun, 0, 0, 0);
  b.part(gun, cyl(.022, .022, .5, 10), p.gun, 0, .01, .48, Math.PI / 2);
  b.part(gun, new THREE.BoxGeometry(.04, .12, .05), p.gun, 0, -.08, -.08, .3);
  b.part(gun, cyl(.016, .016, .12), p.gunLight, 0, .065, .02, Math.PI / 2);
  b.part(gun, new THREE.BoxGeometry(.03, .04, .22), p.gun, 0, -.01, -.33);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, .01, .75);
  gun.add(muzzle);
  return { group: gun, muzzle, meshes: b.meshes };
}

/** B1 battle droid: spindly, skull-like head tube, E-5 blaster. ~1.91 m. */
function buildB1(): ProceduralRig {
  const p = materials();
  const b = new RigBuilder();
  const root = new THREE.Group();
  const hipHeight = .98;
  const pelvis = b.joint(root, 0, hipHeight, 0);
  b.part(pelvis, new RoundedBoxGeometry(.22, .12, .15, 1, .03), p.b1Dark, 0, 0, 0);
  const hips: THREE.Group[] = [], knees: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const hip = b.joint(pelvis, s * .1, -.03, 0);
    b.part(hip, new THREE.SphereGeometry(.045, 8, 6), p.b1Dark, 0, 0, 0);
    b.part(hip, cyl(.038, .032, .44, 8), p.b1, 0, -.22, 0);
    const knee = b.joint(hip, 0, -.45, 0);
    b.part(knee, new THREE.SphereGeometry(.045, 8, 6), p.b1Dark, 0, 0, 0);
    b.part(knee, taperedBox(.07, .44, .08, .7, 1), p.b1, 0, -.23, -.01);
    b.part(knee, new RoundedBoxGeometry(.1, .055, .25, 1, .02), p.b1, 0, -.475, .05);
    hips.push(hip); knees.push(knee);
  }
  const spine = b.joint(pelvis, 0, .06, 0);
  b.part(spine, cyl(.028, .032, .28, 8), p.b1Dark, 0, .14, -.02);
  b.part(spine, taperedBox(.36, .3, .2, .82, .9, 1, 1), p.b1, 0, .4, 0, -.12);
  b.part(spine, new RoundedBoxGeometry(.26, .26, .12, 1, .03), p.b1Dark, 0, .4, -.15);
  b.part(spine, cyl(.018, .02, .2, 6), p.b1Dark, 0, .62, .02, .35);
  const head = b.joint(spine, 0, .7, .06);
  b.part(head, cyl(.05, .062, .32, 10), p.b1, 0, .02, .1, Math.PI / 2 + .25);
  b.part(head, new THREE.SphereGeometry(.072, 10, 8), p.b1, 0, .045, -.06).scale.set(1, .9, 1.2);
  for (const s of [-1, 1]) b.part(head, new THREE.CylinderGeometry(.022, .022, .02, 10), p.b1Eye, s * .056, .03, .03, 0, 0, Math.PI / 2);
  b.part(head, new THREE.BoxGeometry(.05, .02, .05), p.b1Dark, 0, -.025, .24);
  const shoulders: THREE.Group[] = [], elbows: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const shoulder = b.joint(spine, s * .2, .5, 0);
    b.part(shoulder, new THREE.SphereGeometry(.05, 8, 6), p.b1Dark, 0, 0, 0);
    b.part(shoulder, cyl(.028, .026, .28, 8), p.b1, 0, -.14, 0);
    const elbow = b.joint(shoulder, 0, -.29, 0);
    b.part(elbow, cyl(.026, .022, .27, 8), p.b1, 0, -.135, 0);
    b.part(elbow, new THREE.BoxGeometry(.05, .08, .04), p.b1Dark, 0, -.3, 0);
    shoulders.push(shoulder); elbows.push(elbow);
  }
  // E-5 carbine held at the chest.
  const gun = b.joint(spine, .05, .3, .26);
  b.part(gun, new THREE.BoxGeometry(.05, .07, .42), p.gun, 0, 0, 0);
  b.part(gun, cyl(.016, .016, .34), p.gun, 0, .012, .36, Math.PI / 2);
  b.part(gun, new THREE.BoxGeometry(.035, .1, .05), p.gun, 0, -.07, -.05, .3);
  b.part(gun, new THREE.BoxGeometry(.04, .05, .18), p.gun, 0, -.01, -.27);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, .012, .54);
  gun.add(muzzle);
  root.scale.setScalar(1.02);
  return {
    root, pelvis, spine, head, hips: hips as [THREE.Group, THREE.Group], knees: knees as [THREE.Group, THREE.Group],
    shoulders: shoulders as [THREE.Group, THREE.Group], elbows: elbows as [THREE.Group, THREE.Group], muzzle, meshes: b.meshes,
    hipHeight, height: 1.92,
    armPose: armPose(shoulders, [new THREE.Vector3(.04, .3, .44), new THREE.Vector3(.05, .24, .22)], .29, .31),
  };
}

/** B2 super battle droid: hunched armoured torso, wrist blasters. ~2.0 m. */
function buildB2(): ProceduralRig {
  const p = materials();
  const b = new RigBuilder();
  const root = new THREE.Group();
  const hipHeight = .96;
  const pelvis = b.joint(root, 0, hipHeight, 0);
  b.part(pelvis, new RoundedBoxGeometry(.38, .2, .28, 2, .06), p.b2Dark, 0, 0, 0);
  const hips: THREE.Group[] = [], knees: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const hip = b.joint(pelvis, s * .17, -.05, 0);
    b.part(hip, cyl(.1, .085, .44, 10), p.b2, 0, -.22, .02);
    const knee = b.joint(hip, 0, -.44, .02);
    b.part(knee, new THREE.SphereGeometry(.09, 10, 8), p.b2Dark, 0, 0, 0);
    b.part(knee, taperedBox(.15, .44, .16, .8, 1), p.b2, 0, -.23, -.03);
    b.part(knee, new RoundedBoxGeometry(.2, .1, .34, 2, .04), p.b2Dark, 0, -.46, .06);
    hips.push(hip); knees.push(knee);
  }
  const spine = b.joint(pelvis, 0, .08, 0);
  b.part(spine, cyl(.09, .12, .22, 10), p.b2Dark, 0, .1, 0);
  const chest = b.part(spine, new RoundedBoxGeometry(.66, .58, .48, 3, .14), p.b2, 0, .5, .04, .18);
  chest.scale.set(1, 1, 1);
  b.part(spine, new RoundedBoxGeometry(.48, .2, .3, 2, .06), p.b2, 0, .3, .1, .3);
  const head = b.joint(spine, 0, .77, .14);
  b.part(head, new RoundedBoxGeometry(.18, .12, .16, 2, .04), p.b2, 0, 0, 0);
  b.part(head, new THREE.BoxGeometry(.12, .025, .02), p.b2Eye, 0, .01, .085);
  const shoulders: THREE.Group[] = [], elbows: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const shoulder = b.joint(spine, s * .4, .62, .02);
    b.part(shoulder, new THREE.SphereGeometry(.1, 10, 8), p.b2Dark, 0, 0, 0);
    b.part(shoulder, cyl(.075, .07, .3, 10), p.b2, 0, -.16, 0);
    const elbow = b.joint(shoulder, 0, -.32, 0);
    b.part(elbow, taperedBox(.17, .38, .17, 1, 1, .9, .9), p.b2, 0, -.2, 0);
    b.part(elbow, new THREE.BoxGeometry(.09, .09, .3), p.b2Dark, 0, -.36, .1, Math.PI / 2);
    shoulders.push(shoulder); elbows.push(elbow);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, -.52, .12);
  elbows[1].add(muzzle);
  root.scale.setScalar(1.05);
  return {
    root, pelvis, spine, head, hips: hips as [THREE.Group, THREE.Group], knees: knees as [THREE.Group, THREE.Group],
    shoulders: shoulders as [THREE.Group, THREE.Group], elbows: elbows as [THREE.Group, THREE.Group], muzzle, meshes: b.meshes,
    hipHeight, height: 2.05,
    armPose: armPose(shoulders, [new THREE.Vector3(-.3, .42, .5), new THREE.Vector3(.3, .42, .5)], .32, .42),
  };
}

/** Phase I clone trooper with DC-15A. ~1.83 m. */
function buildClone(rank: number): ProceduralRig {
  const p = materials();
  const b = new RigBuilder();
  const root = new THREE.Group();
  const hipHeight = .95;
  const accent = rank >= 0 ? p.ranks[rank % p.ranks.length] : null;
  const pelvis = b.joint(root, 0, hipHeight, 0);
  b.part(pelvis, new RoundedBoxGeometry(.36, .13, .24, 2, .04), p.suit, 0, 0, 0);
  b.part(pelvis, new RoundedBoxGeometry(.15, .14, .05, 1, .02), p.armor, 0, -.05, .12);
  b.part(pelvis, new RoundedBoxGeometry(.38, .065, .25, 1, .02), p.gun, 0, .04, 0);
  for (const x of [-.13, -.05, .05, .13]) b.part(pelvis, new RoundedBoxGeometry(.06, .07, .04, 1, .012), p.armor, x, .04, -.13);
  b.part(pelvis, new RoundedBoxGeometry(.07, .05, .02, 1, .01), p.armor, 0, .045, .128);
  const hips: THREE.Group[] = [], knees: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const hip = b.joint(pelvis, s * .1, -.04, 0);
    b.part(hip, cyl(.068, .06, .43, 10), p.suit, 0, -.22, 0);
    b.part(hip, new RoundedBoxGeometry(.14, .3, .15, 2, .04), p.armor, 0, -.2, .015);
    const knee = b.joint(hip, 0, -.44, 0);
    b.part(knee, new RoundedBoxGeometry(.1, .08, .06, 1, .02), p.armor, 0, 0, .06);
    b.part(knee, cyl(.06, .052, .42, 10), p.suit, 0, -.21, 0);
    b.part(knee, new RoundedBoxGeometry(.13, .3, .14, 2, .04), p.armor, 0, -.22, .01);
    b.part(knee, new RoundedBoxGeometry(.12, .09, .27, 2, .03), p.armor, 0, -.465, .045);
    hips.push(hip); knees.push(knee);
  }
  const spine = b.joint(pelvis, 0, .06, 0);
  b.part(spine, new RoundedBoxGeometry(.32, .2, .2, 2, .05), p.suit, 0, .13, 0);
  b.part(spine, new RoundedBoxGeometry(.28, .12, .05, 1, .02), p.armor, 0, .14, .1);
  b.part(spine, new RoundedBoxGeometry(.44, .34, .26, 3, .08), p.armor, 0, .38, 0);
  b.part(spine, new RoundedBoxGeometry(.32, .3, .14, 2, .04), p.armor, 0, .37, -.15);
  if (accent) b.part(spine, new THREE.BoxGeometry(.2, .05, .02), accent, .08, .46, .13);
  b.part(spine, cyl(.06, .07, .08, 10), p.suit, 0, .58, 0);
  const head = b.joint(spine, 0, .7, .0);
  // Phase I helmet: tall dome, flat face plate with T-visor, brow ridge, crest fin, cheek plates.
  const dome = [[.128, -.12], [.138, -.06], [.144, .0], [.142, .06], [.128, .11], [.1, .15], [.062, .175], [.022, .186], [0, .188]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const helmet = b.part(head, new THREE.LatheGeometry(dome, 20), p.armor, 0, .02, 0);
  helmet.scale.set(1, 1, 1.12);
  b.part(head, new RoundedBoxGeometry(.205, .19, .06, 2, .025), p.armor, 0, -.035, .118);
  b.part(head, new RoundedBoxGeometry(.21, .025, .04, 1, .01), p.armor, 0, .062, .14);
  b.part(head, new THREE.BoxGeometry(.172, .036, .02), p.visor, 0, .028, .15);
  b.part(head, new THREE.BoxGeometry(.044, .1, .02), p.visor, 0, -.035, .15);
  for (const x of [-.03, -.01, .01, .03]) b.part(head, new THREE.BoxGeometry(.008, .03, .012), p.visor, x, -.105, .145);
  b.part(head, new THREE.BoxGeometry(.012, .055, .22), accent ?? p.armor, 0, .205, -.005);
  for (const s of [-1, 1]) {
    b.part(head, cyl(.034, .034, .02, 12), p.armor, s * .148, .0, -.01, 0, 0, Math.PI / 2);
    b.part(head, new RoundedBoxGeometry(.04, .1, .1, 1, .015), p.armor, s * .115, -.085, .07, 0, s * .35, 0);
  }
  const shoulders: THREE.Group[] = [], elbows: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const shoulder = b.joint(spine, s * .26, .5, 0);
    const pauldron = b.part(shoulder, new THREE.SphereGeometry(.09, 12, 8, 0, Math.PI * 2, 0, Math.PI * .55), accent && s > 0 ? accent : p.armor, 0, .01, 0);
    pauldron.scale.set(1.1, .9, 1.15);
    b.part(shoulder, cyl(.052, .048, .28, 10), p.suit, 0, -.14, 0);
    b.part(shoulder, new RoundedBoxGeometry(.11, .2, .11, 1, .03), p.armor, 0, -.13, 0);
    const elbow = b.joint(shoulder, 0, -.29, 0);
    b.part(elbow, cyl(.047, .04, .26, 10), p.armor, 0, -.13, 0);
    b.part(elbow, new RoundedBoxGeometry(.07, .09, .08, 1, .02), p.suit, 0, -.3, 0);
    shoulders.push(shoulder); elbows.push(elbow);
  }
  // DC-15A blaster rifle.
  const gun = b.joint(spine, .08, .3, .24);
  b.part(gun, new THREE.BoxGeometry(.06, .08, .5), p.gun, 0, 0, 0);
  b.part(gun, cyl(.022, .022, .5, 10), p.gun, 0, .01, .48, Math.PI / 2);
  b.part(gun, new THREE.BoxGeometry(.04, .12, .05), p.gun, 0, -.08, -.08, .3);
  b.part(gun, cyl(.016, .016, .12), p.gunLight, 0, .065, .02, Math.PI / 2);
  b.part(gun, new THREE.BoxGeometry(.03, .04, .22), p.gun, 0, -.01, -.33);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, .01, .75);
  gun.add(muzzle);
  return {
    root, pelvis, spine, head, hips: hips as [THREE.Group, THREE.Group], knees: knees as [THREE.Group, THREE.Group],
    shoulders: shoulders as [THREE.Group, THREE.Group], elbows: elbows as [THREE.Group, THREE.Group], muzzle, meshes: b.meshes,
    hipHeight, height: 1.83,
    armPose: armPose(shoulders, [new THREE.Vector3(.07, .29, .42), new THREE.Vector3(.08, .23, .17)], .29, .32),
  };
}

/** A loaded model when available, otherwise the procedural stand-in. */
export function buildRig(kind: ActorKind, variant = 0): Rig {
  const model = buildModelRig(kind);
  if (model) return model;
  return procedural(kind === "b1" ? buildB1() : kind === "b2" ? buildB2() : buildClone(variant));
}

function procedural(rig: ProceduralRig): Rig {
  return {
    root: rig.root, head: rig.head, muzzle: rig.muzzle, meshes: rig.meshes, hipHeight: rig.hipHeight, height: rig.height,
    animate: (pose) => animateProcedural(rig, pose.phase, pose.stride, pose.aimPitch - pose.flinch * .35, pose.time, pose.crouch),
    animateDeath: (t) => {
      const k = Math.min(1, t / .55);
      rig.root.rotation.x = -k * k * Math.PI / 2 * .96;
      rig.pelvis.position.y = rig.hipHeight * (1 - k * .75);
    },
    pieces: () => rig.meshes.slice(),
  };
}

/** Procedural animation: walk cycle blended with an aiming upper body. */
function animateProcedural(rig: ProceduralRig, phase: number, stride: number, aimPitch: number, time: number, crouch = 0): void {
  const swing = Math.sin(phase) * .55 * stride;
  rig.hips[0].rotation.x = swing - crouch * .9;
  rig.hips[1].rotation.x = -swing - crouch * .9;
  rig.knees[0].rotation.x = Math.max(0, Math.sin(phase + 1.4)) * .9 * stride + crouch * 1.6;
  rig.knees[1].rotation.x = Math.max(0, Math.sin(phase + Math.PI + 1.4)) * .9 * stride + crouch * 1.6;
  rig.pelvis.position.y = rig.hipHeight - Math.abs(Math.cos(phase)) * .035 * stride - crouch * .32;
  rig.pelvis.rotation.y = Math.sin(phase) * .08 * stride;
  rig.spine.rotation.y = -rig.pelvis.rotation.y;
  rig.spine.rotation.x = THREE.MathUtils.clamp(aimPitch, -.6, .6) + stride * .08 + crouch * .25;
  rig.head.rotation.x = Math.sin(time * .7) * .03;
  for (let i = 0; i < 2; i++) {
    rig.shoulders[i].quaternion.copy(rig.armPose.shoulder[i]);
    rig.elbows[i].quaternion.copy(rig.armPose.elbow[i]);
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Two-bone IK in spine space: rotations for shoulder and elbow joints (whose limbs hang along -Y)
 * that place each hand on `targets` ([left, right]), elbows bending down and outward.
 */
function armPose(shoulders: THREE.Group[], targets: [THREE.Vector3, THREE.Vector3], upper: number, lower: number): ProceduralRig["armPose"] {
  const shoulderQ: THREE.Quaternion[] = [], elbowQ: THREE.Quaternion[] = [];
  shoulders.forEach((shoulder, i) => {
    const side = i === 0 ? -1 : 1;
    const origin = shoulder.position;
    const toTarget = targets[i].clone().sub(origin);
    const distance = Math.min(toTarget.length(), (upper + lower) * .995);
    const dir = toTarget.normalize();
    const cosA = THREE.MathUtils.clamp((upper * upper + distance * distance - lower * lower) / (2 * upper * distance), -1, 1);
    const pole = new THREE.Vector3(side * .7, -1, -.35);
    const poleDir = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const upperDir = dir.clone().multiplyScalar(cosA).addScaledVector(poleDir, Math.sqrt(1 - cosA * cosA)).normalize();
    const elbow = origin.clone().addScaledVector(upperDir, upper);
    const hand = origin.clone().addScaledVector(dir, distance);
    const foreDir = hand.sub(elbow).normalize();
    const qs = new THREE.Quaternion().setFromUnitVectors(DOWN, upperDir);
    const foreLocal = foreDir.applyQuaternion(qs.clone().invert());
    shoulderQ.push(qs);
    elbowQ.push(new THREE.Quaternion().setFromUnitVectors(DOWN, foreLocal));
  });
  return { shoulder: shoulderQ as [THREE.Quaternion, THREE.Quaternion], elbow: elbowQ as [THREE.Quaternion, THREE.Quaternion] };
}
