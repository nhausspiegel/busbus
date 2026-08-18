import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // MapLibre ships its own web worker; the dep optimizer mangles it and the
  // map silently fails to render. Excluding it is the documented fix.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The GTFS static zip sends NO access-control-allow-origin (the three
      // realtime endpoints do). A browser therefore cannot fetch the timetable
      // directly, so dev goes through this proxy. Production needs its own
      // proxy or a build-time copy of the feed -- see README.
      "/passio-gtfs": {
        target: "https://passio3.com/brown/passioTransit/gtfs",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/passio-gtfs/, ""),
      },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // An empty run is not a failure -- the Stop hook keys on this exit code.
    passWithNoTests: true,
  },
});
