// Converts the downloaded Sketchfab glTF exports into the optimised GLBs in public/models/.
// Usage: node scripts/optimize-models.mjs <download-dir> [name...]
// <download-dir> holds one extracted folder per model (each with scene.gltf); see SOURCES below.
import path from "node:path";
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, meshopt, palette, prune, resample, simplify, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const SOURCES = {
  gunship: { dir: "laati_gunship", textureSize: 2048 },
  vulture: { dir: "vulture_droid", textureSize: 1024 },
  // The export also contains unrelated scenery ~650 m away; keep only the craft itself.
  lander: { dir: "c-9979_landing_craft", textureSize: 1024, keep: (b) => b.min[0] < -300 },
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
  const document = await io.read(path.join(root, source.dir, "scene.gltf"));
  if (source.keep) {
    for (const node of document.getRoot().listNodes()) {
      if (node.getMesh() && !source.keep(getBounds(node))) node.dispose();
    }
  }
  const steps = [dedup(), flatten(), join(), weld(), resample(), palette({ min: 5 })];
  if (source.simplifyRatio) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: source.simplifyRatio, error: .001 }));
  steps.push(
    prune(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [source.textureSize, source.textureSize] }),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  await document.transform(...steps);
  const out = path.join("public", "models", `${name}.glb`);
  await io.write(out, document);
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) triangles += (primitive.getIndices() ?? primitive.getAttribute("POSITION")).getCount() / 3;
  }
  console.log(`${name}: ${Math.round(triangles)} triangles → ${out}`);
}
