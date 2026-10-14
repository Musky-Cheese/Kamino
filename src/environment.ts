import * as THREE from "three";
import { OCEAN_LEVEL } from "./config";
import { rng, smokeTexture } from "./textures";

const NOISE_GLSL = /* glsl */ `
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3. - 2. * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return s; }
`;

const SKY_GLSL = /* glsl */ `
  ${NOISE_GLSL}
  uniform float uTime;
  uniform float uFlash;
  uniform vec3 uFlashDir;
  vec3 skyColor(vec3 d) {
    float h = max(d.y, 0.0);
    vec3 zenith = vec3(.008, .02, .032);
    vec3 horizon = vec3(.05, .105, .14);
    vec3 col = mix(horizon, zenith, pow(h, .42));
    vec2 uv = d.xz / max(d.y + .14, .06) * .8 + vec2(uTime * .01, uTime * .018);
    float c1 = fbm(uv * 1.15);
    float c2 = fbm(uv * 3.3 - vec2(uTime * .015, 0.));
    float cloud = smoothstep(.32, .82, c1 * .72 + c2 * .38);
    vec3 cloudCol = mix(vec3(.022, .045, .062), vec3(.085, .14, .18), c2);
    col = mix(col, cloudCol, cloud * smoothstep(-.04, .22, d.y));
    float focus = pow(max(dot(d, uFlashDir), 0.), 6.);
    col += uFlash * vec3(.5, .7, .95) * (cloud * .9 + .12) * (.25 + focus * 2.2);
    col = mix(col, vec3(.03, .06, .078), smoothstep(.02, -.18, d.y));
    return col;
  }
`;

export type FlashState = { strength: number; direction: THREE.Vector3 };

export class Environment {
  readonly flash: FlashState = { strength: 0, direction: new THREE.Vector3(0, .3, -1).normalize() };
  readonly skyUniforms = {
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uFlashDir: { value: this.flash.direction },
  };
  private readonly ocean: THREE.Mesh;
  private readonly oceanUniforms: Record<string, THREE.IUniform>;
  private readonly rain: THREE.Mesh;
  private readonly rainUniforms: Record<string, THREE.IUniform>;
  private readonly splashes: THREE.InstancedMesh;
  private readonly splashState: Array<{ phase: number; rate: number; x: number; z: number }> = [];
  private readonly splashMaterial: THREE.ShaderMaterial;
  private readonly fogBanks: Array<{ sprite: THREE.Sprite; speed: number; base: THREE.Vector3 }> = [];
  private readonly bolts: Array<{ mesh: THREE.Group; ttl: number }> = [];
  private readonly curtains: THREE.Mesh[] = [];
  private readonly random = rng(1337);
  private nextLightning = 4;
  onThunder?: (distance: number, strength: number) => void;

  constructor(private readonly scene: THREE.Scene, private readonly heightAt: (x: number, z: number) => number | null) {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        varying vec3 vDir;
        void main() { gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0); }`,
    }));
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.name = "sky";
    scene.add(sky);

    this.oceanUniforms = {
      ...this.skyUniforms,
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: .006 },
    };
    this.ocean = this.buildOcean();
    scene.add(this.ocean);

    this.rainUniforms = { uTime: { value: 0 }, uCamera: { value: new THREE.Vector3() }, uFlash: { value: 0 } };
    this.rain = this.buildRain();
    scene.add(this.rain);

    this.splashMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uFlash: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aPhase;
        varying float vPhase;
        varying vec2 vUv;
        void main() {
          vPhase = aPhase;
          vUv = uv;
          vec4 world = instanceMatrix * vec4(position * (.25 + aPhase * .9), 1.0);
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uFlash;
        varying float vPhase;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - .5) * 2.;
          float ring = smoothstep(.62, .82, r) * smoothstep(1., .86, r);
          float a = ring * (1. - vPhase) * .55;
          gl_FragColor = vec4(vec3(.72, .86, .95) * (1. + uFlash), a);
        }`,
    });
    const splashGeometry = new THREE.PlaneGeometry(.32, .32).rotateX(-Math.PI / 2);
    const count = 200;
    this.splashes = new THREE.InstancedMesh(splashGeometry, this.splashMaterial, count);
    this.splashes.geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
    this.splashes.frustumCulled = false;
    for (let i = 0; i < count; i++) this.splashState.push({ phase: this.random(), rate: 1.6 + this.random() * 1.4, x: 0, z: 0 });
    scene.add(this.splashes);

    this.buildFogBanks();
    this.buildRainCurtains();
  }

  get oceanMesh(): THREE.Mesh { return this.ocean; }

  /** Screen-space weather that must not appear in the deck reflection pass. */
  get reflectionHidden(): THREE.Object3D[] { return [this.rain, this.splashes, ...this.curtains]; }

  /** Pre-filtered environment for metal reflections, rendered from the storm sky plus distant city glows. */
  createEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
    const envScene = new THREE.Scene();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uTime: { value: 3 }, uFlash: { value: 0 }, uFlashDir: { value: this.flash.direction } },
      vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `${SKY_GLSL} varying vec3 vDir; void main() { gl_FragColor = vec4(skyColor(normalize(vDir)) * 2.2 + vec3(.012, .02, .026), 1.0); }`,
    }));
    envScene.add(sky);
    // Bands of distant warm and cool window light so wet metal catches highlights.
    const warm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.25, .8) });
    const cool = new THREE.MeshBasicMaterial({ color: new THREE.Color(.6, 1.1, 1.5) });
    for (let i = 0; i < 26; i++) {
      const angle = i / 26 * Math.PI * 2 + this.random() * .2;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(4 + this.random() * 9, .35 + this.random() * .5), i % 3 ? warm : cool);
      panel.position.set(Math.cos(angle) * 60, -2 + this.random() * 9, Math.sin(angle) * 60);
      panel.lookAt(0, panel.position.y, 0);
      envScene.add(panel);
    }
    const overhead = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(.12, .18, .22) }));
    overhead.position.y = 60;
    overhead.rotation.x = Math.PI / 2;
    envScene.add(overhead);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromScene(envScene, .02);
    pmrem.dispose();
    envScene.traverse((object) => {
      if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); }
    });
    return target.texture;
  }

  private buildOcean(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(2400, 2400, 220, 220).rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      uniforms: this.oceanUniforms,
      fog: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vCrest;
        vec3 gerstner(vec2 dir, float steep, float wavelength, vec3 p, inout vec3 tangent, inout vec3 binormal) {
          float k = 6.28318 / wavelength;
          float c = sqrt(9.8 / k);
          vec2 d = normalize(dir);
          float f = k * (dot(d, p.xz) - c * uTime);
          float a = steep / k;
          tangent += vec3(-d.x * d.x * steep * sin(f), d.x * steep * cos(f), -d.x * d.y * steep * sin(f));
          binormal += vec3(-d.x * d.y * steep * sin(f), d.y * steep * cos(f), -d.y * d.y * steep * sin(f));
          return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
        }
        void main() {
          vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 tangent = vec3(1, 0, 0), binormal = vec3(0, 0, 1);
          vec3 base = p;
          p += gerstner(vec2(1., .35), .22, 62., base, tangent, binormal);
          p += gerstner(vec2(.6, 1.), .2, 37., base, tangent, binormal);
          p += gerstner(vec2(-.4, .9), .16, 21., base, tangent, binormal);
          p += gerstner(vec2(.9, -.5), .12, 11., base, tangent, binormal);
          vCrest = p.y - base.y;
          vNormal = normalize(cross(binormal, tangent));
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vCrest;
        void main() {
          vec2 q = vWorld.xz * .09;
          float e = .35;
          float n0 = fbm(q + uTime * .25);
          float nx = fbm(q + vec2(e, 0.) + uTime * .25) - n0;
          float nz = fbm(q + vec2(0., e) + uTime * .25) - n0;
          vec3 normal = normalize(vNormal + vec3(-nx, 0., -nz) * 1.6);
          vec3 view = normalize(cameraPosition - vWorld);
          float fresnel = .02 + .98 * pow(1. - max(dot(normal, view), 0.), 5.);
          vec3 refl = skyColor(reflect(-view, normal));
          vec3 deep = vec3(.004, .018, .026);
          vec3 color = mix(deep, refl * .9, fresnel);
          float foam = smoothstep(2.6, 3.8, vCrest + fbm(vWorld.xz * .25 + uTime * .3) * 1.4) * fbm(vWorld.xz * .8 - uTime * .2);
          color = mix(color, vec3(.16, .2, .22) * (1. + uFlash * 1.5), foam * .7);
          float dist = length(cameraPosition - vWorld);
          float fog = 1. - exp(-pow(dist * uFogDensity, 2.));
          color = mix(color, uFogColor, clamp(fog, 0., 1.));
          gl_FragColor = vec4(color, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = OCEAN_LEVEL;
    mesh.frustumCulled = false;
    mesh.name = "ocean";
    return mesh;
  }

  private buildRain(): THREE.Mesh {
    const count = 4200;
    const base = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute("position", base.attributes.position);
    geometry.setAttribute("uv", base.attributes.uv);
    const offsets = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      offsets[i * 4] = this.random();
      offsets[i * 4 + 1] = this.random();
      offsets[i * 4 + 2] = this.random();
      offsets[i * 4 + 3] = this.random();
    }
    geometry.setAttribute("aOffset", new THREE.InstancedBufferAttribute(offsets, 4));
    geometry.instanceCount = count;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: this.rainUniforms,
      vertexShader: /* glsl */ `
        attribute vec4 aOffset;
        uniform float uTime;
        uniform vec3 uCamera;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          vec3 box = vec3(56., 34., 56.);
          float speed = 22. + aOffset.w * 8.;
          vec3 wind = vec3(-4.2, -speed, -1.6);
          vec3 p = aOffset.xyz * box + wind * uTime;
          vec3 rel = mod(p - uCamera, box) - box * .5;
          vec3 world = uCamera + rel;
          vec3 dir = normalize(wind);
          float len = .7 + aOffset.w * .9;
          vec3 toCam = normalize(cameraPosition - world);
          vec3 side = normalize(cross(dir, toCam)) * .018;
          world += dir * position.y * len + side * position.x * 2.;
          vUv = uv;
          float d = length(rel);
          vFade = smoothstep(27., 12., d) * smoothstep(1.2, 4., d);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uFlash;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          float across = 1. - abs(vUv.x - .5) * 2.;
          float along = smoothstep(0., .35, vUv.y) * smoothstep(1., .6, vUv.y);
          float a = across * along * vFade * .13;
          gl_FragColor = vec4(vec3(.58, .72, .82) * (1. + uFlash * 1.5), a);
        }`,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    return mesh;
  }

  /** Distant rain: scrolling streak curtains on cylinders around the camera, beyond the particle rain. */
  private buildRainCurtains(): void {
    for (const [radius, opacity, density] of [[34, .08, 220], [70, .055, 380], [130, .035, 640]] as const) {
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: this.rainUniforms.uTime, uFlash: this.rainUniforms.uFlash, uOpacity: { value: opacity }, uDensity: { value: density } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime, uFlash, uOpacity, uDensity;
          varying vec2 vUv;
          float hash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
          void main() {
            vec2 uv = vUv * vec2(uDensity, 5.);
            float column = floor(uv.x);
            float r = hash(column);
            float y = fract(uv.y + uTime * (1.6 + r * 1.2) + r * 17.);
            float streak = smoothstep(0., .04, y) * smoothstep(.3, .06, y);
            float across = smoothstep(.12, 0., abs(fract(uv.x) - .5));
            float keep = step(.62, hash(column + 7.31));
            float fade = smoothstep(0., .25, vUv.y) * smoothstep(1., .6, vUv.y);
            float a = streak * across * keep * fade * uOpacity;
            gl_FragColor = vec4(vec3(.58, .72, .82) * (1. + uFlash * 1.8), a);
          }`,
      });
      const curtain = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 70, 48, 1, true), material);
      curtain.frustumCulled = false;
      curtain.renderOrder = 4;
      this.curtains.push(curtain);
      this.scene.add(curtain);
    }
  }

  private buildFogBanks(): void {
    const texture = smokeTexture(99);
    for (let i = 0; i < 46; i++) {
      const low = i < 28;
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: low ? 0x2a4352 : 0x3c5868,
        transparent: true,
        opacity: low ? .38 : .14,
        depthWrite: false,
        fog: true,
      });
      const sprite = new THREE.Sprite(material);
      const angle = this.random() * Math.PI * 2;
      const radius = low ? 30 + this.random() * 220 : 60 + this.random() * 200;
      const base = new THREE.Vector3(Math.cos(angle) * radius, low ? -16 - this.random() * 14 : -2 + this.random() * 10, Math.sin(angle) * radius - 10);
      sprite.position.copy(base);
      const s = low ? 60 + this.random() * 70 : 40 + this.random() * 50;
      sprite.scale.set(s, s * .35, 1);
      material.rotation = this.random() * Math.PI;
      this.scene.add(sprite);
      this.fogBanks.push({ sprite, speed: .6 + this.random() * 1.2, base });
    }
  }

  private strike(camera: THREE.Vector3): void {
    const angle = this.random() * Math.PI * 2;
    const distance = 220 + this.random() * 380;
    const ground = new THREE.Vector3(camera.x + Math.cos(angle) * distance, OCEAN_LEVEL, camera.z + Math.sin(angle) * distance);
    const top = ground.clone().add(new THREE.Vector3((this.random() - .5) * 80, 260, (this.random() - .5) * 80));
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.5, 4, 5), fog: false, transparent: true });
    const branch = (from: THREE.Vector3, to: THREE.Vector3, radius: number, depth: number) => {
      const points: THREE.Vector3[] = [];
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const p = from.clone().lerp(to, i / steps);
        if (i > 0 && i < steps) p.add(new THREE.Vector3((this.random() - .5) * 22, (this.random() - .5) * 8, (this.random() - .5) * 22));
        points.push(p);
      }
      const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", .1);
      group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 4, false), material));
      if (depth > 0) {
        for (let i = 0; i < 2; i++) {
          const start = points[3 + Math.floor(this.random() * 8)];
          const end = start.clone().add(new THREE.Vector3((this.random() - .5) * 90, -40 - this.random() * 70, (this.random() - .5) * 90));
          branch(start, end, radius * .5, depth - 1);
        }
      }
    };
    branch(top, ground, .9, 2);
    this.scene.add(group);
    this.bolts.push({ mesh: group, ttl: .32 });
    this.flash.direction.copy(top).sub(camera).normalize();
    this.flash.strength = 1;
    this.onThunder?.(distance, 1);
  }

  /** Big ambient flash without a visible bolt (cloud-to-cloud). */
  private sheetLightning(camera: THREE.Vector3): void {
    const angle = this.random() * Math.PI * 2;
    this.flash.direction.set(Math.cos(angle), .35 + this.random() * .3, Math.sin(angle)).normalize();
    this.flash.strength = .55 + this.random() * .3;
    this.onThunder?.(500 + this.random() * 600, .6);
    void camera;
  }

  update(delta: number, time: number, camera: THREE.Camera, fog: THREE.FogExp2): void {
    this.nextLightning -= delta;
    if (this.nextLightning <= 0) {
      if (this.random() < .45) this.strike(camera.position);
      else this.sheetLightning(camera.position);
      this.nextLightning = 5 + this.random() * 11;
    }
    // Lightning flickers: a few re-strikes as it decays.
    const decay = this.flash.strength * Math.exp(-delta * 7);
    this.flash.strength = decay < .02 ? 0 : decay;
    const flicker = this.flash.strength > .05 ? this.flash.strength * (.6 + .4 * Math.sin(time * 70)) : 0;

    this.skyUniforms.uTime.value = time;
    this.skyUniforms.uFlash.value = flicker;
    this.oceanUniforms.uFogColor.value.copy(fog.color);
    this.oceanUniforms.uFogDensity.value = fog.density * .55;
    this.rainUniforms.uTime.value = time;
    this.rainUniforms.uCamera.value.copy(camera.position);
    this.rainUniforms.uFlash.value = flicker;
    this.splashMaterial.uniforms.uFlash.value = flicker;
    for (const curtain of this.curtains) curtain.position.set(camera.position.x, camera.position.y + 10, camera.position.z);
    this.ocean.position.x = Math.round(camera.position.x / 10) * 10;
    this.ocean.position.z = Math.round(camera.position.z / 10) * 10;

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i];
      bolt.ttl -= delta;
      bolt.mesh.visible = Math.sin(time * 90) > -.3;
      if (bolt.ttl <= 0) {
        this.scene.remove(bolt.mesh);
        bolt.mesh.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
        this.bolts.splice(i, 1);
      }
    }

    const phases = this.splashes.geometry.getAttribute("aPhase") as THREE.InstancedBufferAttribute;
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < this.splashState.length; i++) {
      const state = this.splashState[i];
      state.phase += delta * state.rate;
      if (state.phase >= 1 || (state.x === 0 && state.z === 0)) {
        state.phase %= 1;
        const angle = this.random() * Math.PI * 2;
        const radius = Math.sqrt(this.random()) * 16;
        state.x = camera.position.x + Math.cos(angle) * radius;
        state.z = camera.position.z + Math.sin(angle) * radius;
        const y = this.heightAt(state.x, state.z);
        matrix.makeTranslation(state.x, y === null ? -9999 : y + .02, state.z);
        this.splashes.setMatrixAt(i, matrix);
      }
      phases.setX(i, state.phase);
    }
    phases.needsUpdate = true;
    this.splashes.instanceMatrix.needsUpdate = true;

    for (const bank of this.fogBanks) {
      bank.sprite.position.x = bank.base.x + Math.sin(time * .02 * bank.speed + bank.base.z) * 25;
      bank.sprite.position.z = bank.base.z + Math.cos(time * .015 * bank.speed + bank.base.x) * 12;
    }
  }
}
