import { useState } from "react";
import type { Alert } from "../data/alerts";
import type { StaticFeed } from "../data/types";

/** Service alerts: detours and closures Passio has published. */
export function AlertBanner({ alerts, feed }: { alerts: Alert[]; feed: StaticFeed | null }) {
  const [open, setOpen] = useState(false);
  if (alerts.length === 0) return null;
  const first = alerts[0]!;
  const names = first.routeIds
    .map((id) => feed?.routes.get(id)?.name ?? id)
    .filter(Boolean);

  return (
    <div style={{
      background: "var(--warn-bg)", border: "1px solid var(--warn-line)",
      color: "var(--warn-ink)", borderRadius: 10, padding: "10px 12px", marginBottom: 12,
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: "flex", gap: 8, alignItems: "flex-start", width: "100%",
                 border: 0, background: "transparent", padding: 0, cursor: "pointer",
                 textAlign: "left", color: "inherit" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
          <path d="M12 3 1.5 21h21L12 3Z" strokeLinejoin="round" /><path d="M12 10v4M12 17.5v.01" />
        </svg>
        <span style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>
          <strong>{first.header}</strong>
          {names.length > 0 && <span style={{ opacity: 0.85 }}> · {names.join(", ")}</span>}
          {alerts.length > 1 && <span style={{ opacity: 0.85 }}> · +{alerts.length - 1} more</span>}
        </span>
        <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.7 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5 }}>
          {alerts.map((a, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : "8px 0 0" }}>
              {alerts.length > 1 && <strong>{a.header}. </strong>}
              {a.description || a.header}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
