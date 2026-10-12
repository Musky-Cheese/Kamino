import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Materials } from "./materials";
import { hasModel, instantiate } from "./models";

/** Box whose cross-section scales linearly from the back (+z) to the front (-z). */
export function taperedBox(w: number, h: number, l: number, frontX: number, frontY: number, backX = 1, backY = 1, segments = 3): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, l, 1, 1, segments);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const t = position.getZ(i) / l + .5;
    position.setX(i, position.getX(i) * THREE.MathUtils.lerp(frontX, backX, t));
    position.setY(i, position.getY(i) * THREE.MathUtils.lerp(frontY, backY, t));
  }
  geometry.computeVertexNormals();
  return geometry;
}

function mesh(group: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

export type Gunship = { group: THREE.Group; blinkers: THREE.Mesh[]; searchlight: THREE.Object3D; /** Chin gun muzzle. */ gun: THREE.Object3D };

function anchor(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  const object = new THREE.Object3D();
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}

/** Republic LAAT/i gunship, nose toward -Z, hull resting on y = 0. */
export function buildGunship(m: Materials): Gunship {
  if (!hasModel("gunship")) return buildProceduralGunship(m);
  // The export faces +Z and is rolled 13.6° about its long axis.
  const g = instantiate("gunship", { rotation: [0, Math.PI, THREE.MathUtils.degToRad(-13.64)], length: 17.5 });
  const blinkers = [-1, 1].map((s) => mesh(g, new THREE.SphereGeometry(.12, 8, 6), s < 0 ? m.redLight : m.coolLight, s * 8.6, 2.15, 2.6));
  return { group: g, blinkers, searchlight: anchor(g, 0, .6, -6.2), gun: anchor(g, 0, .95, -8.9) };
}

function buildProceduralGunship(m: Materials): Gunship {
  const g = new THREE.Group();
  const white = m.repWhite;
  mesh(g, new RoundedBoxGeometry(3.4, 3, 7.5, 2, .35), white, 0, 2.3, .6);
  mesh(g, taperedBox(3.2, 2.8, 4.2, .45, .5), white, 0, 2.5, -5.2);
  const chin = mesh(g, new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.canopy, 0, 1.75, -6.4, Math.PI * .58);
  chin.scale.set(1.05, .75, 1.25);
  const canopy = mesh(g, new THREE.SphereGeometry(.9, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.canopy, 0, 3.7, -5.4, -.25);
  canopy.scale.set(1, .8, 1.6);
  mesh(g, taperedBox(2.6, 1.3, 9, .5, .6, .7, .8), white, 0, 4.25, .2);
  mesh(g, taperedBox(1.3, 1.2, 7, 1, 1, .4, .5), white, 0, 3.9, 7.4);
  mesh(g, new THREE.BoxGeometry(.25, 2.4, 2.6), white, 0, 5.3, 10.2, -.45);
  mesh(g, new THREE.BoxGeometry(5.4, .18, 1.4), white, 0, 4.25, 10.4);
  const blinkers: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    mesh(g, taperedBox(7.6, .34, 3.4, 1, 1, 1, 1), white, s * 5.2, 4.55, .5, 0, s * .16, s * -.1);
    mesh(g, new THREE.CylinderGeometry(.36, .36, 3.4, 12), white, s * 8.8, 4.05, .3, Math.PI / 2);
    mesh(g, new THREE.ConeGeometry(.36, .7, 12), m.repRed, s * 8.8, 4.05, -1.75, -Math.PI / 2);
    blinkers.push(mesh(g, new THREE.SphereGeometry(.12, 8, 6), s < 0 ? m.redLight : m.coolLight, s * 8.8, 4.45, 1.9));
    const turret = mesh(g, new THREE.SphereGeometry(.95, 18, 12), m.canopy, s * 2.05, 3.55, 3.5);
    turret.scale.set(1, 1, 1.05);
    mesh(g, new THREE.CylinderGeometry(.06, .06, 1.6, 8), m.sepDark, s * 2.3, 3.55, 2.4, Math.PI / 2);
    mesh(g, new THREE.BoxGeometry(.1, 1.95, 4), m.hullDark, s * 1.71, 2.15, .8);
    mesh(g, new THREE.BoxGeometry(.06, .1, 3.7), m.redLight, s * 1.68, 3.05, .8);
    mesh(g, new THREE.BoxGeometry(.06, .45, 2.8), m.repRed, s * 1.46, 2.95, -4.7, 0, s * .16);
    mesh(g, new THREE.BoxGeometry(.06, .3, 6), m.repRed, s * 1.72, 1.2, .6);
    mesh(g, new THREE.BoxGeometry(.3, .25, 6.5), m.sepDark, s * 1.1, .12, .3);
    for (const z of [-2.2, 2.6]) mesh(g, new THREE.CylinderGeometry(.09, .09, .9, 6), m.sepDark, s * 1.1, .55, z);
    mesh(g, new THREE.CylinderGeometry(.08, .08, 1.5, 8), m.sepDark, s * .7, 4.95, -3.6, Math.PI / 2);
  }
  const searchlight = new THREE.Object3D();
  searchlight.position.set(0, 1.2, -6.8);
  g.add(searchlight);
  return { group: g, blinkers, searchlight, gun: anchor(g, 0, 1, -7.5) };
}

/**
 * Republic ARC-170 style starfighter, built from primitives: long nose, split wings with heavy cannons
 * along the roots, twin tail fins and two engines. Nose toward -Z, about 13 m long.
 */
export function buildRepublicFighter(m: Materials): { group: THREE.Group; guns: THREE.Object3D[] } {
  const g = new THREE.Group();
  const cyl = (r0: number, r1: number, h: number, seg = 12) => new THREE.CylinderGeometry(r0, r1, h, seg).rotateX(Math.PI / 2);
  const engineGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.6, .7), toneMapped: false });
  mesh(g, taperedBox(1.7, 1.2, 8, .5, .65), m.repWhite, 0, 0, 0);
  mesh(g, taperedBox(1.05, .8, 3, .25, .35), m.repWhite, 0, -.05, -5.5);
  mesh(g, new THREE.SphereGeometry(.55, 12, 8), m.canopy, 0, .55, -2.6).scale.set(1, .7, 2.2);
  mesh(g, new THREE.SphereGeometry(.4, 10, 6), m.canopy, 0, .5, 2.4).scale.set(1, .7, 1.4);
  // Command stripes along the nose.
  for (const sx of [-1, 1]) mesh(g, new THREE.BoxGeometry(.06, .5, 3.6), m.repRed, sx * .62, .05, -3.4, 0, sx * .06);
  const guns: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    // Split S-foil wings, slightly open.
    for (const sy of [-1, 1]) {
      const wing = mesh(g, taperedBox(5.6, .14, 2.8, 1, .8, 1, 1), m.repWhite, sx * 3.9, sy * .22, 1.2, 0, 0, sx * sy * .07);
      wing.castShadow = false;
      mesh(g, new THREE.BoxGeometry(1.4, .16, 2.4), m.repRed, sx * 6.2, sy * .22 + sx * sy * .17, 1.25, 0, 0, sx * sy * .07);
    }
    // Wing-root laser cannons.
    mesh(g, cyl(.32, .36, 5.2), m.repWhite, sx * 1.75, 0, -2.2);
    mesh(g, cyl(.13, .13, 2.2), m.sepDark, sx * 1.75, 0, -5.8);
    guns.push(anchor(g, sx * 1.75, 0, -7));
    // Tail fins.
    mesh(g, taperedBox(.14, 2.4, 2.2, 1, .7), m.repWhite, sx * 1.05, 1.35, 3.3, 0, 0, sx * -.18);
    mesh(g, new THREE.BoxGeometry(.16, .5, 1.4), m.repRed, sx * 1.25, 2.3, 3.5, 0, 0, sx * -.18);
    // Engines.
    mesh(g, cyl(.42, .5, 2.2), m.sepDark, sx * .62, -.1, 4);
    mesh(g, new THREE.CircleGeometry(.38, 14), engineGlow, sx * .62, -.1, 5.12);
  }
  g.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = false; object.receiveShadow = false; } });
  return { group: g, guns };
}

type Fighter = { group: THREE.Group; guns: THREE.Object3D[] };

/**
 * A loaded starfighter turned nose toward -Z and sized to `length`, with gun anchors placed as fractions
 * of its bounds: x and y in half-widths from the centre, z along the length from the nose (0) to the tail (1).
 */
function loadedFighter(name: "arc170" | "v19" | "trifighter", length: number, guns: Array<[number, number, number]>): Fighter {
  const group = instantiate(name, { rotation: [0, Math.PI, 0], length, centerY: true, shadows: false });
  const box = new THREE.Box3().setFromObject(group, true);
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
  const center = box.getCenter(new THREE.Vector3());
  return {
    group,
    guns: guns.map(([x, y, z]) => anchor(group, center.x + x * half.x, center.y + y * half.y, box.min.z + z * half.z * 2)),
  };
}

/** Republic ARC-170 heavy fighter: wing-tip cannons. */
export function buildArc170(m: Materials): Fighter {
  if (!hasModel("arc170")) return buildRepublicFighter(m);
  return loadedFighter("arc170", 14, [[-.93, -.1, .05], [.93, -.1, .05]]);
}

/** Republic V-19 Torrent: light, quick interceptor with cannons on its folded wing tips. */
export function buildV19(m: Materials): Fighter {
  if (!hasModel("v19")) {
    const fallback = buildRepublicFighter(m);
    fallback.group.scale.setScalar(.6);
    return fallback;
  }
  return loadedFighter("v19", 8, [[-.92, -.6, 0], [.92, -.6, 0]]);
}

/** Separatist droid tri-fighter: three arms, a cannon at each tip, plus the nose gun. */
export function buildTriFighter(m: Materials): Fighter {
  if (!hasModel("trifighter")) return buildVulture(m);
  return loadedFighter("trifighter", 7, [[0, .95, .1], [-.85, -.6, .1], [.85, -.6, .1], [0, 0, 0]]);
}

/** Separatist vulture droid in flight mode: a narrow body with four blade wings in an X, red photoreceptors. Nose toward -Z. */
export function buildVulture(m: Materials): { group: THREE.Group; guns: THREE.Object3D[] } {
  if (!hasModel("vulture")) return buildProceduralVulture(m);
  const g = instantiate("vulture", { length: 8, centerY: true, shadows: false });
  // Blaster cannons at the forward tips of the four blade wings.
  const guns = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => anchor(g, sx * 1.9, sy * .7, -4)));
  return { group: g, guns };
}

function buildProceduralVulture(m: Materials): { group: THREE.Group; guns: THREE.Object3D[] } {
  const g = new THREE.Group();
  const body = mesh(g, taperedBox(.9, .9, 4.6, .5, .55), m.sepHull, 0, 0, 0);
  body.castShadow = false;
  mesh(g, new THREE.SphereGeometry(.55, 12, 8), m.sepDark, 0, 0, -2.3).scale.set(1, .8, 1.3);
  for (const s of [-1, 1]) mesh(g, new THREE.SphereGeometry(.12, 8, 6), m.redLight, s * .25, .12, -2.95);
  mesh(g, new THREE.CylinderGeometry(.34, .44, .6, 12), m.sepDark, 0, 0, 2.5, Math.PI / 2);
  mesh(g, new THREE.CircleGeometry(.32, 12), m.amberLight, 0, 0, 2.81);
  const guns: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const wing = new THREE.Group();
      wing.position.set(sx * .4, sy * .25, .3);
      wing.rotation.z = sx * sy * .38;
      g.add(wing);
      mesh(wing, taperedBox(3.6, .1, 1.5, 1, 1, 1, 1), m.sepHull, sx * 1.9, 0, 0, 0, sx * -.18, 0);
      mesh(wing, new THREE.BoxGeometry(.18, .18, 1.6), m.sepDark, sx * 3.7, 0, -.4);
      const gun = new THREE.Object3D();
      gun.position.set(sx * 3.7, 0, -1.3);
      wing.add(gun);
      guns.push(gun);
    }
  }
  g.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = false; object.receiveShadow = false; } });
  return { group: g, guns };
}

export type Lander = {
  group: THREE.Group;
  lights: THREE.Mesh[];
  /** Local-space collision footprint: the hull, then whatever stands on the deck (feet, struts). */
  solids: THREE.Box3[];
  /** Local z where the boarding ramp meets the deck. */
  rampEnd: number;
  /** Local z and deck height at the doorway end of the boarding ramp. */
  rampStart: number;
  rampHeight: number;
};

const luminance = (c: THREE.Color) => c.r * .3 + c.g * .59 + c.b * .11;

/**
 * The C-9979 export is flat colours (wings) plus low-res textures (fuselage). Re-skin it with the
 * game's weathered Separatist materials: greys and textured parts become hull plating, dark parts
 * dark metal, saturated accents keep their colour. Returns the fuselage bounds in `root` space.
 */
function reskinLander(m: Materials, root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const fuselage = new THREE.Box3();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const source = object.material as THREE.MeshStandardMaterial;
    const wing = source.name.startsWith("Color_");
    if (!wing) fuselage.expandByObject(object, true);
    const c = source.color;
    const saturated = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > .15;
    if (source.map) object.material = m.sepHull;
    else if (saturated) return;
    else object.material = luminance(c) >= .08 && source.name !== "Color_I20" ? m.sepHull : m.sepDark;
  });
  return fuselage;
}

/** Bounds of the vertices within `height` of the ground, split into left and right clusters. */
function groundContacts(root: THREE.Object3D, height: number): THREE.Box3[] {
  const sides = [new THREE.Box3(), new THREE.Box3()];
  const v = new THREE.Vector3();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      if (v.y < height) sides[v.x < 0 ? 0 : 1].expandByPoint(v);
    }
  });
  return sides.filter((box) => !box.isEmpty());
}

/** Separatist C-9979 landing craft. Nose and boarding ramp face +Z. `crashed` sets it burning instead of landed. */
export function buildLander(m: Materials, crashed = false): Lander {
  if (!hasModel("lander")) return buildProceduralLander(m, crashed);
  // The export's fuselage runs along X with the nose at +X.
  const g = instantiate("lander", { rotation: [0, -Math.PI / 2, 0], length: 14 });
  const fuselage = reskinLander(m, g);
  const all = new THREE.Box3().setFromObject(g, true);
  const lights: THREE.Mesh[] = [];
  for (const s of [-1, 1]) lights.push(mesh(g, new THREE.SphereGeometry(.16, 8, 6), m.redLight, s * (all.max.x - .4), all.max.y * .55, all.getCenter(new THREE.Vector3()).z));
  lights.push(mesh(g, new THREE.SphereGeometry(.18, 8, 6), m.redLight, 0, all.max.y + .1, fuselage.getCenter(new THREE.Vector3()).z));
  const front = fuselage.max.z, sill = Math.max(fuselage.min.y, .3);
  if (crashed) {
    const c = fuselage.getCenter(new THREE.Vector3());
    for (const [x, y, z, s] of [[.4, .5, .2, 1.4], [-.6, .3, -.3, 1], [.1, .7, .6, .8]] as const) {
      const fire = mesh(g, new THREE.SphereGeometry(s, 10, 8), m.fireGlow, c.x + x * fuselage.max.x, c.y + y, c.z + z * (front - c.z));
      fire.scale.y = .4;
    }
    return { group: g, lights, solids: [fuselage], rampEnd: front, rampStart: front, rampHeight: sill };
  }
  // Boarding ramp from the nose down to the deck, and a lit hold behind it.
  const run = Math.max(2.5, sill * 2.6);
  const ramp = mesh(g, new THREE.BoxGeometry(2.6, .2, Math.hypot(run, sill)), m.sepDark, 0, sill / 2, front + run / 2, Math.atan2(sill, run));
  ramp.castShadow = true;
  const width = fuselage.max.x - fuselage.min.x;
  mesh(g, new THREE.BoxGeometry(Math.min(2.4, width * .8), .08, .08), m.amberLight, 0, sill + 1.9, front - .05);
  return { group: g, lights, solids: [fuselage, ...groundContacts(g, .5)], rampEnd: front + run, rampStart: front, rampHeight: sill };
}

function buildProceduralLander(m: Materials, crashed: boolean): Lander {
  const g = new THREE.Group();
  const profile = [
    [0, -10], [1.5, -9.4], [2.7, -7.8], [3.35, -4.5], [3.55, 0], [3.35, 4], [2.7, 7], [1.7, 9], [.4, 10], [0, 10.05],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = mesh(g, new THREE.LatheGeometry(profile, 32).rotateX(Math.PI / 2), m.sepHull, 0, 3.4, 0);
  body.scale.set(1, .62, 1);
  mesh(g, taperedBox(2.2, 1.3, 12, .4, .5, .8, .8), m.sepHull, 0, 5.3, -1);
  const dome = mesh(g, new THREE.SphereGeometry(1.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), m.sepDark, 0, 5.9, 3.5);
  dome.scale.set(1, .6, 1.4);
  const lights: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    mesh(g, taperedBox(9, .45, 6.5, 1, 1, 1, 1), m.sepHull, s * 7, 4.6, -1.5, 0, s * .22, s * .1);
    mesh(g, new THREE.BoxGeometry(1.6, .9, 5.2), m.sepDark, s * 11, 4.05, -2.6, 0, s * .22);
    lights.push(mesh(g, new THREE.SphereGeometry(.14, 8, 6), m.redLight, s * 11.6, 4.6, .2));
    mesh(g, new THREE.CylinderGeometry(.5, .6, 2.6, 12), m.sepDark, s * 1.6, 3.4, -10.3, Math.PI / 2);
    mesh(g, new THREE.CircleGeometry(.42, 14), m.amberLight, s * 1.6, 3.4, -11.62, 0, Math.PI);
    if (!crashed) {
      const leg = mesh(g, new THREE.CylinderGeometry(.22, .3, 4.4, 8), m.sepDark, s * 10.6, 2.1, -2.4, 0, 0, s * -.08);
      leg.castShadow = true;
      mesh(g, new THREE.CylinderGeometry(.75, .9, .25, 12), m.sepDark, s * 10.8, .12, -2.4);
      mesh(g, new THREE.CylinderGeometry(.25, .3, 2.2, 8), m.sepDark, s * 1.8, 1.1, -6);
      mesh(g, new THREE.CylinderGeometry(.6, .7, .2, 10), m.sepDark, s * 1.8, .1, -6);
    }
  }
  lights.push(mesh(g, new THREE.SphereGeometry(.16, 8, 6), m.redLight, 0, 6.2, 3.5));

  if (crashed) {
    // Long jointed legs splayed across whatever it crashed onto.
    for (let i = 0; i < 4; i++) {
      const angle = -Math.PI * .8 + i * Math.PI * .53;
      let cursor = new THREE.Vector3(Math.cos(angle) * 2.5, 4, Math.sin(angle) * 5);
      const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const segments: Array<[number, number]> = [[7, .9], [9, -.2], [8, -.9]];
      for (const [length, rise] of segments) {
        const direction = outward.clone().multiplyScalar(length).setY(rise * length * .5);
        const end = cursor.clone().add(direction);
        const segment = new THREE.Mesh(new THREE.CylinderGeometry(.28, .38, length, 8), m.sepHull);
        segment.position.copy(cursor).lerp(end, .5);
        segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
        segment.castShadow = true;
        g.add(segment);
        mesh(g, new THREE.SphereGeometry(.55, 10, 8), m.sepDark, end.x, end.y, end.z);
        cursor = end;
      }
    }
    for (const [x, y, z, s] of [[1.5, 4.2, 2, 1.4], [-2.2, 3.8, -4, 1], [.4, 5, -7, .8]] as const) {
      const fire = mesh(g, new THREE.SphereGeometry(s, 10, 8), m.fireGlow, x, y, z);
      fire.scale.y = .4;
    }
  } else {
    // Boarding ramp down to the deck and a lit interior.
    mesh(g, new THREE.BoxGeometry(3.2, .22, 7.3), m.sepDark, 0, .98, 11.5, .258);
    mesh(g, new THREE.BoxGeometry(2.8, 2.1, 1.2), m.hullDark, 0, 2.5, 8.6);
    mesh(g, new THREE.BoxGeometry(2.4, .08, .08), m.amberLight, 0, 3.45, 9.25);
    for (const s of [-1, 1]) mesh(g, new THREE.BoxGeometry(.08, 1.6, .08), m.amberLight, s * 1.25, 2.5, 9.25);
  }
  const box = (x: number, z: number, w: number, l: number, h: number) => new THREE.Box3(new THREE.Vector3(x - w / 2, 0, z - l / 2), new THREE.Vector3(x + w / 2, h, z + l / 2));
  const solids = [box(0, -.5, 7.4, 20, 7), box(-10.8, -2.4, 2, 2, 5), box(10.8, -2.4, 2, 2, 5)];
  return { group: g, lights, solids, rampEnd: 15, rampStart: 8, rampHeight: 1.9 };
}
