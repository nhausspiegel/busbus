/** Draggable bottom sheet with three detents.
 *
 *  The map is the context and the sheet is the answer, so the sheet has to
 *  move without leaving the map: peek shows the next departures, half shows
 *  the list, full shows detail. Drag the grabber, or tap it to cycle. */
import { useEffect, useRef, useState, type ReactNode } from "react";

export type Detent = "peek" | "half" | "full";

/** Fraction of viewport height the sheet occupies at each detent. */
const HEIGHT: Record<Detent, number> = { peek: 0.30, half: 0.55, full: 0.92 };
const ORDER: Detent[] = ["peek", "half", "full"];
const DRAG_THRESHOLD_PX = 5;

export function Sheet({
  detent, onDetentChange, children,
}: { detent: Detent; onDetentChange: (d: Detent) => void; children: ReactNode }) {
  // null means "not dragging" -- the sheet follows `detent`. A number means the
  // finger is down and moving. Entering drag mode on pointerdown instead would
  // freeze the sheet at its start height if pointerup were ever missed.
  const [dragPx, setDragPx] = useState<number | null>(null);
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? false : window.innerWidth >= 820));

  useEffect(() => {
    const onResize = () => { setVh(window.innerHeight); setWide(window.innerWidth >= 820); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const height = dragPx ?? HEIGHT[detent] * vh;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    const startH = HEIGHT[detent] * vh;
    let dragging = false;

    // Track the live height here rather than reading it back out of state, so
    // the release handler never has to call the parent from inside a state
    // updater -- updaters must be pure, and React warns loudly when they are not.
    let liveH = startH;
    const move = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      if (!dragging && Math.abs(delta) < DRAG_THRESHOLD_PX) return;  // still a tap
      dragging = true;
      liveH = Math.min(Math.max(startH + delta, 90), vh * 0.95);
      setDragPx(liveH);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragPx(null);                    // always release, so it cannot stick
      if (!dragging) return;              // a tap: onClick cycles instead
      const f = liveH / vh;
      let best = ORDER[0]!;
      for (const d of ORDER)
        if (Math.abs(HEIGHT[d] - f) < Math.abs(HEIGHT[best] - f)) best = d;
      onDetentChange(best);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const cycle = () => onDetentChange(ORDER[(ORDER.indexOf(detent) + 1) % ORDER.length]!);

  return (
    <section
      aria-label="Departures"
      style={{
        // On a wide screen the sheet becomes a side panel: a full-width tray
        // across a desktop monitor wastes the map and is hard to read across.
        position: "absolute", left: 0, bottom: 0,
        right: wide ? "auto" : 0,
        width: wide ? 400 : "auto",
        margin: wide ? 12 : 0,
        height: wide ? `calc(100vh - 92px)` : height,
        maxHeight: wide ? "none" : "95vh",
        borderRadius: wide ? "var(--sheet-radius)" : undefined,
        background: "var(--raised)",
        borderTopLeftRadius: "var(--sheet-radius)", borderTopRightRadius: "var(--sheet-radius)",
        boxShadow: "var(--shadow)",
        display: "flex", flexDirection: "column",
        transition: dragPx === null ? "height .28s cubic-bezier(.32,.72,0,1)" : "none",
        zIndex: 2,
      }}
    >
      {/* The grabber only means something when the sheet can be resized. */}
      {!wide && <button
        onPointerDown={onPointerDown}
        onClick={cycle}
        aria-label={`Resize panel, currently ${detent}`}
        style={{
          border: 0, background: "transparent", padding: "10px 0 6px",
          cursor: "grab", touchAction: "none", flexShrink: 0, width: "100%",
        }}
      >
        <div style={{ width: 38, height: 5, borderRadius: 3, background: "var(--hairline)", margin: "0 auto" }} />
      </button>}
      <div style={{
        overflowY: "auto", overscrollBehavior: "contain", flex: 1,
        padding: wide ? "16px 18px" : "0 16px calc(16px + var(--safe-b))",
      }}>
        {children}
      </div>
    </section>
  );
}
