import * as THREE from "three";
import { BRIDGES, DAIS, ZONES, type Bridge } from "./config";

type CircleBlocker = { kind: "circle"; x: number; z: number; r: number; top: number };
type BoxBlocker = { kind: "box"; x: number; z: number; hw: number; hd: number; cos: number; sin: number; top: number };
export type Blocker = CircleBlocker | BoxBlocker;

export const STEP_HEIGHT = .45;
const EDGE_MARGIN = .55;
const OFFSETS: Array<[number, number]> = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [.7, .7], [-.7, .7], [.7, -.7], [-.7, -.7]];

/**
 * Analytic walkable space: circular platforms, bridge corridors, the Cresh dais and solid props.
 * Cheap enough to query many times per actor per frame.
 */
export class Navigation {
  readonly blockers: Blocker[] = [];

  addCircle(x: number, z: number, r: number, top: number): void {
    this.blockers.push({ kind: "circle", x, z, r, top });
  }

  addBox(x: number, z: number, width: number, depth: number, rotation: number, top: number): void {
    this.blockers.push({ kind: "box", x, z, hw: width / 2, hd: depth / 2, cos: Math.cos(rotation), sin: Math.sin(rotation), top });
  }

  /** Floor height of open walkable ground (ignoring props), or null over the void. */
  groundAt(x: number, z: number): number | null {
    for (const zone of ZONES) {
      const dx = x - zone.center.x, dz = z - zone.center.y;
      const d = Math.hypot(dx, dz);
      if (d <= zone.radius - EDGE_MARGIN) {
        if (zone.id === "C") {
          if (d <= DAIS.innerRadius) return DAIS.height;
          if (d < DAIS.outerRadius) return DAIS.height * (DAIS.outerRadius - d) / (DAIS.outerRadius - DAIS.innerRadius);
        }
        return 0;
      }
    }
    for (const bridge of BRIDGES) {
      if (distanceToSegment(x, z, bridge.a, bridge.b) <= bridge.halfWidth - .35) return 0;
    }
    return null;
  }

  /** Height of whatever is underfoot including props, or null over the void. */
  heightAt(x: number, z: number): number | null {
    const ground = this.groundAt(x, z);
    if (ground === null) return null;
    let height = ground;
    for (const blocker of this.blockers) {
      if (blocker.top > height && inside(blocker, x, z)) height = blocker.top;
    }
    return height;
  }

  /** Highest support under a disc of the given radius, or null if any part hangs over the void. */
  supportAt(x: number, z: number, radius: number): number | null {
    let best = -Infinity;
    for (const [ox, oz] of OFFSETS) {
      const h = this.heightAt(x + ox * radius, z + oz * radius);
      if (h === null) return null;
      if (h > best) best = h;
    }
    return best;
  }

  canStand(x: number, z: number, radius: number, feetY: number): boolean {
    const h = this.supportAt(x, z, radius);
    return h !== null && h - feetY <= STEP_HEIGHT;
  }

  /** Moves a disc across the level, sliding along obstacles. Returns true if any movement happened. */
  move(position: THREE.Vector3, dx: number, dz: number, radius: number): boolean {
    const feet = position.y;
    if (this.canStand(position.x + dx, position.z + dz, radius, feet)) {
      position.x += dx; position.z += dz;
      return true;
    }
    if (Math.abs(dx) > 1e-5 && this.canStand(position.x + dx, position.z, radius, feet)) {
      position.x += dx;
      return true;
    }
    if (Math.abs(dz) > 1e-5 && this.canStand(position.x, position.z + dz, radius, feet)) {
      position.z += dz;
      return true;
    }
    return false;
  }

  zoneAt(x: number, z: number): number {
    for (let i = 0; i < ZONES.length; i++) {
      const zone = ZONES[i];
      if (Math.hypot(x - zone.center.x, z - zone.center.y) <= zone.radius) return i;
    }
    return -1;
  }

  /** Bridge waypoints from one zone to an adjacent one, choosing the bridge closest to `near`. */
  route(fromZone: number, toZone: number, near: THREE.Vector2, preferSide = false): THREE.Vector2[] {
    const step = toZone > fromZone ? 1 : -1;
    const points: THREE.Vector2[] = [];
    let current = fromZone;
    let cursor = near.clone();
    while (current !== toZone) {
      const next = current + step;
      const options = BRIDGES.filter((bridge) => (bridge.from === Math.min(current, next) && bridge.to === Math.max(current, next)));
      let chosen: Bridge = options[0];
      let best = Infinity;
      for (const bridge of options) {
        const start = bridge.from === current ? bridge.a : bridge.b;
        const score = start.distanceTo(cursor) + (preferSide === !bridge.main ? 0 : 6);
        if (score < best) { best = score; chosen = bridge; }
      }
      const enter = chosen.from === current ? chosen.a : chosen.b;
      const exit = chosen.from === current ? chosen.b : chosen.a;
      points.push(enter.clone(), exit.clone());
      cursor = exit.clone();
      current = next;
    }
    return points;
  }
}

function inside(blocker: Blocker, x: number, z: number): boolean {
  const dx = x - blocker.x, dz = z - blocker.z;
  if (blocker.kind === "circle") return dx * dx + dz * dz <= blocker.r * blocker.r;
  const lx = dx * blocker.cos - dz * blocker.sin;
  const lz = dx * blocker.sin + dz * blocker.cos;
  return Math.abs(lx) <= blocker.hw && Math.abs(lz) <= blocker.hd;
}

export function distanceToSegment(x: number, z: number, a: THREE.Vector2, b: THREE.Vector2): number {
  const abx = b.x - a.x, abz = b.y - a.y;
  const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz), 0, 1);
  return Math.hypot(x - (a.x + abx * t), z - (a.y + abz * t));
}
