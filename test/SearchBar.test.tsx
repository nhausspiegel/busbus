/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

const searchPlaces = vi.fn(async (_q: string, _signal?: AbortSignal) => [
  { name: "Thayer Street", detail: "College Hill, Providence", at: { lat: 41.83, lng: -71.4 } },
]);
vi.mock("../src/data/geocode", () => ({
  searchPlaces: (q: string, signal?: AbortSignal) => searchPlaces(q, signal),
}));

const { SearchBar } = await import("../src/ui/SearchBar");

/** Mirrors MIN_QUERY in the component. */
const MIN_QUERY = 3;

afterEach(cleanup);
beforeEach(() => { searchPlaces.mockClear(); });

/** Open the field and type `term` one character at a time, `gapMs` apart. */
async function type(term: string, gapMs: number) {
  fireEvent.click(screen.getByText("Where to?"));
  const input = screen.getByLabelText("Search for a destination");
  for (let i = 1; i <= term.length; i++) {
    fireEvent.change(input, { target: { value: term.slice(0, i) } });
    await act(async () => { vi.advanceTimersByTime(gapMs); });
  }
}

describe("SearchBar", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const view = () => render(
    <SearchBar destination={null} onPick={() => {}} onClear={() => {}} />);

  it("searches once for a burst of typing, not once per keystroke", async () => {
    // Nominatim is volunteer-run. A request per keystroke is the abuse that
    // gets an app throttled, and a throttled response arrives without CORS
    // headers, so it reads as a confusing network error rather than a limit.
    view();
    await type("thayer street", 220);        // a brisk but ordinary typing speed
    expect(searchPlaces).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(searchPlaces).toHaveBeenCalledTimes(1);
    expect(searchPlaces.mock.calls[0]![0]).toBe("thayer street");
  });

  it("shows results without the rider pressing Search", async () => {
    view();
    await type("thayer street", 220);
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(screen.getByText("Thayer Street")).toBeTruthy();
  });

  it("does not fire per keystroke for a slow typist", async () => {
    // The case a trailing debounce alone gets wrong: 600ms between characters
    // clears and re-arms the timer every time, so every keystroke past the
    // third would send its own request without a floor on the gap.
    view();
    const gap = 600, term = "thayer street";
    await type(term, gap);
    await act(async () => { vi.advanceTimersByTime(2000); });
    // Bounded by the 1200ms floor over the time spent typing, not by the
    // number of keys pressed. Nominatim's own limit is one request a second.
    const typingMs = term.length * gap;
    expect(searchPlaces.mock.calls.length).toBeLessThanOrEqual(Math.ceil(typingMs / 1200) + 1);
    expect(searchPlaces.mock.calls.length).toBeLessThan(term.length - MIN_QUERY);
  });

  it("stays quiet until there is enough to search for", async () => {
    // Two characters match half of Providence; the request is pure noise.
    view();
    await type("th", 220);
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(searchPlaces).not.toHaveBeenCalled();
  });
});
