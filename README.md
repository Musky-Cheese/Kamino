# Kamino

A non-commercial, fan-made first-person shooter for the browser, set during the Battle of Kamino. You are a clone trooper on the storm-lashed platforms of Tipoca City: fight across the bridges with your squad, take each sector, and push the droid army back to its landing craft.

**Play:** https://musky-cheese.github.io/Kamino/

## The battle

The front line runs across four platforms connected by exposed bridges:

| Sector | Platform | What's there |
| --- | --- | --- |
| A | Aurek Landing Pad | Your squad and a parked Republic gunship |
| B | Besh Junction | Dug-in B1 battle droids behind pod towers and barricades |
| C | Cresh Plaza | A raised central dais, super battle droids |
| D | Dorn Landing Platform | The Separatist landing craft pouring out reinforcements |

Kill enough droids in a sector and the survivors **fall back** to the next platform. Move into the marked zone to **secure** it; the front line advances, your squad moves up, and you get armour, detonators and reinforcements. Clear Dorn platform to win.

## Features

- Tipoca City built procedurally: saucer platforms on stilts above a Gerstner-wave ocean, the great dome with a crashed Separatist lander still burning on top, the needle tower, hangar wing and a horizon of stilt cities
- Night storm: GPU rain, ground splashes, lightning bolts that light the clouds and the city, rolling thunder delayed by distance, drifting fog banks
- Volumetric light shafts through the rain (floodlights, gunship searchlights, fires, explosions), screen-space ambient occlusion, wet-deck planar reflections, dynamic reflection probe for armour and glass, rain beading on the helmet visor, aim-down-sights focus blur, bloom, film grade
- Droid and clone AI that takes cover, peeks, fires in bursts, advances, retreats across bridges and gets reinforced
- Projectile blaster bolts with near-miss feedback, scorch marks, sparks, droids that shatter into pieces
- DC-15A with aim-down-sights, recoil, spread, reload, ammo counter on the rifle; thermal detonators
- Fully synthesised audio: blasters, explosions, thunder, rain, footsteps, and a B1 "roger, roger"
- Helmet HUD with front-line tracker, objective marker, radio chatter, damage direction, kill feed
- Low / Medium / High graphics presets, three difficulty levels

## Controls

| Input | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Look |
| Left click | Fire |
| Right click | Aim down sights |
| R | Reload |
| G | Throw thermal detonator |
| Shift | Sprint |
| Space | Jump |
| C | Crouch |
| Escape | Pause |

## Run locally

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev
```

Build the production version with `pnpm build`. Add `?test` to the URL to skip the menu and pointer lock (useful for automated checks).

## Code map

| File | Responsibility |
| --- | --- |
| `src/game.ts` | Game loop, player controller, mission phases, HUD, post-processing |
| `src/battle.ts` | Droid and clone AI, blaster bolts, damage |
| `src/world.ts` | Tipoca City construction, cover points, floodlights, flyovers |
| `src/navigation.ts` | Walkable space, collision and bridge routing |
| `src/config.ts` | Map layout and mission tuning |
| `src/environment.ts` | Sky, ocean, rain, lightning |
| `src/reflections.ts` | Wet-deck planar reflections |
| `src/postfx.ts` | Depth-aware post: volumetric light, ambient occlusion, composite + ADS blur |
| `src/envprobe.ts` | Dynamic environment reflections captured around the player |
| `src/actors.ts` | Droid and clone models and procedural animation |
| `src/vehicles.ts` | Gunship, vulture and lander: loaded models placed with lights and gun anchors, procedural fallbacks |
| `src/models.ts` | glTF loading (meshopt, WebP) behind the loading screen; fitting models to the game's scale |
| `src/weapon.ts` | First-person DC-15A |
| `src/effects.ts` | Sparks, scorch marks, explosions, debris, light pool |
| `src/audio.ts` | Procedural sound |
| `src/textures.ts` / `src/materials.ts` | Procedural PBR textures and shared materials |
| `src/batcher.ts` | Static geometry merging + BVH raycasting |
| `scripts/optimize-models.mjs` | Rebuilds `public/models/` from the raw downloads (gltf-transform: meshopt, WebP, 2K max) |

## Credits

Third-party models, all used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). They were compressed, rescaled and in some cases re-textured for the game.

| Asset | Author | Source |
| --- | --- | --- |
| LAAT/i Gunship | A308 Digital | [Sketchfab](https://sketchfab.com/3d-models/laati-gunship-74dcce4616614706a5a14cc18f9e051f) |
| Vulture Droid | DrEgguin | [Sketchfab](https://sketchfab.com/3d-models/vulture-droid-5542f951834e4032b229ebdee12d3310) |
| C-9979 landing craft (re-textured) | bruhepic925 | [Sketchfab](https://sketchfab.com/3d-models/c-9979-landing-craft-65850006f9d14e36b2a416c026c3b74b) |

## Project status

Built with TypeScript, Three.js and Vite. The earlier top-down multiplayer experiment is preserved at Git tag `prototype-top-down-v0.1`.

This project is unofficial and is not affiliated with or endorsed by Lucasfilm, Disney, or Electronic Arts. It uses the fan-made models credited above plus original procedural geometry, textures and sound, and no official game assets.
