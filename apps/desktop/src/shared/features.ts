// The features of the Every App desktop app, and the backend each one calls. One place for every
// backend app id: a backend is an Every App app behind the Gateway, at `<appId>.<app base domain>`,
// and its id can change (the Gateway is getting app renames), so nothing else names it.
//
// Scribe (meeting notes) is the first feature. Its backend is still the app id `talk`. A new
// feature (dictation, personal notes) adds an entry here, its own section in the window's sidebar
// and its own `everyapp://<feature>/...` links. No Electron import (main and renderer both use it).

export interface FeatureBackend {
  /** The Every App app id the feature's API lives on (the host's first label). */
  appId: string;
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
  backend: { appId: "talk", apiPath: "/api/v1" },
};

export const FEATURES: readonly Feature[] = [SCRIBE];

/** An example backend URL for hints and placeholders, like `https://talk.example.com`. */
export function exampleBackendUrl(feature: Feature, base = "example.com"): string {
  return `https://${feature.backend.appId}.${base}`;
}
