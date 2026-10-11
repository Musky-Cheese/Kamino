import * as THREE from "three";

/**
 * Wet-deck planar reflections. The scene is rendered once more from a camera mirrored about the
 * y = 0 deck plane into a low-resolution, mip-mapped target; patched deck materials then blend that
 * image in by wetness (inverse roughness) and Fresnel, blurred by roughness through the mip chain.
 */
export class WetReflections {
  readonly target: THREE.WebGLRenderTarget;
  readonly uniforms = {
    tReflect: { value: null as THREE.Texture | null },
    uReflectMatrix: { value: new THREE.Matrix4() },
    uReflectStrength: { value: 1 },
  };
  scale = .5;
  enabled = true;
  private readonly virtualCamera = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly clipPlane = new THREE.Vector4();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly bias = new THREE.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.uniforms.tReflect.value = this.target.texture;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.floor(width * this.scale)), Math.max(1, Math.floor(height * this.scale)));
  }

  /** Inject the reflection into a MeshStandardMaterial lying on the y = 0 plane. */
  patch(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform mat4 uReflectMatrix;\nvarying vec4 vReflectCoord;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvReflectCoord = uReflectMatrix * modelMatrix * vec4(transformed, 1.0);");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D tReflect;\nuniform float uReflectStrength;\nvarying vec4 vReflectCoord;")
        .replace("#include <opaque_fragment>", /* glsl */ `
          {
            vec2 ruv = vReflectCoord.xy / vReflectCoord.w;
            ruv += normal.xy * .045;
            float wet = clamp(1.25 - roughnessFactor * 1.9, 0., 1.);
            vec3 viewDir = normalize(vViewPosition);
            float facing = clamp(abs(dot(normal, viewDir)), 0., 1.);
            float f = 1. - facing;
            float fresnel = .03 + .97 * f * f * f * f;
            vec3 reflected = textureLod(tReflect, ruv, roughnessFactor * 6.).rgb;
            outgoingLight += min(reflected, vec3(12.)) * fresnel * wet * uReflectStrength * 2.2;
          }
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => "wet-reflection";
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hidden: THREE.Object3D[]): void {
    if (!this.enabled || camera.position.y < .05) {
      this.uniforms.uReflectStrength.value = 0;
      return;
    }
    const virtual = this.virtualCamera;
    const cameraPosition = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const rotation = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const view = cameraPosition.clone().negate().reflect(this.normal).negate();
    const lookAt = new THREE.Vector3(0, 0, -1).applyMatrix4(rotation).add(cameraPosition);
    const target = lookAt.clone().negate().reflect(this.normal).negate();
    virtual.position.copy(view);
    virtual.up.set(0, 1, 0).applyMatrix4(rotation).reflect(this.normal);
    virtual.lookAt(target);
    virtual.far = camera.far;
    virtual.near = camera.near;
    virtual.updateMatrixWorld();
    virtual.projectionMatrix.copy(camera.projectionMatrix);

    this.uniforms.uReflectMatrix.value.copy(this.bias).multiply(virtual.projectionMatrix).multiply(virtual.matrixWorldInverse);

    // Oblique near plane clips everything below the deck.
    this.plane.setFromNormalAndCoplanarPoint(this.normal, new THREE.Vector3(0, -.02, 0));
    this.plane.applyMatrix4(virtual.matrixWorldInverse);
    this.clipPlane.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = virtual.projectionMatrix.elements;
    const q = new THREE.Vector4(
      (Math.sign(this.clipPlane.x) + p[8]) / p[0],
      (Math.sign(this.clipPlane.y) + p[9]) / p[5],
      -1,
      (1 + p[10]) / p[14],
    );
    this.clipPlane.multiplyScalar(2 / this.clipPlane.dot(q));
    p[2] = this.clipPlane.x;
    p[6] = this.clipPlane.y;
    p[10] = this.clipPlane.z + 1;
    p[14] = this.clipPlane.w;

    const visibility = hidden.map((object) => object.visible);
    hidden.forEach((object) => object.visible = false);
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const previousTarget = renderer.getRenderTarget();
    const strength = this.uniforms.uReflectStrength.value;
    this.uniforms.uReflectStrength.value = 0;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, virtual);
    renderer.setRenderTarget(previousTarget);
    this.uniforms.uReflectStrength.value = strength || 1;
    renderer.shadowMap.autoUpdate = shadowAuto;
    hidden.forEach((object, i) => object.visible = visibility[i]);
  }
}
