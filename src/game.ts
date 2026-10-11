import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

const PLAYER_HEIGHT = 1.72;
const MAGAZINE_SIZE = 20;

type Enemy = {
  id: number;
  group: THREE.Group;
  hitMeshes: THREE.Mesh[];
  arms: THREE.Group[];
  hp: number;
  alive: boolean;
  shotTimer: number;
  walkPhase: number;
};

type Ally = {
  group: THREE.Group;
  arms: THREE.Group[];
  shotTimer: number;
  walkPhase: number;
};

type Tracer = { line: THREE.Line; ttl: number };
type Spark = { mesh: THREE.Mesh; velocity: THREE.Vector3; ttl: number };

export class KaminoGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 180);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  private readonly controls: PointerLockControls;
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly keys = new Set<string>();
  private readonly blockers: THREE.Box2[] = [];
  private readonly shootSurfaces: THREE.Object3D[] = [];
  private readonly enemies: Enemy[] = [];
  private readonly allies: Ally[] = [];
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];
  private readonly rain: THREE.Points;
  private readonly weapon = new THREE.Group();
  private readonly muzzleLight = new THREE.PointLight(0x61cfff, 0, 4);
  private started = false;
  private ended = false;
  private firing = false;
  private moving = false;
  private health = 100;
  private ammo = MAGAZINE_SIZE;
  private reloading = false;
  private nextShot = 0;
  private messageTimer = 0;
  private weaponKick = 0;
  private lightningTimer = 2 + Math.random() * 5;
  private lightningStrength = 0;
  private wave = 1;
  private readonly maxWaves = 3;
  private waveTransition = false;
  private nextEnemyId = 0;
  private bobTime = 0;
  private audio?: AudioContext;
  private readonly stormLight = new THREE.DirectionalLight(0xb9e7ff, 1.2);

  private readonly menu = document.querySelector<HTMLElement>("#menu")!;
  private readonly hud = document.querySelector<HTMLElement>("#hud")!;
  private readonly result = document.querySelector<HTMLElement>("#result")!;
  private readonly enemyCount = document.querySelector<HTMLElement>("#enemies")!;
  private readonly waveText = document.querySelector<HTMLElement>("#wave")!;
  private readonly healthText = document.querySelector<HTMLElement>("#health")!;
  private readonly healthBar = document.querySelector<HTMLElement>("#health-bar")!;
  private readonly ammoText = document.querySelector<HTMLElement>("#ammo")!;
  private readonly hitMarker = document.querySelector<HTMLElement>("#hit-marker")!;
  private readonly message = document.querySelector<HTMLElement>("#mission-message")!;
  private readonly damageFlash = document.querySelector<HTMLElement>("#damage-flash")!;

  constructor(private readonly root: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.root.prepend(this.renderer.domElement);
    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);
    this.rain = this.createRain();
  }

  initialize(): void {
    this.scene.background = new THREE.Color(0x07131d);
    this.scene.fog = new THREE.FogExp2(0x0a1d28, 0.023);
    this.camera.position.set(0, PLAYER_HEIGHT, 25);
    this.camera.rotation.order = "YXZ";
    this.buildLighting();
    this.buildWorld();
    this.buildWeapon();
    this.spawnAllies();
    this.spawnWave();
    this.bindEvents();
    this.updateHud();
    this.renderer.setAnimationLoop(() => this.animate());
  }

  private buildLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0x9bd8ed, 0x071015, 1.7));
    this.stormLight.position.set(-18, 28, 14);
    this.stormLight.castShadow = true;
    this.stormLight.shadow.mapSize.set(1024, 1024);
    this.stormLight.shadow.camera.left = -32;
    this.stormLight.shadow.camera.right = 32;
    this.stormLight.shadow.camera.top = 32;
    this.stormLight.shadow.camera.bottom = -32;
    this.scene.add(this.stormLight);
  }

  private buildWorld(): void {
    const metal = new THREE.MeshStandardMaterial({ color: 0x66818e, metalness: 0.72, roughness: 0.36 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x263c47, metalness: 0.8, roughness: 0.3 });
    const floor = new THREE.MeshStandardMaterial({ color: 0x566e78, metalness: 0.62, roughness: 0.44 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x70c8ea, transparent: true, opacity: 0.18, metalness: 0.45, roughness: 0.1 });
    const glow = new THREE.MeshBasicMaterial({ color: 0x67dcff });

    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 260, 40, 40),
      new THREE.MeshStandardMaterial({ color: 0x04131e, metalness: 0.1, roughness: 0.22 }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = -3.3;
    this.scene.add(ocean);

    this.addBox(0, -0.35, -1, 31, 0.7, 26, floor);
    // Exterior rails and platform ribs.
    this.addBox(0, 0.48, -13.8, 31, 1.05, 0.2, metal);
    this.addBox(0, 0.48, 11.9, 31, 1.05, 0.2, metal);
    this.addBox(-15.35, 0.48, -1, 0.2, 1.05, 26, metal);
    this.addBox(15.35, 0.48, -1, 0.2, 1.05, 26, metal);
    for (let x = -14; x <= 14; x += 2) {
      this.addBox(x, 0.02, -1, 0.08, 0.08, 25, darkMetal);
    }

    this.buildStartingArea(metal, darkMetal, floor, glass, glow);

    // Radial courtyard forms inspired by Tipoca City's layered landing plazas.
    const courtyard = new THREE.Group();
    const centralPad = new THREE.Mesh(new THREE.CylinderGeometry(5.3, 5.75, .32, 24), metal);
    centralPad.position.set(0, .02, -2.5);
    centralPad.receiveShadow = true;
    courtyard.add(centralPad);
    const centralRing = new THREE.Mesh(new THREE.TorusGeometry(4.45, .11, 8, 40), glow);
    centralRing.rotation.x = Math.PI / 2;
    centralRing.position.set(0, .22, -2.5);
    courtyard.add(centralRing);
    for (let i = 0; i < 12; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(.08, .04, 4.1), darkMetal);
      spoke.position.set(0, .21, -2.5);
      spoke.rotation.y = i * Math.PI / 6;
      courtyard.add(spoke);
    }
    this.scene.add(courtyard);
    this.shootSurfaces.push(centralPad);

    const buildTower = (x: number, z: number, scale: number) => {
      const tower = new THREE.Group();
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.2 * scale, 2.55 * scale, .65, 18), metal);
      plinth.position.y = .18;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(.75 * scale, 1.05 * scale, 2.5 * scale, 12), darkMetal);
      base.position.y = 1.6 * scale;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.05 * scale, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), metal);
      cap.position.y = 2.9 * scale;
      const spire = new THREE.Mesh(new THREE.ConeGeometry(.22 * scale, 3.8 * scale, 10), metal);
      spire.position.y = 4.85 * scale;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(.11 * scale, 8, 6), glow);
      lamp.position.y = 6.75 * scale;
      tower.add(plinth, base, cap, spire, lamp);
      tower.position.set(x, 0, z);
      this.scene.add(tower);
      this.shootSurfaces.push(plinth, base, cap, spire);
      this.blockers.push(new THREE.Box2(
        new THREE.Vector2(x - 1.15 * scale, z - 1.15 * scale),
        new THREE.Vector2(x + 1.15 * scale, z + 1.15 * scale),
      ));
    };
    buildTower(-10.5, 6.8, .85);
    buildTower(10.7, -6.2, .9);

    const sidePads: Array<[number, number, number]> = [[-9.4, -7.5, 2.8], [9.3, 6.6, 2.5]];
    sidePads.forEach(([x, z, radius]) => {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + .35, .28, 20), metal);
      pad.position.set(x, .01, z);
      pad.receiveShadow = true;
      const ringLight = new THREE.Mesh(new THREE.TorusGeometry(radius * .73, .07, 6, 32), glow);
      ringLight.rotation.x = Math.PI / 2;
      ringLight.position.set(x, .2, z);
      this.scene.add(pad, ringLight);
      this.shootSurfaces.push(pad);
    });

    // Kaminoan cover and equipment.
    const cover: Array<[number, number, number, number, number]> = [
      [-7.3, -2.2, 2.8, 1.5, 1.25], [7.2, 2.2, 2.4, 1.4, 1.15],
      [-5.8, 8.2, 2.2, 1.2, 1], [6.3, -9.2, 3, 1.4, 1.3], [0, 6.8, 2.4, 1.2, 1.1],
    ];
    cover.forEach(([x, z, w, d, h]) => {
      this.addBox(x, h / 2, z, w, h, d, darkMetal);
      this.addBox(x, h + 0.05, z, w * 0.75, 0.08, d * 0.7, glow, false);
      this.blockers.push(new THREE.Box2(new THREE.Vector2(x - w / 2 - .32, z - d / 2 - .32), new THREE.Vector2(x + w / 2 + .32, z + d / 2 + .32)));
    });

    // Landing beacon and distant Tipoca silhouettes.
    const beacon = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.14, .22, 6, 8), darkMetal);
    mast.position.y = 3;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, .08, 8, 32), glow);
    ring.position.y = 5.3;
    ring.rotation.x = Math.PI / 2;
    beacon.add(mast, ring);
    beacon.position.set(-12, 0, -10);
    this.scene.add(beacon);
    this.shootSurfaces.push(mast);

    for (const [x, z, s] of [[-38, -45, 1.2], [34, -52, .9], [3, -68, 1.5]] as const) {
      const tower = new THREE.Group();
      const column = new THREE.Mesh(new THREE.CylinderGeometry(1.3 * s, 2.2 * s, 19 * s, 10), darkMetal);
      column.position.y = 5 * s;
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(7 * s, 5.5 * s, 2.1 * s, 16), metal);
      disc.position.y = 13 * s;
      tower.add(column, disc);
      tower.position.set(x, -3, z);
      this.scene.add(tower);
    }

    this.scene.add(this.rain);
  }

  private buildStartingArea(
    metal: THREE.MeshStandardMaterial,
    darkMetal: THREE.MeshStandardMaterial,
    floor: THREE.MeshStandardMaterial,
    glass: THREE.MeshStandardMaterial,
    glow: THREE.MeshBasicMaterial,
  ): void {
    const whiteShell = new THREE.MeshStandardMaterial({ color: 0xaabcc3, metalness: .58, roughness: .3 });
    const inset = new THREE.MeshStandardMaterial({ color: 0x101e27, metalness: .82, roughness: .28 });
    const warning = new THREE.MeshBasicMaterial({ color: 0xffa34b });
    const screen = new THREE.MeshBasicMaterial({ color: 0x7ce8ff });
    const deepGlass = glass.clone();
    deepGlass.color.setHex(0x2d8cab);
    deepGlass.opacity = .26;

    // The spawn corridor shell and its long storm-facing windows.
    this.addBox(0, -.3, 21, 7.4, .6, 18.5, floor);
    this.addBox(-3.75, 2.1, 21, .38, 4.8, 18.5, metal);
    this.addBox(3.75, 2.1, 21, .38, 4.8, 18.5, metal);
    this.addBox(0, 4.35, 21, 7.5, .3, 18.5, darkMetal);
    this.addBox(-3.53, 2.28, 21, .05, 2.45, 15.5, deepGlass, false);
    this.addBox(3.53, 2.28, 21, .05, 2.45, 15.5, deepGlass, false);

    // Repeating ribs give the opening view depth and a recognisable Kaminoan silhouette.
    for (let z = 13.2; z <= 29.1; z += 2.65) {
      this.addBox(-3.43, 2.35, z, .24, 4.2, .22, whiteShell);
      this.addBox(3.43, 2.35, z, .24, 4.2, .22, whiteShell);
      this.addBox(0, 4.08, z, 6.65, .12, .2, glow, false);

      const leftShoulder = this.addBox(-2.91, 3.67, z, .18, 1.55, .23, whiteShell);
      leftShoulder.rotation.z = -.72;
      const rightShoulder = this.addBox(2.91, 3.67, z, .18, 1.55, .23, whiteShell);
      rightShoulder.rotation.z = .72;
    }

    // Layered deck plates, illuminated seams, and a central path pull the player forward.
    for (let z = 13.5; z <= 29; z += 2.25) {
      this.addBox(0, .035, z, 5.7, .05, 1.82, inset);
      this.addBox(-2.98, .08, z, .07, .045, 1.72, glow, false);
      this.addBox(2.98, .08, z, .07, .045, 1.72, glow, false);
    }
    this.addBox(0, .075, 21.1, .055, .05, 16.7, glow, false);
    for (let z = 14.1; z <= 28.2; z += 2.25) {
      this.addBox(-1.15, .08, z, .5, .055, .055, whiteShell, false);
      this.addBox(1.15, .08, z, .5, .055, .055, whiteShell, false);
    }

    // Window mullions and lower service panels add close-range parallax at spawn.
    for (const side of [-1, 1]) {
      const x = side * 3.49;
      this.addBox(x, .72, 21, .12, 1.15, 16.4, inset);
      this.addBox(x, 3.58, 21, .12, .4, 16.4, darkMetal);
      for (let z = 14.1; z <= 28.2; z += 2.65) {
        this.addBox(x, 2.28, z, .14, 2.5, .1, metal);
      }
    }

    // A segmented pressure door closes the dead space behind the player.
    this.addBox(0, 2.1, 30.15, 7.2, 4.5, .42, darkMetal);
    this.addBox(0, 2.12, 29.91, 6.25, 3.75, .08, whiteShell);
    this.addBox(0, 2.12, 29.84, .2, 3.55, .08, inset);
    for (const x of [-2.75, -1.4, 1.4, 2.75]) this.addBox(x, 2.12, 29.82, .1, 3.45, .08, inset);
    this.addBox(0, .52, 29.76, 5.9, .09, .09, warning, false);
    this.addBox(0, 3.72, 29.76, 5.9, .08, .09, glow, false);

    // A compact tactical console beside the spawn point makes the space feel occupied.
    const consoleGroup = new THREE.Group();
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(.78, 1.02, .58), inset);
    pedestal.position.y = .51;
    const consoleTop = new THREE.Mesh(new THREE.BoxGeometry(1.02, .13, .72), whiteShell);
    consoleTop.position.set(0, 1.08, -.06);
    consoleTop.rotation.x = -.18;
    const display = new THREE.Mesh(new THREE.PlaneGeometry(.68, .34), screen);
    display.position.set(0, 1.18, -.425);
    display.rotation.x = -.18;
    const scanLine = new THREE.Mesh(new THREE.BoxGeometry(.48, .025, .015), glow);
    scanLine.position.set(0, 1.19, -.438);
    consoleGroup.add(pedestal, consoleTop, display, scanLine);
    consoleGroup.position.set(2.66, 0, 25.2);
    consoleGroup.rotation.y = -.15;
    this.scene.add(consoleGroup);
    this.shootSurfaces.push(pedestal, consoleTop);
    this.blockers.push(new THREE.Box2(new THREE.Vector2(2.05, 24.62), new THREE.Vector2(3.22, 25.78)));

    // The threshold frames the courtyard reveal and changes from cool interior light to storm light.
    this.addBox(-2.78, 2.2, 12, 1.4, 4.5, .65, darkMetal);
    this.addBox(2.78, 2.2, 12, 1.4, 4.5, .65, darkMetal);
    this.addBox(-1.98, 3.42, 12, .3, 2.55, .72, whiteShell).rotation.z = -.58;
    this.addBox(1.98, 3.42, 12, .3, 2.55, .72, whiteShell).rotation.z = .58;
    this.addBox(0, 4.16, 12, 3.6, .24, .72, whiteShell);
    this.addBox(0, 3.93, 11.62, 3.25, .07, .09, warning, false);
    this.addBox(0, .1, 11.72, 5.2, .08, .16, warning, false);

    // Pools of cool light keep the starting area legible without flattening the storm beyond it.
    for (const z of [16, 22, 27.6]) {
      const light = new THREE.PointLight(0x78dcff, 2.6, 8.5, 2);
      light.position.set(0, 3.72, z);
      this.scene.add(light);
    }
    const doorLight = new THREE.PointLight(0xff9b48, 1.7, 5.2, 2);
    doorLight.position.set(0, 1.2, 28.9);
    this.scene.add(doorLight);
  }

  private addBox(x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material, solid = true): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = solid;
    mesh.receiveShadow = solid;
    this.scene.add(mesh);
    this.shootSurfaces.push(mesh);
    return mesh;
  }

  private createRain(): THREE.Points {
    const count = 2600;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - .5) * 90;
      positions[i * 3 + 1] = Math.random() * 35;
      positions[i * 3 + 2] = (Math.random() - .5) * 95;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xa8e4ff, size: .045, transparent: true, opacity: .55 }));
  }

  private buildWeapon(): void {
    const black = new THREE.MeshStandardMaterial({ color: 0x0d151b, metalness: .9, roughness: .22 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x354956, metalness: .9, roughness: .2 });
    const blue = new THREE.MeshBasicMaterial({ color: 0x56cfff });
    const body = new THREE.Mesh(new THREE.BoxGeometry(.16, .17, .72), black);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, .58, 10), steel);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, .025, -.58);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(.14, .13, .28), steel);
    stock.position.set(0, -.02, .4);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(.055, .07, .19), blue);
    sight.position.set(0, .13, -.08);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(.1, .3, .13), black);
    grip.position.set(0, -.2, .15);
    grip.rotation.x = -.22;
    this.muzzleLight.position.set(0, .02, -.9);
    this.weapon.add(body, barrel, stock, sight, grip, this.muzzleLight);
    this.weapon.position.set(.38, -.33, -.7);
    this.weapon.rotation.set(-.08, -.09, 0);
    this.camera.add(this.weapon);
    this.scene.add(this.camera);
  }

  private spawnWave(): void {
    const spawnPoints: Array<[number, number]> = [
      [-5.8, -9.3], [5.2, -7.2], [-12.2, -1.5], [11.8, 8.8], [1.2, -9.8],
      [-9.4, -10.2], [10.5, 1.4], [-12, 9.6], [7.5, -11.4],
    ];
    const count = 3 + this.wave;
    const offset = (this.wave * 2) % spawnPoints.length;
    for (let index = 0; index < count; index++) {
      const [x, z] = spawnPoints[(index + offset) % spawnPoints.length];
      const id = this.nextEnemyId++;
      const enemy = this.createDroid(id);
      enemy.group.position.set(x, 0, z);
      enemy.group.rotation.y = Math.random() * Math.PI * 2;
      enemy.shotTimer = .8 + Math.random() * 2;
      this.enemies.push(enemy);
      this.scene.add(enemy.group);
      this.shootSurfaces.push(...enemy.hitMeshes);
    }
    this.waveTransition = false;
    this.updateHud();
  }

  private spawnAllies(): void {
    [[-1.65, 9.3], [1.65, 9.6]].forEach(([x, z], index) => {
      const ally = this.createClone(index);
      ally.group.position.set(x, 0, z);
      this.allies.push(ally);
      this.scene.add(ally.group);
    });
  }

  private createClone(index: number): Ally {
    const group = new THREE.Group();
    const armor = new THREE.MeshStandardMaterial({ color: 0xdce6e8, metalness: .34, roughness: .36 });
    const blue = new THREE.MeshStandardMaterial({ color: index ? 0x347ba4 : 0x285f94, metalness: .48, roughness: .32 });
    const black = new THREE.MeshStandardMaterial({ color: 0x101820, metalness: .7, roughness: .35 });
    const arms: THREE.Group[] = [];
    const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    part(new THREE.BoxGeometry(.52, .7, .3), armor, 0, 1.35, 0);
    part(new THREE.BoxGeometry(.38, .08, .32), blue, 0, 1.5, -.02);
    const helmet = part(new THREE.SphereGeometry(.27, 10, 7), armor, 0, 1.93, 0);
    helmet.scale.set(1, 1.08, .9);
    part(new THREE.BoxGeometry(.25, .08, .03), black, 0, 1.98, -.24);
    part(new THREE.BoxGeometry(.08, .2, .04), blue, 0, 1.82, -.24);
    [-.17, .17].forEach((x) => {
      part(new THREE.CylinderGeometry(.075, .085, .82, 8), armor, x, .56, 0);
      part(new THREE.BoxGeometry(.19, .1, .32), black, x, .09, -.07);
    });
    [-1, 1].forEach((side) => {
      const arm = new THREE.Group();
      arm.position.set(side * .38, 1.57, 0);
      const limb = part(new THREE.CylinderGeometry(.065, .08, .66, 8), armor, 0, -.28, 0, arm);
      limb.rotation.z = side * .14;
      group.add(arm);
      arms.push(arm);
    });
    const rifle = part(new THREE.BoxGeometry(.1, .1, .78), black, .24, 1.28, -.34);
    rifle.rotation.x = -.2;
    return { group, arms, shotTimer: .4 + index * .5, walkPhase: index * Math.PI };
  }

  private createDroid(id: number): Enemy {
    const group = new THREE.Group();
    const tan = new THREE.MeshStandardMaterial({ color: 0xb39a70, metalness: .55, roughness: .5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x403c34, metalness: .8, roughness: .38 });
    const red = new THREE.MeshBasicMaterial({ color: 0xff3325 });
    const hitMeshes: THREE.Mesh[] = [];
    const arms: THREE.Group[] = [];

    const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.userData.enemyId = id;
      parent.add(mesh);
      hitMeshes.push(mesh);
      return mesh;
    };
    part(new THREE.BoxGeometry(.38, .58, .25), tan, 0, 1.42, 0);
    part(new THREE.BoxGeometry(.27, .3, .32), tan, 0, 1.94, -.02).rotation.x = -.12;
    part(new THREE.BoxGeometry(.18, .06, .04), red, 0, 1.98, -.18);
    part(new THREE.CylinderGeometry(.09, .12, .38, 8), dark, 0, 1.05, 0);
    [-.15, .15].forEach((x) => {
      const leg = part(new THREE.CylinderGeometry(.055, .075, .88, 7), tan, x, .55, 0);
      leg.rotation.z = x < 0 ? -.06 : .06;
      part(new THREE.BoxGeometry(.18, .09, .34), dark, x, .08, -.08);
    });
    [-1, 1].forEach((side) => {
      const arm = new THREE.Group();
      arm.position.set(side * .31, 1.62, 0);
      const limb = part(new THREE.CylinderGeometry(.05, .065, .72, 7), tan, 0, -.28, 0, arm);
      limb.rotation.z = side * .18;
      group.add(arm);
      arms.push(arm);
    });
    const rifle = part(new THREE.BoxGeometry(.09, .09, .78), dark, .23, 1.22, -.32);
    rifle.rotation.x = -.2;
    group.scale.setScalar(1.05);
    return { id, group, hitMeshes, arms, hp: 100, alive: true, shotTimer: 1, walkPhase: Math.random() * Math.PI * 2 };
  }

  private bindEvents(): void {
    document.querySelector<HTMLButtonElement>("#start")!.addEventListener("click", () => {
      this.initializeAudio();
      this.started = true;
      this.controls.lock();
    });
    document.querySelector<HTMLButtonElement>("#restart")!.addEventListener("click", () => location.reload());
    this.controls.addEventListener("lock", () => {
      if (this.ended) return;
      this.menu.classList.add("hidden");
      this.hud.classList.remove("hidden");
      this.showMessage("Rain courtyard · eliminate all hostiles", 2.2);
    });
    this.controls.addEventListener("unlock", () => {
      if (this.started && !this.ended) {
        this.menu.querySelector(".eyebrow")!.textContent = "Mission paused";
        this.menu.querySelector("h1")!.textContent = "PAUSED";
        this.menu.querySelector(".mission-copy")!.textContent = "The battle is waiting. Resume when you're ready.";
        document.querySelector<HTMLButtonElement>("#start")!.textContent = "Resume mission";
        this.menu.classList.remove("hidden");
      }
    });
    addEventListener("keydown", (event) => {
      this.keys.add(event.code);
      if (event.code === "KeyR") this.reload();
    });
    addEventListener("keyup", (event) => this.keys.delete(event.code));
    addEventListener("mousedown", (event) => {
      if (event.button === 0 && this.controls.isLocked) {
        this.firing = true;
        this.fire();
      }
    });
    addEventListener("mouseup", (event) => { if (event.button === 0) this.firing = false; });
    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  private animate(): void {
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), .05);
    if (this.started && !this.ended && this.controls.isLocked) {
      this.updatePlayer(delta);
      this.updateEnemies(delta);
      this.updateAllies(delta);
      if (this.firing) this.fire();
    }
    this.updateAtmosphere(delta);
    this.updateTracers(delta);
    this.updateSparks(delta);
    this.updateWeapon(delta);
    this.renderer.render(this.scene, this.camera);
  }

  private updatePlayer(delta: number): void {
    const speed = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 7.4 : 4.7;
    let forward = Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    let right = Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    this.moving = Boolean(forward || right);
    const sprinting = this.moving && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"));
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, sprinting ? 77 : 72, delta * 7);
    this.camera.updateProjectionMatrix();
    if (!forward && !right) {
      this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, PLAYER_HEIGHT, delta * 10);
      return;
    }
    const length = Math.hypot(forward, right);
    forward /= length;
    right /= length;
    const old = this.camera.position.clone();
    this.controls.moveForward(forward * speed * delta);
    this.controls.moveRight(right * speed * delta);
    this.bobTime += delta * (sprinting ? 12 : 8);
    this.camera.position.y = PLAYER_HEIGHT + Math.sin(this.bobTime) * .035;
    if (!this.isWalkable(this.camera.position.x, this.camera.position.z)) this.camera.position.copy(old);
  }

  private isWalkable(x: number, z: number): boolean {
    const corridor = Math.abs(x) < 3.38 && z >= 11.7 && z <= 30.2;
    const platform = Math.abs(x) < 15.05 && z >= -13.5 && z <= 12.4;
    if (!corridor && !platform) return false;
    const point = new THREE.Vector2(x, z);
    return !this.blockers.some((box) => box.containsPoint(point));
  }

  private fire(): void {
    const now = performance.now();
    if (this.ended || this.reloading || now < this.nextShot) return;
    if (this.ammo <= 0) { this.reload(); return; }
    this.nextShot = now + 165;
    this.ammo--;
    this.weaponKick = 1;
    this.muzzleLight.intensity = 4;
    this.playTone(920, 150, "sawtooth", .045, 210);
    this.updateHud();

    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = this.raycaster.intersectObjects(this.shootSurfaces, false);
    const destination = new THREE.Vector3();
    const first = hits[0];
    if (first) destination.copy(first.point);
    else this.camera.getWorldDirection(destination).multiplyScalar(70).add(this.camera.position);
    const origin = new THREE.Vector3();
    this.muzzleLight.getWorldPosition(origin);
    this.addTracer(origin, destination, 0x55d9ff, .08);

    const enemyId = first?.object.userData.enemyId as number | undefined;
    if (enemyId !== undefined) {
      const enemy = this.enemies[enemyId];
      if (enemy?.alive) {
        enemy.hp -= 40;
        this.playTone(1350, 45, "square", .025, 800);
        this.flashHitMarker();
        if (enemy.hp <= 0) this.killEnemy(enemy);
      }
    }
    if (this.ammo === 0) this.showMessage("Magazine empty · press R", 1.5);
  }

  private reload(): void {
    if (this.reloading || this.ammo === MAGAZINE_SIZE || this.ended) return;
    this.reloading = true;
    this.playTone(180, 80, "square", .018, 120);
    this.showMessage("Reloading…", 1.15);
    setTimeout(() => {
      if (this.ended) return;
      this.ammo = MAGAZINE_SIZE;
      this.reloading = false;
      this.playTone(240, 90, "square", .02, 420);
      this.updateHud();
    }, 1150);
  }

  private updateEnemies(delta: number): void {
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const toPlayer = new THREE.Vector3().subVectors(this.camera.position, enemy.group.position);
      const distance = Math.hypot(toPlayer.x, toPlayer.z);
      enemy.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
      enemy.walkPhase += delta * 5;
      enemy.arms.forEach((arm, index) => arm.rotation.x = Math.sin(enemy.walkPhase + index * Math.PI) * .12 - .55);

      if (distance > 5.5 && distance < 28) {
        const step = toPlayer.setY(0).normalize().multiplyScalar(delta * .72);
        const nextX = enemy.group.position.x + step.x;
        const nextZ = enemy.group.position.z + step.z;
        if (this.isWalkable(nextX, nextZ)) enemy.group.position.set(nextX, 0, nextZ);
      }
      enemy.shotTimer -= delta;
      if (distance < 25 && enemy.shotTimer <= 0) {
        enemy.shotTimer = 1.05 + Math.random() * 1.25;
        this.enemyFire(enemy, distance);
      }
    }
  }

  private updateAllies(delta: number): void {
    const liveEnemies = this.enemies.filter((enemy) => enemy.alive);
    if (!liveEnemies.length) return;
    for (const ally of this.allies) {
      let target = liveEnemies[0];
      let nearest = ally.group.position.distanceToSquared(target.group.position);
      for (const enemy of liveEnemies.slice(1)) {
        const distance = ally.group.position.distanceToSquared(enemy.group.position);
        if (distance < nearest) { nearest = distance; target = enemy; }
      }
      const direction = new THREE.Vector3().subVectors(target.group.position, ally.group.position);
      const distance = Math.hypot(direction.x, direction.z);
      ally.group.rotation.y = Math.atan2(direction.x, direction.z);
      ally.walkPhase += delta * 5;
      ally.arms.forEach((arm, index) => arm.rotation.x = -.65 + Math.sin(ally.walkPhase + index * Math.PI) * .05);
      if (distance > 10) {
        const step = direction.setY(0).normalize().multiplyScalar(delta * 1.15);
        const nextX = ally.group.position.x + step.x;
        const nextZ = ally.group.position.z + step.z;
        if (this.isWalkable(nextX, nextZ)) ally.group.position.set(nextX, 0, nextZ);
      }
      ally.shotTimer -= delta;
      if (distance < 24 && ally.shotTimer <= 0) {
        ally.shotTimer = .65 + Math.random() * .65;
        const origin = ally.group.position.clone().add(new THREE.Vector3(.2, 1.35, 0));
        const destination = target.group.position.clone().add(new THREE.Vector3(0, 1.3, 0));
        if (Math.random() < .7) {
          target.hp -= 24;
          if (target.hp <= 0) this.killEnemy(target);
        } else {
          destination.add(new THREE.Vector3((Math.random() - .5) * 2.6, Math.random() * 1.2, (Math.random() - .5) * 2.6));
        }
        this.addTracer(origin, destination, 0x4ccfff, .1);
        this.playTone(720, 110, "sawtooth", .016, 180);
      }
    }
  }

  private enemyFire(enemy: Enemy, distance: number): void {
    const origin = enemy.group.position.clone().add(new THREE.Vector3(0, 1.35, 0));
    const target = this.camera.position.clone();
    const hitChance = THREE.MathUtils.clamp(.74 - distance * .014, .3, .68);
    const hits = Math.random() < hitChance;
    if (!hits) target.add(new THREE.Vector3((Math.random() - .5) * 4, (Math.random() - .5) * 2, (Math.random() - .5) * 4));
    this.addTracer(origin, target, 0xff392e, .16);
    this.playTone(240, 130, "sawtooth", .022, 90);
    if (hits) this.takeDamage(9);
  }

  private takeDamage(amount: number): void {
    this.health = Math.max(0, this.health - amount);
    this.damageFlash.classList.add("show");
    this.playTone(90, 160, "square", .045, 55);
    setTimeout(() => this.damageFlash.classList.remove("show"), 100);
    this.updateHud();
    if (this.health <= 0) this.finish(false);
  }

  private killEnemy(enemy: Enemy): void {
    if (!enemy.alive) return;
    enemy.alive = false;
    enemy.group.rotation.z = -1.45;
    enemy.group.position.y = .18;
    enemy.hitMeshes.forEach((mesh) => {
      const index = this.shootSurfaces.indexOf(mesh);
      if (index >= 0) this.shootSurfaces.splice(index, 1);
      mesh.userData.enemyId = undefined;
    });
    this.spawnSparks(enemy.group.position.clone().add(new THREE.Vector3(0, 1.2, 0)), 0xff8a38);
    const alive = this.enemies.filter((item) => item.alive).length;
    this.updateHud();
    this.showMessage(alive ? `Droid down · ${alive} remaining` : "Wave clear", 1.4);
    if (alive === 0 && !this.waveTransition) {
      this.waveTransition = true;
      if (this.wave >= this.maxWaves) {
        setTimeout(() => this.finish(true), 900);
      } else {
        this.wave++;
        this.health = Math.min(100, this.health + 18);
        this.ammo = MAGAZINE_SIZE;
        this.updateHud();
        setTimeout(() => {
          if (this.ended) return;
          this.showMessage(`Wave ${this.wave} incoming`, 2);
          this.spawnWave();
        }, 1800);
      }
    }
  }

  private finish(victory: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.controls.unlock();
    this.hud.classList.add("hidden");
    this.menu.classList.add("hidden");
    document.querySelector<HTMLElement>("#result-kicker")!.textContent = victory ? "Mission complete" : "Mission failed";
    document.querySelector<HTMLElement>("#result-title")!.textContent = victory ? "COURTYARD SECURED" : "CLONE DOWN";
    document.querySelector<HTMLElement>("#result-copy")!.textContent = victory
      ? "All three droid waves have been neutralized. Tipoca City's central courtyard is secure—for now."
      : "The droids broke through the rain courtyard. Regroup and try the mission again.";
    this.result.classList.remove("hidden");
  }

  private addTracer(start: THREE.Vector3, end: THREE.Vector3, color: number, ttl: number): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .95 }));
    this.scene.add(line);
    this.tracers.push({ line, ttl });
  }

  private updateTracers(delta: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i];
      tracer.ttl -= delta;
      (tracer.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, tracer.ttl * 7);
      if (tracer.ttl <= 0) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        (tracer.line.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

  private spawnSparks(origin: THREE.Vector3, color: number): void {
    const material = new THREE.MeshBasicMaterial({ color });
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(.025, .025, .18), material.clone());
      mesh.position.copy(origin);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      this.scene.add(mesh);
      this.sparks.push({
        mesh,
        velocity: new THREE.Vector3((Math.random() - .5) * 4.5, 1.5 + Math.random() * 3.2, (Math.random() - .5) * 4.5),
        ttl: .35 + Math.random() * .3,
      });
    }
  }

  private updateSparks(delta: number): void {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      spark.velocity.y -= delta * 8;
      spark.mesh.position.addScaledVector(spark.velocity, delta);
      spark.mesh.scale.z = Math.max(.05, spark.ttl * 2.2);
      spark.ttl -= delta;
      if (spark.ttl <= 0) {
        this.scene.remove(spark.mesh);
        spark.mesh.geometry.dispose();
        (spark.mesh.material as THREE.Material).dispose();
        this.sparks.splice(i, 1);
      }
    }
  }

  private updateAtmosphere(delta: number): void {
    const positions = this.rain.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      let y = positions.getY(i) - delta * 22;
      if (y < -2.5) y = 30;
      positions.setY(i, y);
      positions.setX(i, positions.getX(i) - delta * 2.2);
      if (positions.getX(i) < -45) positions.setX(i, 45);
    }
    positions.needsUpdate = true;
    this.lightningTimer -= delta;
    if (this.lightningTimer <= 0) {
      this.lightningStrength = 4.5;
      this.lightningTimer = 3 + Math.random() * 7;
      this.playTone(48, 480, "sine", .05, 31);
    }
    this.lightningStrength = Math.max(0, this.lightningStrength - delta * 18);
    this.stormLight.intensity = 1.2 + this.lightningStrength;
    if (this.messageTimer > 0) {
      this.messageTimer -= delta;
      if (this.messageTimer <= 0) this.message.classList.remove("show");
    }
  }

  private updateWeapon(delta: number): void {
    this.weaponKick = Math.max(0, this.weaponKick - delta * 9);
    this.weapon.position.z = -.7 + this.weaponKick * .09;
    const sway = this.moving ? Math.sin(this.bobTime * .5) * .012 : 0;
    this.weapon.position.x = THREE.MathUtils.lerp(this.weapon.position.x, .38 + sway, delta * 9);
    this.weapon.position.y = THREE.MathUtils.lerp(this.weapon.position.y, -.33 + Math.abs(sway) * .7, delta * 9);
    this.weapon.rotation.x = -.08 + this.weaponKick * .08;
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - delta * 35);
  }

  private initializeAudio(): void {
    if (!this.audio) this.audio = new AudioContext();
    if (this.audio.state === "suspended") void this.audio.resume();
  }

  private playTone(startFrequency: number, durationMs: number, type: OscillatorType, volume: number, endFrequency: number): void {
    if (!this.audio || this.audio.state !== "running") return;
    const now = this.audio.currentTime;
    const duration = durationMs / 1000;
    const oscillator = this.audio.createOscillator();
    const gain = this.audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    oscillator.connect(gain).connect(this.audio.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  private flashHitMarker(): void {
    this.hitMarker.classList.add("show");
    setTimeout(() => this.hitMarker.classList.remove("show"), 95);
  }

  private showMessage(text: string, duration: number): void {
    this.message.textContent = text;
    this.messageTimer = duration;
    this.message.classList.add("show");
  }

  private updateHud(): void {
    this.enemyCount.textContent = String(this.enemies.filter((enemy) => enemy.alive).length);
    this.waveText.textContent = `WAVE ${this.wave} / ${this.maxWaves}`;
    this.healthText.textContent = String(this.health);
    this.healthBar.style.width = `${this.health}%`;
    this.healthBar.style.background = this.health < 35 ? "#ff5448" : "linear-gradient(90deg, #5bd2ff, #d7f8ff)";
    this.ammoText.textContent = this.reloading ? "—" : String(this.ammo).padStart(2, "0");
  }
}
