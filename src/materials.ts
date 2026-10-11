import * as THREE from "three";
import { grimeTextures, padMarkings, panelTextures, type PbrSet } from "./textures";

function standard(set: PbrSet | null, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ ...(set ?? {}), ...params });
}

function glow(color: THREE.ColorRepresentation, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x050607, emissive: color, emissiveIntensity: intensity, roughness: .4, metalness: 0 });
}

/** Shared materials. Static geometry is merged per material, so reuse matters. */
export class Materials {
  /** Deck plating on the y = 0 plane (receives planar reflections). */
  readonly deck: THREE.MeshStandardMaterial;
  readonly deckDark: THREE.MeshStandardMaterial;
  /** Same plating for surfaces off the reflection plane. */
  readonly deckRaised: THREE.MeshStandardMaterial;
  readonly hull: THREE.MeshStandardMaterial;
  readonly hullDark: THREE.MeshStandardMaterial;
  readonly trim: THREE.MeshStandardMaterial;
  readonly window: THREE.MeshStandardMaterial;
  readonly windowLit: THREE.MeshStandardMaterial;
  readonly warmLight: THREE.MeshStandardMaterial;
  readonly coolLight: THREE.MeshStandardMaterial;
  readonly redLight: THREE.MeshStandardMaterial;
  readonly amberLight: THREE.MeshStandardMaterial;
  readonly hazard: THREE.MeshStandardMaterial;
  readonly sepHull: THREE.MeshStandardMaterial;
  readonly sepDark: THREE.MeshStandardMaterial;
  readonly repWhite: THREE.MeshStandardMaterial;
  readonly repRed: THREE.MeshStandardMaterial;
  readonly repGreen: THREE.MeshStandardMaterial;
  readonly canopy: THREE.MeshStandardMaterial;
  readonly fireGlow: THREE.MeshStandardMaterial;
  readonly crate: THREE.MeshStandardMaterial;
  private readonly padPaints = new Map<string, THREE.MeshStandardMaterial>();

  constructor(maxAnisotropy: number) {
    const deckSet = panelTextures({
      size: 1024, cols: 8, rows: 8, seed: 11, base: [118, 138, 148], tone: .14, grime: .55, streaks: 0, wet: 1,
      roughness: .44, seam: 2, rivets: true, normalStrength: 5, vents: .06,
    });
    const deckDarkSet = panelTextures({
      size: 512, cols: 4, rows: 8, seed: 23, base: [62, 76, 86], tone: .1, grime: .5, streaks: 0, wet: .9,
      roughness: .45, seam: 2, rivets: true, normalStrength: 4, vents: .2,
    });
    const hullSet = panelTextures({
      size: 1024, cols: 6, rows: 10, seed: 41, base: [168, 184, 192], tone: .08, grime: .6, streaks: .5, wet: .5,
      roughness: .4, seam: 1.5, rivets: false, normalStrength: 3.5, bands: true,
    });
    const hullDarkSet = panelTextures({
      size: 512, cols: 4, rows: 6, seed: 59, base: [70, 86, 96], tone: .1, grime: .6, streaks: .45, wet: .5,
      roughness: .42, seam: 1.5, rivets: true, normalStrength: 3.5,
    });
    const sepSet = grimeTextures(71, [150, 124, 92], 1.1);
    for (const set of [deckSet, deckDarkSet, hullSet, hullDarkSet, sepSet]) {
      for (const texture of Object.values(set)) texture.anisotropy = maxAnisotropy;
    }

    this.deck = standard(deckSet, { metalness: .62, roughness: 1, normalScale: new THREE.Vector2(.9, .9) });
    this.deckDark = standard(deckDarkSet, { metalness: .7, roughness: 1, normalScale: new THREE.Vector2(.8, .8) });
    this.deckRaised = this.deck.clone();
    this.hull = standard(hullSet, { metalness: .45, roughness: 1, normalScale: new THREE.Vector2(.7, .7) });
    this.hullDark = standard(hullDarkSet, { metalness: .6, roughness: 1, normalScale: new THREE.Vector2(.7, .7) });
    this.trim = new THREE.MeshStandardMaterial({ color: 0x8ea3ad, metalness: .9, roughness: .22 });
    this.window = new THREE.MeshStandardMaterial({ color: 0x050b10, metalness: .9, roughness: .06, emissive: 0x0a2230, emissiveIntensity: .6 });
    this.windowLit = glow(0xffb978, 1.5);
    this.warmLight = glow(0xffd79a, 2.6);
    this.coolLight = glow(0x7fdcff, 2.4);
    this.redLight = glow(0xff3020, 6);
    this.amberLight = glow(0xff9a3a, 4);
    this.hazard = new THREE.MeshStandardMaterial({ color: 0xd9a043, metalness: .3, roughness: .5 });
    this.sepHull = standard(sepSet, { metalness: .55, roughness: 1, color: 0xffffff });
    this.sepDark = new THREE.MeshStandardMaterial({ color: 0x3b342c, metalness: .7, roughness: .5 });
    this.repWhite = new THREE.MeshStandardMaterial({ color: 0xc9cfcb, metalness: .35, roughness: .42 });
    this.repRed = new THREE.MeshStandardMaterial({ color: 0x8c1c18, metalness: .3, roughness: .5 });
    this.repGreen = new THREE.MeshStandardMaterial({ color: 0x55604a, metalness: .35, roughness: .5 });
    this.canopy = new THREE.MeshStandardMaterial({ color: 0x0b1a16, metalness: .9, roughness: .05, emissive: 0x0b2a1c, emissiveIntensity: .5 });
    this.fireGlow = glow(0xff6a1c, 7);
    this.crate = new THREE.MeshStandardMaterial({ color: 0x4f5a60, metalness: .55, roughness: .45 });
  }

  padPaint(label: string, seed: number): THREE.MeshStandardMaterial {
    let material = this.padPaints.get(label);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        map: padMarkings(seed, label),
        transparent: true,
        roughness: .55,
        metalness: .1,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.padPaints.set(label, material);
    }
    return material;
  }
}
