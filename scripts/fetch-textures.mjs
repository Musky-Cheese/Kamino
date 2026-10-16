// Downloads the CC0 texture sets (ambientCG, Poly Haven) and converts them into public/textures/.
// Usage: node scripts/fetch-textures.mjs <download-dir>
// Each base set becomes <name>_color / _normal / _orm .webp (ORM: R = AO, G = roughness, B = metalness),
// at 2048 px in public/textures/ and 1024 px in public/textures/low/ (the Low graphics preset).
// weathering.webp packs three tiling masks: R = rain streaks, G = grime, B = rust.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const AMBIENTCG = ["MetalPlates004", "MetalPlates008", "MetalPlates001", "Metal032", "SurfaceImperfections003", "Leaking012A"];
const POLYHAVEN = ["blue_metal_plate", "rusty_metal_02"];

const acg = (id, map) => `${id}/${id}_2K-JPG_${map}.jpg`;
/** Game material → source files and how to treat them. */
const SETS = {
  deck: { color: acg("MetalPlates004", "Color"), normal: acg("MetalPlates004", "NormalGL"), roughness: acg("MetalPlates004", "Roughness"), metalness: acg("MetalPlates004", "Metalness") },
  deckDark: { color: acg("MetalPlates008", "Color"), normal: acg("MetalPlates008", "NormalGL"), roughness: acg("MetalPlates008", "Roughness"), metalness: acg("MetalPlates008", "Metalness") },
  // Blue painted plates, desaturated and lifted into Tipoca's white paint.
  hull: { color: "blue_metal_plate/Diffuse.jpg", normal: "blue_metal_plate/nor_gl.jpg", roughness: "blue_metal_plate/Rough.jpg", ao: "blue_metal_plate/AO.jpg", whiten: true },
  hullDark: { color: acg("MetalPlates001", "Color"), normal: acg("MetalPlates001", "NormalGL"), roughness: acg("MetalPlates001", "Roughness"), metalness: acg("MetalPlates001", "Metalness") },
  trim: { color: acg("Metal032", "Color"), normal: acg("Metal032", "NormalGL"), roughness: acg("Metal032", "Roughness"), metalness: acg("Metal032", "Metalness") },
};

const [root] = process.argv.slice(2);
if (!root) throw new Error("Usage: node scripts/fetch-textures.mjs <download-dir>");
fs.mkdirSync(root, { recursive: true });

// ------------------------------------------------------------ download (skipped when present)
for (const id of AMBIENTCG) {
  if (fs.existsSync(path.join(root, id))) continue;
  const zip = path.join(root, `${id}.zip`);
  const res = await fetch(`https://ambientcg.com/get?file=${id}_2K-JPG.zip`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  fs.mkdirSync(path.join(root, id));
  execFileSync("unzip", ["-o", "-q", zip, "-d", path.join(root, id)]);
}
for (const id of POLYHAVEN) {
  if (fs.existsSync(path.join(root, id))) continue;
  fs.mkdirSync(path.join(root, id));
  const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
  for (const map of ["Diffuse", "nor_gl", "Rough", "AO"]) {
    const url = files[map]?.["2k"]?.jpg?.url;
    if (url) fs.writeFileSync(path.join(root, id, `${map}.jpg`), Buffer.from(await (await fetch(url)).arrayBuffer()));
  }
}

// ------------------------------------------------------------ convert
const src = (file) => path.join(root, file);
const grey = async (file, size) => sharp(src(file)).resize(size, size).greyscale().raw().toBuffer();

async function write(name, image, size) {
  for (const [dir, s] of [["public/textures", size], ["public/textures/low", size / 2]]) {
    fs.mkdirSync(dir, { recursive: true });
    await image.clone().resize(s, s).webp({ quality: name.endsWith("normal") ? 90 : 82 }).toFile(path.join(dir, `${name}.webp`));
  }
}

const SIZE = 2048;
/**
 * Desaturate and lift a dark painted plate into Tipoca's white: the 2nd..99th percentile is stretched to
 * full range, then mapped onto 140..247. Done on raw pixels because sharp's `normalise().linear()` chain
 * left the texture untouched (mean ~41/255, which is why the facility walls rendered black).
 */
async function whiten(image) {
  const { data, info } = await image.greyscale().raw().toBuffer({ resolveWithObject: true });
  const hist = new Uint32Array(256);
  for (const v of data) hist[v]++;
  const percentile = (p) => { let n = 0; for (let i = 0; i < 256; i++) { n += hist[i]; if (n >= data.length * p) return i; } return 255; };
  const lo = percentile(.02), hi = Math.max(lo + 1, percentile(.99));
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(140 + .42 * Math.min(255, Math.max(0, (data[i] - lo) * 255 / (hi - lo))));
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } });
}

for (const [name, set] of Object.entries(SETS)) {
  let color = sharp(src(set.color)).resize(SIZE, SIZE);
  if (set.whiten) color = await whiten(color);
  await write(`${name}_color`, color, SIZE);
  await write(`${name}_normal`, sharp(src(set.normal)).resize(SIZE, SIZE), SIZE);
  const r = set.ao ? await grey(set.ao, SIZE) : Buffer.alloc(SIZE * SIZE, 255);
  const g = await grey(set.roughness, SIZE);
  const b = set.metalness ? await grey(set.metalness, SIZE) : Buffer.alloc(SIZE * SIZE, 0);
  const orm = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) { orm[i * 3] = r[i]; orm[i * 3 + 1] = g[i]; orm[i * 3 + 2] = b[i]; }
  await write(`${name}_orm`, sharp(orm, { raw: { width: SIZE, height: SIZE, channels: 3 } }), SIZE);
  console.log(name);
}

// Weathering masks, each stretched to full range.
const W = 1024;
const streaks = await sharp(src(acg("Leaking012A", "Roughness"))).resize(W, W).greyscale().negate().normalise({ lower: 60, upper: 99.5 }).raw().toBuffer();
const grime = await sharp(src(acg("SurfaceImperfections003", "Opacity"))).resize(W, W).greyscale().normalise({ lower: 5, upper: 99 }).raw().toBuffer();
// Rust: how orange the rusty sheet is (red minus blue).
const rustRgb = await sharp(src("rusty_metal_02/Diffuse.jpg")).resize(W, W).removeAlpha().raw().toBuffer();
const rust = Buffer.alloc(W * W);
for (let i = 0; i < W * W; i++) rust[i] = Math.max(0, Math.min(255, (rustRgb[i * 3] - rustRgb[i * 3 + 2]) * 3));
const weathering = Buffer.alloc(W * W * 3);
for (let i = 0; i < W * W; i++) { weathering[i * 3] = streaks[i]; weathering[i * 3 + 1] = grime[i]; weathering[i * 3 + 2] = rust[i]; }
await write("weathering", sharp(weathering, { raw: { width: W, height: W, channels: 3 } }), W);
console.log("weathering");
