/** Draggable bottom sheet with three detents.
 *
 *  The map is the context and the sheet is the answer, so the sheet has to
 *  move without leaving the map: peek shows the next departures, half shows
 *  the list, full shows detail. Drag the grabber, or tap it to cycle. */
import { useEffect, useRef, useState, type ReactNode } from "react";

export type Detent = "peek" | "half" | "full";

/** Fraction of viewport height the sheet occupies at each detent. */
/** Peek is deliberately small: the map is the context and the sheet should not
 *  eat a third of it before the rider has asked for anything. */
const HEIGHT: Record<Detent, number> = { peek: 0.20, half: 0.52, full: 0.92 };
const ORDER: Detent[] = ["peek", "half", "full"];
const DRAG_THRESHOLD_PX = 5;

/** How far a throw carries past the finger, in seconds of travel. Snapping to
 *  wherever the finger happened to stop ignores intent: a fast flick upward
 *  means "open it", even if it was released only slightly above the start. */
const MOMENTUM_SECONDS = 0.16;
/** Past the top detent the sheet still moves, but grudgingly. */
const RUBBER = 0.35;

export function Sheet({
  detent, onDetentChange, header, label, children,
}: {
  detent: Detent; onDetentChange: (d: Detent) => void;
  /** Accessible name for the panel; it is not always a departures list. */
  label?: string;
  /** Pinned above the scroll area -- search belongs here, not floating over
   *  the map, because the sheet is the surface the rider actually works in. */
  header?: ReactNode;
  children: ReactNode;
}) {
  // null means "not dragging" -- the sheet follows `detent`. A number means the
  // finger is down and moving. Entering drag mode on pointerdown instead would
  // freeze the sheet at its start height if pointerup were ever missed.
  const [dragPx, setDragPx] = useState<number | null>(null);
  // The grabber tracks the finger for the whole gesture, so pointerdown and
  // pointerup both land on the button and the browser fires a click after
  // every drag. Without this guard `cycle` ran after the snap and the sheet
  // always overshot by one detent -- dragging down from full was impossible.
  const didDrag = useRef(false);
  const activePointer = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? false : window.innerWidth >= 820));

  useEffect(() => {
    const onResize = () => { setVh(window.innerHeight); setWide(window.innerWidth >= 820); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const height = dragPx ?? HEIGHT[detent] * vh;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || activePointer.current !== null) return;  // ignore a second finger
    activePointer.current = e.pointerId;
    didDrag.current = false;
    const startY = e.clientY;
    const startH = HEIGHT[detent] * vh;
    let dragging = false;
    // Velocity from the most recent movement only: an average over the whole
    // gesture makes a flick at the end of a slow drag feel ignored.
    let lastY = e.clientY;
    let lastT = e.timeStamp;
    let velocity = 0;   // px per second, positive = upward

    // Track the live height here rather than reading it back out of state, so
    // the release handler never has to call the parent from inside a state
    // updater -- updaters must be pure, and React warns loudly when they are not.
    let liveH = startH;
    const maxH = HEIGHT.full * vh;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointer.current) return;
      const delta = startY - ev.clientY;
      if (!dragging && Math.abs(delta) < DRAG_THRESHOLD_PX) return;  // still a tap
      dragging = true;
      didDrag.current = true;

      const dt = (ev.timeStamp - lastT) / 1000;
      // A pause means the throw is over. Without this, drag up, hold, release
      // still flings the sheet using the velocity from a second ago.
      if (dt > 0.1) velocity = 0;
      else if (dt > 0) velocity = (lastY - ev.clientY) / dt;
      lastY = ev.clientY;
      lastT = ev.timeStamp;

      let next = startH + delta;
      // Rubber-band past the top rather than stopping dead, so the sheet feels
      // attached to the finger instead of hitting a wall.
      if (next > maxH) next = maxH + (next - maxH) * RUBBER;
      liveH = Math.min(Math.max(next, 90), maxH + 60);
      setDragPx(liveH);
    };
    const up = (ev: PointerEvent) => {
      // Only this finger ends this drag. Otherwise tapping the map with a
      // second finger snapped the sheet mid-gesture and stranded the first.
      if (ev.pointerId !== activePointer.current) return;
      activePointer.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragPx(null);                    // always release, so it cannot stick
      if (!dragging) return;              // a tap: onClick cycles instead
      // Snap to where the throw was heading, not where the finger stopped.
      const projected = liveH + velocity * MOMENTUM_SECONDS;
      const f = projected / vh;
      let best = ORDER[0]!;
      for (const d of ORDER)
        if (Math.abs(HEIGHT[d] - f) < Math.abs(HEIGHT[best] - f)) best = d;
      onDetentChange(best);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Start a drag from the body. Only takes over when the list is already at
   *  the top and the gesture is vertical; otherwise the browser scrolls. */
  const onContentPointerDown = (e: React.PointerEvent) => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollTop > 0 && detent === "full") return;   // let it scroll
    onPointerDown(e);
  };

  const cycle = () => {
    // A drag already chose a detent; the trailing click must not advance it.
    if (didDrag.current) { didDrag.current = false; return; }
    onDetentChange(ORDER[(ORDER.indexOf(detent) + 1) % ORDER.length]!);
  };

  return (
    <section
      aria-label={label ?? "Departures"}
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
        transition: dragPx === null ? "height .34s cubic-bezier(.22,1,.28,1)" : "none",
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
      {header && (
        // The grabber above is what holds the search field off the top edge,
        // and it only exists when the sheet can be dragged. On a wide screen
        // there is no grabber, so the header has to supply that space itself
        // or the field sits flush against the panel's top with 18px either
        // side of it. Matching the horizontal padding keeps the inset even.
        <div style={{ padding: wide ? "18px 18px 10px" : "0 16px 10px", flexShrink: 0 }}>
          {header}
        </div>
      )}
      <div
        ref={scroller}
        // Dragging works anywhere on the sheet, not only on the grabber --
        // but only when the content is already scrolled to the top, so a
        // downward swipe still scrolls a long list instead of closing it.
        onPointerDown={wide ? undefined : onContentPointerDown}
        style={{
          overflowY: "auto", overscrollBehavior: "contain", flex: 1,
          padding: wide ? "16px 18px" : "0 16px calc(16px + var(--safe-b))",
        }}
      >
        {children}
      </div>
    </section>
  );
}
