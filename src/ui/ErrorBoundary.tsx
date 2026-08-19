import { Component, type ErrorInfo, type ReactNode } from "react";

/** Turns a crash into a recoverable message instead of a blank screen.
 *
 *  This is not defensive decoration: an exception escaping an effect has
 *  unmounted this app twice already (MapLibre throws "Style is not done
 *  loading" if a layer is touched mid-reload). A rider standing at a stop gets
 *  a white rectangle and no way back, which is worse than any wrong time.
 *
 *  Error boundaries still require a class in React 19; there is no hook form. */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the real stack in the console; the screen shows something usable.
    console.error("busbus crashed:", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        position: "fixed", inset: 0, display: "grid", placeItems: "center",
        padding: 24, background: "var(--paper)", color: "var(--ink)",
        font: "15px/1.5 Barlow, system-ui, sans-serif", textAlign: "center",
      }}>
        <div style={{ maxWidth: 340 }}>
          <h1 className="display" style={{ fontSize: 26, margin: "0 0 8px" }}>
            busbus stopped working
          </h1>
          <p style={{ margin: "0 0 4px", color: "var(--muted)", fontSize: 14 }}>
            Something broke while drawing the map. Reloading usually fixes it.
          </p>
          <p style={{ margin: "0 0 18px", color: "var(--muted)", fontSize: 12 }}>
            Shuttle times were not affected — this is a display problem, not a
            wrong departure.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              border: 0, background: "var(--accent)", color: "#fff",
              borderRadius: 10, padding: "10px 20px",
              fontSize: 15, fontWeight: 600, cursor: "pointer",
            }}
          >Reload</button>
        </div>
      </div>
    );
  }
}
