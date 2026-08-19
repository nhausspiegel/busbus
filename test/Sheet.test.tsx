/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Sheet, type Detent } from "../src/ui/Sheet";

// The sheet is a fixed side panel above 820px, where there is nothing to drag.
// jsdom defaults to 1024, so pin a phone viewport for these tests.
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});
afterEach(cleanup);

/** Drive a full pointer gesture the way a finger does: down on the grabber,
 *  moves on the window, up on the window, then the click the browser fires
 *  because both down and up landed on the same element. */
function drag(grabber: HTMLElement, fromY: number, toY: number, steps = 4) {
  act(() => {
    grabber.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientY: fromY, button: 0, pointerId: 1,
    }));
  });
  for (let i = 1; i <= steps; i++) {
    const y = fromY + ((toY - fromY) * i) / steps;
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, clientY: y, pointerId: 1,
      }));
    });
  }
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: toY, pointerId: 1 }));
    // The browser fires this after any press whose down and up share a target.
    grabber.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setup(detent: Detent = "peek") {
  const onDetentChange = vi.fn();
  render(<Sheet detent={detent} onDetentChange={onDetentChange}><p>body</p></Sheet>);
  return { onDetentChange, grabber: screen.getByRole("button", { name: /resize panel/i }) };
}

describe("Sheet", () => {
  it("does not advance a detent on the click that follows a drag", () => {
    // The grabber tracks the finger, so pointerdown and pointerup share a
    // target and the browser fires a click after every drag. Without a guard
    // the sheet snapped and then cycled again, overshooting by one detent --
    // and dragging downward was impossible, since the click undid it.
    const { onDetentChange, grabber } = setup("peek");
    drag(grabber, 700, 400);            // a clear upward drag
    expect(onDetentChange).toHaveBeenCalledTimes(1);
  });

  it("still cycles on a plain tap", () => {
    const { onDetentChange, grabber } = setup("peek");
    act(() => { grabber.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onDetentChange).toHaveBeenCalledWith("half");
  });

  it("can be dragged downward", () => {
    const { onDetentChange, grabber } = setup("full");
    drag(grabber, 100, 600);
    expect(onDetentChange).toHaveBeenCalledTimes(1);
    expect(onDetentChange.mock.calls[0]![0]).not.toBe("full");
  });

  it("ignores a second finger's pointerup mid-drag", () => {
    // Dragging with one thumb and tapping the map with the other used to end
    // the drag and strand the finger still on the screen.
    const { onDetentChange, grabber } = setup("peek");
    act(() => {
      grabber.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, clientY: 700, button: 0, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 500, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 500, pointerId: 2 }));
    });
    expect(onDetentChange).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 500, pointerId: 1 }));
    });
    expect(onDetentChange).toHaveBeenCalledTimes(1);
  });

  it("names the panel for assistive tech", () => {
    render(<Sheet detent="peek" onDetentChange={() => {}} label="Route"><p>x</p></Sheet>);
    expect(screen.getByRole("region", { name: "Route" })).toBeTruthy();
  });
});
