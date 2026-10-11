import * as THREE from "three";

/**
 * Photo-scanned CC0 surface sets (ambientCG, Poly Haven; credits in README.md) and the shader
 * detail layered on top of them: rain streaks and grime on walls, puddles with animated rain
 * ripples on decks, rust and dirt on droids. Built by scripts/fetch-textures.mjs.
 */

export type SurfaceName = "deck" | "deckDark" | "hull" | "hullDark" | "trim";
export type SurfaceSet = { map: THREE.Texture; normalMap: THREE.Texture; orm: THREE.Texture };
export type Surfaces = Record<SurfaceName, SurfaceSet> & { weathering: THREE.Texture };

const NAMES: SurfaceName[] = ["deck", "deckDark", "hull", "hullDark", "trim"];

/** Loads every set (1K versions when `low`). Resolves null if anything fails, leaving the procedural textures. */
export async function loadSurfaces(low: boolean, onProgress: (fraction: number) => void): Promise<Surfaces | null> {
  const loader = new THREE.TextureLoader();
  const base = `${import.meta.env.BASE_URL}textures/${low ? "low/" : ""}`;
  const files = [...NAMES.flatMap((name) => ["color", "normal", "orm"].map((map) => `${name}_${map}`)), "weathering"];
  let done = 0;
  try {
    const textures = await Promise.all(files.map(async (file) => {
      const texture = await loader.loadAsync(`${base}${file}.webp`);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = file.endsWith("_color") ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      onProgress(++done / files.length);
      return [file, texture] as const;
    }));
    const byName = new Map(textures);
    const sets = Object.fromEntries(NAMES.map((name) => [name, {
      map: byName.get(`${name}_color`)!, normalMap: byName.get(`${name}_normal`)!, orm: byName.get(`${name}_orm`)!,
    }])) as Record<SurfaceName, SurfaceSet>;
    return { ...sets, weathering: byName.get("weathering")! };
  } catch (error) {
    console.warn("Surface textures failed to load; using the procedural ones.", error);
    return null;
  }
}

/** Uniforms shared by every patched material; `uDetail` is 0 on the Low preset. */
export const surfaceUniforms = {
  uTime: { value: 0 },
  uDetail: { value: 1 },
  uWeathering: { value: null as THREE.Texture | null },
};

/** Append a shader patch to a material without discarding one already installed (e.g. reflections). */
export function extendShader(material: THREE.Material, key: string, patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, surfaceUniforms);
    patch(shader);
  };
  material.customProgramCacheKey = () => `${previousKey}|${key}`;
}

const NOISE = /* glsl */ `
  uniform float uTime;
  uniform float uDetail;
  uniform sampler2D uWeathering;
  float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float sNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3. - 2. * f);
    return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
  }
  // surface-noise-end`;

const WORLD_VARYINGS = /* glsl */ `
  varying vec3 vSurfacePos;
  varying vec3 vSurfaceNormal;`;

function worldVaryings(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${WORLD_VARYINGS}`)
    .replace("#include <project_vertex>", `#include <project_vertex>
      vSurfacePos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vSurfaceNormal = normalize(mat3(modelMatrix) * objectNormal);`);
  shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${WORLD_VARYINGS}\n${NOISE}`);
}

/** Walls: vertical rain streaks (darker, glossier) and broad grime, projected in world space. */
export function addWeathering(material: THREE.MeshStandardMaterial, strength = 1): void {
  extendShader(material, `weathering${strength}`, (shader) => {
    worldVaryings(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <map_fragment>", /* glsl */ `#include <map_fragment>
        float wStreak = 0., wGrime = 0.;
        if (uDetail > .5) {
          vec3 n = normalize(vSurfaceNormal);
          float side = 1. - abs(n.y);
          vec2 wuv = vec2(abs(n.x) > abs(n.z) ? vSurfacePos.z : vSurfacePos.x, vSurfacePos.y);
          wStreak = texture2D(uWeathering, wuv * vec2(.21, .07)).r * side * ${strength.toFixed(2)};
          wGrime = texture2D(uWeathering, wuv * .11 + vec2(.37, .61)).g * ${strength.toFixed(2)};
          diffuseColor.rgb *= 1. - wStreak * .4 - wGrime * .22;
        }`)
      .replace("#include <roughnessmap_fragment>", /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, .14, wStreak * .7);`);
  });
}

/**
 * Decks: patches of standing water (darker, near-mirror roughness, so the planar reflections
 * show) with expanding rain-drop ripples. Install after the reflection patch.
 */
export function addPuddles(material: THREE.MeshStandardMaterial, coverage = .5): void {
  extendShader(material, `puddles${coverage}`, (shader) => {
    worldVaryings(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("// surface-noise-end", /* glsl */ `// surface-noise-end
        vec2 sRipples(vec2 p, float t) {
          vec2 g = vec2(0.);
          for (int layer = 0; layer < 2; layer++) {
            vec2 q = p * 1.7 + float(layer) * 7.31;
            vec2 cell = floor(q);
            vec2 d = fract(q) - .5 - (vec2(sHash(cell + 1.7), sHash(cell + 5.3)) - .5) * .5;
            float phase = fract(t * .85 + sHash(cell + float(layer) * 13.1));
            float r = length(d);
            float x = (r - phase * .45) * 30.;
            float wave = exp(-x * x * .5) * (1. - phase) * (1. - phase) * sin(x * 2.);
            g += d / max(r, 1e-3) * wave;
          }
          return g;
        }`)
      .replace("#include <roughnessmap_fragment>", /* glsl */ `#include <roughnessmap_fragment>
        float wet = sNoise(vSurfacePos.xz * .15) * .65 + sNoise(vSurfacePos.xz * .6 + 3.1) * .35;
        float puddle = smoothstep(${(1 - coverage * .5).toFixed(3)}, ${(1.08 - coverage * .5).toFixed(3)}, wet) * step(.7, vSurfaceNormal.y);
        diffuseColor.rgb *= mix(1., .45, puddle);
        roughnessFactor = mix(roughnessFactor, .03, puddle);`)
      .replace("#include <normal_fragment_maps>", /* glsl */ `#include <normal_fragment_maps>
        // Standing water is flat: fade out the plating's normal map, then add the ripples.
        normal = normalize(mix(normal, normalize((viewMatrix * vec4(0., 1., 0., 0.)).xyz), puddle * .85));
        if (uDetail > .5 && puddle > .01) {
          vec2 ripple = sRipples(vSurfacePos.xz, uTime) * puddle * .35;
          normal = normalize(normal + mat3(viewMatrix) * vec3(ripple.x, 0., ripple.y));
        }`);
  });
}

/** Droid and armour wear from the model's own UVs: dirt (darker, rougher) and rust (orange, rough). */
export function addWear(material: THREE.MeshStandardMaterial, dirt: number, rust: number, tiling = 3): void {
  if (!material.map) return;
  extendShader(material, `wear${dirt}${rust}${tiling}`, (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${NOISE}`)
      .replace("#include <map_fragment>", /* glsl */ `#include <map_fragment>
        float wDirt = 0., wRust = 0.;
        if (uDetail > .5) {
          vec3 w = texture2D(uWeathering, vMapUv * ${tiling.toFixed(1)}).rgb;
          wDirt = w.g * ${dirt.toFixed(2)};
          wRust = smoothstep(.3, .85, w.b) * ${rust.toFixed(2)};
          diffuseColor.rgb = mix(diffuseColor.rgb * (1. - wDirt * .5), vec3(.32, .16, .07), wRust);
        }`)
      .replace("#include <roughnessmap_fragment>", /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + wRust * .4 + wDirt * .25, 0., 1.);`);
  });
}
