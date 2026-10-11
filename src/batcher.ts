import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { computeBoundsTree, acceleratedRaycast, disposeBoundsTree } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type BatchOptions = {
  /** "box" projects world-space UVs (consistent texel density); "keep" scales the geometry's own UVs. */
  uv?: "box" | "keep";
  uvScale?: number | [number, number];
  cast?: boolean;
  receive?: boolean;
  shoot?: boolean;
};

type Bucket = { material: THREE.Material; geometries: THREE.BufferGeometry[]; cast: boolean; receive: boolean; shoot: boolean; chunk: string };

/**
 * Position / normal / uv as plain Float32 attributes. Loaded glTF meshes are quantized
 * (normalized Int16 / Int8) or interleaved, which would clamp under a world transform and can't merge.
 */
function floatCopy(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const copy = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const attribute = geometry.getAttribute(name);
    if (!attribute) continue;
    const { count, itemSize } = attribute;
    const array = new Float32Array(count * itemSize);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < itemSize; k++) array[i * itemSize + k] = attribute.getComponent(i, k);
    }
    copy.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  if (geometry.index) copy.setIndex(geometry.index.clone());
  return copy;
}

const scratch = new THREE.Matrix4();
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();

/**
 * Collects static world geometry and merges it per material and chunk, so a city of thousands
 * of parts renders in a few dozen draw calls and can be raycast through a BVH.
 */
export class StaticBatcher {
  chunk = "core";
  private readonly buckets = new Map<string, Bucket>();
  readonly shootables: THREE.Mesh[] = [];
  readonly meshes: THREE.Mesh[] = [];

  add(geometry: THREE.BufferGeometry, material: THREE.Material, transform?: THREE.Matrix4 | THREE.Object3D, options: BatchOptions = {}): void {
    let geo = floatCopy(geometry);
    if (geo.index) geo = geo.toNonIndexed();
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (transform) {
      if (transform instanceof THREE.Object3D) {
        transform.updateMatrixWorld(true);
        scratch.copy(transform.matrixWorld);
      } else scratch.copy(transform);
      geo.applyMatrix4(scratch);
    }
    const scale = options.uvScale ?? 1;
    const [su, sv] = typeof scale === "number" ? [scale, scale] : scale;
    if ((options.uv ?? "box") === "box") this.boxProject(geo, su, sv);
    else if (su !== 1 || sv !== 1) {
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
    const cast = options.cast ?? true, receive = options.receive ?? true, shoot = options.shoot ?? true;
    const key = `${material.uuid}|${this.chunk}|${cast}|${receive}|${shoot}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { material, geometries: [], cast, receive, shoot, chunk: this.chunk };
      this.buckets.set(key, bucket);
    }
    bucket.geometries.push(geo);
    geometry.dispose();
  }

  /** Convenience: add a primitive placed with position / rotation / scale. */
  place(geometry: THREE.BufferGeometry, material: THREE.Material, position: THREE.Vector3Like, rotation?: THREE.Euler | [number, number, number], scale?: THREE.Vector3Like | number, options?: BatchOptions): void {
    const object = new THREE.Object3D();
    object.position.set(position.x, position.y, position.z);
    if (rotation) {
      if (rotation instanceof THREE.Euler) object.rotation.copy(rotation);
      else object.rotation.set(rotation[0], rotation[1], rotation[2]);
    }
    if (scale !== undefined) {
      if (typeof scale === "number") object.scale.setScalar(scale);
      else object.scale.set(scale.x, scale.y, scale.z);
    }
    this.add(geometry, material, object, options);
  }

  /** Bakes every mesh under `root` into the batch using its world transform. */
  addObject(root: THREE.Object3D, options?: BatchOptions): void {
    root.updateMatrixWorld(true);
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) this.add(object.geometry, object.material as THREE.Material, object.matrixWorld, options);
    });
  }

  private boxProject(geo: THREE.BufferGeometry, su: number, sv: number): void {
    const position = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i);
      b.fromBufferAttribute(position, i + 1);
      c.fromBufferAttribute(position, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      for (let k = 0; k < 3; k++) {
        const p = k === 0 ? a : k === 1 ? b : c;
        let u: number, v: number;
        if (ay >= ax && ay >= az) { u = p.x; v = p.z; }
        else if (ax >= az) { u = p.z; v = p.y; }
        else { u = p.x; v = p.y; }
        uv.setXY(i + k, u * su, v * sv);
      }
    }
  }

  build(scene: THREE.Scene): void {
    for (const bucket of this.buckets.values()) {
      const merged = mergeGeometries(bucket.geometries, false);
      bucket.geometries.forEach((geo) => geo.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.castShadow = bucket.cast;
      mesh.receiveShadow = bucket.receive;
      mesh.matrixAutoUpdate = false;
      mesh.name = `static:${bucket.chunk}`;
      if (bucket.shoot) {
        merged.computeBoundsTree();
        this.shootables.push(mesh);
      }
      this.meshes.push(mesh);
      scene.add(mesh);
    }
    this.buckets.clear();
  }
}
