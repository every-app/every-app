import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDependencies } from "./package-manager";

const mocks = vi.hoisted(() => ({
  runLogged: vi.fn(),
}));

vi.mock("./childLog", () => ({
  runLogged: mocks.runLogged,
}));

describe("installDependencies manifest overrides", () => {
  beforeEach(() => {
    mocks.runLogged.mockReset();
  });

  it("skips dependency install when install is false", async () => {
    await installDependencies({
      cwd: "/tmp/app",
      description: "Installing...",
      install: false,
    });

    expect(mocks.runLogged).not.toHaveBeenCalled();
  });

  it("runs a custom install command through the shell", async () => {
    await installDependencies({
      cwd: "/tmp/app",
      description: "Installing...",
      install: "yarn install --immutable && yarn constraints",
      verbose: true,
    });

    // Its output goes to a log file; --verbose streams it to stderr too.
    expect(mocks.runLogged).toHaveBeenCalledWith(
      "yarn install --immutable && yarn constraints",
      [],
      expect.objectContaining({
        cwd: "/tmp/app",
        what: "Installing",
        shell: true,
        echo: true,
      }),
    );
  });
});
