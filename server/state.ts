import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    name: t.string().default("Trooper"),
    team: t.string().default("clones"),
    x: t.float32().default(0),
    y: t.float32().default(0),
    angle: t.float32().default(0),
    hp: t.uint8().default(100),
    alive: t.boolean().default(true),
    kills: t.uint16().default(0),
    deaths: t.uint16().default(0),
  },
  "PlayerState",
);

export type PlayerStateType = SchemaType<typeof PlayerState>;

export const BattleState = schema(
  {
    players: t.map(PlayerState),
    cloneScore: t.uint16().default(0),
    droidScore: t.uint16().default(0),
  },
  "BattleState",
);

export type BattleStateType = SchemaType<typeof BattleState>;
