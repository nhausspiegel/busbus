import { useState } from "react";
import { TUNING } from "../render/links";

/**
 * Sliders for the rendering numbers that can only be judged by looking.
 *
 * Every value in `TUNING` was first set by guessing and then corrected once the
 * owner looked at the map -- twice for the miter threshold, because three
 * samples were not the distribution. Guessing, shipping, and asking someone to
 * look is a slow loop with a person in the middle of it. This puts the numbers
 * where the eye judging them already is.
 *
 * Shown on localhost, and anywhere with `?tune` in the URL so the deployed
 * build can be adjusted too. It changes nothing about what ships: the defaults
 * live in `TUNING`, and moving a slider only affects the running tab.
 */
const FIELDS = [
  { key: "laneGapPx", label: "lane gap", min: 0, max: 14, step: 0.5,
    hint: "space between two routes sharing a street" },
  { key: "clearPx", label: "junction clearance", min: 0, max: 24, step: 0.5,
    hint: "how far each line pulls back before the corner curve" },
  { key: "miterExcessPx", label: "corner threshold", min: 0.1, max: 4, step: 0.05,
    hint: "sharper than this and the corner is drawn as a curve, not a miter" },
  { key: "curveTension", label: "curve tension", min: 0, max: 1, step: 0.02,
    hint: "higher bulges the corner curve outward" },
] as const;

export function RenderTuner({ onChange }: { onChange: () => void }) {
  const [, bump] = useState(0);
  const [open, setOpen] = useState(false);

  const show = import.meta.env.DEV
    || (typeof location !== "undefined" && new URLSearchParams(location.search).has("tune"));
  if (!show) return null;

  const set = (key: string, v: number) => {
    (TUNING as unknown as Record<string, number>)[key] = v;
    bump((n) => n + 1);
    onChange();
  };

  const box: React.CSSProperties = {
    position: "absolute", top: 104, right: 10, zIndex: 3,
    background: "rgb(255 255 255 / 96%)", borderRadius: 10,
    border: "1px solid rgb(0 0 0 / 15%)", boxShadow: "0 2px 10px rgb(0 0 0 / 22%)",
    font: "500 11px ui-sans-serif, system-ui, sans-serif", color: "#241C17",
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        style={{ ...box, padding: "7px 11px", cursor: "pointer" }}>
        tune
      </button>
    );
  }

  return (
    <div style={{ ...box, padding: 12, width: 232 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 11 }}>render tuning</strong>
        <button type="button" onClick={() => setOpen(false)}
          style={{ border: 0, background: "none", cursor: "pointer", font: "inherit" }}
          aria-label="Close">×</button>
      </div>
      {FIELDS.map((f) => {
        const v = (TUNING as unknown as Record<string, number>)[f.key]!;
        return (
          <label key={f.key} style={{ display: "block", marginBottom: 10 }} title={f.hint}>
            <div style={{ display: "flex", justifyContent: "space-between",
                          alignItems: "center", gap: 8 }}>
              <span>{f.label}</span>
              {/* Typed, not only dragged: a slider cannot express 0.85, and the
                  values worth testing are often just outside the range the
                  slider was given. No min/max here on purpose. */}
              <input type="number" step={f.step} value={v}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) set(f.key, n);
                }}
                style={{ width: 62, padding: "1px 4px", font: "inherit",
                         fontVariantNumeric: "tabular-nums", textAlign: "right",
                         border: "1px solid rgb(0 0 0 / 20%)", borderRadius: 4 }} />
            </div>
            <input type="range" min={f.min} max={f.max} step={f.step}
              value={Math.min(f.max, Math.max(f.min, v))}
              onChange={(e) => set(f.key, Number(e.target.value))}
              style={{ width: "100%", marginTop: 2 }} />
          </label>
        );
      })}
      <div style={{ opacity: 0.6, lineHeight: 1.35 }}>
        Pixels, so they mean the same at every zoom. Type a value to go past a
        slider's range. Not persisted — reload for the committed defaults.
      </div>
    </div>
  );
}
