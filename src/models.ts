import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

/**
 * Third-party glTF assets (see the Credits in README.md). Files live in public/models/ and are
 * optimised with gltf-transform (meshopt geometry, WebP textures at 2K max).
 */
const MODEL_FILES = {
  gunship: "gunship.glb",
  vulture: "vulture.glb",
  lander: "lander.glb",
  clone: "clone.glb",
  b1: "b1.glb",
  b2: "b2.glb",
  /** Quaternius Universal Animation Library clips (skeleton only), retargeted onto the clone and B1. */
  anims: "anims.glb",
} as const;

export type ModelName = keyof typeof MODEL_FILES;

const cache = new Map<ModelName, GLTF>();

/** Loads every model in parallel. Failures are logged and leave that slot on its procedural fallback. */
export async function loadModels(onProgress: (fraction: number) => void): Promise<void> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const names = Object.keys(MODEL_FILES) as ModelName[];
  const loaded = new Map<ModelName, number>();
  const totals = new Map<ModelName, number>();
  const report = () => {
    let done = 0, total = 0;
    for (const name of names) {
      const size = totals.get(name) ?? 0;
      total += size;
      done += Math.min(loaded.get(name) ?? 0, size);
    }
    onProgress(total > 0 ? done / total : 0);
  };
  await Promise.all(names.map(async (name) => {
    try {
      const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${MODEL_FILES[name]}`, (event) => {
        if (event.lengthComputable) totals.set(name, event.total);
        loaded.set(name, event.loaded);
        report();
      });
      cache.set(name, gltf);
    } catch (error) {
      console.warn(`Model "${name}" failed to load; using the procedural fallback.`, error);
    }
  }));
  onProgress(1);
}

export function hasModel(name: ModelName): boolean {
  return cache.has(name);
}

/** The loaded glTF itself (shared; clone before modifying anything that is rendered). */
export function getModel(name: ModelName): GLTF | undefined {
  return cache.get(name);
}

export type FitOptions = {
  /** Rotation applied to the raw scene before measuring, to bring it into the game's axis convention. */
  rotation?: [number, number, number];
  /** Target size along Z (metres). */
  length?: number;
  /** Target height instead of length (characters). */
  height?: number;
  /** Centre vertically instead of resting the lowest point on y = 0 (for aircraft). */
  centerY?: boolean;
  shadows?: boolean;
};

/**
 * A fresh copy of a loaded model, rotated into the game's convention, scaled to `length` along Z (or `height`),
 * centred on X/Z with its lowest point at y = 0 (or centred on Y with `centerY`). Geometry and materials are
 * shared between copies; skinned meshes get their own skeleton.
 */
export function instantiate(name: ModelName, options: FitOptions): THREE.Group {
  const gltf = cache.get(name);
  if (!gltf) throw new Error(`Model "${name}" is not loaded`);
  const inner = SkeletonUtils.clone(gltf.scene);
  if (options.rotation) inner.rotation.set(...options.rotation);
  const fit = new THREE.Group();
  fit.add(inner);
  fit.updateMatrixWorld(true);
  // Precise: a rotated AABB of a large joined mesh overestimates badly.
  const box = new THREE.Box3().setFromObject(inner, true);
  const size = box.getSize(new THREE.Vector3());
  const scale = options.height !== undefined ? options.height / size.y : (options.length ?? size.z) / size.z;
  fit.scale.setScalar(scale);
  const center = box.getCenter(new THREE.Vector3());
  fit.position.set(-center.x * scale, -(options.centerY ? center.y : box.min.y) * scale, -center.z * scale);
  const shadows = options.shadows ?? true;
  inner.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = shadows;
      object.receiveShadow = shadows;
    }
  });
  const root = new THREE.Group();
  root.add(fit);
  return root;
}
