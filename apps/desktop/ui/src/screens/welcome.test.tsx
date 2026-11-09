import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPLASH_TIMING, WelcomeSplash } from "./WelcomeSplash";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const root = () =>
  screen.getByText("Enjoy Every App").closest("[data-shown]") as HTMLElement;
const card = () => screen.getByText("Enjoy Every App").parentElement!;

describe("WelcomeSplash", () => {
  it("says Enjoy Every App with the mark, and never takes input", () => {
    render(<WelcomeSplash shown reducedMotion={false} />);
    expect(card().getAttribute("role")).toBe("status");
    expect(card().querySelector("img[alt=\"Every App\"]")).toBeTruthy();
    expect(root().className).toContain("pointer-events-none");
  });

  it("fades in when shown, out when not, then reports once it's gone", () => {
    const onHidden = vi.fn();
    const { rerender } = render(
      <WelcomeSplash shown={false} onHidden={onHidden} reducedMotion={false} />,
    );
    expect(root().style.visibility).toBe("hidden");
    act(() => vi.advanceTimersByTime(1000));
    expect(onHidden).not.toHaveBeenCalled(); // never shown, nothing to report

    rerender(<WelcomeSplash shown onHidden={onHidden} reducedMotion={false} />);
    expect(root().style.visibility).toBe("visible");
    act(() => vi.advanceTimersByTime(50)); // two animation frames
    expect(root().dataset.shown).toBe("true");
    expect(card().style.opacity).toBe("1");
    expect(card().style.transitionDuration).toBe(`${SPLASH_TIMING.fadeIn}ms`);

    rerender(
      <WelcomeSplash shown={false} onHidden={onHidden} reducedMotion={false} />,
    );
    expect(root().dataset.shown).toBe("false");
    expect(root().style.visibility).toBe("visible"); // still fading out
    expect(card().style.transitionDuration).toBe(`${SPLASH_TIMING.fadeOut}ms`);
    act(() => vi.advanceTimersByTime(SPLASH_TIMING.fadeOut));
    expect(root().style.visibility).toBe("hidden");
    expect(onHidden).toHaveBeenCalledOnce();
  });

  it("with reduced motion: up at once, no fades or scale", () => {
    render(<WelcomeSplash shown reducedMotion />);
    expect(root().dataset.shown).toBe("true");
    expect(card().style.transitionDuration).toBe("0ms");
    expect(card().style.transform).toBe("none");
  });

  it("follows prefers-reduced-motion when not told", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      render(<WelcomeSplash shown />);
      expect(matchMedia).toHaveBeenCalledWith(
        "(prefers-reduced-motion: reduce)",
      );
      expect(root().dataset.shown).toBe("true");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
