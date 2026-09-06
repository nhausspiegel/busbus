/** When the rider wants to travel: a pill, and the screen behind it.
 *
 *  This used to be three controls in a row -- Leave / Arrive by / now plus a
 *  bare time input -- rendered flat wherever it appeared. The row said nothing
 *  about which of the two questions was live until you read the highlighting,
 *  and it took horizontal space on a screen that has none.
 *
 *  Now it is one pill that states the current answer, and a Date & Time screen
 *  behind it, which is the only place the choice is made. */
import { useState } from "react";

export type WhenMode = "leave" | "arrive";

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** Spelled out rather than taken from toLocaleDateString, so the month heading
 *  and each day's accessible name do not depend on the runner's locale --
 *  which is otherwise a test that passes here and fails on another machine. */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
                     "August", "September", "October", "November", "December"];
const monthLabel = (d: Date) => `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
const dayLabel = (d: Date) => `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;

const time = (d: Date) =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate();

/** Midnight, for comparing a calendar day against today without the clock. */
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Every cell of a month grid, padded so the 1st lands under its weekday. */
function monthGrid(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const pad = first.getDay();
  const cells: (Date | null)[] = Array(pad).fill(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d));
  return cells;
}

export function WhenControl({
  at, mode = "leave", onChange, onModeChange, onExpandedChange,
}: {
  at: Date | null;
  mode?: WhenMode;
  onChange: (d: Date | null) => void;
  onModeChange?: (m: WhenMode) => void;
  /** So the sheet can rise for the calendar and settle again after. */
  onExpandedChange?: (open: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  /** What `at` was when the screen opened, so Cancel can put it back. */
  const [entry, setEntry] = useState<Date | null>(null);
  const [month, setMonth] = useState(() => startOfDay(at ?? new Date()));

  const now = new Date();
  const chosen = at !== null;
  const label = mode === "arrive" ? "Arrive by" : "Leave at";

  const setEditingAnd = (open: boolean) => { setEditing(open); onExpandedChange?.(open); };

  const openScreen = () => {
    setEntry(at);
    setMonth(startOfDay(at ?? new Date()));
    setEditingAnd(true);
  };

  // The day the rider is editing. With no time chosen the screen opens on now,
  // so moving either control alone still produces a complete answer.
  const working = at ?? now;

  const pickDay = (d: Date) => {
    const next = new Date(d);
    next.setHours(working.getHours(), working.getMinutes(), 0, 0);
    onChange(next);
  };

  if (!editing) {
    return (
      <button
        onClick={openScreen}
        aria-pressed={chosen}
        aria-label={mode === "arrive" ? "Arrival deadline" : "Departure time"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 12,
          border: `1px solid ${chosen ? "var(--accent)" : "var(--hairline)"}`,
          background: chosen ? "var(--accent-wash)" : "var(--raised)",
          color: chosen ? "var(--accent)" : "var(--ink)",
          borderRadius: 999, padding: "6px 12px", fontSize: 13, fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {/* "Now" is the whole answer when nothing is chosen -- the screenshots
            put everything else behind this one word. */}
        {chosen ? `${label} ${time(at)}${sameDay(at, now) ? "" : ` ${at.toLocaleDateString([], { month: "short", day: "numeric" })}`}` : "Now"}
        <svg width="9" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"
             stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>
    );
  }

  const cells = monthGrid(month.getFullYear(), month.getMonth());
  const today = startOfDay(now);

  return (
    <div role="dialog" aria-label="Date & Time"
         style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 36px",
                    alignItems: "center" }}>
        <button onClick={() => { onChange(entry); setEditingAnd(false); }}
                aria-label="Cancel" style={roundBtn(false)}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
               stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
        <h2 style={{ margin: 0, textAlign: "center", fontSize: 17, fontWeight: 700 }}>
          Date &amp; Time
        </h2>
        <button onClick={() => setEditingAnd(false)} aria-label="Done" style={roundBtn(true)}>
          <svg width="13" height="10" viewBox="0 0 13 10" fill="none" aria-hidden="true"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 5l4 4 7-8" />
          </svg>
        </button>
      </div>

      {/* One toggle, not two independent pills: they were always mutually
          exclusive and never read that way. */}
      {onModeChange && (
        <div role="group" aria-label="Plan by"
             style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4,
                      background: "var(--paper)", borderRadius: 999, padding: 3 }}>
          {(["leave", "arrive"] as const).map((m) => (
            <button key={m} onClick={() => onModeChange(m)} aria-pressed={mode === m}
                    aria-label={m === "leave" ? "Leave at" : "Arrive by"}
                    style={{
                      border: 0, borderRadius: 999, padding: "7px 0", fontSize: 14,
                      fontWeight: 600, cursor: "pointer",
                      background: mode === m ? "var(--raised)" : "transparent",
                      color: mode === m ? "var(--ink)" : "var(--muted)",
                    }}>
              {m === "leave" ? "Leave at" : "Arrive by"}
            </button>
          ))}
        </div>
      )}

      <div style={{ background: "var(--paper)", borderRadius: 14, padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <span style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>
            {monthLabel(month)}
          </span>
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                  aria-label="Previous month" style={stepBtn}>‹</button>
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                  aria-label="Next month" style={stepBtn}>›</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {DAY_NAMES.map((d) => (
            <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 700,
                                  color: "var(--muted)", padding: "4px 0" }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={`pad${i}`} />;
            // A day already gone cannot be planned for, and offering it is how
            // "leave at" quietly became "have left".
            const past = d < today;
            const isToday = sameDay(d, now);
            const picked = at !== null && sameDay(d, at);
            return (
              <button key={d.toISOString()} disabled={past} onClick={() => pickDay(d)}
                      aria-current={isToday ? "date" : undefined}
                      aria-pressed={picked}
                      aria-label={dayLabel(d)}
                      style={{
                        border: 0, background: picked ? "var(--accent)" : "transparent",
                        color: past ? "var(--hairline)"
                             : picked ? "var(--raised)"
                             : isToday ? "var(--accent)" : "var(--ink)",
                        fontWeight: isToday || picked ? 700 : 500,
                        aspectRatio: "1", borderRadius: 999, fontSize: 15,
                        cursor: past ? "default" : "pointer",
                      }}>
                {d.getDate()}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>Time</span>
          <input
            type="time" aria-label={label}
            value={`${String(working.getHours()).padStart(2, "0")}:${String(working.getMinutes()).padStart(2, "0")}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              if (!Number.isFinite(h) || !Number.isFinite(m)) return;
              const next = new Date(working);
              next.setHours(h!, m!, 0, 0);
              onChange(next);
            }}
            style={{ border: 0, background: "var(--raised)", color: "var(--ink)",
                     borderRadius: 999, padding: "6px 12px",
                     font: "15px Barlow, sans-serif" }}
          />
        </div>
      </div>

      {/* The reset. Below the calendar, as in Maps -- it undoes everything
          above it rather than being one more option among them. */}
      <button onClick={() => { onChange(null); setEditingAnd(false); }}
              disabled={!chosen} aria-label="Leave Now"
              style={{ border: 0, borderRadius: 14, padding: "13px 0", width: "100%",
                       background: "var(--paper)", fontSize: 16, fontWeight: 600,
                       color: chosen ? "var(--accent)" : "var(--muted)",
                       cursor: chosen ? "pointer" : "default" }}>
        Leave Now
      </button>
    </div>
  );
}

const roundBtn = (accent: boolean): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 30, height: 30, borderRadius: 999, border: 0, cursor: "pointer",
  background: accent ? "var(--accent)" : "var(--paper)",
  color: accent ? "var(--raised)" : "var(--ink)",
});

const stepBtn: React.CSSProperties = {
  border: 0, background: "transparent", color: "var(--accent)",
  fontSize: 22, lineHeight: 1, width: 30, cursor: "pointer",
};
