// Converts the downloaded Sketchfab / Quaternius exports into the optimised GLBs in public/models/.
// Usage: node scripts/optimize-models.mjs <download-dir> [name...]
// <download-dir> holds one extracted folder per model; see SOURCES below for the expected layout.
import path from "node:path";
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, meshopt, palette, prune, resample, simplify, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const SOURCES = {
  gunship: { dir: "laati_gunship", textureSize: 2048 },
  vulture: { dir: "vulture_droid", textureSize: 1024 },
  // The export also holds an MTT near the origin; keep only the C-9979 ~650 m away. Its flat
  // colours are swapped for the game's Separatist hull materials at load, so skip the palette pass.
  lander: { dir: "c-9979_landing_craft", textureSize: 1024, keep: (b) => b.min[0] < -300, palette: false },
  // Skinned, 66-bone humanoid; trimmed under 30k triangles.
  clone: { dir: "clone", textureSize: 2048, simplifyRatio: .86 },
  // Rigid parts parented to bone nodes: keep the hierarchy intact.
  b1: { dir: "battle_droid_b1", textureSize: 2048, rigid: true },
  b2: { dir: "b2", textureSize: 1024 },
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
  if (source.clips) {
    for (const animation of graph.listAnimations()) if (!source.clips.includes(animation.getName())) animation.dispose();
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
  const out = path.join("public", "models", `${name}.glb`);
  await io.write(out, document);
  let triangles = 0;
  for (const mesh of graph.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) triangles += (primitive.getIndices() ?? primitive.getAttribute("POSITION")).getCount() / 3;
  }
  console.log(`${name}: ${Math.round(triangles)} triangles, ${graph.listAnimations().length} clips → ${out}`);
}
