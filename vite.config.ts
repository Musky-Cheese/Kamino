import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    // Three.js alone is ~600 kB; one bundle is fine for a single-page game.
    chunkSizeWarningLimit: 1200,
  },
});
