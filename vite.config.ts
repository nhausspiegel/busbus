import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // An empty run is not a failure -- the Stop hook keys on this exit code.
    passWithNoTests: true,
  },
});
