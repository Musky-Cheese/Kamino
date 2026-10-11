import { spawn } from "node:child_process";
import { Client } from "@colyseus/sdk";

const server = spawn(process.execPath, ["dist-server/index.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: "2568", CLIENT_ORIGIN: "http://localhost:5173" },
});

async function waitForServer() {
  const timeoutAt = Date.now() + 8_000;
  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch("http://localhost:2568/health");
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy within 8 seconds.");
}

try {
  await waitForServer();
  const first = await new Client("ws://localhost:2568").joinOrCreate("battle", { name: "Tester One" });
  const second = await new Client("ws://localhost:2568").joinOrCreate("battle", { name: "Tester Two" });

  await new Promise((resolve) => setTimeout(resolve, 150));

  const firstPlayer = first.state.players.get(first.sessionId);
  const secondPlayer = second.state.players.get(second.sessionId);
  if (!firstPlayer || !secondPlayer) throw new Error("Both players were not synchronized.");
  if (firstPlayer.team === secondPlayer.team) throw new Error("Initial players were not team-balanced.");

  const startingX = firstPlayer.x;
  first.send("input", { x: 1, y: 0, angle: 0 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (first.state.players.get(first.sessionId).x <= startingX) {
    throw new Error("Authoritative movement did not advance the first player.");
  }

  await first.leave();
  await second.leave();
  console.log("Smoke test passed: health, matchmaking, team balance, sync, and movement.");
} finally {
  server.kill();
}
