import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Do NOT add optimizeDeps.exclude for maplibre-gl. It silences a harmless
  // dev warning but stops Rollup emitting maplibre-gl-worker.mjs, so the
  // production build serves index.html in its place, GeoJSON never parses,
  // and vector layers vanish while raster tiles still draw.
  // GitHub Pages serves the site under /<repo>/, not the domain root.
  base: process.env["GITHUB_ACTIONS"] ? "/busbus/" : "/",
  server: { port: 5173, strictPort: true },
  test: {
    // Node by default; component tests opt into jsdom with a docblock. The
    // routing layer is pure and must stay testable without a DOM.
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // An empty run is not a failure -- the Stop hook keys on this exit code.
    passWithNoTests: true,
  },
});
