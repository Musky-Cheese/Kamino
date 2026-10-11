import Phaser from "phaser";
import { Client, type Room } from "@colyseus/sdk";
import { Callbacks } from "@colyseus/schema";
import "./style.css";

type Team = "clones" | "droids";
type NetworkPlayer = {
  name: string;
  team: Team;
  x: number;
  y: number;
  angle: number;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
};
type BattleState = {
  players: Map<string, NetworkPlayer>;
  cloneScore: number;
  droidScore: number;
};
type ShotEvent = { shooterId: string; x1: number; y1: number; x2: number; y2: number; hit: boolean };

const menu = document.querySelector<HTMLElement>("#menu")!;
const deployButton = document.querySelector<HTMLButtonElement>("#deploy")!;
const practiceButton = document.querySelector<HTMLButtonElement>("#practice")!;
const callsignInput = document.querySelector<HTMLInputElement>("#callsign")!;
const statusText = document.querySelector<HTMLElement>("#status")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const scoreText = document.querySelector<HTMLElement>("#score")!;
const identityText = document.querySelector<HTMLElement>("#identity")!;
const healthBar = document.querySelector<HTMLElement>("#health")!;

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "ws://localhost:2567";

class BattleScene extends Phaser.Scene {
  private room?: Room<BattleState>;
  private localId = "";
  private keys?: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  private readonly visuals = new Map<string, Phaser.GameObjects.Container>();
  private readonly targets = new Map<string, { x: number; y: number; angle: number; alive: boolean }>();
  private readonly practicePlayers = new Map<string, NetworkPlayer>();
  private practiceMode = false;
  private practiceScore = 0;
  private lastInputAt = 0;
  private rain?: Phaser.GameObjects.TileSprite;

  constructor() {
    super("battle");
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#071521");
    this.drawArena();
    this.createRain();

    this.keys = this.input.keyboard?.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    }) as typeof this.keys;

    this.input.on("pointerdown", () => this.fire());
  }

  attachRoom(room: Room<BattleState>, localId: string): void {
    this.room = room;
    this.localId = localId;
    const callbacks = Callbacks.get(room as never);

    callbacks.onAdd("players" as never, ((player: NetworkPlayer, id: string) => {
      this.addPlayer(id, player);
      callbacks.onChange(player as never, () => this.syncTarget(id, player));
      this.syncTarget(id, player);
    }) as never, true);

    callbacks.onRemove("players" as never, ((_player: NetworkPlayer, id: string) => {
      this.visuals.get(id)?.destroy();
      this.visuals.delete(id);
      this.targets.delete(id);
    }) as never);

    callbacks.listen("cloneScore" as never, (() => this.updateScore()) as never, true);
    callbacks.listen("droidScore" as never, (() => this.updateScore()) as never, true);
    room.onMessage("shot", (message: ShotEvent) => this.drawShot(message));
  }

  startPractice(name: string): void {
    this.practiceMode = true;
    this.localId = "practice-player";
    const player: NetworkPlayer = {
      name: name || "CT-1010",
      team: "clones",
      x: 190,
      y: 400,
      angle: 0,
      hp: 100,
      alive: true,
      kills: 0,
      deaths: 0,
    };
    this.practicePlayers.set(this.localId, player);
    this.addPlayer(this.localId, player);
    this.syncTarget(this.localId, player);

    const positions = [
      [920, 300], [1030, 390], [910, 500], [760, 255], [790, 545],
    ];
    positions.forEach(([x, y], index) => {
      const bot: NetworkPlayer = {
        name: `B1-${index + 1}`,
        team: "droids",
        x,
        y,
        angle: Math.PI,
        hp: 100,
        alive: true,
        kills: 0,
        deaths: 0,
      };
      const id = `practice-bot-${index}`;
      this.practicePlayers.set(id, bot);
      this.addPlayer(id, bot);
      this.syncTarget(id, bot);
    });
    this.updatePracticeHud();
  }

  update(_time: number, delta: number): void {
    if (this.rain) {
      this.rain.tilePositionX -= delta * 0.22;
      this.rain.tilePositionY -= delta * 0.62;
    }

    for (const [id, visual] of this.visuals) {
      const target = this.targets.get(id);
      if (!target) continue;
      const factor = id === this.localId ? 0.42 : 0.22;
      visual.x = Phaser.Math.Linear(visual.x, target.x, factor);
      visual.y = Phaser.Math.Linear(visual.y, target.y, factor);
      visual.rotation = Phaser.Math.Angle.RotateTo(visual.rotation, target.angle, 0.22);
      visual.setAlpha(target.alive ? 1 : 0.18);
    }

    if (!this.keys || !this.localId) return;
    const local = this.visuals.get(this.localId);
    if (!local) return;

    const pointer = this.input.activePointer;
    const angle = Phaser.Math.Angle.Between(local.x, local.y, pointer.worldX, pointer.worldY);
    const x = Number(this.keys.right.isDown) - Number(this.keys.left.isDown);
    const y = Number(this.keys.down.isDown) - Number(this.keys.up.isDown);

    if (this.practiceMode) {
      const player = this.practicePlayers.get(this.localId)!;
      const length = Math.hypot(x, y) || 1;
      const speed = 235 * (delta / 1000);
      player.x = Phaser.Math.Clamp(player.x + (x / length) * speed, 24, 1176);
      player.y = Phaser.Math.Clamp(player.y + (y / length) * speed, 24, 776);
      player.angle = angle;
      this.syncTarget(this.localId, player);
      this.updatePracticeBots(delta);
      return;
    }

    if (!this.room || this.time.now - this.lastInputAt < 33) return;
    this.room.send("input", { x, y, angle });
    this.lastInputAt = this.time.now;
  }

  private drawArena(): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x06111a, 1).fillRect(0, 0, 1200, 800);

    for (let x = -800; x < 1800; x += 72) {
      graphics.lineStyle(1, 0x1a3b4d, 0.28).lineBetween(x, 0, x + 420, 800);
    }

    graphics.fillStyle(0x122631, 1).fillRoundedRect(95, 240, 1010, 320, 28);
    graphics.lineStyle(3, 0x4b7184, 0.75).strokeRoundedRect(95, 240, 1010, 320, 28);
    graphics.fillStyle(0x1b3440, 1).fillRoundedRect(360, 160, 480, 480, 76);
    graphics.lineStyle(2, 0x698899, 0.5).strokeRoundedRect(360, 160, 480, 480, 76);
    graphics.fillStyle(0x10212a, 1).fillCircle(600, 400, 158);
    graphics.lineStyle(3, 0x77a0b4, 0.55).strokeCircle(600, 400, 158);
    graphics.fillStyle(0x285267, 0.8).fillCircle(600, 400, 44);

    graphics.lineStyle(1, 0x8ec9e4, 0.18);
    for (let x = 120; x <= 1080; x += 48) graphics.lineBetween(x, 256, x, 544);
    for (let y = 272; y <= 528; y += 48) graphics.lineBetween(112, y, 1088, y);

    this.add.text(130, 282, "CLONE DEPLOYMENT", { color: "#79cffa", fontFamily: "monospace", fontSize: "12px" }).setAlpha(0.7);
    this.add.text(930, 282, "DROID DEPLOYMENT", { color: "#ffac66", fontFamily: "monospace", fontSize: "12px" }).setAlpha(0.7);
  }

  private createRain(): void {
    const texture = this.make.graphics({ x: 0, y: 0 });
    texture.lineStyle(1, 0xaadbed, 0.28);
    texture.lineBetween(8, 0, 1, 22);
    texture.lineBetween(31, 24, 24, 47);
    texture.generateTexture("rain", 48, 48);
    texture.destroy();
    this.rain = this.add.tileSprite(0, 0, 1200, 800, "rain").setOrigin(0).setDepth(50).setBlendMode(Phaser.BlendModes.ADD);
  }

  private addPlayer(id: string, player: NetworkPlayer): void {
    const color = player.team === "clones" ? 0x8bd8ff : 0xffa55f;
    const body = this.add.graphics();
    body.fillStyle(0x07131b, 1).fillCircle(0, 0, 18);
    body.lineStyle(4, color, 1).strokeCircle(0, 0, 18);
    body.fillStyle(color, 1).fillTriangle(14, -5, 29, 0, 14, 5);
    const label = this.add.text(0, -34, player.name, {
      color: player.team === "clones" ? "#bdeaff" : "#ffd1aa",
      fontFamily: "monospace",
      fontSize: "12px",
      stroke: "#041018",
      strokeThickness: 4,
    }).setOrigin(0.5).setRotation(-player.angle);

    const container = this.add.container(player.x, player.y, [body, label]).setDepth(10);
    container.setData("label", label);
    this.visuals.set(id, container);
  }

  private syncTarget(id: string, player: NetworkPlayer): void {
    this.targets.set(id, { x: player.x, y: player.y, angle: player.angle, alive: player.alive });
    const visual = this.visuals.get(id);
    const label = visual?.getData("label") as Phaser.GameObjects.Text | undefined;
    if (label) label.setRotation(-player.angle);

    if (id === this.localId) {
      identityText.textContent = `${player.team.toUpperCase()} · ${player.name} · ${player.kills} K / ${player.deaths} D`;
      healthBar.style.setProperty("--health", `${player.hp}%`);
    }
  }

  private updateScore(): void {
    if (!this.room) return;
    scoreText.innerHTML = `<span class="clone">CLONES ${this.room.state.cloneScore ?? 0}</span><span class="droid">DROIDS ${this.room.state.droidScore ?? 0}</span>`;
  }

  private fire(): void {
    if (!this.localId) return;
    const local = this.visuals.get(this.localId);
    if (!local) return;
    const pointer = this.input.activePointer;
    const angle = Phaser.Math.Angle.Between(local.x, local.y, pointer.worldX, pointer.worldY);
    if (this.practiceMode) {
      this.firePracticeShot(local.x, local.y, angle);
      return;
    }
    if (!this.room) return;
    this.room.send("shoot", { angle });
  }

  private updatePracticeBots(delta: number): void {
    const player = this.practicePlayers.get(this.localId);
    if (!player) return;
    let index = 0;
    for (const [id, bot] of this.practicePlayers) {
      if (bot.team !== "droids" || !bot.alive) continue;
      const angle = Phaser.Math.Angle.Between(bot.x, bot.y, player.x, player.y);
      bot.angle = angle;
      const drift = Math.sin(this.time.now / 700 + index * 1.7) * 0.7;
      const speed = 42 * (delta / 1000);
      bot.x = Phaser.Math.Clamp(bot.x + Math.cos(angle + drift) * speed, 400, 1120);
      bot.y = Phaser.Math.Clamp(bot.y + Math.sin(angle + drift) * speed, 190, 610);
      this.syncTarget(id, bot);
      index += 1;
    }
  }

  private firePracticeShot(x: number, y: number, angle: number): void {
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    let victimId = "";
    let victim: NetworkPlayer | undefined;
    let nearest = 680;

    for (const [id, candidate] of this.practicePlayers) {
      if (candidate.team !== "droids" || !candidate.alive) continue;
      const offsetX = candidate.x - x;
      const offsetY = candidate.y - y;
      const along = offsetX * dirX + offsetY * dirY;
      const perpendicular = Math.abs(offsetX * dirY - offsetY * dirX);
      if (along > 0 && along < nearest && perpendicular <= 25) {
        victim = candidate;
        victimId = id;
        nearest = along;
      }
    }

    this.drawShot({
      shooterId: this.localId,
      x1: x,
      y1: y,
      x2: x + dirX * nearest,
      y2: y + dirY * nearest,
      hit: Boolean(victim),
    });

    if (!victim) return;
    victim.hp = Math.max(0, victim.hp - 34);
    if (victim.hp === 0) {
      victim.alive = false;
      this.practiceScore += 1;
      this.practicePlayers.get(this.localId)!.kills = this.practiceScore;
      this.syncTarget(victimId, victim);
      this.updatePracticeHud();
      this.time.delayedCall(1400, () => {
        if (!victim) return;
        victim.hp = 100;
        victim.alive = true;
        victim.x = Phaser.Math.Between(760, 1060);
        victim.y = Phaser.Math.Between(260, 540);
        this.syncTarget(victimId, victim);
      });
    }
  }

  private updatePracticeHud(): void {
    const player = this.practicePlayers.get(this.localId);
    scoreText.innerHTML = `<span class="clone">TARGETS ${this.practiceScore}</span><span class="droid">PRACTICE RANGE</span>`;
    if (player) {
      identityText.textContent = `CLONES · ${player.name} · ${this.practiceScore} TARGETS`;
      healthBar.style.setProperty("--health", "100%");
    }
  }

  private drawShot(shot: ShotEvent): void {
    const beam = this.add.graphics().setDepth(40);
    beam.lineStyle(3, shot.hit ? 0xffffff : 0x75d9ff, 1).lineBetween(shot.x1, shot.y1, shot.x2, shot.y2);
    beam.lineStyle(8, shot.hit ? 0xff866e : 0x469dff, 0.22).lineBetween(shot.x1, shot.y1, shot.x2, shot.y2);
    this.tweens.add({ targets: beam, alpha: 0, duration: 120, onComplete: () => beam.destroy() });
  }
}

const battleScene = new BattleScene();
new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 1200,
  height: 800,
  scene: battleScene,
  backgroundColor: "#071521",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  render: { antialias: true, pixelArt: false },
});

async function deploy(): Promise<void> {
  deployButton.disabled = true;
  statusText.textContent = "Locating an available battle…";

  try {
    const client = new Client(serverUrl);
    const room = await client.joinOrCreate<BattleState>("battle", {
      name: callsignInput.value,
    });

    battleScene.attachRoom(room, room.sessionId);
    menu.hidden = true;
    hud.hidden = false;
  } catch (error) {
    console.error(error);
    statusText.textContent = "Could not reach the battle server. Is it running?";
    deployButton.disabled = false;
  }
}

deployButton.addEventListener("click", deploy);
practiceButton.addEventListener("click", () => {
  battleScene.startPractice(callsignInput.value.trim());
  menu.hidden = true;
  hud.hidden = false;
});
callsignInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void deploy();
});
statusText.textContent = "Ready to deploy.";
