import * as THREE from "three";

/**
 * Battlefield layout. The front runs along -Z: the player starts on Aurek pad, pushes the droids back to
 * Dorn landing, then follows them into the Tipoca cloning facility.
 */

export type ZoneId = "A" | "B" | "C" | "D" | "E" | "F" | "G";

export type CoverSpec = { kind: "barricade" | "crate" | "pod" | "dais" | "console" | "tank"; x: number; z: number; rotation?: number };

/** A doorway droids walk out of: `start` is hidden behind the wall, `exit` is just inside the room. */
export type SpawnDoor = { start: THREE.Vector2; exit: THREE.Vector2 };

export type Zone = {
  id: ZoneId;
  name: string;
  center: THREE.Vector2;
  radius: number;
  capture: THREE.Vector2;
  cover: CoverSpec[];
  /** Indoor sectors are rectangular rooms (half extents) instead of round platforms. */
  room?: { hw: number; hd: number; ceiling: number };
  /** Indoor sectors are reinforced through these doors rather than from the landing craft. */
  spawns?: SpawnDoor[];
};

export type Bridge = {
  from: number;
  to: number;
  a: THREE.Vector2;
  b: THREE.Vector2;
  halfWidth: number;
  main: boolean;
  /** An interior doorway rather than a bridge over the sea: no deck is built and no rail gap is cut. */
  door?: boolean;
};

const v = (x: number, z: number) => new THREE.Vector2(x, z);

export const ZONES: Zone[] = [
  {
    id: "A",
    name: "Aurek Landing Pad",
    center: v(0, 62),
    radius: 17,
    capture: v(0, 62),
    cover: [
      { kind: "crate", x: 7, z: -8 }, { kind: "crate", x: 8.3, z: -7.2 }, { kind: "barricade", x: -3, z: -11 },
      { kind: "barricade", x: 9, z: -12, rotation: .5 }, { kind: "crate", x: 11, z: 3 }, { kind: "pod", x: 12.5, z: -2 },
    ],
  },
  {
    id: "B",
    name: "Besh Junction",
    center: v(0, 18),
    radius: 14,
    capture: v(0, 18),
    cover: [
      { kind: "pod", x: -8, z: -3 }, { kind: "pod", x: 8, z: 3 }, { kind: "barricade", x: -3.5, z: 6 },
      { kind: "barricade", x: 4, z: -4.5 }, { kind: "barricade", x: -6, z: -9, rotation: -.4 }, { kind: "crate", x: 6, z: 9 },
      { kind: "crate", x: 7.2, z: 9.6 }, { kind: "barricade", x: 9.5, z: -6, rotation: .5 }, { kind: "crate", x: -10, z: 5 },
    ],
  },
  {
    id: "C",
    name: "Cresh Plaza",
    center: v(-4, -28),
    radius: 16,
    capture: v(-4, -28),
    cover: [
      { kind: "dais", x: 0, z: 0 }, { kind: "pod", x: -11, z: -4 }, { kind: "pod", x: 11, z: 3 },
      { kind: "barricade", x: 6, z: -9 }, { kind: "barricade", x: -5, z: 9.5 }, { kind: "barricade", x: -10.5, z: 7, rotation: .6 },
      { kind: "barricade", x: 10.5, z: -8.5, rotation: -.5 }, { kind: "crate", x: 4, z: 10 }, { kind: "crate", x: -6, z: -11 },
      { kind: "barricade", x: 1, z: -12.5 },
    ],
  },
  {
    id: "D",
    name: "Dorn Landing Platform",
    center: v(2, -82),
    radius: 29,
    capture: v(2, -62),
    cover: [
      { kind: "barricade", x: -9, z: 15 }, { kind: "barricade", x: 9, z: 15 }, { kind: "barricade", x: -19, z: 3, rotation: .9 },
      { kind: "barricade", x: 20, z: 2, rotation: -.9 }, { kind: "crate", x: -7, z: 20 }, { kind: "crate", x: 7, z: 20 },
      { kind: "crate", x: -19, z: 11 }, { kind: "pod", x: 20, z: 12 }, { kind: "barricade", x: -6, z: 3 },
      { kind: "barricade", x: 8, z: 2, rotation: .3 }, { kind: "pod", x: -18, z: -9 }, { kind: "pod", x: 19, z: -11 },
      { kind: "barricade", x: -13, z: -17, rotation: -.4 }, { kind: "barricade", x: 14, z: -17, rotation: .35 },
      { kind: "crate", x: -5, z: -22 }, { kind: "crate", x: 6, z: -22 },
    ],
  },
  {
    id: "E",
    name: "Tipoca Facility Lobby",
    center: v(2, -142),
    radius: 27,
    capture: v(2, -146),
    cover: [
      { kind: "barricade", x: -9, z: 10 }, { kind: "barricade", x: 9, z: 10 }, { kind: "pod", x: -15, z: 1 },
      { kind: "pod", x: 15, z: 1 }, { kind: "crate", x: -8, z: -7 }, { kind: "crate", x: 8, z: -7 },
      { kind: "barricade", x: -11, z: -14, rotation: .3 }, { kind: "barricade", x: 11, z: -14, rotation: -.3 },
      // Kept off the centre line so the walk to the blast door stays clear.
      { kind: "barricade", x: -5, z: -11 }, { kind: "crate", x: 5.5, z: -12.5 },
    ],
    // Service doors in the back wall: once Dorn falls, the lander is behind the front line.
    spawns: [
      { start: v(-12, -163.2), exit: v(-12, -159.4) },
      { start: v(16, -163.2), exit: v(16, -159.4) },
    ],
  },
  {
    // A 6 m walkway with three pairs of alcoves; the solid blocks between them are the only cover.
    id: "F",
    name: "Security Corridor",
    center: v(2, -181),
    radius: 7,
    capture: v(2, -181),
    room: { hw: 7, hd: 20, ceiling: 4.4 },
    cover: [
      { kind: "barricade", x: 1.2, z: 15 }, { kind: "crate", x: 1.9, z: 6 }, { kind: "barricade", x: -1.2, z: -5 },
      { kind: "crate", x: 1.9, z: -15 },
    ],
    spawns: [
      { start: v(-6.8, -192), exit: v(-3.6, -192) },
      { start: v(10.8, -192), exit: v(7.6, -192) },
    ],
  },
  {
    // Tall growth-tank hall ending in a raised control deck under the storm windows.
    id: "G",
    name: "Cloning Hall",
    center: v(2, -229),
    radius: 22,
    capture: v(2, -232),
    room: { hw: 22, hd: 28, ceiling: 13 },
    cover: [
      ...[18, 10, 2, -6, -14].flatMap((z) => [-15, -8, 8, 15].map((x) => ({ kind: "tank" as const, x, z }))),
      { kind: "barricade", x: -1, z: 4 }, { kind: "barricade", x: 2, z: -9 }, { kind: "crate", x: 4.5, z: 14 },
      { kind: "crate", x: -4.5, z: -2 }, { kind: "console", x: -5, z: -21.5 }, { kind: "console", x: 5, z: -21.5 },
      { kind: "crate", x: 0, z: -24 },
    ],
    spawns: [
      { start: v(-21.8, -241), exit: v(-18, -241) },
      { start: v(25.8, -241), exit: v(22, -241) },
      { start: v(-16, -258.8), exit: v(-16, -254.5) },
      { start: v(20, -258.8), exit: v(20, -254.5) },
    ],
  },
];

/** Raised control deck at the far end of the cloning hall (walkable, one step up). */
export const CONTROL_DECK = { x: 2, z: -251.5, width: 22, depth: 7, height: .4 };

export const BRIDGES: Bridge[] = [
  { from: 0, to: 1, a: v(0, 46.5), b: v(0, 31), halfWidth: 3, main: true },
  { from: 0, to: 1, a: v(-10, 50), b: v(-9, 28), halfWidth: 1.8, main: false },
  { from: 1, to: 2, a: v(-1, 5), b: v(-3, -13), halfWidth: 3, main: true },
  { from: 1, to: 2, a: v(9, 8), b: v(7, -19), halfWidth: 1.8, main: false },
  { from: 2, to: 3, a: v(-3, -43), b: v(0, -63), halfWidth: 3, main: true },
  { from: 2, to: 3, a: v(-15, -38), b: v(-11, -68), halfWidth: 1.8, main: false },
  { from: 3, to: 4, a: v(2, -110), b: v(2, -115), halfWidth: 4, main: true },
  { from: 3, to: 4, a: v(-17, -101), b: v(-18, -122), halfWidth: 1.8, main: false },
  { from: 4, to: 5, a: v(2, -156), b: v(2, -166), halfWidth: 2, main: true, door: true },
  { from: 5, to: 6, a: v(2, -196), b: v(2, -206), halfWidth: 3, main: true, door: true },
];

/** Raised central dais in Cresh Plaza. */
export const DAIS = { innerRadius: 4.6, outerRadius: 6.8, height: 1.05 };

/** The Separatist landing craft parked on Dorn, droids pour out of its ramp. */
export const LANDER = { x: 2, z: -90, ramp: v(2, -75) };

export const PLAYER_START = new THREE.Vector3(5, 0, 74.5);

export type PhaseSpec = { enemyZone: number; quota: number; maxAlive: number; superDroids: number; initial: number };

export const PHASES: PhaseSpec[] = [
  { enemyZone: 1, quota: 14, maxAlive: 7, superDroids: 0, initial: 7 },
  { enemyZone: 2, quota: 20, maxAlive: 9, superDroids: 2, initial: 7 },
  { enemyZone: 3, quota: 30, maxAlive: 12, superDroids: 5, initial: 10 },
  { enemyZone: 4, quota: 18, maxAlive: 9, superDroids: 3, initial: 8 },
  { enemyZone: 5, quota: 16, maxAlive: 7, superDroids: 2, initial: 6 },
  { enemyZone: 6, quota: 24, maxAlive: 10, superDroids: 5, initial: 9 },
];

/** Phase index of the first fight inside the facility (the lobby). */
export const FACILITY_PHASE = 3;

export const OCEAN_LEVEL = -38;

export type Quality = "low" | "medium" | "high";
