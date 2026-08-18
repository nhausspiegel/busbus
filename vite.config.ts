import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // MapLibre ships its own web worker; the dep optimizer mangles it and the
  // map silently fails to render. Excluding it is the documented fix.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  // GitHub Pages serves the site under /<repo>/, not the domain root.
  base: process.env["GITHUB_ACTIONS"] ? "/busbus/" : "/",
  server: { port: 5173, strictPort: true },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // An empty run is not a failure -- the Stop hook keys on this exit code.
    passWithNoTests: true,
  },
});
