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

    if (!this.room || !this.keys || !this.localId || this.time.now - this.lastInputAt < 33) return;
    const local = this.visuals.get(this.localId);
    if (!local) return;

    const pointer = this.input.activePointer;
    const angle = Phaser.Math.Angle.Between(local.x, local.y, pointer.worldX, pointer.worldY);
    const x = Number(this.keys.right.isDown) - Number(this.keys.left.isDown);
    const y = Number(this.keys.down.isDown) - Number(this.keys.up.isDown);
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
    if (!this.room || !this.localId) return;
    const local = this.visuals.get(this.localId);
    if (!local) return;
    const pointer = this.input.activePointer;
    const angle = Phaser.Math.Angle.Between(local.x, local.y, pointer.worldX, pointer.worldY);
    this.room.send("shoot", { angle });
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
callsignInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void deploy();
});
statusText.textContent = "Ready to deploy.";
