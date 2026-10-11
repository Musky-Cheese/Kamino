import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { BattleRoom } from "./BattleRoom.js";

const port = Number.parseInt(process.env.PORT ?? "2567", 10);
const origin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    app.use(cors({ origin }));
    app.get("/health", (_request, response) => {
      response.json({ ok: true, service: "kamino-server" });
    });
  },
});

gameServer.define("battle", BattleRoom);

await gameServer.listen(port);
console.log(`Kamino battle server listening on ws://localhost:${port}`);
