import * as THREE from "three";

/** Procedural textures. Everything is generated at load so the game ships with no third-party art. */

export function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

class TileNoise {
  private readonly values: Float32Array;

  constructor(private readonly period: number, seed: number) {
    const random = rng(seed);
    this.values = new Float32Array(period * period);
    for (let i = 0; i < this.values.length; i++) this.values[i] = random();
  }

  /** u, v in [0, 1); tiles seamlessly. */
  sample(u: number, v: number): number {
    const p = this.period;
    const x = u * p, y = v * p;
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
    const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
    const su = xf * xf * (3 - 2 * xf), sv = yf * yf * (3 - 2 * yf);
    const a = this.values[y0 * p + x0], b = this.values[y0 * p + x1];
    const c = this.values[y1 * p + x0], d = this.values[y1 * p + x1];
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  }
}

class Fbm {
  private readonly octaves: TileNoise[];

  constructor(basePeriod: number, count: number, seed: number) {
    this.octaves = Array.from({ length: count }, (_, i) => new TileNoise(basePeriod << i, seed + i * 7919));
  }

  sample(u: number, v: number): number {
    let sum = 0, amp = .5, norm = 0;
    for (const octave of this.octaves) {
      sum += octave.sample(u, v) * amp;
      norm += amp;
      amp *= .5;
    }
    return sum / norm;
  }
}

export type PbrSet = { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture };

type PanelOptions = {
  size: number;
  cols: number;
  rows: number;
  seed: number;
  base: [number, number, number];
  tone: number;
  grime: number;
  streaks: number;
  wet: number;
  roughness: number;
  seam: number;
  rivets: boolean;
  normalStrength: number;
  vents?: number;
  bands?: boolean;
};

function canvasTexture(width: number, height: number, data: Uint8ClampedArray, srgb: boolean): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(width, height);
  image.data.set(data);
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/** Wet, weathered metal plating: albedo + normal + roughness that tile. */
export function panelTextures(options: PanelOptions): PbrSet {
  const { size } = options;
  const random = rng(options.seed);
  const height = new Float32Array(size * size).fill(1);
  const tone = new Float32Array(size * size).fill(1);
  const seamMask = new Float32Array(size * size);

  // Lay out panels on a grid, merging neighbours to create varied plate sizes.
  const cellW = size / options.cols, cellH = size / options.rows;
  const used = new Uint8Array(options.cols * options.rows);
  const panels: Array<[number, number, number, number]> = [];
  for (let r = 0; r < options.rows; r++) {
    for (let c = 0; c < options.cols; c++) {
      if (used[r * options.cols + c]) continue;
      let w = 1, h = 1;
      if (c + 1 < options.cols && !used[r * options.cols + c + 1] && random() < .45) w = 2;
      if (r + 1 < options.rows && random() < .3) {
        let free = true;
        for (let k = 0; k < w; k++) if (used[(r + 1) * options.cols + c + k]) free = false;
        if (free) h = 2;
      }
      for (let rr = 0; rr < h; rr++) for (let cc = 0; cc < w; cc++) used[(r + rr) * options.cols + c + cc] = 1;
      panels.push([Math.round(c * cellW), Math.round(r * cellH), Math.round(w * cellW), Math.round(h * cellH)]);
    }
  }

  const seam = options.seam;
  const bevel = seam * 1.6;
  for (const [x0, y0, w, h] of panels) {
    const panelTone = 1 + (random() - .5) * options.tone;
    const inset = random() < .18;
    const vented = options.vents !== undefined && random() < options.vents;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const index = (y % size) * size + (x % size);
        const d = Math.min(x - x0, x0 + w - 1 - x, y - y0, y0 + h - 1 - y);
        let value = 1;
        if (d < seam) { value = 0; seamMask[index] = 1; }
        else if (d < seam + bevel) value = (d - seam) / bevel;
        if (inset && d > seam + bevel + size * .02) {
          const di = d - (seam + bevel + size * .02);
          value = di < bevel ? 1 - .35 * (di / bevel) : .65;
        }
        if (vented && d > seam + bevel * 3) {
          const stripe = (y - y0) % Math.max(6, Math.round(size / 64));
          if (stripe < 2) { value = .25; seamMask[index] = .6; }
        }
        height[index] = value;
        tone[index] = panelTone;
      }
    }
    if (options.rivets) {
      const r = Math.max(1.6, size / 360);
      const margin = seam + bevel + r * 2.5;
      const corners = [[x0 + margin, y0 + margin], [x0 + w - margin, y0 + margin], [x0 + margin, y0 + h - margin], [x0 + w - margin, y0 + h - margin]];
      for (const [cx, cy] of corners) {
        for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
          for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
            const dd = Math.hypot(x - cx, y - cy);
            if (dd > r) continue;
            const index = (((y % size) + size) % size) * size + (((x % size) + size) % size);
            height[index] += .5 * Math.sqrt(1 - (dd / r) ** 2);
          }
        }
      }
    }
  }

  const grime = new Fbm(4, 5, options.seed + 11);
  const wet = new Fbm(3, 4, options.seed + 29);
  const fine = new Fbm(32, 3, options.seed + 51);
  const streakNoise = new TileNoise(Math.max(16, size / 8), options.seed + 73);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const [br, bg, bb] = options.base;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const u = x / size, v = y / size;
      const g = grime.sample(u, v);
      const w = THREE.MathUtils.smoothstep(wet.sample(u, v), .45, .65) * options.wet;
      const f = fine.sample(u, v);
      const streak = options.streaks ? Math.pow(streakNoise.sample(u, v * .08), 3) * options.streaks : 0;
      let shade = tone[index] * (1 - options.grime * (g - .35)) * (.92 + f * .16) - streak;
      if (options.bands) shade *= .92 + .08 * Math.sin(v * Math.PI * 2 * 6);
      shade *= 1 - seamMask[index] * .55;
      shade *= 1 - w * .18;
      const o = index * 4;
      albedo[o] = Math.min(255, br * shade);
      albedo[o + 1] = Math.min(255, bg * shade);
      albedo[o + 2] = Math.min(255, bb * shade);
      albedo[o + 3] = 255;
      let r = options.roughness + (g - .5) * .25 + f * .08 + streak * .6 + seamMask[index] * .2 - w * .5;
      r = THREE.MathUtils.clamp(r, .1, 1);
      const rv = r * 255;
      rough[o] = rv; rough[o + 1] = rv; rough[o + 2] = rv; rough[o + 3] = 255;
    }
  }

  const normal = new Uint8ClampedArray(size * size * 4);
  const strength = options.normalStrength;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size, xr = (x + 1) % size;
      const yu = (y - 1 + size) % size, yd = (y + 1) % size;
      const hx = (height[y * size + xr] - height[y * size + xl]) * strength;
      const hy = (height[yd * size + x] - height[yu * size + x]) * strength;
      const fx = (fine.sample((x + 1) / size, y / size) - fine.sample((x - 1) / size, y / size)) * strength * .25;
      const nx = -(hx + fx), ny = hy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 4;
      normal[o] = (nx / len * .5 + .5) * 255;
      normal[o + 1] = (ny / len * .5 + .5) * 255;
      normal[o + 2] = (nz / len * .5 + .5) * 255;
      normal[o + 3] = 255;
    }
  }

  return {
    map: canvasTexture(size, size, albedo, true),
    normalMap: canvasTexture(size, size, normal, false),
    roughnessMap: canvasTexture(size, size, rough, false),
  };
}

/** Painted landing-pad markings: radial clock lines, rings, hazard chevrons, worn by weather. */
export function padMarkings(seed: number, label: string): THREE.Texture {
  const size = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  ctx.translate(c, c);
  const paint = "rgba(214,232,240,0.62)";
  const amber = "rgba(255,196,96,0.7)";

  const ring = (r: number, width: number, color: string, dash?: number[]) => {
    ctx.beginPath();
    ctx.setLineDash(dash ?? []);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  ring(c * .965, 10, paint);
  ring(c * .93, 4, paint, [28, 18]);
  ring(c * .62, 7, paint);
  ring(c * .58, 3, amber, [60, 30]);
  ring(c * .26, 8, paint);
  ctx.setLineDash([]);

  // Clock-like radial spokes, long on the cardinals.
  for (let i = 0; i < 48; i++) {
    const angle = i / 48 * Math.PI * 2;
    const long = i % 12 === 0, mid = i % 4 === 0;
    const r0 = long ? c * .27 : mid ? c * .63 : c * .8;
    const r1 = c * .92;
    ctx.save();
    ctx.rotate(angle);
    ctx.fillStyle = long ? paint : "rgba(214,232,240,0.42)";
    ctx.fillRect(r0, long ? -9 : -3.5, r1 - r0, long ? 18 : 7);
    ctx.restore();
  }

  // Hazard chevrons on the outer rim.
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate(i * Math.PI / 2 + Math.PI / 4);
    ctx.translate(c * .76, 0);
    ctx.fillStyle = amber;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.moveTo(-30 + k * 42, -46);
      ctx.lineTo(0 + k * 42, 0);
      ctx.lineTo(-30 + k * 42, 46);
      ctx.lineTo(-12 + k * 42, 46);
      ctx.lineTo(18 + k * 42, 0);
      ctx.lineTo(-12 + k * 42, -46);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.fillStyle = paint;
  ctx.font = "700 120px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, c * .44);
  ctx.save();
  ctx.rotate(Math.PI);
  ctx.fillText(label, 0, c * .44);
  ctx.restore();

  // Weathering: knock alpha out with noise.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const wear = new Fbm(8, 5, seed);
  const mask = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      if (!mask.data[o + 3]) continue;
      const n = wear.sample(x / size, y / size);
      mask.data[o + 3] *= THREE.MathUtils.smoothstep(n, .3, .62);
    }
  }
  ctx.putImageData(mask, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export function glowTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(.25, "rgba(255,255,255,.55)");
  gradient.addColorStop(.6, "rgba(255,255,255,.12)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function smokeTexture(seed: number): THREE.Texture {
  const size = 256;
  const noise = new Fbm(4, 5, seed);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / size - .5, dy = y / size - .5;
      const falloff = Math.max(0, 1 - Math.hypot(dx, dy) * 2);
      const n = noise.sample(x / size, y / size);
      const a = Math.pow(falloff, 1.4) * THREE.MathUtils.smoothstep(n, .25, .75);
      const o = (y * size + x) * 4;
      const shade = 180 + n * 75;
      data[o] = shade; data[o + 1] = shade; data[o + 2] = shade; data[o + 3] = a * 255;
    }
  }
  const texture = canvasTexture(size, size, data, true);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Burn mark for blaster impacts. */
export function scorchTexture(seed: number): THREE.Texture {
  const size = 128;
  const noise = new Fbm(4, 4, seed);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / size - .5, dy = y / size - .5;
      const d = Math.hypot(dx, dy) * 2;
      const n = noise.sample(x / size, y / size);
      const a = THREE.MathUtils.clamp((1 - d) * 1.6 - n * .7, 0, 1);
      const o = (y * size + x) * 4;
      data[o] = 12; data[o + 1] = 10; data[o + 2] = 9; data[o + 3] = a * 235;
    }
  }
  const texture = canvasTexture(size, size, data, true);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Subtle surface grime for characters and props using native UVs. */
export function grimeTextures(seed: number, base: [number, number, number], amount: number): PbrSet {
  return panelTextures({
    size: 256, cols: 2, rows: 2, seed, base, tone: .05, grime: amount, streaks: .12, wet: .4,
    roughness: .5, seam: 1, rivets: false, normalStrength: .6,
  });
}
