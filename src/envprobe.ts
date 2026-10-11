import * as THREE from "three";

/**
 * Dynamic image-based lighting. Every `interval` seconds the city around the player is captured into a
 * small cube map — one face per frame so there's no hitch — then pre-filtered with PMREM and used as
 * the scene environment, so armour, glass and droid metal reflect the actual nearby lights.
 */
export class EnvironmentProbe {
  interval = 1.5;
  private readonly cubeTarget = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
  private readonly cube = new THREE.CubeCamera(.5, 450, this.cubeTarget);
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private face = -1;
  private timer = .5;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();
    this.cube.coordinateSystem = renderer.coordinateSystem;
    this.cube.updateCoordinateSystem();
  }

  /** `prepare` hides camera-attached and screen-space objects; `restore` undoes it. */
  update(delta: number, position: THREE.Vector3, prepare: () => void, restore: () => void): void {
    if (!Number.isFinite(this.interval)) return;
    if (this.face < 0) {
      this.timer -= delta;
      if (this.timer > 0) return;
      this.cube.position.copy(position).add(new THREE.Vector3(0, .6, 0));
      this.cube.updateMatrixWorld(true);
      this.face = 0;
    }
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousFace = renderer.getActiveCubeFace();
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    prepare();
    if (this.face < 6) {
      renderer.setRenderTarget(this.cubeTarget, this.face);
      renderer.clear();
      renderer.render(this.scene, this.cube.children[this.face] as THREE.Camera);
      this.face++;
    } else {
      this.envTarget = this.pmrem.fromCubemap(this.cubeTarget.texture, this.envTarget);
      this.scene.environment = this.envTarget.texture;
      this.face = -1;
      this.timer = this.interval;
    }
    restore();
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.setRenderTarget(previousTarget, previousFace);
  }
}
