import * as THREE from "three";

/** Battlefield layout. The front runs along -Z: the player starts on Aurek pad and pushes the droids back to Dorn landing. */

export type ZoneId = "A" | "B" | "C" | "D" | "E";

export type CoverSpec = { kind: "barricade" | "crate" | "pod" | "dais"; x: number; z: number; rotation?: number };

export type Zone = {
  id: ZoneId;
  name: string;
  center: THREE.Vector2;
  radius: number;
  capture: THREE.Vector2;
  cover: CoverSpec[];
};

export type Bridge = {
  from: number;
  to: number;
  a: THREE.Vector2;
  b: THREE.Vector2;
  halfWidth: number;
  main: boolean;
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
    name: "Tipoca Cloning Facility",
    center: v(2, -142),
    radius: 27,
    capture: v(2, -146),
    cover: [
      { kind: "barricade", x: -9, z: 10 }, { kind: "barricade", x: 9, z: 10 }, { kind: "pod", x: -15, z: 1 },
      { kind: "pod", x: 15, z: 1 }, { kind: "crate", x: -8, z: -7 }, { kind: "crate", x: 8, z: -7 },
      { kind: "barricade", x: -11, z: -14, rotation: .3 }, { kind: "barricade", x: 11, z: -14, rotation: -.3 },
      { kind: "barricade", x: 0, z: -18 },
    ],
  },
];

export const BRIDGES: Bridge[] = [
  { from: 0, to: 1, a: v(0, 46.5), b: v(0, 31), halfWidth: 3, main: true },
  { from: 0, to: 1, a: v(-10, 50), b: v(-9, 28), halfWidth: 1.8, main: false },
  { from: 1, to: 2, a: v(-1, 5), b: v(-3, -13), halfWidth: 3, main: true },
  { from: 1, to: 2, a: v(9, 8), b: v(7, -19), halfWidth: 1.8, main: false },
  { from: 2, to: 3, a: v(-3, -43), b: v(0, -63), halfWidth: 3, main: true },
  { from: 2, to: 3, a: v(-15, -38), b: v(-11, -68), halfWidth: 1.8, main: false },
  { from: 3, to: 4, a: v(2, -110), b: v(2, -115), halfWidth: 4, main: true },
  { from: 3, to: 4, a: v(-17, -101), b: v(-18, -122), halfWidth: 1.8, main: false },
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
  { enemyZone: 4, quota: 24, maxAlive: 10, superDroids: 6, initial: 8 },
];

export const OCEAN_LEVEL = -38;

export type Quality = "low" | "medium" | "high";
