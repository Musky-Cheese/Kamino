import { Client, Room } from "@colyseus/core";
import { BattleState, PlayerState, type BattleStateType, type PlayerStateType } from "./state.js";

type Team = "clones" | "droids";
type PlayerInput = { x: number; y: number; angle: number };
type InputMessage = Partial<PlayerInput>;
type ShootMessage = { angle?: number };

const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;
const PLAYER_SPEED = 235;
const PLAYER_RADIUS = 18;
const SHOT_RANGE = 680;
const SHOT_DAMAGE = 34;
const FIRE_DELAY_MS = 280;

const SPAWNS: Record<Team, Array<{ x: number; y: number }>> = {
  clones: [
    { x: 160, y: 330 },
    { x: 210, y: 400 },
    { x: 160, y: 470 },
  ],
  droids: [
    { x: 1040, y: 330 },
    { x: 990, y: 400 },
    { x: 1040, y: 470 },
  ],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class BattleRoom extends Room<{ state: BattleStateType }> {
  maxClients = 16;
  state = new BattleState();

  private readonly playerInputs = new Map<string, PlayerInput>();
  private readonly lastShotAt = new Map<string, number>();
  private spawnIndex: Record<Team, number> = { clones: 0, droids: 0 };

  onCreate(): void {
    this.patchRate = 50;

    this.onMessage<InputMessage>("input", (client, message) => {
      const previous = this.playerInputs.get(client.sessionId) ?? { x: 0, y: 0, angle: 0 };
      this.playerInputs.set(client.sessionId, {
        x: clamp(finite(message?.x, previous.x), -1, 1),
        y: clamp(finite(message?.y, previous.y), -1, 1),
        angle: finite(message?.angle, previous.angle),
      });
    });

    this.onMessage<ShootMessage>("shoot", (client, message) => {
      this.handleShot(client, finite(message?.angle));
    });

    this.setFixedTimestep(({ dt }) => this.simulate(dt), 30);
  }

  onJoin(client: Client, options?: { name?: string }): void {
    const team = this.pickTeam();
    const player = new PlayerState({
      name: this.cleanName(options?.name),
      team,
    });

    this.placeAtSpawn(player, team);
    this.state.players.set(client.sessionId, player);
    this.playerInputs.set(client.sessionId, { x: 0, y: 0, angle: team === "clones" ? 0 : Math.PI });

    client.send("welcome", { id: client.sessionId, team });
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    this.playerInputs.delete(client.sessionId);
    this.lastShotAt.delete(client.sessionId);
  }

  private cleanName(value: unknown): string {
    if (typeof value !== "string") return "Trooper";
    const cleaned = value.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 16);
    return cleaned || "Trooper";
  }

  private pickTeam(): Team {
    let clones = 0;
    let droids = 0;
    this.state.players.forEach((player) => {
      if (player.team === "clones") clones += 1;
      else droids += 1;
    });
    return clones <= droids ? "clones" : "droids";
  }

  private placeAtSpawn(player: PlayerStateType, team: Team): void {
    const options = SPAWNS[team];
    const spawn = options[this.spawnIndex[team]++ % options.length];
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = 100;
    player.alive = true;
    player.angle = team === "clones" ? 0 : Math.PI;
  }

  private simulate(dt: number): void {
    this.state.players.forEach((player, sessionId) => {
      if (!player.alive) return;
      const input = this.playerInputs.get(sessionId);
      if (!input) return;

      const length = Math.hypot(input.x, input.y);
      const scale = length > 1 ? 1 / length : 1;
      player.x = clamp(player.x + input.x * scale * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
      player.y = clamp(player.y + input.y * scale * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);
      player.angle = input.angle;
    });
  }

  private handleShot(client: Client, angle: number): void {
    const shooter = this.state.players.get(client.sessionId);
    if (!shooter?.alive) return;

    const now = Date.now();
    if (now - (this.lastShotAt.get(client.sessionId) ?? 0) < FIRE_DELAY_MS) return;
    this.lastShotAt.set(client.sessionId, now);

    const shotAngle = Number.isFinite(angle) ? angle : shooter.angle;
    shooter.angle = shotAngle;
    const dirX = Math.cos(shotAngle);
    const dirY = Math.sin(shotAngle);

    let victim: PlayerStateType | undefined;
    let victimId: string | undefined;
    let nearestDistance = SHOT_RANGE;

    this.state.players.forEach((candidate, sessionId) => {
      if (sessionId === client.sessionId || !candidate.alive || candidate.team === shooter.team) return;

      const offsetX = candidate.x - shooter.x;
      const offsetY = candidate.y - shooter.y;
      const alongRay = offsetX * dirX + offsetY * dirY;
      if (alongRay <= 0 || alongRay >= nearestDistance) return;

      const perpendicular = Math.abs(offsetX * dirY - offsetY * dirX);
      if (perpendicular <= PLAYER_RADIUS + 5) {
        victim = candidate;
        victimId = sessionId;
        nearestDistance = alongRay;
      }
    });

    let endX = shooter.x + dirX * SHOT_RANGE;
    let endY = shooter.y + dirY * SHOT_RANGE;

    if (victim) {
      endX = shooter.x + dirX * nearestDistance;
      endY = shooter.y + dirY * nearestDistance;
      victim.hp = Math.max(0, victim.hp - SHOT_DAMAGE);

      if (victim.hp === 0) {
        victim.alive = false;
        victim.deaths += 1;
        shooter.kills += 1;
        if (shooter.team === "clones") this.state.cloneScore += 1;
        else this.state.droidScore += 1;

        const defeated = victim;
        const defeatedId = victimId;
        this.clock.setTimeout(() => {
          if (defeatedId && this.state.players.get(defeatedId) === defeated) {
            this.placeAtSpawn(defeated, defeated.team as Team);
          }
        }, 2500);
      }
    }

    this.broadcast("shot", {
      shooterId: client.sessionId,
      x1: shooter.x,
      y1: shooter.y,
      x2: endX,
      y2: endY,
      hit: Boolean(victim),
    });
  }
}
