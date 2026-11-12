// The features of the Every App desktop app, and the backend each one calls. One place for every
// backend app id: a backend is an Every App app behind the Gateway, at `<appId>.<app base domain>`,
// and its id can change (the Gateway is getting app renames), so nothing else names it.
//
// Scribe (meeting notes) is the first feature; OpenScribe is its open-source project. Its backend is the app id `scribe`, which was
// `talk`: a Gateway that installed it before the rename may serve only `talk.<base>`, a fresh one
// only `scribe.<base>`, a renamed one both, so the app is looked for under each (auth/locate.ts). A new
// feature (dictation, personal notes) adds an entry here, its own section in the window's sidebar
// and its own `everyapp://<feature>/...` links. No Electron import (main and renderer both use it).

export interface FeatureBackend {
  /** The Every App app id the feature's API lives on (the host's first label). */
  appId: string;
  /** Ids it had before, newest first: an older Gateway may still have it under one of these. */
  formerAppIds?: readonly string[];
  /** Where its bearer API is mounted on that host. */
  apiPath: string;
}

export interface Feature {
  /** Stable key: deep links (`everyapp://<id>/…`), storage, routes. Never shown. */
  id: string;
  /** What the window calls it. */
  label: string;
  backend: FeatureBackend;
}

export const SCRIBE: Feature = {
  id: "scribe",
  label: "Scribe",
  backend: { appId: "scribe", formerAppIds: ["talk"], apiPath: "/api/v1" },
};

export const FEATURES: readonly Feature[] = [SCRIBE];

/** Every id the backend may be under, the current one first. */
export function backendAppIds(feature: Feature): readonly string[] {
  return [feature.backend.appId, ...(feature.backend.formerAppIds ?? [])];
}

/** An example backend URL for hints and placeholders, like `https://scribe.example.com`. */
export function exampleBackendUrl(feature: Feature, base = "example.com"): string {
  return `https://${feature.backend.appId}.${base}`;
}
