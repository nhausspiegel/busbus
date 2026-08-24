/** Destination entry: type a place, or tap the map. */
import { useEffect, useRef, useState } from "react";
import { searchPlaces, type Place } from "../data/geocode";

/** Shortest query worth sending. Below this every result is noise anyway. */
const MIN_QUERY = 3;
/** How long a rider must stop typing before the request goes out. */
const TYPING_PAUSE_MS = 450;
/**
 * Floor on the gap between two requests, however the rider types.
 *
 * A trailing debounce alone only protects against typists FASTER than the
 * pause. Someone typing at a deliberate 600ms per character clears the timer
 * every single time and fires one Nominatim request per keystroke -- precisely
 * the abuse the debounce was meant to prevent, from the rider least likely to
 * be in a hurry.
 */
const MIN_GAP_MS = 1_200;

export function SearchBar({
  destination, onPick, onClear,
}: {
  destination: { label: string } | null;
  onPick: (p: Place) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** When the last geocode actually left, so the floor can be enforced. */
  const lastSent = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    void search(q);
  };

  const search = async (term: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true); setMsg(null);
    try {
      const found = await searchPlaces(term, ctl.signal);
      setResults(found);
      if (found.length === 0) setMsg("Nothing found near Providence. Try a street address.");
    } catch (err) {
      if ((err as Error).name !== "AbortError") setMsg("Place search is unavailable. Tap the map instead.");
    } finally {
      setBusy(false);
    }
  };

  // Results while typing, rather than only after the button. Debounced and
  // floored at three characters because Nominatim is volunteer-run and a
  // request per keystroke is exactly the abuse that gets an app throttled --
  // a throttled response comes back without CORS headers and reads as a
  // confusing network error rather than a rate limit. One request per pause
  // in typing, and the previous one is aborted before the next goes out.
  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_QUERY) { setResults([]); setMsg(null); return; }
    // Wait for a pause in typing, but never less than MIN_GAP_MS since the
    // last request actually went out.
    const since = Date.now() - lastSent.current;
    const delay = Math.max(TYPING_PAUSE_MS, MIN_GAP_MS - since);
    const t = setTimeout(() => {
      lastSent.current = Date.now();
      void search(term);
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  if (destination && !open) {
    return (
      <div style={bar}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                       whiteSpace: "nowrap", fontSize: 15 }}>
          To <strong>{destination.label}</strong>
        </span>
        <button onClick={onClear} style={ghostBtn} aria-label="Clear destination">Clear</button>
      </div>
    );
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ ...bar, cursor: "pointer", textAlign: "left" }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--muted)"
             strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <span style={{ color: "var(--muted)", fontSize: 15 }}>Where to?</span>
      </button>
    );
  }

  return (
    <div style={{ ...bar, flexDirection: "column", alignItems: "stretch", gap: 0, padding: 0 }}>
      <form onSubmit={run} style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search a place or address"
          aria-label="Search for a destination"
          style={{ flex: 1, border: 0, outline: "none", font: "15px Barlow, sans-serif",
                   background: "transparent", color: "var(--ink)", minWidth: 0 }}
        />
        <button type="submit" disabled={busy || q.trim().length < 3} style={ghostBtn}>
          {busy ? "…" : "Search"}
        </button>
        <button type="button"
                onClick={() => {
                  // Abort the in-flight geocode too, or it lands afterwards and
                  // repopulates results behind the closed panel.
                  abort.current?.abort();
                  setOpen(false); setResults([]); setMsg(null); setBusy(false);
                }}
                style={ghostBtn} aria-label="Close search">Cancel</button>
      </form>

      {msg && <p style={{ margin: 0, padding: "0 12px 10px", fontSize: 13, color: "var(--muted)" }}>{msg}</p>}

      {results.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 260, overflowY: "auto",
                     borderTop: "1px solid var(--hairline)" }}>
          {results.map((p, i) => (
            <li key={i}>
              <button
                onClick={() => { onPick(p); setOpen(false); setResults([]); setQ(""); }}
                style={{ display: "block", width: "100%", textAlign: "left", border: 0,
                         background: "transparent", padding: "10px 12px", cursor: "pointer",
                         borderBottom: "1px solid var(--hairline)" }}
              >
                <div style={{ fontSize: 15, fontWeight: 500 }}>{p.name}</div>
                {p.detail && <div style={{ fontSize: 12, color: "var(--muted)" }}>{p.detail}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%",
  background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 12,
  padding: "11px 12px", boxSizing: "border-box",
};

const ghostBtn: React.CSSProperties = {
  border: 0, background: "transparent", color: "var(--accent)",
  fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "2px 4px", flexShrink: 0,
};
