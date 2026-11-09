import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfTestReport } from "../types";
import { SelfTest, type SelfTestProps } from "./SelfTest";

afterEach(cleanup);

const ok = {
  status: "ok",
  peak: 0.5,
  clipping: false,
  clippedSamples: 0,
  dropouts: 0,
} as const;
const progress = (
  seconds: number,
  system: Partial<SelfTestReport["system"]> = {},
): SelfTestReport => ({
  seconds,
  passed: false,
  mic: { ...ok, device: "MacBook Pro Microphone" },
  system: { ...ok, device: "MacBook Pro Speakers", ...system },
});
const props = (over: Partial<SelfTestProps>): SelfTestProps => ({
  state: { kind: "idle" },
  onStart: () => {},
  onStop: () => {},
  onOpenSettings: () => {},
  ...over,
});
const row = (side: "mic" | "system") =>
  screen
    .getByRole("list", { name: "Microphone and Mac audio" })
    .querySelector(`[data-side="${side}"]`) as HTMLElement;

describe("SelfTest", () => {
  it("starts, shows live meters named by device, and stops", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(<SelfTest {...props({ onStart, onStop })} />);
    expect(screen.getByText(/Nothing is recorded or sent anywhere/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start check" }));
    expect(onStart).toHaveBeenCalledOnce();
    rerender(
      <SelfTest
        {...props({
          onStart,
          onStop,
          state: {
            kind: "checking",
            progress: progress(1),
            levels: { mic: 0.6, system: 0.3 },
          },
        })}
      />,
    );
    expect(screen.getByText(/Speak, and play something on your Mac/)).toBeTruthy();
    expect(within(row("mic")).getByText("MacBook Pro Microphone")).toBeTruthy();
    expect(within(row("system")).getByText("MacBook Pro Speakers")).toBeTruthy();
    expect(
      screen.getByRole("meter", { name: "Microphone level" }).getAttribute("aria-valuenow"),
    ).toBe("60");
    expect(within(row("mic")).getByText("Working")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("marks a side that stays quiet, with Open Settings and no how-to", () => {
    const onOpenSettings = vi.fn();
    const quiet = { status: "denied", peak: 0 } as const;
    const { rerender } = render(
      <SelfTest
        {...props({
          onOpenSettings,
          state: { kind: "checking", progress: progress(2, quiet), levels: { mic: 0.5, system: 0 } },
        })}
      />,
    );
    expect(within(row("system")).getByText("Listening…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
    rerender(
      <SelfTest
        {...props({
          onOpenSettings,
          state: { kind: "checking", progress: progress(3, quiet), levels: { mic: 0.5, system: 0 } },
        })}
      />,
    );
    expect(within(row("system")).getByText("No sound")).toBeTruthy();
    expect(screen.queryByText(/Privacy & Security/)).toBeNull();
    fireEvent.click(within(row("system")).getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith("systemAudio");
  });

  it("keeps the result after Stop, without meters, and offers Check again", () => {
    render(<SelfTest {...props({ state: { kind: "done", report: progress(1, { status: "silent" }) } })} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(within(row("system")).getByText("No sound")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("explains why it can't start, and shows a refusal", () => {
    const { rerender } = render(
      <SelfTest
        {...props({
          disabledReason: "Stop the recording to check your microphone and Mac audio.",
        })}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Start check" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Stop the recording/)).toBeTruthy();
    rerender(
      <SelfTest
        {...props({
          state: { kind: "error", message: "Every App is already checking your microphone and Mac audio." },
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/already checking/);
  });
});
