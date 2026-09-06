/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

const searchPlaces = vi.fn(async (_q: string, _stops?: unknown, _signal?: AbortSignal) => [
  { name: "Thayer Street", detail: "College Hill, Providence", at: { lat: 41.83, lng: -71.4 } },
]);
vi.mock("../src/data/geocode", () => ({
  searchPlaces: (q: string, stops?: unknown, signal?: AbortSignal) => searchPlaces(q, stops, signal),
}));

const { SearchBar: Raw } = await import("../src/ui/SearchBar");

/** SearchBar's open state is owned by App, so tests supply the same wiring.
 *  Without a host holding it, clicking "Where to?" would report the change and
 *  render nothing -- which is exactly the bug this indirection exists for. */
function SearchBar(props: Omit<Parameters<typeof Raw>[0], "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false);
  return <Raw {...props} open={open} onOpenChange={setOpen} />;
}

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

describe("the search field is mostly field", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("has no Search button, because results arrive while typing", async () => {
    // Two word-buttons crowded a field that is mostly field, and the Search
    // one only offered a second way to do what the list already does.
    render(<SearchBar destination={null} onPick={() => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByText("Where to?"));
    expect(screen.queryByRole("button", { name: /^search$/i })).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("closes with an icon rather than the word Cancel", () => {
    render(<SearchBar destination={null} onPick={() => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByText("Where to?"));
    const close = screen.getByRole("button", { name: /close search/i });
    expect(close).toBeTruthy();
    expect(close.textContent).toBe("");          // an icon, not a word
    fireEvent.click(close);
    expect(screen.getByText("Where to?")).toBeTruthy();
  });

  /** The destination branch was untested, and both of these were broken in it.
   *  The x replaced the word "Cancel" on the CLOSE control and never reached
   *  the CLEAR one beside it; and the branch rendered a plain div, so once a
   *  route was on the map there was no way back into search at all. */
  describe("with a destination already picked", () => {
    const withDest = () => render(
      <SearchBar destination={{ label: "Trader Joe's" }}
                 onPick={() => {}} onClear={onClear} />);
    let onClear = vi.fn();
    beforeEach(() => { onClear = vi.fn(); });

    it("clears with an icon rather than the word Clear", () => {
      withDest();
      const clear = screen.getByRole("button", { name: /clear destination/i });
      expect(clear.textContent).toBe("");        // an icon, not a word
      fireEvent.click(clear);
      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it("reopens search on a tap, without discarding the destination", () => {
      // Clearing was the only way back in, and it threw the destination away.
      withDest();
      fireEvent.click(screen.getByText("Trader Joe's"));
      expect(screen.getByLabelText("Search for a destination")).toBeTruthy();
      expect(onClear).not.toHaveBeenCalled();
    });
  });

  it("still searches when the rider presses Enter", async () => {
    render(<SearchBar destination={null} onPick={() => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByText("Where to?"));
    const input = screen.getByLabelText("Search for a destination");
    fireEvent.change(input, { target: { value: "thayer street" } });
    fireEvent.submit(input.closest("form")!);
    await act(async () => { vi.advanceTimersByTime(50); });
    // The stop list rides along now: results are filtered to what a rider can
    // walk to a stop from, and the stops themselves are offered as places.
    expect(searchPlaces).toHaveBeenCalledWith(
      "thayer street", expect.any(Array), expect.anything());
  });
});
