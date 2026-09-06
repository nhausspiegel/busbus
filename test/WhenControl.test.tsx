/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WhenControl } from "../src/ui/WhenControl";

afterEach(cleanup);

/** Frozen so "today", "past day" and "this month" mean something fixed. */
const NOW = new Date(2026, 8, 5, 14, 28);      // Sat 5 Sep 2026, 2:28pm
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const view = (props: Partial<Parameters<typeof WhenControl>[0]> = {}) => {
  const onChange = vi.fn(), onModeChange = vi.fn();
  render(<WhenControl at={null} mode="leave" onChange={onChange}
                      onModeChange={onModeChange} {...props} />);
  return { onChange, onModeChange };
};
const open = () => fireEvent.click(screen.getByRole("button", { name: /departure time|arrival deadline/i }));

describe("collapsed", () => {
  it("reads Now, and is not highlighted, until a time is chosen", () => {
    view();
    const pill = screen.getByRole("button", { name: /departure time/i });
    expect(pill.textContent).toMatch(/Now/);
    expect(pill.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the chosen time, highlighted", () => {
    view({ at: new Date(2026, 8, 5, 14, 30) });
    const pill = screen.getByRole("button", { name: /departure time/i });
    expect(pill.textContent).toMatch(/2:30/);
    expect(pill.getAttribute("aria-pressed")).toBe("true");
  });

  it("says which question the time answers", () => {
    view({ at: new Date(2026, 8, 5, 14, 30), mode: "arrive" });
    expect(screen.getByRole("button", { name: /arrival deadline/i }).textContent)
      .toMatch(/Arrive by/);
  });

  it("shows no calendar until it is opened", () => {
    view();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Date & Time screen", () => {
  it("opens on the pill, with the leave/arrive toggle", () => {
    view();
    open();
    expect(screen.getByRole("dialog", { name: /date & time/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave at" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Arrive by" })).toBeTruthy();
  });

  it("names the month it is showing", () => {
    view();
    open();
    expect(screen.getByText(/September 2026/)).toBeTruthy();
  });

  it("marks today, and disables every day before it", () => {
    view();
    open();
    // 5 Sep is today; 4 Sep is yesterday and cannot be planned for.
    expect(screen.getByRole("button", { name: "5 September 2026" })
      .getAttribute("aria-current")).toBe("date");
    expect((screen.getByRole("button", { name: "4 September 2026" }) as HTMLButtonElement)
      .disabled).toBe(true);
    expect((screen.getByRole("button", { name: "6 September 2026" }) as HTMLButtonElement)
      .disabled).toBe(false);
  });

  it("switches between leaving and arriving", () => {
    const { onModeChange } = view();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
    expect(onModeChange).toHaveBeenCalledWith("arrive");
  });

  it("Leave Now clears the time and closes", () => {
    const { onChange } = view({ at: new Date(2026, 8, 6, 9, 0) });
    open();
    fireEvent.click(screen.getByRole("button", { name: /leave now/i }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("picking a day keeps the time of day already chosen", () => {
    const { onChange } = view({ at: new Date(2026, 8, 5, 14, 30) });
    open();
    fireEvent.click(screen.getByRole("button", { name: "8 September 2026" }));
    const got = onChange.mock.calls.at(-1)![0] as Date;
    expect([got.getFullYear(), got.getMonth(), got.getDate()]).toEqual([2026, 8, 8]);
    expect([got.getHours(), got.getMinutes()]).toEqual([14, 30]);
  });

  it("closes on the confirm control", () => {
    view();
    open();
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancelling restores the time it opened with", () => {
    const { onChange } = view({ at: new Date(2026, 8, 5, 14, 30) });
    open();
    fireEvent.click(screen.getByRole("button", { name: "8 September 2026" }));
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onChange).toHaveBeenCalledWith(new Date(2026, 8, 5, 14, 30));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("steps to the next month and back", () => {
    view();
    open();
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(screen.getByText(/October 2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(screen.getByText(/September 2026/)).toBeTruthy();
  });
});
