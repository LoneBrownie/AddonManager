import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // `public/` at the repo root holds the curated addon lists, which are served
  // from GitHub and fetched at runtime. Without this, Vite would treat them as
  // static assets and bundle a stale copy into the app.
  publicDir: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
