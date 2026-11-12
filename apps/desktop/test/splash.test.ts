import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splashShownOf, trackAway, type AwayTarget } from "../src/renderer/src/splash";

describe("splashShownOf", () => {
  it("is up while the window is away unless recording", () => {
    expect(splashShownOf({ away: true, recording: "idle" })).toBe(true);
    expect(splashShownOf({ away: true, recording: "recording" })).toBe(false);
    expect(splashShownOf({ away: true, recording: "starting" })).toBe(false);
    expect(splashShownOf({ away: false, recording: "idle" })).toBe(false);
  });
});

function fakeWindow(focused = true) {
  const win = new EventTarget();
  const doc = new EventTarget();
  const state = { focused, visibility: "visible" };
  const target = {
    addEventListener: (t: string, l: () => void) => win.addEventListener(t, l),
    removeEventListener: (t: string, l: () => void) => win.removeEventListener(t, l),
    document: {
      hasFocus: () => state.focused,
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: (t: string, l: () => void) => doc.addEventListener(t, l),
      removeEventListener: (t: string, l: () => void) => doc.removeEventListener(t, l),
    },
  } as unknown as AwayTarget;
  return {
    target,
    blur: () => ((state.focused = false), win.dispatchEvent(new Event("blur"))),
    focus: () => ((state.focused = true), win.dispatchEvent(new Event("focus"))),
    hide: () => ((state.visibility = "hidden"), doc.dispatchEvent(new Event("visibilitychange"))),
    unhide: () => ((state.visibility = "visible"), doc.dispatchEvent(new Event("visibilitychange"))),
  };
}

describe("trackAway", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports away after the delay once it's minimized or hidden, and back at once when restored", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    const stop = trackAway(w.target, 300, onChange);
    w.hide();
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    w.unhide();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores a quick trip out of sight", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange);
    w.hide();
    vi.advanceTimersByTime(100);
    w.unhide();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is never away when the window opens unfocused", () => {
    const w = fakeWindow(false);
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange);
    vi.advanceTimersByTime(60_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is not away when it opens unfocused and is hidden before it was ever in front", () => {
    const w = fakeWindow(false);
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange);
    w.hide();
    vi.advanceTimersByTime(60_000);
    expect(onChange).not.toHaveBeenCalled();
    // Once it has been in front, hiding it counts.
    w.unhide();
    w.focus();
    w.hide();
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("is not away while visible but unfocused", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange);
    w.blur();
    vi.advanceTimersByTime(60_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("comes back when it's visible again, focused or not", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange);
    w.blur();
    w.hide();
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenLastCalledWith(true);
    w.unhide();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("stops listening", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange)();
    w.hide();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
