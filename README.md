# Kamino

An early, non-commercial, fan-made multiplayer browser game prototype inspired by the Battle of Kamino. Two teams—clones and droids—fight across a storm platform in short, server-authoritative matches.

This project is unofficial and is not affiliated with, endorsed by, or sponsored by Lucasfilm Ltd. or The Walt Disney Company. Star Wars and related names belong to their respective owners. No official game assets are included.

## Current playable slice

- Up to 16 players in one match room
- Automatic clone/droid team balancing
- Server-authoritative movement, hitscan shooting, damage, kills, and respawns
- Shared team score and personal K/D display
- Procedural placeholder arena and rain—no external art assets required
- Callsign entry and responsive browser layout

## Run locally

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173` in two browser windows to test multiplayer. The client connects to `ws://localhost:2567` by default.

Useful commands:

```bash
pnpm typecheck
pnpm build
pnpm smoke
pnpm start
```

Copy `.env.example` to `.env` when you need different ports or deployment URLs. Vite reads `VITE_SERVER_URL` from the environment at build time.

## Controls

- `WASD`: move
- Mouse: aim
- Left click: fire

## Architecture

The browser sends movement and firing intent to a Colyseus room. The server owns positions, validates fire rate and hits, applies damage, manages respawns, and synchronizes the resulting state. This prevents clients from awarding themselves hits or changing their own health.

## Near-term roadmap

1. Add platform and corridor collision.
2. Introduce one class per faction with distinct weapon behavior.
3. Add command-post capture and a match timer.
4. Add a room-code lobby and match restart flow.
5. Replace procedural placeholders with original art and audio.

## Where a collaborator can help

- Playtest in two browser windows and report movement, aiming, and latency issues.
- Sketch a compact map with two bases, a central objective, and two flanking routes.
- Decide whether combat should feel fast and arcade-like or slower and tactical.
- Define the first clone and droid class abilities.
- Create original rain, weapon, impact, and ambience audio.
