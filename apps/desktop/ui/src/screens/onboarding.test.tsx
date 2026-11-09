import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingScreen } from "./OnboardingScreen";

afterEach(cleanup);

const commands = {
  cli: "npm install -g everyapp",
  gateway: "everyapp setup",
  scribe: "everyapp install https://github.com/every-app/private-open-scribe",
};

describe("OnboardingScreen: connect your Gateway", () => {
  it("asks for the Gateway address; Continue waits for one", () => {
    const onConnect = vi.fn();
    const { rerender } = render(<OnboardingScreen step="gateway" appName="Scribe" address="" onConnect={onConnect} />);
    const button = screen.getByRole("button", { name: /Continue/ });
    expect(button).toHaveProperty("disabled", true);
    rerender(<OnboardingScreen step="gateway" appName="Scribe" address="apps.acme.com" onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onConnect).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Your Gateway address")).toHaveProperty("value", "apps.acme.com");
  });

  it("drops a pasted https:// (the field shows it) but keeps local http", () => {
    const onAddressChange = vi.fn();
    render(<OnboardingScreen step="gateway" appName="Scribe" address="" onAddressChange={onAddressChange} />);
    const input = screen.getByLabelText("Your Gateway address");
    fireEvent.change(input, { target: { value: "https://apps.acme.com" } });
    expect(onAddressChange).toHaveBeenLastCalledWith("apps.acme.com");
    fireEvent.change(input, { target: { value: "http://localhost:8787" } });
    expect(onAddressChange).toHaveBeenLastCalledWith("http://localhost:8787");
  });

  it("folds the setup commands behind No Gateway yet?, copies them by id, and says more apps are coming", () => {
    const onCopyCommand = vi.fn();
    render(
      <OnboardingScreen step="gateway" appName="Scribe" setupCommands={commands} onCopyCommand={onCopyCommand} />,
    );
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.queryByText("Add Scribe to it")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /No Gateway yet\?/ }));
    expect(screen.getByText("Add Scribe to it")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy everyapp setup" }));
    expect(onCopyCommand).toHaveBeenCalledWith("gateway");
    expect(screen.getByText("Scribe today. More apps soon.")).toBeTruthy();
  });

  it("shows the error, and the browser wait as its own screen", () => {
    const { rerender } = render(
      <OnboardingScreen step="gateway" appName="Scribe" address="acme.com" error="acme.com doesn't answer like an Every App Gateway." />,
    );
    expect(screen.getByRole("alert").textContent).toContain("doesn't answer");
    const onCancel = vi.fn();
    rerender(<OnboardingScreen step="gateway" appName="Scribe" address="apps.acme.com" connecting="browser" onCancelConnect={onCancel} />);
    expect(screen.getByRole("heading", { name: "Finish in your browser" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("OnboardingScreen: permissions", () => {
  it("Continue needs the mic, and system audio asked (macOS can't report it)", () => {
    const { rerender } = render(
      <OnboardingScreen
        step="permissions"
        appName="Scribe"
        permissions={{ mic: "granted", systemAudio: "unknown", notifications: "undetermined" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
    rerender(
      <OnboardingScreen
        step="permissions"
        appName="Scribe"
        permissions={{ mic: "granted", systemAudio: "unknown", notifications: "undetermined" }}
        systemAudioAsked
        onTestSound={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Play a test sound" })).toBeTruthy();
    expect(screen.queryByText("Set up later in Settings")).toBeNull();
  });

  it("asks with Allow and offers System Settings when blocked", () => {
    const onGrant = vi.fn();
    render(
      <OnboardingScreen
        step="permissions"
        appName="Scribe"
        permissions={{ mic: "denied", systemAudio: "undetermined", notifications: "undetermined" }}
        onGrant={onGrant}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(onGrant).toHaveBeenCalledWith("mic");
    fireEvent.click(screen.getAllByRole("button", { name: "Allow" })[0]!);
    expect(onGrant).toHaveBeenCalledWith("systemAudio");
    expect(screen.getByText("Set up later in Settings")).toBeTruthy();
  });
});

describe("OnboardingScreen: add the app", () => {
  it("explains why, shows the install command and checks again", () => {
    const onCheckAgain = vi.fn();
    render(
      <OnboardingScreen
        step="add-app"
        appName="Scribe"
        gatewayHost="apps.acme.com"
        setupCommands={commands}
        onCheckAgain={onCheckAgain}
      />,
    );
    expect(screen.getByRole("heading", { name: "Add Scribe to your Gateway" })).toBeTruthy();
    expect(screen.getByText(/ready to share with your team and the people in the meeting/)).toBeTruthy();
    expect(screen.getByText(/apps.acme.com is connected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /I've installed it/ }));
    expect(onCheckAgain).toHaveBeenCalledOnce();
    expect(screen.getByText("One more thing")).toBeTruthy();
  });
});
