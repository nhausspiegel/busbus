/** Leave now, or plan for a later time today.
 *
 *  Uses a native time input: it is the platform's own picker, already
 *  accessible and already familiar, and there is nothing here worth
 *  reimplementing. */
export function WhenControl({
  at, onChange,
}: { at: Date | null; onChange: (d: Date | null) => void }) {
  const value = at
    ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
    : "";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <label style={{ fontSize: 13, color: "var(--muted)" }} htmlFor="leave-at">Leave</label>
      <button
        onClick={() => onChange(null)}
        aria-pressed={at === null}
        style={{
          border: `1px solid ${at === null ? "var(--accent)" : "var(--hairline)"}`,
          background: at === null ? "var(--accent-wash)" : "var(--raised)",
          color: at === null ? "var(--accent)" : "var(--ink)",
          borderRadius: 999, padding: "4px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}
      >now</button>
      <input
        id="leave-at" type="time" value={value}
        onChange={(e) => {
          const [h, m] = e.target.value.split(":").map(Number);
          if (!Number.isFinite(h) || !Number.isFinite(m)) return onChange(null);
          const d = new Date();
          d.setHours(h!, m!, 0, 0);
          // Picking 8:00 at 11pm means tomorrow morning, not this morning --
          // otherwise the app silently plans a trip that already happened.
          if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
          onChange(d);
        }}
        style={{
          border: `1px solid ${at ? "var(--accent)" : "var(--hairline)"}`,
          background: "var(--raised)", color: "var(--ink)",
          borderRadius: 999, padding: "4px 10px", font: "13px Barlow, sans-serif",
        }}
      />
      {at && at.toDateString() !== new Date().toDateString() && (
        <span style={{ fontSize: 12, color: "var(--muted)" }}>tomorrow</span>
      )}
    </div>
  );
}
