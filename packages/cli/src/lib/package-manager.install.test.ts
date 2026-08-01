import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDependencies } from "./package-manager";

const mocks = vi.hoisted(() => ({
  executeCommandWithFormatting: vi.fn(),
}));

vi.mock("./formatting", () => ({
  executeCommandWithFormatting: mocks.executeCommandWithFormatting,
}));

describe("installDependencies manifest overrides", () => {
  beforeEach(() => {
    mocks.executeCommandWithFormatting.mockReset();
  });

  it("skips dependency install when install is false", async () => {
    await installDependencies({
      cwd: "/tmp/app",
      description: "Installing...",
      install: false,
    });

    expect(mocks.executeCommandWithFormatting).not.toHaveBeenCalled();
  });

  it("runs a custom install command through the shell", async () => {
    await installDependencies({
      cwd: "/tmp/app",
      description: "Installing...",
      install: "yarn install --immutable && yarn constraints",
      verbose: true,
    });

    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledWith(
      "yarn install --immutable && yarn constraints",
      [],
      expect.objectContaining({
        cwd: "/tmp/app",
        description: "Installing...",
        shell: true,
        verbose: true,
      }),
    );
  });
});
