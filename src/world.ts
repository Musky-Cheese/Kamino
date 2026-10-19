import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { StaticBatcher, type BatchOptions } from "./batcher";
import { BRIDGES, CONTROL_DECK, DAIS, LANDER, OCEAN_LEVEL, ZONES, type Bridge, type Zone } from "./config";
import type { Materials } from "./materials";
import { Navigation, type Blocker } from "./navigation";
import { rng, smokeTexture } from "./textures";
import { buildGunship, buildLander, taperedBox } from "./vehicles";


export type CoverPoint = { position: THREE.Vector2; zone: number; taken: boolean };

type Flyer = { group: THREE.Group; blinkers: THREE.Mesh[]; gun: THREE.Object3D; radius: number; height: number; speed: number; phase: number; center: THREE.Vector2; bank: number };

/** Sliding blast door between facility sectors: blocks movement and fire until opened. */
export type Door = {
  /** The sector this door leads out of. */
  from: number;
  position: THREE.Vector3;
  panels: Array<{ mesh: THREE.Mesh; closedX: number; slide: number }>;
  lamp: THREE.MeshStandardMaterial;
  blocker: Blocker;
  open: number;
  opening: boolean;
};

type Gap = { at: number; half: number; height: number };

const UP = new THREE.Vector3(0, 1, 0);

function lightConeMaterial(color: THREE.ColorRepresentation, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        // Written without pow/normalize so no fragment can ever produce NaN/Inf.
        float nl = length(vNormal), vl = length(vView);
        float facing = (nl > 1e-4 && vl > 1e-4) ? clamp(abs(dot(vNormal, vView)) / (nl * vl), 0., 1.) : 0.;
        float edge = facing * sqrt(facing);
        float along = clamp(vUv.y, 0., 1.);
        along *= along;
        gl_FragColor = vec4(clamp(uColor * uStrength * edge * along, 0., 4.), 1.0);
      }`,
  });
}

export class World {
  readonly nav = new Navigation();
  readonly batcher = new StaticBatcher();
  readonly enemyCover: CoverPoint[][] = ZONES.map(() => []);
  readonly allyCover: CoverPoint[][] = ZONES.map(() => []);
  readonly captureMarkers: Array<{ group: THREE.Group; ring: THREE.Mesh; beam: THREE.Mesh; fill: THREE.Mesh }> = [];
  readonly spotLights: THREE.SpotLight[] = [];
  readonly lampLights: THREE.PointLight[] = [];
  /** Gunship searchlight cones; the beam points down local -Y. */
  readonly searchBeams: THREE.Mesh[] = [];
  readonly crashFire = new THREE.PointLight(0xff7a2a, 0, 60, 1.6);
  readonly crashSmokeOrigin = new THREE.Vector3();
  /** Spots around the city where the wider battle flares up (for ambient fire and explosions). */
  readonly ambientPoints: THREE.Vector3[] = [];
  /** Blast doors between the facility sectors. */
  readonly doors: Door[] = [];
  /** Doorway-to-deck route used to make reinforcements visibly walk out of the lander. */
  readonly landerDeployment = {
    start: new THREE.Vector3(LANDER.x, 1.9, LANDER.z + 8),
    exit: new THREE.Vector3(LANDER.x, 0, LANDER.z + 15),
  };
  private readonly blinkers: THREE.Mesh[] = [];
  private readonly flyers: Flyer[] = [];
  private readonly smoke: Array<{ sprite: THREE.Sprite; age: number; life: number; velocity: THREE.Vector3; start: THREE.Vector3 }> = [];
  private readonly random = rng(2026);
  private readonly railMaterial: THREE.MeshStandardMaterial;
  private readonly lightMaterial: THREE.MeshStandardMaterial;

  constructor(private readonly scene: THREE.Scene, private readonly m: Materials) {
    this.railMaterial = m.hull.clone();
    this.railMaterial.side = THREE.DoubleSide;
    this.lightMaterial = m.warmLight.clone();
    this.lightMaterial.side = THREE.DoubleSide;
  }

  build(): void {
    const b = this.batcher;
    ZONES.forEach((zone, index) => {
      b.chunk = zone.id;
      const labels: Record<Zone["id"], string> = { A: "AUREK 01", B: "BESH 02", C: "CRESH 03", D: "DORN 04", E: "TIPOCA 05", F: "", G: "" };
      if (zone.id === "E") this.lobby(zone);
      // Rooms first, so cover standing on the control deck is placed on top of it.
      if (zone.id === "F") this.securityCorridor(zone, index);
      if (zone.id === "G") this.cloningHall(zone);
      if (!zone.room) this.platform(zone.center.x, zone.center.y, zone.radius, 0, this.gapsFor(index), labels[zone.id], index + 3, true);
      for (const cover of zone.cover) this.cover(zone, index, cover.kind, cover.x, cover.z, cover.rotation ?? 0);
      if (!zone.room) this.floodlight(zone, index);
      this.captureMarker(zone);
    });
    BRIDGES.forEach((bridge, index) => {
      if (bridge.door) return;
      b.chunk = `bridge${index}`;
      this.bridge(bridge);
    });

    b.chunk = "A";
    this.parkedGunship();
    b.chunk = "D";
    this.parkedLander();
    b.chunk = "dome";
    this.greatDome(54, -24);
    b.chunk = "east";
    this.eastWing();
    b.chunk = "west";
    this.needleTower(-56, -18);
    this.decorPlatforms();
    b.chunk = "far";
    this.distantCity();
    this.batcher.build(this.scene);
    this.spawnFlyers();
  }

  get shootables(): THREE.Mesh[] { return this.batcher.shootables; }

  // ---------------------------------------------------------------- platforms

  /** Angular gaps in the perimeter rail where bridges join this zone. */
  private gapsFor(zoneIndex: number): Array<[number, number]> {
    const zone = ZONES[zoneIndex];
    const gaps: Array<[number, number]> = [];
    // Facility buildings that run off the edge of this platform.
    for (const other of ZONES) {
      if (!other.room) continue;
      const nearX = THREE.MathUtils.clamp(zone.center.x, other.center.x - other.room.hw, other.center.x + other.room.hw);
      const nearZ = THREE.MathUtils.clamp(zone.center.y, other.center.y - other.room.hd, other.center.y + other.room.hd);
      if (Math.hypot(nearX - zone.center.x, nearZ - zone.center.y) >= zone.radius) continue;
      const angle = Math.atan2(other.center.y - zone.center.y, other.center.x - zone.center.x);
      const half = Math.asin(Math.min(1, (other.room.hw + .45) / zone.radius));
      gaps.push([angle - half, angle + half]);
    }
    for (const bridge of BRIDGES) {
      if (bridge.door) continue;
      if (bridge.from !== zoneIndex && bridge.to !== zoneIndex) continue;
      const inside = bridge.from === zoneIndex ? bridge.a : bridge.b;
      const outside = bridge.from === zoneIndex ? bridge.b : bridge.a;
      const crossing = this.rimCrossing(zone.center, zone.radius, inside, outside);
      const angle = Math.atan2(crossing.y - zone.center.y, crossing.x - zone.center.x);
      const half = Math.asin(Math.min(1, (bridge.halfWidth + .25) / zone.radius));
      gaps.push([angle - half, angle + half]);
    }
    return gaps;
  }

  private rimCrossing(center: THREE.Vector2, radius: number, inside: THREE.Vector2, outside: THREE.Vector2): THREE.Vector2 {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const p = inside.clone().lerp(outside, mid);
      if (p.distanceTo(center) < radius) lo = mid; else hi = mid;
    }
    return inside.clone().lerp(outside, lo);
  }

  private platform(cx: number, cz: number, r: number, y: number, gaps: Array<[number, number]>, label: string, seed: number, walkable: boolean): void {
    const b = this.batcher, m = this.m;
    const segments = Math.max(48, Math.round(r * 6));
    b.place(new THREE.CircleGeometry(r, segments).rotateX(-Math.PI / 2), y === 0 ? m.deck : m.deckRaised, { x: cx, y, z: cz }, undefined, undefined, { uvScale: 1 / 9 });
    b.place(new THREE.RingGeometry(r, r + .35, segments, 1).rotateX(-Math.PI / 2), m.trim, { x: cx, y: y + .001, z: cz }, undefined, undefined, { uvScale: .25 });
    b.place(new THREE.CylinderGeometry(r + .35, r + .2, 1.4, segments, 1, true), m.hull, { x: cx, y: y - .7, z: cz }, undefined, undefined, { uvScale: 1 / 6 });
    const saucer = [
      [0, -7.6], [r * .2, -7.3], [r * .45, -6.2], [r * .72, -4.2], [r * .92, -2.4], [r + .2, -1.4],
    ].map(([px, py]) => new THREE.Vector2(px, py));
    b.place(new THREE.LatheGeometry(saucer, segments), m.hullDark, { x: cx, y, z: cz }, undefined, undefined, { uvScale: 1 / 7, cast: false });
    // Rim window band: a dashed row of warm lights wrapping the outer skirt.
    const dashes = Math.round(r * 2.4);
    for (let i = 0; i < dashes; i++) {
      if (this.random() < .25) continue;
      const a = i / dashes * Math.PI * 2;
      b.place(new THREE.BoxGeometry(.9, .14, .05), this.random() < .8 ? m.windowLit : m.coolLight,
        { x: cx + Math.cos(a) * (r + .36), y: y - .75, z: cz + Math.sin(a) * (r + .36) }, [0, -a - Math.PI / 2, 0], undefined, { cast: false, shoot: false });
    }
    // Stilts down to the ocean.
    const columnHeight = y - 7 - OCEAN_LEVEL;
    b.place(new THREE.CylinderGeometry(r * .11, r * .15, columnHeight, 20), m.hullDark, { x: cx, y: OCEAN_LEVEL + columnHeight / 2, z: cz }, undefined, undefined, { cast: false, shoot: false });
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2 + seed;
      const top = new THREE.Vector3(cx + Math.cos(a) * r * .55, y - 5, cz + Math.sin(a) * r * .55);
      const bottom = new THREE.Vector3(cx + Math.cos(a) * r * .25, OCEAN_LEVEL, cz + Math.sin(a) * r * .25);
      const length = top.distanceTo(bottom);
      const leg = new THREE.Object3D();
      leg.position.copy(top).lerp(bottom, .5);
      leg.quaternion.setFromUnitVectors(UP, top.clone().sub(bottom).normalize());
      b.add(new THREE.CylinderGeometry(.55, .75, length, 10), m.hullDark, leg, { cast: false, shoot: false });
    }

    b.place(new THREE.CircleGeometry(r * .97, segments).rotateX(-Math.PI / 2), m.padPaint(label, seed), { x: cx, y: y + .012, z: cz }, undefined, undefined, { uv: "keep", cast: false, shoot: false });
    // Inset floor lights.
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      b.place(new THREE.CylinderGeometry(.09, .09, .04, 10), i % 2 ? m.coolLight : m.warmLight,
        { x: cx + Math.cos(a) * r * .9, y: y + .01, z: cz + Math.sin(a) * r * .9 }, undefined, undefined, { cast: false, shoot: false });
    }
    this.perimeterRail(cx, cz, r, y, gaps, walkable);
  }

  private perimeterRail(cx: number, cz: number, r: number, y: number, gaps: Array<[number, number]>, walkable: boolean): void {
    const b = this.batcher, m = this.m;
    const sorted = gaps.map(([a0, a1]) => [normalizeAngle(a0), normalizeAngle(a0) + (a1 - a0)] as [number, number]).sort((p, q) => p[0] - q[0]);
    const spans: Array<[number, number]> = [];
    if (!sorted.length) spans.push([0, Math.PI * 2]);
    else {
      for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i][1];
        const end = i + 1 < sorted.length ? sorted[i + 1][0] : sorted[0][0] + Math.PI * 2;
        if (end - start > .02) spans.push([start, end]);
      }
    }
    const R = r - .12;
    const height = walkable ? 1.05 : .9;
    for (const [a0, a1] of spans) {
      const length = a1 - a0;
      const segs = Math.max(4, Math.round(length * R * 1.5));
      const thetaStart = Math.PI / 2 - a1;
      b.place(new THREE.CylinderGeometry(R, R, height, segs, 1, true, thetaStart, length), this.railMaterial, { x: cx, y: y + height / 2, z: cz }, undefined, undefined, { uvScale: 1 / 6 });
      b.place(new THREE.CylinderGeometry(R + .22, R + .22, height, segs, 1, true, thetaStart, length), this.railMaterial, { x: cx, y: y + height / 2, z: cz }, undefined, undefined, { uvScale: 1 / 6, cast: false });
      b.place(new THREE.RingGeometry(R, R + .22, segs, 1, -a1, length).rotateX(-Math.PI / 2), m.trim, { x: cx, y: y + height, z: cz }, undefined, undefined, { uvScale: .5 });
      b.place(new THREE.CylinderGeometry(R - .02, R - .02, .06, segs, 1, true, thetaStart, length), this.lightMaterial, { x: cx, y: y + height - .14, z: cz }, undefined, undefined, { cast: false, shoot: false });
      // Bollard lamps along the rail top.
      const count = Math.floor(length * R / 5);
      for (let i = 1; i < count; i++) {
        const a = a0 + i / count * length;
        const px = cx + Math.cos(a) * (R + .11), pz = cz + Math.sin(a) * (R + .11);
        b.place(new THREE.CylinderGeometry(.13, .16, .35, 10), m.hullDark, { x: px, y: y + height + .17, z: pz }, undefined, undefined, { shoot: false });
        b.place(new THREE.SphereGeometry(.14, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), m.lampGlow, { x: px, y: y + height + .34, z: pz }, undefined, undefined, { cast: false, shoot: false });
      }
    }
  }

  // ---------------------------------------------------------------- bridges

  private bridge(bridge: Bridge): void {
    const b = this.batcher, m = this.m;
    const fromZone = ZONES[bridge.from], toZone = ZONES[bridge.to];
    const start = this.rimCrossing(fromZone.center, fromZone.radius, bridge.a, bridge.b);
    const end = this.rimCrossing(toZone.center, toZone.radius, bridge.b, bridge.a);
    const direction = end.clone().sub(start);
    const length = direction.length() + 1.2;
    const mid = start.clone().add(end).multiplyScalar(.5);
    const angle = Math.atan2(direction.x, direction.y);
    const w = bridge.halfWidth * 2;
    const frame = new THREE.Object3D();
    frame.position.set(mid.x, 0, mid.y);
    frame.rotation.y = angle;
    frame.updateMatrixWorld();
    const local = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, options?: Parameters<StaticBatcher["add"]>[3]) => {
      const object = new THREE.Object3D();
      object.position.set(x, y, z);
      frame.add(object);
      object.updateMatrixWorld();
      b.add(geometry, material, object, options);
      frame.remove(object);
    };
    local(new THREE.BoxGeometry(w, .5, length), m.deckDark, 0, -.26, 0, { uvScale: 1 / 4 });
    local(new THREE.BoxGeometry(w * .45, .02, length), m.deck, 0, -.005, 0, { uvScale: 1 / 4, cast: false });
    for (const s of [-1, 1]) {
      local(new THREE.BoxGeometry(.26, 1.05, length - .6), m.hull, s * (bridge.halfWidth - .13), .52, 0, { uvScale: 1 / 4 });
      local(new THREE.BoxGeometry(.32, .06, length - .6), m.trim, s * (bridge.halfWidth - .13), 1.06, 0, { uvScale: .5 });
      local(new THREE.BoxGeometry(.03, .05, length - .8), m.warmLight, s * (bridge.halfWidth - .275), .88, 0, { cast: false, shoot: false });
      local(new THREE.BoxGeometry(.4, .9, length), m.hullDark, s * (bridge.halfWidth - .6), -.95, 0, { uvScale: 1 / 4 });
      local(new THREE.BoxGeometry(.06, .05, length - .6), m.coolLight, s * (bridge.halfWidth + .02), -.3, 0, { cast: false, shoot: false });
      if (bridge.main) {
        for (let z = -length / 2 + 3; z < length / 2 - 2; z += 7) {
          local(new THREE.CylinderGeometry(.11, .15, 3.2, 10), m.hullDark, s * (bridge.halfWidth - .13), 2.1, z, { shoot: false });
          local(new THREE.BoxGeometry(.05, 2.2, .05), m.warmLight, s * (bridge.halfWidth - .26), 2.2, z, { cast: false, shoot: false });
          local(new THREE.SphereGeometry(.17, 10, 8), m.lampGlow, s * (bridge.halfWidth - .13), 3.75, z, { cast: false, shoot: false });
        }
      }
    }
    for (let z = -length / 2 + 1.5; z < length / 2; z += 3) {
      local(new THREE.BoxGeometry(w - 1, .35, .3), m.hullDark, 0, -1.2, z, { cast: false });
    }
    if (length > 12) {
      const pylonHeight = -1.4 - OCEAN_LEVEL;
      local(new THREE.CylinderGeometry(.7, 1.1, pylonHeight, 12), m.hullDark, 0, -1.4 - pylonHeight / 2, 0, { cast: false, shoot: false });
    }
    if (bridge.main) {
      const light = new THREE.PointLight(0xffd9a8, 22, 16, 2);
      light.position.set(mid.x, 3.4, mid.y);
      this.scene.add(light);
      this.lampLights.push(light);
    }
  }

  // ---------------------------------------------------------------- facility

  private box(material: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, options?: BatchOptions): void {
    this.batcher.place(new THREE.BoxGeometry(sx, sy, sz), material, { x, y, z }, undefined, undefined, options);
  }

  /**
   * Straight wall from `from` to `to` along `axis` (an "x" wall runs along x at z = `fixed`), with doorways
   * cut out of its lower part. Only the full-height pieces block movement.
   */
  private wallRun(axis: "x" | "z", fixed: number, from: number, to: number, height: number, thickness: number, material: THREE.Material,
    gaps: Gap[] = [], solid = true, options: BatchOptions = { uvScale: 1 / 5 }): void {
    const piece = (a0: number, a1: number, y0: number, y1: number, block: boolean) => {
      if (a1 - a0 < .01 || y1 - y0 < .01) return;
      const mid = (a0 + a1) / 2, length = a1 - a0, h = y1 - y0;
      if (axis === "x") this.box(material, mid, y0 + h / 2, fixed, length, h, thickness, options);
      else this.box(material, fixed, y0 + h / 2, mid, thickness, h, length, options);
      if (block && solid) {
        if (axis === "x") this.nav.addBox(mid, fixed, length, thickness, 0, y1);
        else this.nav.addBox(fixed, mid, thickness, length, 0, y1);
      }
    };
    let cursor = Math.min(from, to);
    for (const gap of [...gaps].sort((p, q) => p.at - q.at)) {
      piece(cursor, gap.at - gap.half, 0, height, true);
      piece(gap.at - gap.half, gap.at + gap.half, gap.height, height, false);
      cursor = gap.at + gap.half;
    }
    piece(cursor, Math.max(from, to), 0, height, true);
  }

  /** Half-cylinder roof shell along z, the rounded Kaminoan top seen from outside. */
  private vaultRoof(x: number, y: number, z: number, radius: number, length: number, rise: number): void {
    const vault = new THREE.CylinderGeometry(radius, radius, length, 40, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
    this.batcher.place(vault, this.m.hull, { x, y, z }, undefined, { x: 1, y: rise / radius, z: 1 }, { uvScale: 1 / 8 });
  }

  /** Stilts from a building's underside to the sea. */
  private stilts(points: Array<[number, number]>, radius: number, top: number): void {
    const height = top - OCEAN_LEVEL;
    for (const [x, z] of points) {
      this.box(this.m.hullDark, x, top - .4, z, radius * 2.6, .8, radius * 2.6, { cast: false });
      this.batcher.place(new THREE.CylinderGeometry(radius, radius * 1.3, height, 16), this.m.hullDark, { x, y: OCEAN_LEVEL + height / 2, z }, undefined, undefined, { cast: false, shoot: false });
    }
  }

  /**
   * Dark service closet behind a doorway in a room's outer wall; reinforcements appear inside it.
   * (`x`, `z`) is the doorway on the room's boundary, (`outX`, `outZ`) points away from the room.
   */
  private serviceCloset(x: number, z: number, outX: number, outZ: number): void {
    const m = this.m;
    const depth = 2.6, width = 2.1, height = 2.7;
    const alongX = outX !== 0;
    const cx = x + outX * depth / 2, cz = z + outZ * depth / 2;
    const sx = alongX ? depth : width + .4, sz = alongX ? width + .4 : depth;
    this.box(m.hullDark, cx, -.12, cz, sx, .24, sz, { cast: false });
    this.box(m.hullDark, cx, height + .12, cz, sx, .24, sz);
    this.box(m.hullDark, x + outX * (depth + .1), height / 2, z + outZ * (depth + .1), alongX ? .2 : width + .4, height, alongX ? width + .4 : .2);
    for (const s of [-1, 1]) {
      this.box(m.hullDark, alongX ? cx : x + s * (width / 2 + .1), height / 2, alongX ? z + s * (width / 2 + .1) : cz, alongX ? depth : .2, height, alongX ? .2 : depth);
    }
    this.box(m.redLight, x + outX * (depth - .02), height - .35, z + outZ * (depth - .02), alongX ? .04 : 1.3, .06, alongX ? 1.3 : .04, { cast: false, shoot: false });
    // Door frame on the room side.
    for (const s of [-1, 1]) {
      this.box(m.trim, alongX ? x : x + s * 1.02, 1.3, alongX ? z + s * 1.02 : z, alongX ? .35 : .18, 2.6, alongX ? .18 : .35, { shoot: false });
    }
    this.box(m.amberLight, x, 2.62, z, alongX ? .36 : 2, .08, alongX ? 2 : .36, { cast: false, shoot: false });
  }

  /** A two-leaf blast door across a doorway in an x-running wall. Panels slide sideways into the wall. */
  private blastDoor(from: number, x: number, z: number, width: number, height: number, thickness: number): Door {
    const panels: Door["panels"] = [];
    for (const s of [-1, 1]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width / 2, height, thickness * .5), this.m.hullDark);
      mesh.position.set(x + s * width / 4, height / 2, z);
      mesh.castShadow = mesh.receiveShadow = true;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(width / 2 - .3, .22, thickness * .5 + .02), this.m.hazard);
      stripe.position.y = -height * .18;
      const seam = new THREE.Mesh(new THREE.BoxGeometry(.05, height - .3, thickness * .5 + .02), this.m.coolLight);
      seam.position.x = -s * (width / 4 - .06);
      mesh.add(stripe, seam);
      this.scene.add(mesh);
      this.batcher.shootables.push(mesh);
      panels.push({ mesh, closedX: mesh.position.x, slide: s * width / 2 });
    }
    const lamp = this.m.redLight.clone();
    this.batcher.place(new THREE.BoxGeometry(width * .6, .12, thickness + .08), lamp, { x, y: height + .25, z }, undefined, undefined, { cast: false, shoot: false });
    for (const s of [-1, 1]) this.box(this.m.trim, x + s * (width / 2 + .12), height / 2, z, .24, height, thickness + .12, { shoot: false });
    const blocker = this.nav.addBox(x, z, width, thickness + .2, 0, height);
    const door: Door = { from, position: new THREE.Vector3(x, height / 2, z), panels, lamp, blocker, open: 0, opening: false };
    this.doors.push(door);
    return door;
  }

  /** Start sliding open the door out of sector `from`; it stops blocking movement at once. `instant` skips the animation. */
  openDoor(from: number, instant = false): Door | null {
    const door = this.doors.find((candidate) => candidate.from === from);
    if (!door || door.opening) return null;
    door.opening = true;
    door.blocker.top = -1;
    door.lamp.emissive.set(0x4fdcff);
    door.lamp.emissiveIntensity = 3;
    if (instant) door.open = .999;
    return door;
  }

  private updateDoors(delta: number): void {
    for (const door of this.doors) {
      if (!door.opening || door.open >= 1) continue;
      door.open = Math.min(1, door.open + delta / 2.2);
      const t = door.open * door.open * (3 - 2 * door.open);
      for (const panel of door.panels) panel.mesh.position.x = panel.closedX + panel.slide * t;
      if (door.open >= 1) {
        for (const panel of door.panels) {
          panel.mesh.visible = false;
          const index = this.batcher.shootables.indexOf(panel.mesh);
          if (index >= 0) this.batcher.shootables.splice(index, 1);
        }
      }
    }
  }

  /** Sector E: the facility's entrance lobby, a roofed hall entered from the landing district. */
  private lobby(zone: Zone): void {
    const b = this.batcher, m = this.m;
    const x = zone.center.x, z = zone.center.y;
    const wall = (width: number, height: number, depth: number, px: number, py: number, pz: number, solid = true) => {
      b.place(new THREE.BoxGeometry(width, height, depth), m.hull, { x: px, y: py, z: pz }, undefined, undefined, { uvScale: 1 / 5 });
      if (solid) this.nav.addBox(px, pz, width, depth, 0, py + height / 2);
    };
    // The northern face is split around a broad breach, making the player cross a clear threshold
    // from the rain and open firefight into a confined, defended hall.
    wall(16, 6.8, .9, x - 12, 3.4, z + 19);
    wall(16, 6.8, .9, x + 12, 3.4, z + 19);
    // The back wall holds the blast door into the security corridor, flanked by two service doors
    // through which the facility feeds reinforcements once the landing craft is behind the front.
    this.wallRun("x", z - 19, x - 20, x - 2, 6.8, .9, m.hull, [{ at: x - 14, half: 1.05, height: 2.65 }]);
    this.wallRun("x", z - 19, x + 2, x + 20, 6.8, .9, m.hull, [{ at: x + 14, half: 1.05, height: 2.65 }]);
    this.serviceCloset(x - 14, z - 19, 0, -1);
    this.serviceCloset(x + 14, z - 19, 0, -1);
    wall(4, 3.2, .9, x, 5.2, z - 19, false);
    this.blastDoor(ZONES.indexOf(zone), x, z - 19, 4, 3.6, .9);
    wall(.9, 6.8, 38, x - 20, 3.4, z);
    wall(.9, 6.8, 38, x + 20, 3.4, z);
    // Clean interior lining inside the weathered shell (as in the corridor and hall), so the walls take
    // diffuse light from the fixtures and the room reads as a room rather than a black box.
    const lining = { uvScale: 1 / 5, cast: false, shoot: false };
    this.box(m.interior, x - 12, 3.3, z + 18.4, 16, 6.6, .3, lining);
    this.box(m.interior, x + 12, 3.3, z + 18.4, 16, 6.6, .3, lining);
    this.wallRun("x", z - 18.4, x - 19.5, x - 2, 6.6, .3, m.interior, [{ at: x - 14, half: 1.05, height: 2.65 }], false, lining);
    this.wallRun("x", z - 18.4, x + 2, x + 19.5, 6.6, .3, m.interior, [{ at: x + 14, half: 1.05, height: 2.65 }], false, lining);
    this.box(m.interior, x - 19.4, 3.3, z, .3, 6.6, 36.8, lining);
    this.box(m.interior, x + 19.4, 3.3, z, .3, 6.6, 36.8, lining);
    this.box(m.interior, x, 7.28, z, 38.8, .06, 36.8, { ...lining, uvScale: 1 / 6 });
    // Door frame and a low, ribbed ceiling make the enclosure read as an interior while preserving
    // sightlines through the main hall.
    wall(.9, 7.5, 1.5, x - 4.1, 3.75, z + 19, false);
    wall(.9, 7.5, 1.5, x + 4.1, 3.75, z + 19, false);
    wall(8.8, .8, 1.5, x, 7.1, z + 19, false);
    // The roof casts so moonlight stays outside.
    b.place(new THREE.BoxGeometry(39, .3, 37), m.hullDark, { x, y: 7.45, z }, undefined, undefined, { uvScale: 1 / 6 });
    this.nav.addRoof(x - 20, z - 19, x + 20, z + 19, 7.3);
    for (let dz = -14; dz <= 14; dz += 7) {
      b.place(new THREE.BoxGeometry(39, .32, .4), m.trim, { x, y: 7.2, z: z + dz }, undefined, undefined, { cast: false });
      b.place(new THREE.BoxGeometry(38, .05, .08), m.coolLight, { x, y: 7.02, z: z + dz }, undefined, undefined, { cast: false, shoot: false });
    }
    // Interior columns divide the room into firing lanes and give both sides meaningful cover.
    for (const [ox, oz] of [[-12, 7], [12, 7], [-12, -7], [12, -7]] as const) {
      b.place(new THREE.CylinderGeometry(.72, .95, 7, 12), m.hullDark, { x: x + ox, y: 3.5, z: z + oz }, undefined, undefined, { uvScale: 1 / 4 });
      b.place(new THREE.CylinderGeometry(.78, .78, .08, 12), m.warmLight, { x: x + ox, y: 6.9, z: z + oz }, undefined, undefined, { cast: false, shoot: false });
      this.nav.addCircle(x + ox, z + oz, .95, 7);
      // Each column cap is a real fixture, so the side lanes and the walls behind them get shape.
      const capLight = new THREE.PointLight(0xffd9a8, 11, 14, 2);
      capLight.position.set(x + ox, 6.4, z + oz);
      this.scene.add(capLight);
      this.lampLights.push(capLight);
    }
    const entryLight = new THREE.PointLight(0x9bdcff, 28, 18, 2);
    entryLight.position.set(x, 5.4, z + 16);
    this.scene.add(entryLight);
    const innerLight = new THREE.PointLight(0xffc487, 20, 17, 2);
    innerLight.position.set(x, 5, z - 11);
    this.scene.add(innerLight);
    this.lampLights.push(innerLight);
  }

  /** Sector F: a narrow corridor behind the lobby, three pairs of alcoves between solid wall blocks. */
  private securityCorridor(zone: Zone, zoneIndex: number): void {
    const m = this.m;
    const room = zone.room!;
    const cx = zone.center.x, cz = zone.center.y, H = room.ceiling;
    const x0 = cx - room.hw, x1 = cx + room.hw, z0 = cz + room.hd, z1 = cz - room.hd;
    const walk = 3;
    const alcoves = [cz + 11, cz, cz - 11];
    const alcoveHalf = 2.5;
    const doorsAt = new Set(zone.spawns!.map((spawn) => `${Math.sign(spawn.exit.x - cx)}|${spawn.exit.y}`));

    // Floor: a step above the lobby deck so it never fights the platform paint for depth.
    this.box(m.interiorFloor, cx, -.11, cz, room.hw * 2, .3, room.hd * 2, { uvScale: 1 / 4 });
    this.nav.addBox(cx, cz, room.hw * 2, room.hd * 2, 0, .04);
    this.box(m.hullDark, cx, .045, cz, 1.6, .01, room.hd * 2 - 1, { cast: false, shoot: false, uvScale: 1 / 3 });
    for (const s of [-1, 1]) this.box(m.coolLight, cx + s * (walk - .15), .05, cz, .06, .02, room.hd * 2 - 1, { cast: false, shoot: false });
    // Underside where the corridor runs off the lobby platform.
    this.box(m.hullDark, cx, -.95, cz - 4, room.hw * 2 + .6, 1.6, room.hd * 2 - 8, { cast: false, uvScale: 1 / 5 });
    this.stilts([[cx, cz - 6], [cx, cz - 17]], .9, -1.75);

    // Outer walls, with service doorways in the far alcoves. Lining inside, weathered shell outside.
    for (const s of [-1, 1]) {
      const edge = s < 0 ? x0 : x1;
      const gaps: Gap[] = alcoves.filter((z) => doorsAt.has(`${s}|${z}`)).map((at) => ({ at, half: .95, height: 2.6 }));
      this.wallRun("z", edge - s * .3, z1, z0, H, .6, m.interior, gaps);
      this.wallRun("z", edge + s * .15, z1, z0, H + .3, .3, m.hull, gaps, false);
      for (const at of gaps.map((gap) => gap.at)) this.serviceCloset(edge, at, s, 0);
      // Solid blocks between the alcoves; the walkway faces carry light panels and corner trims.
      const spans: Array<[number, number]> = [];
      let top = z0;
      for (const at of alcoves) { spans.push([at + alcoveHalf, top]); top = at - alcoveHalf; }
      spans.push([z1, top]);
      for (const [a, c] of spans) {
        const mid = (a + c) / 2, length = c - a;
        const bx = cx + s * (walk + (room.hw - walk) / 2);
        this.box(m.interior, bx, H / 2, mid, room.hw - walk, H, length);
        this.nav.addBox(bx, mid, room.hw - walk, length, 0, H);
        for (const end of [a, c]) {
          if (end === z0 || end === z1) continue;
          this.box(m.trim, cx + s * walk, H / 2, end, .28, H, .28, { shoot: false });
        }
        if (length > 4) this.box(m.coolLight, cx + s * (walk - .01), 2.1, mid, .02, 1.6, .12, { cast: false, shoot: false });
      }
      // Alcove fittings and the cover they give: droids hug the wall nearer the lobby, clones the far one.
      for (const at of alcoves) {
        const inner = cx + s * 4.6;
        if (!doorsAt.has(`${s}|${at}`)) {
          const lx = edge - s * .85;
          this.box(m.hullDark, lx, 1.1, at, .5, 2.2, 3.6, { uvScale: 1 / 2 });
          this.box(m.coolLight, lx - s * .26, 1.9, at, .02, .05, 3.2, { cast: false, shoot: false });
          this.nav.addBox(lx, at, .5, 3.6, 0, 2.2);
        }
        this.box(m.warmLight, cx + s * 5, H - .02, at, 1.4, .03, 1.4, { cast: false, shoot: false });
        // The alcove ceiling panel lights its own bay, so the wall blocks and anyone hugging them read.
        const bayLight = new THREE.PointLight(0xffd9a8, 5, 12, 2);
        bayLight.position.set(cx + s * 4.6, H - .7, at);
        this.scene.add(bayLight);
        this.lampLights.push(bayLight);
        this.enemyCover[zoneIndex].push({ position: new THREE.Vector2(inner, at + 1.7), zone: zoneIndex, taken: false });
        this.allyCover[zoneIndex].push({ position: new THREE.Vector2(inner, at - 1.7), zone: zoneIndex, taken: false });
      }
    }

    // Ceiling, panels, and the rounded roof seen from outside.
    this.box(m.interior, cx, H + .15, cz, room.hw * 2, .3, room.hd * 2, { uvScale: 1 / 5 });
    for (let z = z0 - 3; z > z1 + 1; z -= 5) this.box(m.coolLight, cx, H - .02, z, 1.4, .04, 2.6, { cast: false, shoot: false });
    this.vaultRoof(cx, H + .3, cz, room.hw + .3, room.hd * 2, 2.2);
    this.nav.addRoof(x0 - 2.8, z1, x1 + 2.8, z0, H);

    for (const dz of [9, -9]) {
      const light = new THREE.PointLight(0xdcefff, 11, 18, 2);
      light.position.set(cx, H - .6, cz + dz);
      this.scene.add(light);
      this.lampLights.push(light);
    }
  }

  /** Sector G: the tall cloning hall, rows of growth tanks, a control deck and storm windows at the far end. */
  private cloningHall(zone: Zone): void {
    const m = this.m;
    const room = zone.room!;
    const cx = zone.center.x, cz = zone.center.y, H = room.ceiling;
    const x0 = cx - room.hw, x1 = cx + room.hw, z0 = cz + room.hd, z1 = cz - room.hd;
    const windowHalf = 12, windowBottom = 1.2, windowTop = 10.5;
    const sideDoor = (side: number) => zone.spawns!.filter((spawn) => Math.abs(spawn.exit.x - (side < 0 ? x0 : x1)) < 3).map((spawn) => spawn.exit.y);
    const backDoors = zone.spawns!.filter((spawn) => Math.abs(spawn.exit.y - z1) < 4).map((spawn) => spawn.exit.x);

    this.box(m.interiorFloor, cx, -.11, cz, room.hw * 2, .3, room.hd * 2, { uvScale: 1 / 4 });
    this.nav.addBox(cx, cz, room.hw * 2, room.hd * 2, 0, .04);
    this.box(m.hullDark, cx, .045, cz + 2, 6, .01, room.hd * 2 - 12, { cast: false, shoot: false, uvScale: 1 / 3 });
    for (const s of [-1, 1]) this.box(m.coolLight, cx + s * 3, .05, cz + 2, .07, .02, room.hd * 2 - 12, { cast: false, shoot: false });
    this.box(m.hullDark, cx, -1.3, cz, room.hw * 2 + .6, 2.4, room.hd * 2 + .6, { cast: false, uvScale: 1 / 6 });
    this.stilts([[cx - 12, cz + 14], [cx + 12, cz + 14], [cx - 12, cz - 14], [cx + 12, cz - 14]], 1.3, -2.5);

    // Front wall with the second blast door, lined to match the corridor.
    this.wallRun("x", z0 - .4, x0, x1, H, .8, m.interior, [{ at: cx, half: 3, height: 4.2 }]);
    this.blastDoor(ZONES.indexOf(zone) - 1, cx, z0 - .4, 6, 4.2, .8);

    // Side walls: solid to 7 m with a service door, a band of storm windows above, then the cornice.
    for (const s of [-1, 1]) {
      const edge = s < 0 ? x0 : x1;
      const gaps: Gap[] = sideDoor(s).map((at) => ({ at, half: .95, height: 2.6 }));
      this.wallRun("z", edge - s * .4, z1, z0, 7, .8, m.interior, gaps);
      this.wallRun("z", edge + s * .15, z1, z0, 7, .3, m.hull, gaps, false);
      for (const at of gaps.map((gap) => gap.at)) this.serviceCloset(edge, at, s, 0);
      const piers: number[] = [];
      for (let z = z0 - .8; z > z1 + 4; z -= 7) piers.push(z);
      piers.push(z1 + .8);
      piers.forEach((z, i) => {
        this.box(m.interior, edge - s * .4, 9, z, .8, 4, 1.6, { uvScale: 1 / 4 });
        const next = piers[i + 1];
        if (next !== undefined) this.box(m.glass, edge - s * .4, 9, (z + next) / 2, .08, 4, z - next - 1.6, { cast: false, shoot: false });
      });
      this.box(m.interior, edge - s * .4, 12, cz, .8, 2, room.hd * 2, { uvScale: 1 / 5 });
      this.box(m.hull, edge + s * .15, 12.15, cz, .3, 2.3, room.hd * 2, { uvScale: 1 / 5 });
      // Maintenance gantry along the wall (not walkable).
      const gx = edge - s * 2;
      this.box(m.hullDark, gx, 5.6, cz - 1, 2.4, .22, room.hd * 2 - 6, { uvScale: 1 / 3 });
      this.box(m.trim, gx - s * 1.15, 6.15, cz - 1, .07, .07, room.hd * 2 - 6, { shoot: false });
      this.box(m.warmLight, gx - s * 1.2, 5.48, cz - 1, .04, .04, room.hd * 2 - 6, { cast: false, shoot: false });
      for (let z = z0 - 4; z > z1 + 3; z -= 7) {
        this.box(m.trim, gx - s * 1.15, 5.9, z, .06, .55, .06, { shoot: false });
        this.box(m.hullDark, edge - s * 1.05, 5.1, z, 1.3, .8, .3, { shoot: false });
      }
    }

    // Back wall: the great storm window between two service doors.
    const backZ = z1 + .4;
    this.wallRun("x", backZ, x0, cx - windowHalf, H, .8, m.interior, backDoors.filter((x) => x < cx).map((at) => ({ at, half: .95, height: 2.6 })));
    this.wallRun("x", backZ, cx + windowHalf, x1, H, .8, m.interior, backDoors.filter((x) => x > cx).map((at) => ({ at, half: .95, height: 2.6 })));
    this.wallRun("x", z1 - .15, x0, x1, H + .3, .3, m.hull, [
      ...backDoors.map((at) => ({ at, half: .95, height: 2.6 })),
      { at: cx, half: windowHalf, height: windowTop },
    ], false);
    for (const x of backDoors) this.serviceCloset(x, z1, 0, -1);
    this.box(m.interior, cx, windowBottom / 2, backZ, windowHalf * 2, windowBottom, .8);
    this.box(m.interior, cx, (windowTop + H) / 2, backZ, windowHalf * 2, H - windowTop, .8, { uvScale: 1 / 5 });
    this.nav.addBox(cx, backZ, windowHalf * 2, .8, 0, H);
    this.box(m.glass, cx, (windowBottom + windowTop) / 2, backZ, windowHalf * 2, windowTop - windowBottom, .06, { cast: false });
    for (let i = 0; i <= 6; i++) this.box(m.trim, cx - windowHalf + i * 4, (windowBottom + windowTop) / 2, backZ, .3, windowTop - windowBottom, .9);
    this.box(m.trim, cx, 5.85, backZ, windowHalf * 2, .25, .9);
    this.box(m.coolLight, cx, windowBottom + .02, backZ + .46, windowHalf * 2, .03, .05, { cast: false, shoot: false });

    // Raised control deck under the window.
    const deck = CONTROL_DECK;
    this.box(m.interiorFloor, deck.x, deck.height / 2, deck.z, deck.width, deck.height, deck.depth, { uvScale: 1 / 4 });
    this.box(m.coolLight, deck.x, deck.height - .02, deck.z + deck.depth / 2 + .01, deck.width, .04, .04, { cast: false, shoot: false });
    this.nav.addBox(deck.x, deck.z, deck.width, deck.depth, 0, deck.height);

    // Ceiling with ribs and light strips; the vaulted roof over it.
    this.box(m.interior, cx, H + .2, cz, room.hw * 2, .4, room.hd * 2, { uvScale: 1 / 6 });
    for (let z = z0 - 3.5; z > z1; z -= 7) this.box(m.trim, cx, H - .25, z, room.hw * 2, .5, .5, { uvScale: 1 / 2 });
    for (const dx of [-9, 0, 9]) this.box(dx === 0 ? m.warmLight : m.coolLight, cx + dx, H - .04, cz, dx === 0 ? .3 : .5, .06, room.hd * 2 - 4, { cast: false, shoot: false });
    this.vaultRoof(cx, H + .4, cz, room.hw + .3, room.hd * 2 + .6, 6.5);
    this.nav.addRoof(x0 - 2.8, z1 - 2.8, x1 + 2.8, z0, H);

    // Eased back a little now the room fill carries the walls; these stay the accents.
    const lights: Array<[number, number, number, number, number]> = [
      [0xffd6a8, z0 - 5, 9, 32, 26],
      [0x8fe8ff, cz, 10, 48, 34],
      [0xc6ecff, z1 + 7, 8, 38, 28],
    ];
    for (const [color, z, y, intensity, distance] of lights) {
      const light = new THREE.PointLight(color, intensity, distance, 2);
      light.position.set(cx, y, z);
      this.scene.add(light);
      this.lampLights.push(light);
    }
  }

  // ---------------------------------------------------------------- props

  private cover(zone: Zone, zoneIndex: number, kind: string, lx: number, lz: number, rotation: number): void {
    const x = zone.center.x + lx, z = zone.center.y + lz;
    const b = this.batcher, m = this.m;
    // Indoors, cover stands on the raised floor or the control deck.
    const base = zone.room ? this.nav.heightAt(x, z) ?? 0 : 0;
    const addPoints = (offsets: Array<[number, number]>, depth: number) => {
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      for (const [ox] of offsets) {
        // Local x along the cover, local z is its facing normal; enemies hide on -z, clones on +z.
        const toWorld = (px: number, pz: number) => new THREE.Vector2(x + px * cos + pz * sin, z - px * sin + pz * cos);
        this.enemyCover[zoneIndex].push({ position: toWorld(ox, -depth), zone: zoneIndex, taken: false });
        this.allyCover[zoneIndex].push({ position: toWorld(ox, depth), zone: zoneIndex, taken: false });
      }
    };
    if (kind === "pod") {
      this.pod(x, z, 1, this.random() * Math.PI * 2);
      this.nav.addCircle(x, z, 2.5, 7.8);
      this.enemyCover[zoneIndex].push({ position: new THREE.Vector2(x - 1.3, z - 3), zone: zoneIndex, taken: false }, { position: new THREE.Vector2(x + 1.3, z - 3), zone: zoneIndex, taken: false });
      this.allyCover[zoneIndex].push({ position: new THREE.Vector2(x - 1.3, z + 3), zone: zoneIndex, taken: false }, { position: new THREE.Vector2(x + 1.3, z + 3), zone: zoneIndex, taken: false });
    } else if (kind === "barricade") {
      const object = new THREE.Object3D();
      object.position.set(x, base + .58, z);
      object.rotation.y = rotation;
      b.add(new RoundedBoxGeometry(3.3, 1.16, .8, 3, .2), m.hull, object, { uvScale: 1 / 3 });
      object.position.y = base + 1.17;
      b.add(new THREE.BoxGeometry(2.6, .05, .3), m.trim, object);
      object.position.y = base + .98;
      b.add(new THREE.BoxGeometry(2.7, .06, .82), m.coolLight, object, { cast: false, shoot: false });
      this.nav.addBox(x, z, 3.5, 1.0, rotation, base + 1.16);
      addPoints([[-.9, 0], [.9, 0]], 1.05);
    } else if (kind === "crate") {
      const object = new THREE.Object3D();
      object.position.set(x, base + .5, z);
      object.rotation.y = rotation + this.random() * .6;
      b.add(new RoundedBoxGeometry(1.15, 1, 1.15, 2, .08), m.crate, object, { uvScale: 1 / 2 });
      object.position.y = base + .78;
      b.add(new THREE.BoxGeometry(1.17, .1, 1.17), m.hazard, object);
      this.nav.addCircle(x, z, .85, base + 1);
      addPoints([[0, 0]], 1.05);
    } else if (kind === "tank") {
      // Growth tank: lit fluid column with a dark figure inside, plumbed into the ceiling.
      const top = zone.room?.ceiling ?? 8;
      b.place(new THREE.CylinderGeometry(1.4, 1.55, .6, 28), m.hullDark, { x, y: base + .3, z }, undefined, undefined, { uvScale: 1 / 2 });
      b.place(new THREE.TorusGeometry(1.43, .04, 4, 40).rotateX(Math.PI / 2), m.coolLight, { x, y: base + .62, z }, undefined, undefined, { cast: false, shoot: false });
      b.place(new THREE.CylinderGeometry(1.05, 1.05, 4.1, 28, 1, true), m.tankFluid, { x, y: base + 2.65, z }, undefined, undefined, { cast: false });
      b.place(new THREE.CylinderGeometry(1.18, 1.18, 4.3, 28, 1, true), m.tankGlass, { x, y: base + 2.75, z }, undefined, undefined, { cast: false, shoot: false });
      b.place(new THREE.SphereGeometry(.42, 14, 10), m.window, { x, y: base + 2.7, z }, [(this.random() - .5) * .3, 0, (this.random() - .5) * .3], { x: .75, y: 1.7, z: .75 }, { cast: false, shoot: false });
      b.place(new THREE.CylinderGeometry(1.25, 1.4, .7, 28), m.hullDark, { x, y: base + 5.25, z }, undefined, undefined, { uvScale: 1 / 2 });
      b.place(new THREE.TorusGeometry(1.2, .035, 4, 40).rotateX(Math.PI / 2), m.warmLight, { x, y: base + 4.88, z }, undefined, undefined, { cast: false, shoot: false });
      for (const s of [-1, 1]) {
        const length = top - base - 5.6;
        b.place(new THREE.CylinderGeometry(.11, .11, length, 8), m.trim, { x: x + s * .55, y: base + 5.6 + length / 2, z }, undefined, undefined, { shoot: false });
      }
      this.nav.addCircle(x, z, 1.45, top);
      for (const s of [-1, 1]) {
        this.enemyCover[zoneIndex].push({ position: new THREE.Vector2(x + s * .9, z - 2.1), zone: zoneIndex, taken: false });
        this.allyCover[zoneIndex].push({ position: new THREE.Vector2(x + s * .9, z + 2.1), zone: zoneIndex, taken: false });
      }
    } else if (kind === "console") {
      const object = new THREE.Object3D();
      object.position.set(x, base + .55, z);
      object.rotation.y = rotation;
      b.add(new THREE.BoxGeometry(2.6, 1.1, .9), m.hullDark, object, { uvScale: 1 / 2 });
      object.position.y = base + 1.13;
      b.add(new THREE.BoxGeometry(2.3, .03, .62), m.coolLight, object, { cast: false, shoot: false });
      this.nav.addBox(x, z, 2.8, 1.1, rotation, base + 1.1);
      addPoints([[-.8, 0], [.8, 0]], 1.05);
    } else if (kind === "dais") {
      const steps = [[DAIS.outerRadius, .35], [(DAIS.outerRadius + DAIS.innerRadius) / 2, .7], [DAIS.innerRadius, DAIS.height]] as const;
      for (const [radius, height] of steps) {
        b.place(new THREE.CylinderGeometry(radius, radius, height, 64), m.hull, { x, y: height / 2, z }, undefined, undefined, { uvScale: 1 / 4 });
        b.place(new THREE.TorusGeometry(radius - .05, .03, 4, 64).rotateX(Math.PI / 2), m.coolLight, { x, y: height + .005, z }, undefined, undefined, { cast: false, shoot: false });
      }
      b.place(new THREE.CircleGeometry(DAIS.innerRadius - .1, 64).rotateX(-Math.PI / 2), m.deckRaised, { x, y: DAIS.height + .01, z }, undefined, undefined, { uvScale: 1 / 6 });
      // Hologram table at the centre of the plaza.
      b.place(new THREE.CylinderGeometry(.9, 1.2, .9, 24), m.hullDark, { x, y: DAIS.height + .45, z });
      b.place(new THREE.CylinderGeometry(.85, .85, .04, 24), m.coolLight, { x, y: DAIS.height + .92, z }, undefined, undefined, { cast: false });
      this.nav.addCircle(x, z, 1.25, DAIS.height + .9);
    }
  }

  /** Kaminoan pod tower: flared base, slotted windows, domed cap and antenna cluster. */
  private pod(x: number, z: number, s: number, doorAngle: number, baseY = 0): void {
    const b = this.batcher, m = this.m;
    const profile = [
      [2.45, 0], [2.4, .3], [2.05, .62], [2, 4.8], [2.35, 5.25], [2.42, 5.6], [2.2, 6.2], [1.65, 7], [.95, 7.5], [.4, 7.76], [0, 7.8],
    ].map(([r, y]) => new THREE.Vector2(r * s, y * s));
    b.place(new THREE.LatheGeometry(profile, 40), m.hull, { x, y: baseY, z }, undefined, undefined, { uv: "keep", uvScale: [4, 1] });
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * Math.PI * 2;
      if (Math.abs(normalizeAngle(a - doorAngle + Math.PI) - Math.PI) < .3) continue;
      const lit = this.random() < .22;
      b.place(new THREE.BoxGeometry(.2 * s, 3.1 * s, .08), lit ? m.windowLit : m.window,
        { x: x + Math.cos(a) * 2.02 * s, y: baseY + 2.85 * s, z: z + Math.sin(a) * 2.02 * s }, [0, -a - Math.PI / 2, 0], undefined, { cast: false });
    }
    b.place(new THREE.BoxGeometry(1.1 * s, 2.2 * s, .12), m.window, { x: x + Math.cos(doorAngle) * 2.02 * s, y: baseY + 1.15 * s, z: z + Math.sin(doorAngle) * 2.02 * s }, [0, -doorAngle - Math.PI / 2, 0], undefined, { cast: false });
    b.place(new THREE.TorusGeometry(2.38 * s, .045, 4, 48).rotateX(Math.PI / 2), m.warmLight, { x, y: baseY + 5.42 * s, z }, undefined, undefined, { cast: false, shoot: false });
    b.place(new THREE.TorusGeometry(2.43 * s, .04, 4, 48).rotateX(Math.PI / 2), m.coolLight, { x, y: baseY + .12, z }, undefined, undefined, { cast: false, shoot: false });
    const antennas: Array<[number, number, number]> = [[.25, 3.2, .3], [-.3, 2.3, -.2], [.05, 1.6, -.45]];
    for (const [ox, h, oz] of antennas) {
      b.place(new THREE.CylinderGeometry(.04 * s, .08 * s, h * s, 6), m.trim, { x: x + ox * s, y: baseY + (7.6 + h / 2) * s, z: z + oz * s }, undefined, undefined, { shoot: false });
      b.place(new THREE.SphereGeometry(.09 * s, 8, 6), m.warmLight, { x: x + ox * s, y: baseY + (7.6 + h) * s, z: z + oz * s }, undefined, undefined, { cast: false, shoot: false });
    }
  }

  private floodlight(zone: Zone, index: number): void {
    const b = this.batcher, m = this.m;
    const angle = [Math.PI * .25, -Math.PI * .2, Math.PI * .8, Math.PI * .15, Math.PI * .72][index] ?? Math.PI * .25;
    const r = zone.radius - .9;
    const x = zone.center.x + Math.cos(angle) * r, z = zone.center.y + Math.sin(angle) * r;
    const height = 11;
    b.place(new THREE.CylinderGeometry(.18, .32, height, 12), m.hullDark, { x, y: height / 2, z });
    b.place(new THREE.CylinderGeometry(.55, .55, .25, 16), m.hullDark, { x, y: .12, z });
    const head = new THREE.Vector3(x - Math.cos(angle) * .6, height + .2, z - Math.sin(angle) * .6);
    const target = new THREE.Vector3(zone.center.x - Math.cos(angle) * 3, 0, zone.center.y - Math.sin(angle) * 3);
    const holder = new THREE.Object3D();
    holder.position.copy(head);
    holder.lookAt(target);
    b.add(new THREE.BoxGeometry(1.4, .5, .5), m.hullDark, holder);
    const lens = new THREE.Object3D();
    lens.position.set(0, 0, .26);
    holder.add(lens);
    b.add(new THREE.PlaneGeometry(1.25, .38), m.warmLight, lens, { cast: false, shoot: false });
    this.nav.addCircle(x, z, .45, height);

    const spot = new THREE.SpotLight(0xffe4c0, 210, 60, .62, .85, 1.6);
    spot.position.copy(head);
    spot.target.position.copy(target);
    this.scene.add(spot, spot.target);
    this.spotLights.push(spot);

    // The visible beam itself comes from the volumetric light pass.
  }

  private captureMarker(zone: Zone): void {
    const group = new THREE.Group();
    const y = zone.id === "C" ? DAIS.height + .02 : .03;
    group.position.set(zone.capture.x, y, zone.capture.y);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(.4, 1.6, 2.4), transparent: true, opacity: .9, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.3, 4.55, 96).rotateX(-Math.PI / 2), ringMaterial);
    const fill = new THREE.Mesh(new THREE.RingGeometry(0, 4.3, 96, 1, 0, .001).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(.3, 1.2, 1.9), transparent: true, opacity: .22, depthWrite: false, side: THREE.DoubleSide }));
    fill.position.y = .005;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 9, 64, 1, true), lightConeMaterial(0x7fdcff, .12));
    (beam.material as THREE.ShaderMaterial).uniforms.uStrength.value = .3;
    beam.geometry.rotateX(Math.PI);
    beam.position.y = 4.5;
    if (zone.room) {
      // Keep the column under the ceiling.
      const height = Math.min(9, zone.room.ceiling - .3);
      beam.scale.y = height / 9;
      beam.position.y = height / 2;
      group.position.y = .07;
    }
    group.add(ring, fill, beam);
    group.visible = false;
    this.scene.add(group);
    this.captureMarkers.push({ group, ring, beam, fill });
  }

  private parkedGunship(): void {
    const zone = ZONES[0];
    const { group, blinkers } = buildGunship(this.m);
    group.position.set(zone.center.x - 8.5, 0, zone.center.y - 1);
    group.rotation.y = .2;
    this.batcher.addObject(group, { uv: "keep" });
    // Hull only: the wings are high enough to walk under.
    this.nav.addBox(group.position.x, group.position.z + 1, 4.2, 17, group.rotation.y, 6);
    void blinkers;
    const bayLight = new THREE.PointLight(0xff4a3a, 6, 9, 2);
    bayLight.position.set(group.position.x + 2.8, 2.4, group.position.z);
    this.scene.add(bayLight);
  }

  private parkedLander(): void {
    const { group, lights, solids, rampEnd, rampStart, rampHeight } = buildLander(this.m);
    group.position.set(LANDER.x, 0, LANDER.z);
    this.batcher.addObject(group, { cast: true, uvScale: 1 / 5 });
    void lights;
    for (const solid of solids) {
      const center = solid.getCenter(new THREE.Vector3()), size = solid.getSize(new THREE.Vector3());
      this.nav.addBox(LANDER.x + center.x, LANDER.z + center.z, size.x, size.z, 0, solid.max.y);
    }
    // Ramp side rails keep droids flowing out of the front.
    for (const s of [-1, 1]) this.nav.addBox(LANDER.x + s * 1.9, LANDER.z + rampEnd - 3.5, .4, 7, 0, 2);
    // Begin just inside the hold so the hull hides creation; the first visible frame is an exit.
    this.landerDeployment.start.set(LANDER.x, rampHeight, LANDER.z + rampStart - .8);
    this.landerDeployment.exit.set(LANDER.x, 0, LANDER.z + rampEnd + .15);
    const interior = new THREE.PointLight(0xff9a50, 30, 14, 2);
    interior.position.set(LANDER.x, 2.6, LANDER.z + rampEnd - 5.5);
    this.scene.add(interior);
  }

  // ---------------------------------------------------------------- landmarks

  private greatDome(cx: number, cz: number): void {
    const b = this.batcher, m = this.m;
    const baseY = -1.2;
    this.platform(cx, cz, 34, baseY, [], "TIPOCA", 91, false);
    const profile = [
      [26.4, 0], [26.6, .8], [26.2, 2.2], [25.6, 3.6], [24.4, 6], [22.3, 9.2], [19.5, 12.3], [15.8, 15.2], [11.2, 17.5], [6, 19], [2.5, 19.5], [0, 19.6],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    b.place(new THREE.LatheGeometry(profile, 96), m.hull, { x: cx, y: baseY, z: cz }, undefined, undefined, { uv: "keep", uvScale: [14, 3] });
    // Ribs follow the dome curve.
    const ribCurve = new THREE.CatmullRomCurve3(profile.slice(0, -1).map((p) => new THREE.Vector3(p.x + .25, p.y + .1, 0)));
    for (let i = 0; i < 24; i++) {
      const rib = new THREE.Object3D();
      rib.position.set(cx, baseY, cz);
      rib.rotation.y = i / 24 * Math.PI * 2;
      b.add(new THREE.TubeGeometry(ribCurve, 40, .22, 5, false), m.trim, rib, { uvScale: .5 });
    }
    // Window bands.
    for (const [r, y, lit] of [[26.62, 1.4, m.windowLit], [25.95, 2.9, m.coolLight], [23.7, 7.1, m.windowLit], [19.9, 12, m.warmLight]] as const) {
      b.place(new THREE.TorusGeometry(r, .14, 6, 160).rotateX(Math.PI / 2), lit, { x: cx, y: baseY + y, z: cz }, undefined, undefined, { cast: false, shoot: false });
    }
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + .3;
      const door = new THREE.Object3D();
      door.position.set(cx + Math.cos(a) * 26.5, baseY + 2, cz + Math.sin(a) * 26.5);
      door.rotation.y = -a + Math.PI / 2;
      b.add(new THREE.BoxGeometry(4.2, 4, .6), m.window, door, { cast: false });
      door.translateZ(.32);
      door.translateY(2.1);
      b.add(new THREE.BoxGeometry(4.4, .12, .05), m.amberLight, door, { cast: false, shoot: false });
    }
    // Cupola and spire.
    b.place(new THREE.CylinderGeometry(3.4, 4, 2.4, 32), m.hullDark, { x: cx, y: baseY + 20.3, z: cz });
    b.place(new THREE.SphereGeometry(3.4, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.hull, { x: cx, y: baseY + 21.5, z: cz });
    b.place(new THREE.CylinderGeometry(.12, .3, 9, 8), m.trim, { x: cx, y: baseY + 29, z: cz });
    b.place(new THREE.SphereGeometry(.3, 8, 6), m.redLight, { x: cx, y: baseY + 33.6, z: cz }, undefined, undefined, { cast: false });
    b.place(new THREE.TorusGeometry(3.42, .08, 4, 48).rotateX(Math.PI / 2), m.coolLight, { x: cx, y: baseY + 21.4, z: cz }, undefined, undefined, { cast: false });

    // Crashed Separatist lander draped over the dome, still burning.
    const wreck = buildLander(this.m, true).group;
    wreck.position.set(cx - 13, baseY + 13.2, cz + 7);
    wreck.rotation.set(.25, 1.1, .62);
    wreck.scale.setScalar(1.15);
    b.addObject(wreck, { shoot: false, uvScale: 1 / 5 });
    this.crashFire.position.set(cx - 15, baseY + 17, cz + 8);
    this.scene.add(this.crashFire);
    this.crashSmokeOrigin.copy(this.crashFire.position);
    const texture = smokeTexture(7);
    for (let i = 0; i < 26; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: 0x1c2024, transparent: true, depthWrite: false, opacity: 0 }));
      this.scene.add(sprite);
      this.smoke.push({ sprite, age: this.random() * 9, life: 9, velocity: new THREE.Vector3(2.4 + this.random(), 3.2 + this.random() * 1.5, .6), start: this.crashSmokeOrigin.clone().add(new THREE.Vector3(this.random() * 3, 0, this.random() * 3)) });
    }

    for (let i = 0; i < 8; i++) {
      const a = Math.PI * .55 + i * .28;
      this.ambientPoints.push(new THREE.Vector3(cx + Math.cos(a) * 31, baseY + 1.3, cz + Math.sin(a) * 31));
    }
    // Satellite pods around the dome base.
    for (const a of [2.2, 2.75, 3.6, 4.3]) this.pod(cx + Math.cos(a) * 30.5, cz + Math.sin(a) * 30.5, .8, a + Math.PI, baseY);
  }

  /** Long administrative wing to the east with a leaning exhaust cone, like the hangar complex of Tipoca City. */
  private eastWing(): void {
    const b = this.batcher, m = this.m;
    const shape = new THREE.Shape();
    shape.moveTo(-26, -9);
    shape.lineTo(26, -9);
    shape.lineTo(26, 10);
    shape.lineTo(-12, 10);
    shape.quadraticCurveTo(-22, 9.5, -25, 4);
    shape.lineTo(-26.5, -2);
    shape.lineTo(-26, -9);
    const body = new THREE.ExtrudeGeometry(shape, { depth: 170, bevelEnabled: false, curveSegments: 8 });
    b.place(body, m.hull, { x: 118, y: 0, z: -140 }, undefined, undefined, { uvScale: 1 / 10, cast: false });
    for (let row = 0; row < 3; row++) {
      for (let z = -136; z < 28; z += 3.5 + this.random() * 6) {
        const length = 2 + this.random() * 9;
        b.place(new THREE.BoxGeometry(.1, .5, length), this.random() < .7 ? m.windowLit : m.coolLight, { x: 118 - 26.6, y: -6.5 + row * 2.2, z: z + length / 2 }, undefined, undefined, { cast: false, shoot: false });
      }
    }
    b.place(new THREE.BoxGeometry(.15, .12, 168), m.warmLight, { x: 118 - 24.9, y: 4.2, z: -55 }, [0, 0, -.62], undefined, { cast: false, shoot: false });
    for (const [x, z, s] of [[112, -18, 1], [125, -78, .8]] as const) {
      b.place(new THREE.BoxGeometry(12 * s, 1.6, 12 * s), m.hullDark, { x, y: 10.8, z });
      const vent = new THREE.Object3D();
      vent.position.set(x, 10 + 10 * s, z);
      vent.rotation.z = .22;
      b.add(new THREE.CylinderGeometry(1.2 * s, 4.6 * s, 20 * s, 32, 1, false), m.hull, vent, { cast: false, uvScale: 1 / 6 });
      vent.position.set(x - 2.2 * s, 10 + 20 * s, z);
      b.add(new THREE.CylinderGeometry(1.05 * s, 1.2 * s, .6, 24), m.hullDark, vent, { cast: false });
    }
    for (let z = -130; z < 30; z += 26) {
      b.place(new THREE.CylinderGeometry(2.5, 3, 30, 12), m.hullDark, { x: 118, y: OCEAN_LEVEL + 15, z }, undefined, undefined, { cast: false, shoot: false });
    }
  }

  private needleTower(x: number, z: number): void {
    const b = this.batcher, m = this.m;
    this.platform(x, z, 10, -2.5, [], "KAMINO", 77, false);
    b.place(new THREE.CylinderGeometry(.35, 3, 74, 24), m.hull, { x, y: -2.5 + 37, z }, undefined, undefined, { uv: "keep", uvScale: [3, 10] });
    for (const [y, r] of [[8, 2.75], [20, 2.35], [33, 1.9], [47, 1.45]] as const) {
      b.place(new THREE.TorusGeometry(r, .12, 6, 40).rotateX(Math.PI / 2), m.warmLight, { x, y, z }, undefined, undefined, { cast: false });
      b.place(new THREE.CylinderGeometry(r + .25, r + .45, .6, 32), m.hullDark, { x, y: y - .4, z });
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(.45, 10, 8), this.m.redLight.clone());
    beacon.position.set(x, 72, z);
    this.scene.add(beacon);
    this.blinkers.push(beacon);
    this.pod(x + 6, z + 2, .7, 0, -2.5);
  }

  private decorPlatforms(): void {
    const spots: Array<[number, number, number, number]> = [
      [-38, 32, 9, -1.5], [-44, 74, 8, -3], [30, 50, 8, -2], [24, 92, 10, -4], [36, -80, 9, -2.5],
      [32, -122, 11, -4], [-26, -112, 12, -3], [-34, -66, 9, -1.8], [-28, 108, 9, -5], [44, 18, 6, -1],
    ];
    spots.forEach(([x, z, r, y], index) => {
      this.batcher.chunk = `decor${index}`;
      this.platform(x, z, r, y, [], `K-${index + 10}`, 200 + index, false);
      this.ambientPoints.push(new THREE.Vector3(x, y + 1.3, z), new THREE.Vector3(x + r * .5, y + 1.3, z - r * .4));
      if (r > 7) this.pod(x + r * .25, z - r * .2, .75 + this.random() * .3, this.random() * 6, y);
      for (let i = 0; i < 3; i++) {
        const a = this.random() * Math.PI * 2, d = r * .55;
        this.batcher.place(new THREE.CylinderGeometry(.12, .16, 2.6, 8), this.m.hullDark, { x: x + Math.cos(a) * d, y: y + 1.3, z: z + Math.sin(a) * d }, undefined, undefined, { shoot: false });
        this.batcher.place(new THREE.SphereGeometry(.16, 8, 6), this.m.warmLight, { x: x + Math.cos(a) * d, y: y + 2.65, z: z + Math.sin(a) * d }, undefined, undefined, { cast: false, shoot: false });
      }
    });
    // Decorative walkways linking the outer platforms.
    const links: Array<[number, number]> = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 8], [2, 9]];
    for (const [i, j] of links) {
      const [x0, z0, r0, y0] = spots[i], [x1, z1, r1, y1] = spots[j];
      const a = new THREE.Vector3(x0, y0, z0), c = new THREE.Vector3(x1, y1, z1);
      const dir = c.clone().sub(a);
      const flat = new THREE.Vector2(dir.x, dir.z);
      const span = flat.length() - r0 - r1 + 1;
      const start = a.clone().add(new THREE.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(r0 - .5));
      const end = c.clone().sub(new THREE.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(r1 - .5));
      const mid = start.clone().lerp(end, .5);
      const walk = new THREE.Object3D();
      walk.position.copy(mid).setY(mid.y - .25);
      walk.lookAt(end.x, end.y - .25, end.z);
      this.batcher.add(new THREE.BoxGeometry(3, .5, span), this.m.hullDark, walk, { uvScale: 1 / 4, shoot: false });
      for (const s of [-1, 1]) {
        walk.translateX(s * 1.4);
        walk.translateY(.75);
        this.batcher.add(new THREE.BoxGeometry(.2, 1, span), this.m.hull, walk, { shoot: false });
        walk.translateY(.1);
        walk.translateX(-s * .12);
        this.batcher.add(new THREE.BoxGeometry(.03, .05, span - .4), this.m.warmLight, walk, { cast: false, shoot: false });
        walk.translateX(s * .12);
        walk.translateY(-.85);
        walk.translateX(-s * 1.4);
      }
    }
  }

  /** Stilt saucers out to the horizon. */
  private distantCity(): void {
    const b = this.batcher, m = this.m;
    const options = { cast: false, receive: false, shoot: false } as const;
    for (let i = 0; i < 18; i++) {
      const angle = i / 18 * Math.PI * 2 + this.random() * .25;
      const distance = 190 + this.random() * 260;
      const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance - 20;
      const s = .8 + this.random() * 1.1;
      const top = 6 + this.random() * 18;
      b.place(new THREE.CylinderGeometry(2.2 * s, 3 * s, top - OCEAN_LEVEL, 12), m.hullDark, { x, y: (top + OCEAN_LEVEL) / 2, z }, undefined, undefined, options);
      const saucer = [[0, -3.2], [9, -2.4], [16.5, -.6], [18, 0], [17.4, 1], [12, 2.6], [5, 3.3], [0, 3.5]].map(([r, y]) => new THREE.Vector2(r * s, y * s));
      b.place(new THREE.LatheGeometry(saucer, 40), m.hull, { x, y: top, z }, undefined, undefined, { ...options, uv: "keep", uvScale: [6, 1] });
      b.place(new THREE.TorusGeometry(17.6 * s, .22 * s, 4, 64).rotateX(Math.PI / 2), m.windowLit, { x, y: top + .1, z }, undefined, undefined, options);
      b.place(new THREE.TorusGeometry(12 * s, .16 * s, 4, 64).rotateX(Math.PI / 2), m.coolLight, { x, y: top + 2.65 * s, z }, undefined, undefined, options);
      if (this.random() < .5) {
        b.place(new THREE.LatheGeometry(saucer.map((p) => p.clone().multiplyScalar(.55)), 32), m.hull, { x, y: top + 5 * s, z }, undefined, undefined, { ...options, uv: "keep", uvScale: [4, 1] });
        b.place(new THREE.CylinderGeometry(1.2 * s, 1.2 * s, 5 * s, 10), m.hullDark, { x, y: top + 3 * s, z }, undefined, undefined, options);
      }
      const spire = new THREE.Mesh(new THREE.SphereGeometry(.5 * s, 8, 6), this.m.redLight.clone());
      spire.position.set(x, top + 9 * s, z);
      this.scene.add(spire);
      this.blinkers.push(spire);
    }
  }

  // ---------------------------------------------------------------- animation

  private spawnFlyers(): void {
    for (let i = 0; i < 3; i++) {
      const gunship = buildGunship(this.m);
      gunship.group.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = false; object.receiveShadow = false; } });
      // A faint cone keeps the beam readable beyond the volumetric pass's range.
      const beam = new THREE.Mesh(new THREE.ConeGeometry(9, 46, 24, 1, true).translate(0, -23, 0), lightConeMaterial(0xdff4ff, .025));
      beam.rotation.x = -.5;
      gunship.searchlight.add(beam);
      this.searchBeams.push(beam);
      this.scene.add(gunship.group);
      this.flyers.push({
        group: gunship.group, blinkers: gunship.blinkers, gun: gunship.gun, radius: 95 + i * 38, height: 30 + i * 9,
        speed: (.075 - i * .012) * (i % 2 ? -1 : 1), phase: i * 2.1, center: new THREE.Vector2(10, -20), bank: i % 2 ? -.3 : .3,
      });
    }
  }

  /** Muzzle positions of the circling gunships' chin guns. */
  gunshipGuns(): THREE.Vector3[] {
    return this.flyers.map((flyer) => flyer.gun.getWorldPosition(new THREE.Vector3()));
  }

  update(delta: number, time: number): void {
    this.m.update(time);
    this.updateDoors(delta);
    for (const flyer of this.flyers) {
      const a = flyer.phase + time * flyer.speed;
      const x = flyer.center.x + Math.cos(a) * flyer.radius;
      const z = flyer.center.y + Math.sin(a) * flyer.radius;
      flyer.group.position.set(x, flyer.height + Math.sin(time * .4 + flyer.phase) * 2.5, z);
      const dir = Math.sign(flyer.speed);
      const tangent = new THREE.Vector3(-Math.sin(a) * dir, 0, Math.cos(a) * dir);
      flyer.group.rotation.set(0, Math.atan2(-tangent.x, -tangent.z), flyer.bank);
      const on = Math.sin(time * 6 + flyer.phase) > .6;
      flyer.blinkers.forEach((blinker) => blinker.visible = on);
    }
    const blink = Math.sin(time * 2.4) > .2;
    this.blinkers.forEach((blinker) => blinker.visible = blink);
    this.crashFire.intensity = 320 * (.75 + .25 * Math.sin(time * 13) * Math.sin(time * 7.3 + 1));
    for (const puff of this.smoke) {
      puff.age += delta;
      if (puff.age > puff.life) puff.age -= puff.life;
      const t = puff.age / puff.life;
      puff.sprite.position.copy(puff.start).addScaledVector(puff.velocity, puff.age);
      const s = 4 + t * 22;
      puff.sprite.scale.set(s, s, 1);
      puff.sprite.material.opacity = Math.sin(t * Math.PI) * .55;
      puff.sprite.material.rotation = t * 1.4;
    }
  }
}

function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}
