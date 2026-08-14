import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app's real version, for the browser build's stand-in backend. In the
// desktop app the engine answers this; in the browser it used to answer
// "0.0.0-mock", which is fine until a screenshot of Settings ends up in the
// README with a version nobody can install.
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  // `public/` at the repo root holds the curated addon lists, which are served
  // from GitHub and fetched at runtime. Without this, Vite would treat them as
  // static assets and bundle a stale copy into the app.
  publicDir: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
