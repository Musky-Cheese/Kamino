// Converts the downloaded Sketchfab / Quaternius exports into the optimised GLBs in public/models/.
// Usage: node scripts/optimize-models.mjs <download-dir> [name...]
// <download-dir> holds one extracted folder per model; see SOURCES below for the expected layout.
import path from "node:path";
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, meshopt, palette, prune, resample, simplify, textureCompress, transformPrimitive, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const SOURCES = {
  gunship: { dir: "laati_gunship", textureSize: 2048 },
  vulture: { dir: "vulture_droid", textureSize: 1024 },
  // The export also holds an MTT near the origin; keep only the C-9979 ~650 m away. Its flat
  // colours are swapped for the game's Separatist hull materials at load, so skip the palette pass.
  lander: { dir: "c-9979_landing_craft", textureSize: 1024, keep: (b) => b.min[0] < -300, palette: false },
  // Skinned, 66-bone humanoid; trimmed under 30k triangles. Sketchfab's export only binds the first
  // mesh (armour) correctly; the undersuit and helmet vertices are in other spaces. These column-major
  // matrices move them into the armour's bind space: the undersuit one is a similarity fit of per-bone
  // vertex centroids to bone midpoints, the helmet one uses the same rotation, sized and seated on the head joint.
  clone: {
    dir: "clone", textureSize: 1024, simplifyRatio: .86, rigid: true,
    rebind: {
      Undersuit: [-0.22809, 0.00049, -0.00004, 0, -0.0005, -0.22764, 0.0142, 0, 0, 0.0142, 0.22764, 0, -0.00809, 0.03848, -0.02524, 1],
      Helmet_Phase1: [-0.05546, 0, 0, 0, 0, -0.05535, 0.00348, 0, 0, 0.00348, 0.05535, 0, -0.04651, 0.45001, 0.05612, 1],
    },
  },
  // Rigid parts parented to bone nodes: keep the hierarchy intact (as for all skinned characters).
  b1: { dir: "battle_droid_b1", textureSize: 2048, rigid: true },
  b2: { dir: "b2", textureSize: 1024, rigid: true },
  // Dogfight starfighters, seen at a distance: small textures, the ARC-170 thinned out.
  arc170: { dir: "arc170", textureSize: 1024, simplifyRatio: .5 },
  v19: { dir: "v19_torrent", textureSize: 1024 },
  trifighter: { dir: "tri_fighter", textureSize: 1024 },
  // Animation library: skeleton and the clips the game uses, no mesh.
  anims: {
    file: "ual/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb",
    clips: ["A_TPose", "Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Crouch_Idle_Loop", "Crouch_Fwd_Loop", "Death01", "Hit_Chest", "Hit_Head"],
  },
};

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.encoder": MeshoptEncoder,
});

const [root, ...only] = process.argv.slice(2);
if (!root) throw new Error("Usage: node scripts/optimize-models.mjs <download-dir> [name...]");

for (const [name, source] of Object.entries(SOURCES)) {
  if (only.length && !only.includes(name)) continue;
  const document = await io.read(path.join(root, source.file ?? path.join(source.dir, "scene.gltf")));
  const graph = document.getRoot();
  if (source.keep) {
    for (const node of graph.listNodes()) {
      if (node.getMesh() && !source.keep(getBounds(node))) node.dispose();
    }
  }
  if (source.rebind) {
    for (const mesh of graph.listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        const matrix = source.rebind[primitive.getMaterial()?.getName()];
        if (matrix) transformPrimitive(primitive, matrix);
        // A few undersuit vertices have no skin weights (later normalised onto the skeleton root, below
        // the feet): drop the triangles that use them, or they stretch into spikes once the body moves.
        const joints = primitive.getAttribute("JOINTS_0"), weights = primitive.getAttribute("WEIGHTS_0"), indices = primitive.getIndices();
        if (!joints || !weights || !indices) continue;
        const stray = (i) => weights.getElement(i, []).reduce((sum, w) => sum + w, 0) < .5;
        const kept = [];
        for (let t = 0; t < indices.getCount(); t += 3) {
          const tri = [indices.getScalar(t), indices.getScalar(t + 1), indices.getScalar(t + 2)];
          if (!tri.some(stray)) kept.push(...tri);
        }
        if (kept.length < indices.getCount()) indices.setArray(new Uint32Array(kept));
      }
    }
  }
  if (source.clips) {
    const dropAnimation = (animation) => {
      animation.listSamplers().forEach((sampler) => sampler.dispose());
      animation.listChannels().forEach((channel) => channel.dispose());
      animation.dispose();
    };
    for (const animation of graph.listAnimations()) if (!source.clips.includes(animation.getName())) dropAnimation(animation);
    // Only body rotations (plus pelvis / root translation, which carries the fall in Death01) are retargeted.
    for (const animation of graph.listAnimations()) {
      for (const channel of animation.listChannels()) {
        const node = channel.getTargetNode()?.getName() ?? "";
        const path = channel.getTargetPath();
        const finger = /index|middle|ring|pinky|thumb|leaf/.test(node);
        if (finger || path === "scale" || (path === "translation" && node !== "pelvis" && node !== "root")) {
          channel.getSampler()?.dispose();
          channel.dispose();
        }
      }
    }
    for (const node of graph.listNodes()) { node.setMesh(null); node.setSkin(null); }
    for (const material of graph.listMaterials()) material.dispose();
    for (const texture of graph.listTextures()) texture.dispose();
  }
  const steps = [dedup()];
  if (!source.rigid) steps.push(flatten(), join());
  steps.push(weld(), resample());
  if (source.palette !== false && !source.clips) steps.push(palette({ min: 5 }));
  if (source.simplifyRatio) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: source.simplifyRatio, error: .001 }));
  steps.push(prune({ keepLeaves: Boolean(source.clips) }));
  if (source.textureSize) steps.push(textureCompress({ encoder: sharp, targetFormat: "webp", resize: [source.textureSize, source.textureSize] }));
  steps.push(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  await document.transform(...steps);
  // Sampler data dropped above can outlive prune(); remove accessors nothing but the root references.
  for (const accessor of graph.listAccessors()) if (accessor.listParents().every((parent) => parent === graph)) accessor.dispose();
  const out = path.join("public", "models", `${name}.glb`);
  await io.write(out, document);
  let triangles = 0;
  for (const mesh of graph.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) triangles += (primitive.getIndices() ?? primitive.getAttribute("POSITION")).getCount() / 3;
  }
  console.log(`${name}: ${Math.round(triangles)} triangles, ${graph.listAnimations().length} clips → ${out}`);
}
