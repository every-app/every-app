import { describe, expect, it } from "vitest";
import { connectionOf, gateOf, signInAgainOf, transcriptionNoteOf, type Snapshot } from "../src/renderer/src/connection";

const base = {
  version: "0.1.0",
  connection: "online",
  auth: { status: "signedIn", method: "oauth", appUrl: "https://talk.example.com", email: "ben@every.to" },
  helper: { status: "ready", restarts: 0 },
  recording: { state: "idle" },
  calendar: { connected: true, events: [] },
  tray: "idle",
  updater: { enabled: false },
} as unknown as Snapshot;

const with_ = (patch: { auth?: object; recording?: object; connection?: Snapshot["connection"] }): Snapshot =>
  ({
    ...base,
    ...(patch.connection ? { connection: patch.connection } : {}),
    auth: { ...base.auth, ...patch.auth },
    recording: { ...base.recording, ...patch.recording },
  }) as Snapshot;

describe("which window shows", () => {
  it("keeps the app through an expired sign-in, and leaves only on a real sign-out", () => {
    expect(gateOf(undefined)).toBe("loading");
    expect(gateOf(base)).toBe("app");
    expect(gateOf(with_({ auth: { status: "signedOut", expired: true } }), "app")).toBe("app");
    expect(gateOf(with_({ auth: { status: "signedOut" } }), "app")).toBe("welcome");
    expect(gateOf(with_({ auth: { status: "signedOut" } }))).toBe("welcome");
  });

  it("stays in the app while signing back in, and through a failed attempt", () => {
    expect(gateOf(with_({ auth: { status: "signingIn" } }), "app")).toBe("app");
    expect(gateOf(with_({ auth: { status: "signedOut", error: "Sign-in was cancelled." } }), "app")).toBe("app");
    // From the welcome screen, signing in is just signing in.
    expect(gateOf(with_({ auth: { status: "signingIn" } }), "welcome")).toBe("welcome");
  });
});

describe("connection", () => {
  it("is main's field, never the window's guess", () => {
    expect(connectionOf(undefined)).toBe("online");
    expect(connectionOf(base)).toBe("online");
    expect(connectionOf(with_({ connection: "offline" }))).toBe("offline");
    expect(connectionOf(with_({ connection: "signin-needed", auth: { status: "signedOut", expired: true } }))).toBe("signin-needed");
  });

  it("asks to sign in again the way you signed in", () => {
    expect(signInAgainOf(base)).toBeNull();
    expect(signInAgainOf(with_({ connection: "offline" }))).toBeNull();
    const needed = "signin-needed" as const;
    expect(signInAgainOf(with_({ connection: needed, auth: { status: "signedOut", expired: true } }))).toMatchObject({ kind: "oauth", appUrl: "https://talk.example.com", signingIn: false });
    expect(signInAgainOf(with_({ connection: needed, auth: { status: "signedOut", expired: true, method: "token" } }))).toMatchObject({ kind: "token" });
    expect(signInAgainOf(with_({ connection: needed, auth: { needsEveryAppSignIn: true, method: "token" } }))).toMatchObject({ kind: "everyApp" });
    expect(signInAgainOf(with_({ auth: { status: "signingIn" } }))).toMatchObject({ kind: "oauth", signingIn: true });
  });

  it("says when transcription is reconnecting or catching up", () => {
    expect(transcriptionNoteOf(base)).toBeNull();
    expect(transcriptionNoteOf(with_({ recording: { transcription: "reconnecting" } }))).toBe("reconnecting");
    expect(transcriptionNoteOf(with_({ recording: { transcription: "catching_up" } }))).toBe("catching_up");
    expect(transcriptionNoteOf(with_({ recording: { transcription: "live" } }))).toBeNull();
  });
});
