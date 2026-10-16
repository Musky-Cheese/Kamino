import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Depth-aware post effects. ScenePass renders the frame once into a multisampled HDR target with a
 * depth texture; AO and volumetric light are computed at half resolution from that depth, then
 * CompositePass blends them back in (plus an aim-down-sights near-field blur).
 */

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DEPTH_HELPERS = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform float uNear, uFar;
  uniform mat4 uInvProjection;
  float sceneDepth(vec2 uv) { return texture2D(tDepth, uv).x; }
  float linearDepth(vec2 uv) { return -perspectiveDepthToViewZ(sceneDepth(uv), uNear, uFar); }
  vec3 viewPosition(vec2 uv, float depth) {
    vec4 p = uInvProjection * vec4(uv * 2. - 1., depth * 2. - 1., 1.);
    return p.xyz / p.w;
  }`;

function depthUniforms() {
  return {
    tDepth: { value: null as THREE.Texture | null },
    uNear: { value: .1 },
    uFar: { value: 1000 },
    uInvProjection: { value: new THREE.Matrix4() },
  };
}

function syncCamera(uniforms: ReturnType<typeof depthUniforms>, camera: THREE.PerspectiveCamera, depth: THREE.Texture): void {
  uniforms.tDepth.value = depth;
  uniforms.uNear.value = camera.near;
  uniforms.uFar.value = camera.far;
  uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);
}

// ------------------------------------------------------------------ scene

export class ScenePass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly copy: FullScreenQuad;
  private readonly copyMaterial: THREE.ShaderMaterial;

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera, samples: number) {
    super();
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.target.texture } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.copy = new FullScreenQuad(this.copyMaterial);
  }

  get depth(): THREE.DepthTexture { return this.target.depthTexture!; }

  setSize(width: number, height: number): void { this.target.setSize(width, height); }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    this.copy.render(renderer);
  }
}

// ------------------------------------------------------------------ ambient occlusion

const AO_SAMPLES = 14;

export class AmbientOcclusionPass extends Pass {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly scenePass: ScenePass) {
    super();
    this.needsSwap = false;
    const kernel: THREE.Vector3[] = [];
    for (let i = 0; i < AO_SAMPLES; i++) {
      // Hemisphere (+z) samples, denser near the centre.
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * .85 + .15).normalize();
      const scale = .15 + .85 * (i / AO_SAMPLES) ** 2;
      kernel.push(v.multiplyScalar(scale));
    }
    this.material = new THREE.ShaderMaterial({
      defines: { SAMPLES: AO_SAMPLES },
      uniforms: {
        ...depthUniforms(),
        uProjection: { value: new THREE.Matrix4() },
        uKernel: { value: kernel },
        uRadius: { value: .75 },
        uTime: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${DEPTH_HELPERS}
        uniform mat4 uProjection;
        uniform vec3 uKernel[SAMPLES];
        uniform float uRadius, uTime;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }
        void main() {
          float depth = sceneDepth(vUv);
          vec3 p = viewPosition(vUv, depth);
          float distance = -p.z;
          // Sky, ocean horizon and the far city get no AO (this is what broke GTAO here).
          if (depth >= .99999 || distance > 70.) { gl_FragColor = vec4(1.); return; }
          vec3 n = normalize(cross(dFdx(p), dFdy(p)));
          if (dot(n, p) > 0.) n = -n;
          float angle = hash(gl_FragCoord.xy) * 6.2831853;
          vec3 random = vec3(cos(angle), sin(angle), 0.);
          vec3 t = normalize(random - n * dot(random, n));
          mat3 tbn = mat3(t, cross(n, t), n);
          float radius = uRadius * (1. + distance * .02);
          float occlusion = 0.;
          for (int i = 0; i < SAMPLES; i++) {
            vec3 s = p + tbn * uKernel[i] * radius;
            vec4 clip = uProjection * vec4(s, 1.);
            vec2 suv = clip.xy / clip.w * .5 + .5;
            if (suv.x < 0. || suv.x > 1. || suv.y < 0. || suv.y > 1.) continue;
            float sceneZ = viewPosition(suv, sceneDepth(suv)).z;
            float range = smoothstep(0., 1., radius / max(abs(p.z - sceneZ), 1e-3));
            occlusion += step(s.z + .03, sceneZ) * range;
          }
          float ao = 1. - occlusion / float(SAMPLES);
          ao = mix(ao, 1., smoothstep(45., 70., distance));
          gl_FragColor = vec4(vec3(ao), 1.);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
  }

  render(renderer: THREE.WebGLRenderer): void {
    const u = this.material.uniforms;
    syncCamera(u as unknown as ReturnType<typeof depthUniforms>, this.camera, this.scenePass.depth);
    u.uProjection.value.copy(this.camera.projectionMatrix);
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }
}

// ------------------------------------------------------------------ volumetric light

export const MAX_SPOTS = 8;
export const MAX_POINTS = 6;

export type VolumeSpot = { position: THREE.Vector3; direction: THREE.Vector3; angle: number; color: THREE.Color };
export type VolumePoint = { position: THREE.Vector3; color: THREE.Color; range: number };

export class VolumetricPass extends Pass {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  readonly spots: VolumeSpot[] = [];
  readonly points: VolumePoint[] = [];
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly scenePass: ScenePass) {
    super();
    this.needsSwap = false;
    const v3 = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());
    this.material = new THREE.ShaderMaterial({
      defines: { MAX_SPOTS, MAX_POINTS, STEPS: 26 },
      uniforms: {
        ...depthUniforms(),
        uCameraWorld: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        // A thinner atmosphere keeps shafts visible without turning every lamp into a white veil.
        uDensity: { value: .032 },
        uFlash: { value: 0 },
        uSpotCount: { value: 0 },
        uSpotPos: { value: v3(MAX_SPOTS) },
        uSpotDir: { value: v3(MAX_SPOTS) },
        uSpotCos: { value: Array.from({ length: MAX_SPOTS }, () => new THREE.Vector2()) },
        uSpotColor: { value: v3(MAX_SPOTS) },
        uPointCount: { value: 0 },
        uPointPos: { value: v3(MAX_POINTS) },
        uPointColor: { value: v3(MAX_POINTS) },
        uPointRange: { value: new Array<number>(MAX_POINTS).fill(1) },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${DEPTH_HELPERS}
        uniform mat4 uCameraWorld;
        uniform vec3 uCameraPosition;
        uniform float uTime, uDensity, uFlash;
        uniform int uSpotCount, uPointCount;
        uniform vec3 uSpotPos[MAX_SPOTS], uSpotDir[MAX_SPOTS], uSpotColor[MAX_SPOTS];
        uniform vec2 uSpotCos[MAX_SPOTS];
        uniform vec3 uPointPos[MAX_POINTS], uPointColor[MAX_POINTS];
        uniform float uPointRange[MAX_POINTS];
        varying vec2 vUv;
        float hash3(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float noise3(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3. - 2. * f);
          return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }
        // Rain-laden air: wind-blown clumps plus falling vertical streaks.
        float density(vec3 p) {
          vec3 wind = vec3(-3.2, 0., -1.2) * uTime;
          float clumps = noise3((p + wind) * .12);
          float streaks = noise3(vec3(p.x * 1.6, p.y * .08 + uTime * 2.4, p.z * 1.6));
          return uDensity * (.35 + clumps * .9 + streaks * .2);
        }
        float phase(float cosTheta) {
          float g = .3;
          return (1. - g * g) / pow(1. + g * g - 2. * g * cosTheta, 1.5) * .25;
        }
        void main() {
          float depth = sceneDepth(vUv);
          vec3 viewEnd = viewPosition(vUv, depth);
          vec3 viewFar = viewPosition(vUv, 1.);
          vec3 rayView = normalize(viewFar);
          vec3 ray = normalize((uCameraWorld * vec4(rayView, 0.)).xyz);
          float maxDistance = depth >= .99999 ? 160. : min(length(viewEnd), 160.);
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))) + uTime * 7.31);
          vec3 light = vec3(0.);
          float transmittance = 1.;
          float previous = 0.;
          for (int i = 0; i < STEPS; i++) {
            float k = (float(i) + jitter) / float(STEPS);
            float t = maxDistance * k * k;
            float stepLength = t - previous;
            previous = t;
            vec3 p = uCameraPosition + ray * t;
            float sigma = density(p);
            vec3 scatter = vec3(0.);
            for (int s = 0; s < MAX_SPOTS; s++) {
              if (s >= uSpotCount) break;
              vec3 toPoint = p - uSpotPos[s];
              float d = length(toPoint);
              vec3 dir = toPoint / max(d, 1e-3);
              float cone = smoothstep(uSpotCos[s].x, uSpotCos[s].y, dot(dir, uSpotDir[s]));
              if (cone <= 0.) continue;
              // Forward scattering: brightest looking back up the beam toward the lamp.
              scatter += uSpotColor[s] * cone / (1. + d * d * .012) * phase(dot(dir, -ray));
            }
            for (int s = 0; s < MAX_POINTS; s++) {
              if (s >= uPointCount) break;
              float d = distance(p, uPointPos[s]);
              float fall = smoothstep(uPointRange[s], 0., d);
              scatter += uPointColor[s] * fall * fall / (1. + d * d * .3);
            }
            scatter += vec3(.3, .42, .55) * uFlash * .25;
            light += scatter * sigma * stepLength * transmittance;
            transmittance *= exp(-sigma * stepLength * .08);
          }
          gl_FragColor = vec4(light, 1.);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  set flash(value: number) { this.material.uniforms.uFlash.value = value; }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, _read: THREE.WebGLRenderTarget, delta: number): void {
    const u = this.material.uniforms;
    syncCamera(u as unknown as ReturnType<typeof depthUniforms>, this.camera, this.scenePass.depth);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    u.uCameraPosition.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.uTime.value += delta;
    const spots = this.spots.slice(0, MAX_SPOTS);
    u.uSpotCount.value = spots.length;
    spots.forEach((spot, i) => {
      u.uSpotPos.value[i].copy(spot.position);
      u.uSpotDir.value[i].copy(spot.direction).normalize();
      u.uSpotCos.value[i].set(Math.cos(spot.angle), Math.cos(spot.angle * .55));
      u.uSpotColor.value[i].set(spot.color.r, spot.color.g, spot.color.b);
    });
    const points = this.points.slice(0, MAX_POINTS);
    u.uPointCount.value = points.length;
    points.forEach((point, i) => {
      u.uPointPos.value[i].copy(point.position);
      u.uPointColor.value[i].set(point.color.r, point.color.g, point.color.b);
      u.uPointRange.value[i] = point.range;
    });
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }
}

// ------------------------------------------------------------------ heat haze

export const HAZE_LAYER = 7;

type HazeQuad = { mesh: THREE.Mesh; material: THREE.ShaderMaterial; ttl: number; life: number; rise: number; peak: number };

/**
 * Heat shimmer. Vertical billboards over fires and explosions render rising-noise UV offsets into a
 * half-resolution buffer (depth-tested against the scene in the shader), which the composite pass
 * uses to refract the image behind them.
 */
export class HeatHazePass extends Pass {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly quads: HazeQuad[] = [];
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly clearColor = new THREE.Color();
  private readonly shared = { ...depthUniforms(), uTime: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) } };

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.PerspectiveCamera, private readonly scenePass: ScenePass) {
    super();
    this.needsSwap = false;
  }

  /** A shimmering column `width` × `height` metres rising from `position`. Infinite life = persistent. */
  spawn(position: THREE.Vector3, width: number, height: number, strength: number, life = Infinity, rise = 0): THREE.Mesh {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        tDepth: this.shared.tDepth,
        uTime: this.shared.uTime,
        uResolution: this.shared.uResolution,
        uSize: { value: new THREE.Vector2(width, height) },
        uStrength: { value: strength },
        uSeed: { value: Math.random() * 100 },
      },
      vertexShader: /* glsl */ `
        uniform vec2 uSize;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 center = (modelMatrix * vec4(0., 0., 0., 1.)).xyz;
          vec3 toCamera = cameraPosition - center;
          vec3 right = normalize(cross(vec3(0., 1., 0.), toCamera));
          vec3 world = center + right * position.x * uSize.x + vec3(0., 1., 0.) * (position.y + .5) * uSize.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform float uTime, uStrength, uSeed;
        varying vec2 vUv;
        float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3. - 2. * f);
          return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
        }
        void main() {
          // Hidden behind nearer geometry: the scene depth was resolved before this pass.
          if (texture2D(tDepth, gl_FragCoord.xy / uResolution).x < gl_FragCoord.z - 1e-5) discard;
          vec2 q = vec2(vUv.x * 2.2, vUv.y * 1.4 - uTime * .9) + uSeed;
          vec2 offset = vec2(vnoise(q * 5.) + vnoise(q * 11.) * .5, vnoise(q * 5. + 7.7) + vnoise(q * 11. + 3.1) * .5) / 1.5 - .5;
          float across = smoothstep(0., .4, 1. - abs(vUv.x - .5) * 2.);
          float along = smoothstep(0., .12, vUv.y) * (1. - smoothstep(.35, 1., vUv.y));
          gl_FragColor = vec4(offset * across * along * uStrength, 0., 1.);
        }`,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.copy(position);
    mesh.frustumCulled = false;
    mesh.layers.set(HAZE_LAYER);
    this.scene.add(mesh);
    this.quads.push({ mesh, material, ttl: life, life, rise, peak: strength });
    return mesh;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2)), h = Math.max(1, Math.floor(height / 2));
    this.target.setSize(w, h);
    this.shared.uResolution.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, _read: THREE.WebGLRenderTarget, delta: number): void {
    this.shared.uTime.value += delta;
    for (let i = this.quads.length - 1; i >= 0; i--) {
      const quad = this.quads[i];
      if (!Number.isFinite(quad.ttl)) continue;
      quad.ttl -= delta;
      if (quad.ttl <= 0) {
        this.scene.remove(quad.mesh);
        quad.material.dispose();
        this.quads.splice(i, 1);
        continue;
      }
      const t = quad.ttl / quad.life;
      quad.mesh.position.y += quad.rise * delta;
      quad.material.uniforms.uStrength.value = quad.peak * Math.min(1, t * 3);
    }
    syncCamera(this.shared, this.camera, this.scenePass.depth);
    // Offsets accumulate additively on zero; the scene background and fog must stay out of it.
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    if (this.quads.length > 0) {
      const mask = this.camera.layers.mask;
      const shadowAuto = renderer.shadowMap.autoUpdate;
      const background = this.scene.background;
      const autoClear = renderer.autoClear;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = false;
      this.scene.background = null;
      this.camera.layers.set(HAZE_LAYER);
      renderer.render(this.scene, this.camera);
      this.camera.layers.mask = mask;
      this.scene.background = background;
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadowAuto;
    }
    renderer.setClearColor(this.clearColor, clearAlpha);
  }
}

// ------------------------------------------------------------------ lens flares

export const MAX_FLARES = 8;

/** A bright source for the lens: `tolerance` is how far (metres) behind the sampled depth it may sit before counting as hidden. */
export type FlareSource = { position: THREE.Vector3; color: THREE.Color; intensity: number; size: number; tolerance: number };

/**
 * Projects flare sources to the screen and measures, in a tiny render target, how much of each is
 * visible against the scene depth (one pixel per source), so flares fade behind railings and
 * towers without ever reading pixels back to the CPU.
 */
export class FlareVisibilityPass extends Pass {
  readonly target = new THREE.WebGLRenderTarget(MAX_FLARES, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  readonly sources: FlareSource[] = [];
  /** Screen position (uv), view distance and tolerance per projected source, shared with the composite. */
  readonly projected = Array.from({ length: MAX_FLARES }, () => new THREE.Vector4());
  readonly colors = Array.from({ length: MAX_FLARES }, () => new THREE.Vector4());
  count = 0;
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly clip = new THREE.Vector4();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly scenePass: ScenePass) {
    super();
    this.needsSwap = false;
    this.material = new THREE.ShaderMaterial({
      defines: { MAX_FLARES },
      uniforms: { ...depthUniforms(), uFlare: { value: this.projected }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${DEPTH_HELPERS}
        uniform vec4 uFlare[MAX_FLARES];
        uniform vec2 uTexel;
        void main() {
          int index = int(gl_FragCoord.x);
          vec4 flare = vec4(0.);
          for (int i = 0; i < MAX_FLARES; i++) if (i == index) flare = uFlare[i];
          float visible = 0.;
          for (int ring = 1; ring <= 2; ring++) {
            for (int k = 0; k < 8; k++) {
              float a = float(k) * .785398 + float(ring) * .3;
              vec2 uv = flare.xy + vec2(cos(a), sin(a)) * uTexel * (2.5 + float(ring) * 3.);
              visible += step(flare.z - flare.w, linearDepth(uv));
            }
          }
          visible = (visible + step(flare.z - flare.w, linearDepth(flare.xy))) / 17.;
          gl_FragColor = vec4(visible, 0., 0., 1.);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.material.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  render(renderer: THREE.WebGLRenderer): void {
    const u = this.material.uniforms;
    syncCamera(u as unknown as ReturnType<typeof depthUniforms>, this.camera, this.scenePass.depth);
    this.count = 0;
    for (const source of this.sources) {
      if (this.count >= MAX_FLARES || source.intensity <= .001) continue;
      this.clip.set(source.position.x, source.position.y, source.position.z, 1).applyMatrix4(this.camera.matrixWorldInverse);
      const viewDistance = -this.clip.z;
      this.clip.applyMatrix4(this.camera.projectionMatrix);
      if (this.clip.w <= 0) continue;
      const x = this.clip.x / this.clip.w * .5 + .5, y = this.clip.y / this.clip.w * .5 + .5;
      if (x < -.15 || x > 1.15 || y < -.15 || y > 1.15) continue;
      // Fade as the source leaves the frame so streaks don't pop at the edge.
      const edge = THREE.MathUtils.smoothstep(Math.min(x, 1 - x, y, 1 - y), -.12, .04);
      this.projected[this.count].set(x, y, viewDistance, source.tolerance);
      this.colors[this.count].set(source.color.r * source.intensity * edge, source.color.g * source.intensity * edge, source.color.b * source.intensity * edge, source.size);
      this.count++;
    }
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }
}

// ------------------------------------------------------------------ composite

export class CompositePass extends Pass {
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly previousViewProjection = new THREE.Matrix4();
  private frames = 0;
  aoStrength = 1;
  volumeStrength = 1;
  flareStrength = 1;
  /** Camera motion blur amount (0 = off). */
  motionBlur = .55;
  ads = 0;
  /** Seconds since the last frame, used to normalise motion blur to a fixed shutter. */
  delta = 1 / 60;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly scenePass: ScenePass,
    private readonly ao: AmbientOcclusionPass,
    private readonly volume: VolumetricPass,
    private readonly haze: HeatHazePass,
    private readonly flares: FlareVisibilityPass,
  ) {
    super();
    this.material = new THREE.ShaderMaterial({
      defines: { MAX_FLARES },
      uniforms: {
        ...depthUniforms(),
        tDiffuse: { value: null },
        tAO: { value: null },
        tVolume: { value: null },
        tHaze: { value: null },
        tFlareVisibility: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uAspect: { value: 1 },
        uAoStrength: { value: 1 },
        uVolumeStrength: { value: 1 },
        uHazeStrength: { value: 1 },
        uFlareStrength: { value: 1 },
        uBlur: { value: 0 },
        uAds: { value: 0 },
        uCameraWorld: { value: new THREE.Matrix4() },
        uPreviousViewProjection: { value: new THREE.Matrix4() },
        uFlareCount: { value: 0 },
        uFlare: { value: flares.projected },
        uFlareColor: { value: flares.colors },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${DEPTH_HELPERS}
        uniform sampler2D tDiffuse, tAO, tVolume, tHaze, tFlareVisibility;
        uniform vec2 uTexel;
        uniform float uAspect, uAoStrength, uVolumeStrength, uHazeStrength, uFlareStrength, uBlur, uAds;
        uniform mat4 uCameraWorld, uPreviousViewProjection;
        uniform int uFlareCount;
        uniform vec4 uFlare[MAX_FLARES], uFlareColor[MAX_FLARES];
        varying vec2 vUv;
        const float VIEWMODEL_Z = 1.1;
        float hash(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }
        void main() {
          float depth = sceneDepth(vUv);
          vec3 viewPos = viewPosition(vUv, depth);
          float z = -viewPos.z;
          // Heat shimmer refracts what's behind the fire; the rifle in your hands is never behind it.
          vec2 haze = texture2D(tHaze, vUv).xy * uHazeStrength * .022;
          haze *= step(VIEWMODEL_Z, z);
          vec2 uv = vUv + haze;
          vec4 color = texture2D(tDiffuse, uv);
          // Camera motion blur: reproject this pixel into last frame and smear along the screen-space motion.
          if (uBlur > 0. && z > VIEWMODEL_Z) {
            vec4 world = uCameraWorld * vec4(viewPos, 1.);
            vec4 previous = uPreviousViewProjection * world;
            vec2 previousUv = previous.xy / previous.w * .5 + .5;
            vec2 velocity = (vUv - previousUv) * uBlur;
            float pixels = length(velocity / uTexel);
            if (pixels > 16.) velocity *= 16. / pixels;
            if (pixels > .75) {
              float jitter = hash(gl_FragCoord.xy) - .5;
              vec3 sum = color.rgb;
              float weight = 1.;
              for (int i = 0; i < 7; i++) {
                float k = (float(i) + jitter) / 7. - .5;
                vec2 tap = uv + velocity * k;
                // Don't drag the viewmodel across the world.
                float w = step(VIEWMODEL_Z, linearDepth(tap));
                sum += texture2D(tDiffuse, tap).rgb * w;
                weight += w;
              }
              color.rgb = sum / weight;
            }
          }
          // Aim-down-sights: the rifle in front of your eye goes soft while the target stays sharp.
          if (uAds > .01 && z < VIEWMODEL_Z) {
            vec3 sum = color.rgb;
            float weight = 1.;
            for (int i = 0; i < 12; i++) {
              float a = float(i) * 2.39996;
              vec2 offset = vec2(cos(a), sin(a)) * sqrt(float(i + 1) / 12.) * uTexel * 7. * uAds;
              sum += texture2D(tDiffuse, uv + offset).rgb;
              weight += 1.;
            }
            color.rgb = sum / weight;
          }
          // Depth-aware upsample of the half-resolution AO.
          float ao = 0., aoWeight = 0.;
          for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
              vec2 suv = vUv + vec2(float(x), float(y)) * uTexel * 2.;
              float w = 1. / (1e-3 + abs(linearDepth(suv) - z) * 4.);
              ao += texture2D(tAO, suv).r * w;
              aoWeight += w;
            }
          }
          ao /= aoWeight;
          color.rgb *= mix(1., ao, uAoStrength);
          // Soft upsample of the half-resolution light shafts.
          vec3 volume = vec3(0.);
          for (int i = 0; i < 5; i++) {
            float a = float(i) * 1.2566;
            volume += texture2D(tVolume, vUv + vec2(cos(a), sin(a)) * uTexel * 2.5).rgb;
          }
          // Prevent overlapping lamps and lightning from flooding the whole frame with haze.
          color.rgb += min(volume / 5., vec3(1.15)) * uVolumeStrength;
          // Lens flares: a hot core, an anamorphic streak and a couple of ghosts mirrored through the centre.
          vec3 flare = vec3(0.);
          for (int i = 0; i < MAX_FLARES; i++) {
            if (i >= uFlareCount) break;
            float visible = texture2D(tFlareVisibility, vec2((float(i) + .5) / float(MAX_FLARES), .5)).r;
            if (visible <= 0.) continue;
            vec2 source = uFlare[i].xy;
            float size = uFlareColor[i].w;
            vec3 tint = uFlareColor[i].rgb * visible;
            vec2 d = (vUv - source) * vec2(uAspect, 1.);
            float r = length(d);
            float core = exp(-r * r / (size * size) * 3.) * .9 + exp(-r / size * 1.2) * .25;
            float streak = exp(-abs(d.y) / (size * .09)) * exp(-abs(d.x) / (size * 7.)) * .5;
            float ghosts = 0.;
            vec2 axis = vec2(.5) - source;
            float centred = 1. - smoothstep(.25, .75, length(axis));
            for (int g = 0; g < 2; g++) {
              vec2 at = source + axis * (1.35 + float(g) * .55);
              float gr = length((vUv - at) * vec2(uAspect, 1.));
              float ring = smoothstep(size * 1.8, size * 1.1, gr) * (.35 + .65 * smoothstep(size * .9, size * 1.5, gr));
              ghosts += ring * centred * (g == 0 ? .09 : .05);
            }
            flare += tint * core + tint * vec3(.5, .72, 1.) * streak + tint * vec3(.55, 1., .7) * ghosts;
          }
          color.rgb += flare * uFlareStrength;
          gl_FragColor = color;
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.material.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.material.uniforms.uAspect.value = width / Math.max(1, height);
  }

  render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    syncCamera(u as unknown as ReturnType<typeof depthUniforms>, this.camera, this.scenePass.depth);
    u.tDiffuse.value = read.texture;
    u.tAO.value = this.ao.enabled ? this.ao.target.texture : null;
    u.uAoStrength.value = this.ao.enabled ? this.aoStrength : 0;
    u.tVolume.value = this.volume.target.texture;
    u.uVolumeStrength.value = this.volume.enabled ? this.volumeStrength : 0;
    u.tHaze.value = this.haze.target.texture;
    u.uHazeStrength.value = this.haze.enabled ? 1 : 0;
    u.tFlareVisibility.value = this.flares.target.texture;
    u.uFlareCount.value = this.flares.enabled ? this.flares.count : 0;
    u.uFlareStrength.value = this.flareStrength;
    u.uAds.value = this.ads;
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    u.uPreviousViewProjection.value.copy(this.previousViewProjection);
    // Fixed 1/110 s shutter whatever the frame rate; the first frames have no history.
    u.uBlur.value = this.frames++ < 2 ? 0 : this.motionBlur * Math.min(2, (1 / 110) / Math.max(this.delta, 1e-3));
    renderer.setRenderTarget(this.renderToScreen ? null : write);
    this.quad.render(renderer);
    this.previousViewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
  }
}
