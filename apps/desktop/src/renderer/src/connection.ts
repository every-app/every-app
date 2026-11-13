// Connection, sign-in expiry and live-transcription state, as main reports them on the snapshot
// (AppSnapshot.connection, AuthSnapshot.expired, RecordingSnapshot.transcription in shared/ipc.ts).
// Main is the source of truth: the window's own failed calls never change these.

import type { AppSnapshot, Connection } from "@shared/ipc";

export type { Connection };
export type Snapshot = AppSnapshot;

export function connectionOf(state: Snapshot | undefined): Connection {
  return state?.connection ?? "online";
}

/**
 * Which window to show. An expired sign-in keeps the app (and whatever you were doing) with a
 * "Sign in again" prompt; only a plain sign-out, or never having signed in, shows the welcome.
 */
export type Gate = "loading" | "welcome" | "app";

export function gateOf(state: Snapshot | undefined, previous?: Gate): Gate {
  if (!state) return "loading";
  if (state.auth.status === "signedIn") return "app";
  if (state.auth.expired) return "app";
  // Signing back in from the app's prompt: stay put until it lands, and through a failed attempt
  // (which carries an error; a plain Sign out doesn't).
  if (previous === "app" && (state.auth.status === "signingIn" || state.auth.error)) return "app";
  return "welcome";
}

export type SignInAgain =
  | { kind: "oauth"; appUrl: string; signingIn: boolean; error?: string }
  | { kind: "token"; appUrl: string; error?: string }
  | { kind: "everyApp"; appUrl: string; signingIn: boolean; error?: string };

/** How to sign back in: Every App's sign-in, or a fresh token for a token sign-in. */
export function signInAgainOf(state: Snapshot | undefined): SignInAgain | null {
  if (!state) return null;
  // Inside the app, any state short of signed in needs it, whatever `connection` says.
  if (connectionOf(state) !== "signin-needed" && state.auth.status === "signedIn") return null;
  const { auth } = state;
  const appUrl = auth.appUrl ?? "";
  const signingIn = auth.status === "signingIn";
  if (auth.needsEveryAppSignIn) return { kind: "everyApp", appUrl, signingIn, error: auth.error };
  if (auth.method === "token") return { kind: "token", appUrl, error: auth.error };
  return { kind: "oauth", appUrl, signingIn, error: auth.error };
}

/**
 * What the live view says about transcription: "reconnecting" (can't reach it; the helper keeps
 * the audio), then "catching_up" (that audio is transcribed and lands in place), then nothing.
 */
export function transcriptionNoteOf(state: Snapshot | undefined): "reconnecting" | "catching_up" | "own_server_down" | null {
  const t = state?.recording.transcription;
  // With the person's own server there is nothing to reconnect to: say whose server it is.
  if (t === "reconnecting" && state?.recording.mode === "custom") return "own_server_down";
  return t === "reconnecting" || t === "catching_up" ? t : null;
}

/** With the person's own server, what its trouble is called on the meeting page: the same words
 * go above the recording bar on every other page (`AppFrame`'s recorder). */
export const OWN_SERVER_DOWN = "Your transcription server isn't answering. Audio is kept for up to 5 minutes.";

/**
 * What the recording bar says above itself away from the meeting's page. Only for a recording
 * on the person's own transcription server: that its server isn't answering, and the helper's
 * words when audio was dropped or left untranscribed.
 */
export function ownServerBarNotes(state: Snapshot | undefined): { status: string | null; warning: string | null } {
  const rec = state?.recording;
  if (!rec || rec.mode !== "custom" || rec.state === "idle") return { status: null, warning: null };
  return { status: rec.transcription === "reconnecting" ? OWN_SERVER_DOWN : null, warning: rec.warning ?? null };
}

/** Offline or signed out, now online: time to refetch what failed (lists, calendar, unsaved notes). */
export function cameBackOnline(previous: Connection, next: Connection): boolean {
  return previous !== "online" && next === "online";
}
