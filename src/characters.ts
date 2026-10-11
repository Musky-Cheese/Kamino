import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { buildDC15, buildE5, type ActorKind, type Pose, type Rig } from "./actors";
import "./batcher"; // installs computeBoundsTree / accelerated raycasting on three's prototypes
import { getModel, hasModel, instantiate } from "./models";
import { retargetClips, rotateWorld } from "./retarget";

/**
 * Animated character rigs built from the loaded glTF models (credits in README.md).
 *
 * Clone and B1 play Quaternius Universal Animation Library clips retargeted onto their skeletons;
 * the B2 plays its own clips. Each kind is prepared once into a template (fitted, reference-posed,
 * weapon attached, hit proxies built); every actor gets a SkeletonUtils clone of it and its own mixer.
 * Rifles are held by two-bone IK on top of the clips, which have no rifle poses.
 */

// ---------------------------------------------------------------- shared helpers

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Two-bone IK in world space: bend `upper`/`lower` so `hand` reaches `target`, elbow toward `pole`. */
function solveTwoBone(upper: THREE.Object3D, lower: THREE.Object3D, hand: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  hand.getWorldPosition(_c);
  const upperLength = _a.distanceTo(_b), lowerLength = _b.distanceTo(_c);
  const toTarget = _t.copy(target).sub(_a);
  const distance = THREE.MathUtils.clamp(toTarget.length(), 1e-3, (upperLength + lowerLength) * .999);
  const dir = toTarget.normalize();
  const cosA = THREE.MathUtils.clamp((upperLength ** 2 + distance ** 2 - lowerLength ** 2) / (2 * upperLength * distance), -1, 1);
  const bend = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  const elbow = _a.clone().addScaledVector(dir, cosA * upperLength).addScaledVector(bend, Math.sqrt(1 - cosA * cosA) * upperLength);
  rotateWorld(upper, _q.setFromUnitVectors(_b.sub(_a).normalize(), elbow.sub(_a).normalize()));
  lower.getWorldPosition(_b);
  hand.getWorldPosition(_c);
  rotateWorld(lower, _q.setFromUnitVectors(_c.sub(_b).normalize(), target.clone().sub(_b).normalize()));
}

/** Parent `child` to `bone` keeping the transform it has in `root` space. */
function attachKeepingPose(root: THREE.Object3D, bone: THREE.Object3D, child: THREE.Object3D): void {
  root.add(child);
  root.updateMatrixWorld(true);
  bone.attach(child);
}

/** Root-space bounds of the vertices each bone dominates, in the current pose. */
function boneVertexBounds(root: THREE.Object3D, mesh: THREE.SkinnedMesh): Map<THREE.Bone, THREE.Box3> {
  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const bounds = new Map<THREE.Bone, THREE.Box3>();
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    let best = 0, weight = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); }
    }
    const bone = mesh.skeleton.bones[best];
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
    let box = bounds.get(bone);
    if (!box) bounds.set(bone, box = new THREE.Box3());
    box.expandByPoint(v);
  }
  return bounds;
}

const proxyMaterial = new THREE.MeshBasicMaterial({ visible: false });

/** Invisible box following `bone`, used for hit tests instead of the skinned mesh. */
function hitProxy(root: THREE.Object3D, bone: THREE.Object3D, box: THREE.Box3, name: string): THREE.Mesh {
  const size = box.getSize(new THREE.Vector3()).max(new THREE.Vector3(.08, .08, .08));
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), proxyMaterial);
  proxy.name = name;
  box.getCenter(proxy.position);
  attachKeepingPose(root, bone, proxy);
  return proxy;
}

/**
 * Freeze a skinned mesh's current pose into static meshes, one per group of bones, positioned in
 * place under the skinned mesh so the shatter effect can fling them apart.
 */
function bakePieces(mesh: THREE.SkinnedMesh, groupOf: (bone: THREE.Bone) => THREE.Bone): THREE.Mesh[] {
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  const geometry = mesh.geometry;
  const { skinIndex, skinWeight, position } = geometry.attributes;
  const index = geometry.index;
  const owner = new Map<number, THREE.Bone>();
  const triangles = new Map<THREE.Bone, number[]>();
  const vertexGroup = (i: number) => {
    let best = 0, weight = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); }
    }
    return groupOf(mesh.skeleton.bones[best]);
  };
  const count = index ? index.count : position.count;
  for (let t = 0; t < count; t += 3) {
    const i0 = index ? index.getX(t) : t;
    let group = owner.get(i0);
    if (!group) owner.set(i0, group = vertexGroup(i0));
    let list = triangles.get(group);
    if (!list) triangles.set(group, list = []);
    for (let k = 0; k < 3; k++) list.push(index ? index.getX(t + k) : t + k);
  }
  const pieces: THREE.Mesh[] = [];
  const v = new THREE.Vector3();
  for (const list of triangles.values()) {
    const positions = new Float32Array(list.length * 3);
    for (let k = 0; k < list.length; k++) mesh.getVertexPosition(list[k], v).toArray(positions, k * 3);
    const uv = geometry.attributes.uv;
    const piece = new THREE.BufferGeometry();
    piece.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (uv) {
      const uvs = new Float32Array(list.length * 2);
      for (let k = 0; k < list.length; k++) { uvs[k * 2] = uv.getX(list[k]); uvs[k * 2 + 1] = uv.getY(list[k]); }
      piece.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    }
    piece.computeVertexNormals();
    piece.computeBoundingBox();
    const center = piece.boundingBox!.getCenter(new THREE.Vector3());
    piece.translate(-center.x, -center.y, -center.z);
    const part = new THREE.Mesh(piece, mesh.material);
    part.position.copy(center);
    part.castShadow = true;
    mesh.add(part);
    pieces.push(part);
  }
  mesh.visible = false;
  return pieces;
}

/** Bone weights for idle → walk → jog → sprint at a given ground speed (m/s). */
const GAITS = [0, 1.4, 3.2, 5.5];
function gaitWeights(speed: number): number[] {
  const weights = [0, 0, 0, 0];
  if (speed >= GAITS[3]) { weights[3] = 1; return weights; }
  for (let i = 0; i < 3; i++) {
    if (speed <= GAITS[i + 1]) {
      const t = (speed - GAITS[i]) / (GAITS[i + 1] - GAITS[i]);
      weights[i] = 1 - t;
      weights[i + 1] = t;
      return weights;
    }
  }
  return weights;
}

// ---------------------------------------------------------------- templates

type Template = {
  root: THREE.Group;
  clips: Map<string, THREE.AnimationClip>;
  height: number;
  hipHeight: number;
};

const templates = new Map<ActorKind, Template | null>();

const SOURCE_LIMBS: Array<[string, string]> = ["l", "r"].flatMap((s) => [
  [`upperarm_${s}`, `lowerarm_${s}`], [`lowerarm_${s}`, `hand_${s}`], [`thigh_${s}`, `calf_${s}`], [`calf_${s}`, `foot_${s}`],
] as Array<[string, string]>);

function libraryClips(target: THREE.Object3D, bones: THREE.Object3D[], map: Record<string, string>, hips: string): Map<string, THREE.AnimationClip> {
  const library = getModel("anims")!;
  const clips = retargetClips({ source: SkeletonUtils.clone(library.scene), target, bones, map, limbs: SOURCE_LIMBS, hips: ["pelvis", hips] }, library.animations);
  const byName = new Map(clips.map((clip) => [clip.name, clip]));
  for (const name of ["Hit_Chest", "Hit_Head"]) {
    const clip = byName.get(name);
    if (clip) byName.set(name, THREE.AnimationUtils.makeClipAdditive(clip));
  }
  return byName;
}

function measure(root: THREE.Group, hips: string): { height: number; hipHeight: number } {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  return { height: box.max.y - box.min.y, hipHeight: root.getObjectByName(hips)!.getWorldPosition(new THREE.Vector3()).y };
}

/**
 * Rifle in front of the chest, barrel forward. It hangs off the character root rather than the
 * chest bone (idle clips twist the chest, which would swing the barrel sideways); each frame it
 * follows the chest's movement and pitches with the aim. Rest positions are kept in userData.
 */
function mountRifle(root: THREE.Group, chest: THREE.Object3D, shoulder: THREE.Object3D, gun: ReturnType<typeof buildDC15>, position: THREE.Vector3): void {
  gun.group.name = "rifle";
  gun.muzzle.name = "muzzle";
  gun.group.position.copy(position);
  for (const mesh of gun.meshes) mesh.name = "rifle-part";
  root.add(gun.group);
  root.updateMatrixWorld(true);
  gun.group.userData.rest = position.clone();
  gun.group.userData.chest = root.worldToLocal(chest.getWorldPosition(new THREE.Vector3()));
  gun.group.userData.pivot = root.worldToLocal(shoulder.getWorldPosition(new THREE.Vector3()));
}

// Mixamo-style clone skeleton (names as sanitised by three).
const CLONE_MAP: Record<string, string> = {
  Hips_01: "pelvis", Spine_02: "spine_01", Spine1_03: "spine_02", Spine2_04: "spine_03", Neck_05: "neck_01", Head_06: "Head",
  LeftShoulder_07: "clavicle_l", LeftArm_08: "upperarm_l", LeftForeArm_09: "lowerarm_l", LeftHand_010: "hand_l",
  RightShoulder_026: "clavicle_r", RightArm_027: "upperarm_r", RightForeArm_028: "lowerarm_r", RightHand_029: "hand_r",
  LeftUpLeg_045: "thigh_l", LeftLeg_046: "calf_l", LeftFoot_047: "foot_l", LeftToeBase_048: "ball_l",
  RightUpLeg_049: "thigh_r", RightLeg_050: "calf_r", RightFoot_051: "foot_r", RightToeBase_052: "ball_r",
};

function cloneTemplate(): Template {
  const root = instantiate("clone", { height: 1.83 });
  const bones: THREE.Object3D[] = [];
  root.traverse((object) => { if ((object as THREE.Bone).isBone) bones.push(object); });
  const clips = libraryClips(root, bones, CLONE_MAP, "Hips_01");
  const chest = root.getObjectByName("Spine2_04")!;
  const { height, hipHeight } = measure(root, "Hips_01");
  // DC-15A across the chest on the right (-X) side.
  mountRifle(root, chest, root.getObjectByName("RightArm_027")!, buildDC15(), new THREE.Vector3(-.09, hipHeight + .36, .3));
  return { root, clips, height, hipHeight };
}

// B1: rigid parts on bone nodes. Hands and feet were IK targets parented to the armature; they are
// re-parented under the forearms and shins so the chain is plain forward kinematics.
const B1_MAP: Record<string, string> = {
  Bone003_25: "pelvis", Bone_5: "spine_01", Bone007_3: "spine_03", Bone008_1: "Head",
  Bone004L_9: "thigh_l", Bone005R_7: "calf_l", Bone006L_27: "foot_l",
  Bone004R_14: "thigh_r", Bone005L_12: "calf_r", Bone006R_50: "foot_r",
  Bone001L_19: "upperarm_l", Bone002R_17: "lowerarm_l", Bone009L_37: "hand_l",
  Bone001R_23: "upperarm_r", Bone002L_21: "lowerarm_r", Bone009R_48: "hand_r",
};
const B1_REPARENT: Array<[string, string]> = [["Bone006L_27", "Bone005R_7"], ["Bone006R_50", "Bone005L_12"], ["Bone009L_37", "Bone002R_17"], ["Bone009R_48", "Bone002L_21"]];

function b1Template(): Template {
  const root = instantiate("b1", { height: 1.92 });
  root.updateMatrixWorld(true);
  for (const [child, parent] of B1_REPARENT) root.getObjectByName(parent)!.attach(root.getObjectByName(child)!);
  const bones: THREE.Object3D[] = [];
  root.traverse((object) => { if (object.name.startsWith("Bone")) bones.push(object); });
  const clips = libraryClips(root, bones, B1_MAP, "Bone003_25");
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.name = "b1-part";
      object.geometry.computeBoundsTree();
    }
  });
  const chest = root.getObjectByName("Bone007_3")!;
  const { height, hipHeight } = measure(root, "Bone003_25");
  mountRifle(root, chest, root.getObjectByName("Bone001R_23")!, buildE5(), new THREE.Vector3(-.06, hipHeight + .4, .3));
  return { root, clips, height, hipHeight };
}

// B2: skinned, own clips. Hit proxies follow the major bones.
const B2_PROXIES = ["torso_013", "waist_011", "thighl_034", "thighr_037", "shinl_035", "shinr_038", "bicepl_015", "bicepr_024", "forearml_016", "forearmr_025"];

function b2Template(): Template {
  const root = instantiate("b2", { height: 2.05 });
  const gltf = getModel("b2")!;
  const clips = new Map(gltf.animations.map((clip) => [clip.name.trim(), clip]));
  const mesh = root.getObjectByProperty("isSkinnedMesh", true) as THREE.SkinnedMesh;
  // Pose the template like the stance it will mostly hold so proxies and bounds match.
  const { height, hipHeight } = measure(root, "waist_011");
  const bounds = boneVertexBounds(root, mesh);
  for (const name of B2_PROXIES) {
    const bone = root.getObjectByName(name)!;
    const box = bounds.get(bone as THREE.Bone);
    if (box) hitProxy(root, bone, box, "hitbox");
  }
  // The head is part of the torso mesh: a small box on top of the torso.
  const torso = bounds.get(root.getObjectByName("torso_013") as THREE.Bone)!;
  const head = new THREE.Box3(new THREE.Vector3(-.12, torso.max.y - .2, torso.min.z), new THREE.Vector3(.12, torso.max.y, torso.max.z));
  const headGroup = new THREE.Group();
  headGroup.name = "head";
  attachKeepingPose(root, root.getObjectByName("torso_013")!, headGroup);
  const headProxy = hitProxy(root, root.getObjectByName("torso_013")!, head, "hitbox-head");
  headGroup.attach(headProxy);
  // Wrist blaster on the right forearm (-X side), firing forward.
  const muzzle = new THREE.Object3D();
  muzzle.name = "muzzle";
  const palm = root.getObjectByName("palmr_026")!.getWorldPosition(new THREE.Vector3());
  muzzle.position.copy(root.worldToLocal(palm)).add(new THREE.Vector3(0, .04, .14));
  attachKeepingPose(root, root.getObjectByName("forearmr_025")!, muzzle);
  return { root, clips, height, hipHeight };
}

function template(kind: ActorKind): Template | null {
  if (templates.has(kind)) return templates.get(kind)!;
  let result: Template | null = null;
  try {
    if (kind === "clone" && hasModel("clone") && hasModel("anims")) result = cloneTemplate();
    else if (kind === "b1" && hasModel("b1") && hasModel("anims")) result = b1Template();
    else if (kind === "b2" && hasModel("b2")) result = b2Template();
  } catch (error) {
    console.warn(`Character "${kind}" could not be prepared; using the procedural rig.`, error);
  }
  if (result) {
    result.root.traverse((object) => {
      if (object instanceof THREE.SkinnedMesh) {
        object.computeBoundingSphere();
        // Generous bounds: crouching, aiming and lying dead all move vertices away from the rest pose.
        object.boundingSphere!.radius *= 1.6;
      }
    });
  }
  templates.set(kind, result);
  return result;
}

// ---------------------------------------------------------------- per-actor rigs

/** Model-space +X: the character's left (models face +Z). */
const LEFT = new THREE.Vector3(1, 0, 0);

/** Clone and B1: library clips for the body, rifle held by IK, chest pitched to aim. */
function humanoidRig(kind: "clone" | "b1", t: Template): Rig {
  const root = SkeletonUtils.clone(t.root) as THREE.Group;
  const named = (name: string) => root.getObjectByName(name)!;
  const isClone = kind === "clone";
  const bone = (source: string) => {
    const map = isClone ? CLONE_MAP : B1_MAP;
    return named(Object.keys(map).find((key) => map[key] === source)!);
  };
  const spine = [bone("spine_01"), bone("spine_03")];
  const chest = spine[1];
  const arms = (["l", "r"] as const).map((s) => ({ upper: bone(`upperarm_${s}`), lower: bone(`lowerarm_${s}`), hand: bone(`hand_${s}`), side: s === "l" ? 1 : -1 }));
  const rifle = named("rifle");
  const grips = [new THREE.Vector3(0, -.02, .26), new THREE.Vector3(0, -.06, -.07)]; // left hand fore-grip, right hand pistol grip
  const mixer = new THREE.AnimationMixer(root);
  const action = (name: string) => {
    const clip = t.clips.get(name);
    return clip ? mixer.clipAction(clip) : null;
  };
  const gaits = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop"].map(action);
  const crouchGaits = [action("Crouch_Idle_Loop"), action("Crouch_Fwd_Loop")];
  const loops = [...gaits, ...crouchGaits].filter((a): a is THREE.AnimationAction => Boolean(a));
  for (const a of loops) { a.play(); a.setEffectiveWeight(0); a.timeScale = 0; }
  const hit = action("Hit_Chest");
  if (hit) { hit.blendMode = THREE.AdditiveAnimationBlendMode; hit.setLoop(THREE.LoopOnce, 1); }
  const death = action("Death01");
  if (death) { death.setLoop(THREE.LoopOnce, 1); death.clampWhenFinished = true; }
  /** Rifle: carried with the chest, pitched about the shoulder. */
  const placeRifle = (pitch: number, roll = 0) => {
    const { rest, chest: chestRest, pivot } = rifle.userData as Record<string, THREE.Vector3>;
    const lift = root.worldToLocal(chest.getWorldPosition(new THREE.Vector3())).sub(chestRest);
    rifle.rotation.set(pitch, 0, roll);
    rifle.position.copy(rest).sub(pivot).applyEuler(rifle.rotation).add(pivot).add(lift);
    rifle.updateMatrixWorld(true);
  };
  let gaitPhase = Math.random();
  let lastFlinch = 0;
  let dying = false;
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) meshes.push(object);
  });
  const pole = new THREE.Vector3(), target = new THREE.Vector3(), axis = new THREE.Vector3();

  return {
    root, head: bone("Head"), muzzle: named("muzzle"), meshes: isClone ? [] : meshes, height: t.height, hipHeight: t.hipHeight,
    animate(pose: Pose) {
      const speed = pose.stride * 3;
      const weights = gaitWeights(speed);
      // Advance one shared gait phase; stride length scales with speed so feet roughly match the ground.
      const cycle = speed < .2 ? 2.5 : THREE.MathUtils.clamp(1.9 - speed * .2, .65, 1.4);
      gaitPhase = (gaitPhase + pose.delta / cycle) % 1;
      const crouch = isClone || kind === "b1" ? pose.crouch : 0;
      gaits.forEach((a, i) => {
        if (!a) return;
        a.setEffectiveWeight(weights[i] * (1 - crouch));
        a.time = gaitPhase * a.getClip().duration;
      });
      const moving = Math.min(1, speed / 1.2);
      crouchGaits.forEach((a, i) => {
        if (!a) return;
        a.setEffectiveWeight(crouch * (i === 0 ? 1 - moving : moving));
        a.time = gaitPhase * a.getClip().duration;
      });
      if (hit && pose.flinch > lastFlinch + .3) { hit.reset().setEffectiveWeight(1).play(); }
      lastFlinch = pose.flinch;
      mixer.update(pose.delta);
      root.updateMatrixWorld(true);
      // Aim: pitch the chest about the character's lateral axis (negative pitch leans back, aiming up).
      axis.copy(LEFT).applyQuaternion(root.getWorldQuaternion(_q)).normalize();
      const pitch = THREE.MathUtils.clamp(pose.aimPitch, -.7, .7) * .5;
      for (const s of spine) rotateWorld(s, new THREE.Quaternion().setFromAxisAngle(axis, pitch));
      placeRifle(pitch * 2);
      // Hands on the rifle.
      const down = new THREE.Vector3(0, -1, 0);
      const back = new THREE.Vector3(0, 0, -1).applyQuaternion(root.getWorldQuaternion(_q));
      arms.forEach((arm, i) => {
        // Elbows down, out to the side and slightly back.
        pole.copy(down).addScaledVector(axis, arm.side * .6).addScaledVector(back, .3);
        target.copy(grips[i]).applyMatrix4(rifle.matrixWorld);
        solveTwoBone(arm.upper, arm.lower, arm.hand, target, pole);
      });
    },
    animateDeath(time: number, delta: number) {
      if (!dying) {
        dying = true;
        for (const a of loops) a.fadeOut(.15);
        death?.reset().fadeIn(.1).play();
      }
      if (time < 4) {
        mixer.update(delta);
        root.updateMatrixWorld(true);
        // The rifle drops with the body and rolls onto its side.
        placeRifle(0, Math.min(1, time / .8) * 1.4);
      }
    },
    pieces: () => meshes.slice(),
  };
}

/** B2: walk / ready-weapon clips, torso pitched to aim, wrist blaster. */
function b2Rig(t: Template): Rig {
  const root = SkeletonUtils.clone(t.root) as THREE.Group;
  const named = (name: string) => root.getObjectByName(name)!;
  const mixer = new THREE.AnimationMixer(root);
  const play = (name: string) => {
    const clip = t.clips.get(name);
    if (!clip) return null;
    const a = mixer.clipAction(clip);
    a.play();
    a.setEffectiveWeight(0);
    return a;
  };
  const walk = play("walk guns up");
  const ready = play("Ready weapon");
  if (ready) { ready.setLoop(THREE.LoopOnce, 1); ready.clampWhenFinished = true; ready.time = ready.getClip().duration; }
  const torso = named("torso_013");
  const mesh = root.getObjectByProperty("isSkinnedMesh", true) as THREE.SkinnedMesh;
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => { if (object instanceof THREE.Mesh && object.name.startsWith("hitbox")) meshes.push(object); });
  // Shatter groups: fingers and controls fold into their nearest major bone.
  const major = new Set(["torso_013", "waist_011", "thighl_034", "thighr_037", "shinl_035", "shinr_038", "bicepl_015", "bicepr_024", "forearml_016", "forearmr_025", "footl_03", "footr_07", "palml_017", "palmr_026"]);
  const groupOf = (bone: THREE.Bone): THREE.Bone => {
    let b: THREE.Object3D | null = bone;
    while (b && !major.has(b.name)) b = b.parent;
    return (b as THREE.Bone) ?? bone;
  };
  let phase = Math.random();
  const axis = new THREE.Vector3();
  return {
    root, head: named("head"), muzzle: named("muzzle"), meshes, height: t.height, hipHeight: t.hipHeight,
    animate(pose: Pose) {
      const speed = pose.stride * 3;
      const moving = THREE.MathUtils.clamp(speed / 1.2, 0, 1);
      if (walk) {
        phase = (phase + pose.delta * Math.max(.6, speed / 1.3)) % 1;
        walk.setEffectiveWeight(moving);
        walk.time = phase * walk.getClip().duration;
        walk.timeScale = 0;
      }
      ready?.setEffectiveWeight(1 - moving);
      mixer.update(pose.delta);
      root.updateMatrixWorld(true);
      axis.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(_q)).normalize();
      const pitch = THREE.MathUtils.clamp(pose.aimPitch - pose.flinch * .3, -.6, .6);
      rotateWorld(torso, new THREE.Quaternion().setFromAxisAngle(axis, pitch));
    },
    animateDeath() { /* B2s shatter; never left lying. */ },
    pieces: () => bakePieces(mesh, groupOf),
  };
}

/** A rig built from the loaded model for `kind`, or null to fall back to the procedural one. */
export function buildModelRig(kind: ActorKind): Rig | null {
  const t = template(kind);
  if (!t) return null;
  return kind === "b2" ? b2Rig(t) : humanoidRig(kind, t);
}
