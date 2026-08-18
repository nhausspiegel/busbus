// Placeholder entry point. Objective 3 (the Apple-Maps-style UI) replaces this.
// Objective 1 is proven headlessly via scripts/plan-demo.ts.
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
    <h1>busbus</h1>
    <p>Routing engine ready. UI not built yet — run <code>npx tsx scripts/plan-demo.ts</code>.</p>
  </main>,
);
