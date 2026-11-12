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
  };
}

describe("trackAway", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports away after the delay, and back at once", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    const stop = trackAway(w.target, 300, onChange);
    w.blur();
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    w.focus();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores a quick trip away", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange);
    w.blur();
    vi.advanceTimersByTime(100);
    w.focus();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("counts a hidden window as away, and starts away if it isn't focused", () => {
    const w = fakeWindow(false);
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange);
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenLastCalledWith(true);
    const v = fakeWindow();
    const onV = vi.fn();
    trackAway(v.target, 300, onV);
    v.hide();
    vi.advanceTimersByTime(300);
    expect(onV).toHaveBeenLastCalledWith(true);
  });

  it("stops listening", () => {
    const w = fakeWindow();
    const onChange = vi.fn();
    trackAway(w.target, 300, onChange)();
    w.blur();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
