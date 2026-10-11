# Kamino

A non-commercial, fan-made first-person browser game prototype inspired by the Battle of Kamino. You play as a clone trooper defending Tipoca City's central rain courtyard from a droid strike team.

**Play:** https://musky-cheese.github.io/Kamino/

## Phase Two

- First-person movement and mouse look
- Compact Kamino access corridor and layered circular rain courtyard
- DC-15S-style blaster with shooting, hit feedback, ammo, and reloads
- Three escalating battle-droid waves with pursuit and ranged combat
- Two AI clone allies who advance and return fire
- Procedural blaster, hit, reload, damage, and thunder audio
- Sprint FOV, movement bob, weapon sway, automatic fire, and destruction sparks
- Health, victory, defeat, pause, and restart flow
- Desktop browser support

## Controls

| Input | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Look |
| Left click | Fire |
| R | Reload |
| Shift | Sprint |
| Escape | Pause / release mouse |

## Run locally

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev
```

Build the production version with `pnpm build`.

## Project status

Phase Two is a short single-player battle built with TypeScript, Three.js, and Vite. The previous top-down multiplayer experiment is preserved at Git tag `prototype-top-down-v0.1`.

This project is unofficial and is not affiliated with or endorsed by Lucasfilm, Disney, or Electronic Arts. It uses original procedural geometry and no official game assets.
