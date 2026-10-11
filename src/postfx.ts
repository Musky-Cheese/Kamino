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
        uDensity: { value: .055 },
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

// ------------------------------------------------------------------ composite

export class CompositePass extends Pass {
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  aoStrength = 1;
  volumeStrength = 1;
  ads = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly scenePass: ScenePass,
    private readonly ao: AmbientOcclusionPass,
    private readonly volume: VolumetricPass,
  ) {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...depthUniforms(),
        tDiffuse: { value: null },
        tAO: { value: null },
        tVolume: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uAoStrength: { value: 1 },
        uVolumeStrength: { value: 1 },
        uAds: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${DEPTH_HELPERS}
        uniform sampler2D tDiffuse, tAO, tVolume;
        uniform vec2 uTexel;
        uniform float uAoStrength, uVolumeStrength, uAds;
        varying vec2 vUv;
        void main() {
          float z = linearDepth(vUv);
          vec4 color = texture2D(tDiffuse, vUv);
          // Aim-down-sights: the rifle in front of your eye goes soft while the target stays sharp.
          if (uAds > .01 && z < 1.1) {
            vec3 sum = color.rgb;
            float weight = 1.;
            for (int i = 0; i < 12; i++) {
              float a = float(i) * 2.39996;
              vec2 offset = vec2(cos(a), sin(a)) * sqrt(float(i + 1) / 12.) * uTexel * 7. * uAds;
              sum += texture2D(tDiffuse, vUv + offset).rgb;
              weight += 1.;
            }
            color.rgb = sum / weight;
          }
          // Depth-aware upsample of the half-resolution AO.
          float ao = 0., aoWeight = 0.;
          for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
              vec2 uv = vUv + vec2(float(x), float(y)) * uTexel * 2.;
              float w = 1. / (1e-3 + abs(linearDepth(uv) - z) * 4.);
              ao += texture2D(tAO, uv).r * w;
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
          color.rgb += volume / 5. * uVolumeStrength;
          gl_FragColor = color;
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.material.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    syncCamera(u as unknown as ReturnType<typeof depthUniforms>, this.camera, this.scenePass.depth);
    u.tDiffuse.value = read.texture;
    u.tAO.value = this.ao.enabled ? this.ao.target.texture : null;
    u.uAoStrength.value = this.ao.enabled ? this.aoStrength : 0;
    u.tVolume.value = this.volume.target.texture;
    u.uVolumeStrength.value = this.volume.enabled ? this.volumeStrength : 0;
    u.uAds.value = this.ads;
    renderer.setRenderTarget(this.renderToScreen ? null : write);
    this.quad.render(renderer);
  }
}
