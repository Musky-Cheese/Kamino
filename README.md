# Kamino

A non-commercial, fan-made first-person shooter for the browser, set during the Battle of Kamino. You are a clone trooper on the storm-lashed platforms of Tipoca City: fight across the bridges with your squad, take each sector, push the droid army past its landing craft and clear them out of the cloning facility.

**Play:** https://musky-cheese.github.io/Kamino/

## The battle

The front line runs across four platforms connected by exposed bridges, then indoors through the Tipoca cloning facility:

| Sector | Location | What's there |
| --- | --- | --- |
| A | Aurek Landing Pad | Your squad and a parked Republic gunship |
| B | Besh Junction | Dug-in B1 battle droids behind pod towers and barricades |
| C | Cresh Plaza | A raised central dais, super battle droids |
| D | Dorn Landing Platform | The Separatist landing craft pouring out reinforcements |
| E | Tipoca Facility Lobby | A roofed hall with pillars, sealed at the back by a blast door |
| F | Security Corridor | A narrow 40 m corridor; the alcoves are the only cover, droids come out of service doors |
| G | Cloning Hall | Rows of growth tanks, a raised control deck and storm windows; the last stand |

Kill enough droids in a sector and the survivors **fall back** to the next one; inside the facility the next blast door grinds open for them. Move into the marked zone to **secure** it; the front line advances, your squad moves up, and you get armour, detonators and reinforcements. Indoors the squad follows you into each room. Clear the cloning hall to win.

Under a roof the rain stops, your visor dries, lightning only reaches in through windows and doorways, the storm is muffled and blaster fire echoes off the walls.

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

Build the production version with `pnpm build`. Add `?test` to the URL to skip the menu and pointer lock (useful for automated checks). `?start=final`, `?start=corridor` and `?start=hall` jump straight to the facility entrance, the security corridor or the cloning hall.

## Code map

| File | Responsibility |
| --- | --- |
| `src/game.ts` | Game loop, player controller, mission phases, HUD, post-processing |
| `src/battle.ts` | Droid and clone AI, blaster bolts, damage |
| `src/world.ts` | Tipoca City and cloning facility construction, blast doors, cover points, floodlights, flyovers |
| `src/navigation.ts` | Walkable space, collision, roofs, bridge and doorway routing |
| `src/config.ts` | Map layout and mission tuning |
| `src/environment.ts` | Sky, ocean, rain, lightning |
| `src/reflections.ts` | Wet-deck planar reflections |
| `src/postfx.ts` | Depth-aware post: volumetric light, ambient occlusion, composite + ADS blur |
| `src/envprobe.ts` | Dynamic environment reflections captured around the player |
| `src/actors.ts` | Rig interface the AI drives; procedural fallback droids and clones; weapon models |
| `src/characters.ts` | Animated clone / B1 / B2 from the loaded models: clip blending, rifle IK, hit proxies, shatter pieces |
| `src/retarget.ts` | Bakes animation-library clips onto other skeletons |
| `src/airbattle.ts` | The dogfight overhead: fighter AI, bolts, shoot-downs, burning wrecks and crashes |
| `src/vehicles.ts` | Gunship, starfighters, vulture and lander: loaded models placed with lights and gun anchors, procedural fallbacks |
| `src/models.ts` | glTF loading (meshopt, WebP) behind the loading screen; fitting models to the game's scale |
| `src/weapon.ts` | First-person DC-15A |
| `src/effects.ts` | Sparks, scorch marks, explosions, debris, light pool |
| `src/audio.ts` | Procedural sound |
| `src/materials.ts` | Shared materials: photo-scanned surface sets with procedural fallbacks |
| `src/surfaces.ts` | Surface texture loading; shader detail: wall streaks and grime, deck puddles with rain ripples, droid wear |
| `src/textures.ts` | Procedural textures (pad markings, smoke, scorch; fallback PBR sets) |
| `src/batcher.ts` | Static geometry merging + BVH raycasting |
| `scripts/optimize-models.mjs` | Rebuilds `public/models/` from the raw downloads (gltf-transform: meshopt, WebP, 2K max) |
| `scripts/fetch-textures.mjs` | Downloads the CC0 surface sets and writes `public/textures/` (2K) and `public/textures/low/` (1K) |

## Credits

Third-party models, used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) unless noted. They were compressed, rescaled and in some cases re-textured for the game.

| Asset | Author | Source |
| --- | --- | --- |
| LAAT/i Gunship | A308 Digital | [Sketchfab](https://sketchfab.com/3d-models/laati-gunship-74dcce4616614706a5a14cc18f9e051f) |
| Vulture Droid | DrEgguin | [Sketchfab](https://sketchfab.com/3d-models/vulture-droid-5542f951834e4032b229ebdee12d3310) |
| C-9979 landing craft (re-textured) | bruhepic925 | [Sketchfab](https://sketchfab.com/3d-models/c-9979-landing-craft-65850006f9d14e36b2a416c026c3b74b) |
| Clone Trooper Phase1 (Shiny) [Updated] (skin binding repaired) | Admiral Tributon | [Sketchfab](https://sketchfab.com/3d-models/clone-trooper-phase1-shiny-updated-aae018747b054186bd48e460b0ad1192) |
| Battle Droid B1 | Andrés Kuiper | [Sketchfab](https://sketchfab.com/3d-models/battle-droid-b1-3ee39289d86a45cd894f61e269ea10ed) |
| Super Battle Droid B2 Animated (based on Andrés Kuiper's B2) | Suvalien | [Sketchfab](https://sketchfab.com/3d-models/super-battle-droid-b2-animated-training-a0f947934672450bad323d6438499812) |
| ARC-170 Starfighter | DrEgguin | [Sketchfab](https://sketchfab.com/3d-models/arc-170-starfighter-b9407262cdf34d37b0720ca6b70469be) |
| V-19 Torrent Starfighter | A308 Digital | [Sketchfab](https://sketchfab.com/3d-models/v-19-torrent-starfighter-67804739c036405faea16120d31bc65a) |
| Trade Federation Droid Tri-Fighter | scarlequin | [Sketchfab](https://sketchfab.com/3d-models/trade-federation-droid-tri-fighter-9c06ba9b24144221aa80f56192f485b6) |
| Universal Animation Library (CC0, retargeted onto the clone and B1) | Quaternius | [quaternius.com](https://quaternius.com/packs/universalanimationlibrary.html) |

Surface textures (all CC0), converted to WebP by `scripts/fetch-textures.mjs`:

| Texture | Used for | Source |
| --- | --- | --- |
| MetalPlates004 | Deck plating | [ambientCG](https://ambientcg.com/view?id=MetalPlates004) |
| MetalPlates008 | Bridge decks | [ambientCG](https://ambientcg.com/view?id=MetalPlates008) |
| blue_metal_plate (desaturated) | White Kaminoan hull | [Poly Haven](https://polyhaven.com/a/blue_metal_plate) |
| MetalPlates001 | Dark hull | [ambientCG](https://ambientcg.com/view?id=MetalPlates001) |
| Metal032 | Wet steel trim | [ambientCG](https://ambientcg.com/view?id=Metal032) |
| Leaking012A, SurfaceImperfections003 | Rain streaks, grime, glass smudges | [ambientCG](https://ambientcg.com/view?id=Leaking012A), [ambientCG](https://ambientcg.com/view?id=SurfaceImperfections003) |
| rusty_metal_02 | Droid rust mask | [Poly Haven](https://polyhaven.com/a/rusty_metal_02) |

Sound effects (all CC0) in `public/audio/`, pitched and layered in `src/audio.ts`:

| Sound | Used for | Source |
| --- | --- | --- |
| Sci-Fi Sounds: laserSmall, impactMetal | Blaster shots, droid debris clatter | [Kenney](https://kenney.nl/assets/sci-fi-sounds) |
| Impact Sounds: impactMetal, impactPlate, footstep_concrete | Bolt hits, droids breaking apart, droid footsteps | [Kenney](https://kenney.nl/assets/impact-sounds) |

The B1 voice lines are original recordings made with the Windows text-to-speech voice and processed in-game. Rain, wind, sea, thunder and UI sounds are synthesised.

## Project status

Built with TypeScript, Three.js and Vite. The earlier top-down multiplayer experiment is preserved at Git tag `prototype-top-down-v0.1`.

This project is unofficial and is not affiliated with or endorsed by Lucasfilm, Disney, or Electronic Arts. It uses the fan-made models credited above plus the CC0 textures and sounds credited above and original procedural geometry and sound, and no official game assets.
