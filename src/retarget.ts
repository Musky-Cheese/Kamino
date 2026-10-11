import * as THREE from "three";

/**
 * Bakes animation clips from one skeleton onto another with a different bone layout and rest pose.
 *
 * Both skeletons are first brought into the same reference pose: limb bones of the target are
 * rotated so each points the same way as its counterpart in the source rest pose (this turns an
 * A-pose into the source's T-pose). Each frame, a mapped target bone then takes the source bone's
 * world-space rotation relative to the reference pose. The pelvis also follows the source's
 * height change, scaled by leg length. Output tracks address target nodes by name, so the clips
 * play on any clone of the target.
 */
export type RetargetSetup = {
  /** Source scene in its rest pose (not animated, not shared with anything that is). */
  source: THREE.Object3D;
  /** Target template in its rest pose, already fitted to game scale. */
  target: THREE.Object3D;
  /** Target nodes that make up the skeleton, parents before children. */
  bones: THREE.Object3D[];
  /** Target node name → source bone name. */
  map: Record<string, string>;
  /** Source bone pairs (parent, child) whose direction the target limbs are aligned to. */
  limbs: Array<[string, string]>;
  /** Source and target pelvis names. */
  hips: [string, string];
};

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

function worldQuaternion(object: THREE.Object3D): THREE.Quaternion {
  return object.getWorldQuaternion(new THREE.Quaternion());
}

/** Rotate `object` by a world-space rotation `q` (about its own position). */
export function rotateWorld(object: THREE.Object3D, q: THREE.Quaternion): void {
  const parent = object.parent ? worldQuaternion(object.parent) : new THREE.Quaternion();
  const world = parent.clone().multiply(object.quaternion);
  object.quaternion.copy(parent.invert().multiply(q.clone().multiply(world)));
  object.updateMatrixWorld(true);
}

/** Set `object`'s world-space rotation. */
function setWorldQuaternion(object: THREE.Object3D, world: THREE.Quaternion): void {
  const parent = object.parent ? worldQuaternion(object.parent) : new THREE.Quaternion();
  object.quaternion.copy(parent.invert().multiply(world));
  object.updateMatrixWorld(true);
}

/** Lowest point of the object's bounds; feet rest there. A bare skeleton (no mesh) stands on y = 0. */
function floor(object: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(object, true);
  return box.isEmpty() ? 0 : box.min.y;
}

export function retargetClips(setup: RetargetSetup, clips: THREE.AnimationClip[], fps = 30): THREE.AnimationClip[] {
  const { source, target, bones, map, limbs } = setup;
  source.updateMatrixWorld(true);
  target.updateMatrixWorld(true);
  const sourceBone = (name: string) => {
    const bone = source.getObjectByName(name);
    if (!bone) throw new Error(`retarget: source bone ${name} missing`);
    return bone;
  };
  const inverse = new Map(Object.entries(map).map(([t, s]) => [s, t]));
  const targetFor = (sourceName: string) => {
    const name = inverse.get(sourceName);
    return name ? target.getObjectByName(name) ?? null : null;
  };

  // Reference pose: align target limbs with the source rest directions, parents first.
  const ordered = limbs.map(([a, b]) => ({ a, b, ta: targetFor(a), tb: targetFor(b) })).filter((l) => l.ta && l.tb);
  ordered.sort((x, y) => bones.indexOf(x.ta!) - bones.indexOf(y.ta!));
  for (const { a, b, ta, tb } of ordered) {
    const want = sourceBone(b).getWorldPosition(_v).sub(sourceBone(a).getWorldPosition(_v2)).normalize().clone();
    const have = tb!.getWorldPosition(new THREE.Vector3()).sub(ta!.getWorldPosition(new THREE.Vector3())).normalize();
    rotateWorld(ta!, _q.setFromUnitVectors(have, want));
  }
  const referenceLocal = new Map(bones.map((bone) => [bone, bone.quaternion.clone()]));
  const referencePosition = new Map(bones.map((bone) => [bone, bone.position.clone()]));
  const targetReference = new Map(bones.map((bone) => [bone, worldQuaternion(bone)]));
  const sourceReference = new Map(Object.values(map).map((name) => [name, worldQuaternion(sourceBone(name))]));

  const [sourceHipsName, targetHipsName] = setup.hips;
  const sourceHips = sourceBone(sourceHipsName);
  const targetHips = target.getObjectByName(targetHipsName)!;
  const sourceHipsRest = sourceHips.getWorldPosition(new THREE.Vector3());
  const targetHipsRest = targetHips.getWorldPosition(new THREE.Vector3());
  const legScale = (targetHipsRest.y - floor(target)) / (sourceHipsRest.y - floor(source) || 1);

  const mixer = new THREE.AnimationMixer(source);
  const results: THREE.AnimationClip[] = [];
  for (const clip of clips) {
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.play();
    const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = new Float32Array(frames);
    const rotations = new Map(bones.map((bone) => [bone, new Float32Array(frames * 4)]));
    const hipPositions = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) {
      const t = Math.min(clip.duration, f / fps);
      times[f] = t;
      mixer.setTime(t);
      source.updateMatrixWorld(true);
      for (const bone of bones) {
        const sourceName = map[bone.name];
        if (sourceName) {
          // World delta from the source reference, applied on top of the target reference.
          const delta = worldQuaternion(sourceBone(sourceName)).multiply(_q2.copy(sourceReference.get(sourceName)!).invert());
          setWorldQuaternion(bone, delta.multiply(targetReference.get(bone)!));
        } else {
          bone.quaternion.copy(referenceLocal.get(bone)!);
          bone.updateMatrixWorld(true);
        }
        bone.quaternion.toArray(rotations.get(bone)!, f * 4);
      }
      const offset = sourceHips.getWorldPosition(_v).sub(sourceHipsRest).multiplyScalar(legScale);
      const world = targetHipsRest.clone().add(offset);
      targetHips.parent!.worldToLocal(world);
      world.toArray(hipPositions, f * 3);
    }
    action.stop();
    const tracks: THREE.KeyframeTrack[] = bones.map((bone) => new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, rotations.get(bone)!));
    tracks.push(new THREE.VectorKeyframeTrack(`${targetHips.name}.position`, times, hipPositions));
    results.push(new THREE.AnimationClip(clip.name, clip.duration, tracks));
  }
  mixer.uncacheRoot(source);
  // Leave the template in its reference pose, which is also frame zero of a neutral stance.
  for (const bone of bones) {
    bone.quaternion.copy(referenceLocal.get(bone)!);
    bone.position.copy(referencePosition.get(bone)!);
  }
  target.updateMatrixWorld(true);
  return results;
}
