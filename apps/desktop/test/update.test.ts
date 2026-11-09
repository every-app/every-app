import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "@shared/ipc";
import { installUpdate, rememberDeferred, updatePillOf } from "../src/renderer/src/update";

const snap = (updater: Partial<AppSnapshot["updater"]>, recording: object = { state: "idle" }) =>
  ({ updater: { enabled: true, state: "idle", ...updater }, recording }) as unknown as AppSnapshot;

describe("update pill", () => {
  it("shows once an update is downloaded", () => {
    expect(updatePillOf(snap({ enabled: true, state: "ready", version: "0.2.0" }))).toEqual({ version: "0.2.0", kind: "ready" });
  });

  it("hides while recording, and says Restart to update after Stop", () => {
    const ready = { enabled: true, state: "ready" as const, version: "0.2.0", deferred: true };
    expect(updatePillOf(snap(ready, { state: "recording" }))).toBeNull();
    expect(updatePillOf(snap(ready, { state: "stopping" }))).toBeNull();
    expect(updatePillOf(snap(ready))).toEqual({ version: "0.2.0", kind: "afterStop" });
  });

  it("stays away otherwise", () => {
    for (const state of ["idle", "checking", "downloading", "upToDate", "error"] as const) {
      expect(updatePillOf(snap({ enabled: true, state, version: "0.2.0" }))).toBeNull();
    }
    expect(updatePillOf(snap({ enabled: false }))).toBeNull();
    expect(updatePillOf(snap({ enabled: true, state: "ready" }))).toBeNull(); // no version
    expect(updatePillOf(undefined)).toBeNull();
  });

  it("installs through the bridge, and says when main put it off", async () => {
    const install = vi.fn(async () => ({ deferred: true }));
    expect(await installUpdate({ "update:install": install })).toEqual({ deferred: true });
    expect(install).toHaveBeenCalledOnce();
  });

  it("remembers a restart put off during a recording, since main clears `deferred` at Stop", () => {
    const during = snap({ state: "ready", version: "0.2.0", deferred: true }, { state: "recording" });
    const after = snap({ state: "ready", version: "0.2.0", deferred: false });
    let remembered = rememberDeferred(false, during);
    expect(remembered).toBe(true);
    remembered = rememberDeferred(remembered, after);
    expect(updatePillOf(after, remembered)).toEqual({ version: "0.2.0", kind: "afterStop" });
    // A new download (or none) starts fresh.
    expect(rememberDeferred(remembered, snap({ state: "downloading" }))).toBe(false);
    expect(updatePillOf(after, false)).toEqual({ version: "0.2.0", kind: "ready" });
  });
});
