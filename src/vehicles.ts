import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Materials } from "./materials";

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

export type Gunship = { group: THREE.Group; blinkers: THREE.Mesh[]; searchlight: THREE.Object3D };

/** Republic LAAT/i-style gunship, nose toward -Z, skids at y = 0. */
export function buildGunship(m: Materials): Gunship {
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
  return { group: g, blinkers, searchlight };
}

/** Separatist vulture droid in flight mode: a narrow body with four blade wings in an X, red photoreceptors. Nose toward -Z. */
export function buildVulture(m: Materials): { group: THREE.Group; guns: THREE.Object3D[] } {
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

export type Lander = { group: THREE.Group; lights: THREE.Mesh[] };

/** Separatist landing craft. Nose and boarding ramp face +Z. `crashed` adds sprawling spider legs instead of landing struts. */
export function buildLander(m: Materials, crashed = false): Lander {
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
  return { group: g, lights };
}
