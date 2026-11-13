import { describe, expect, it } from "vitest";
import {
  validateManifestStrict,
  WORKER_MANIFEST_MAX_BYTES,
  workerManifest,
  workerManifestProblem,
} from "@every-app/perimeter/manifest";
import { largeManifest } from "./workerManifest.fixture";

const size = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe("workerManifest", () => {
  it("is the manifest itself when it fits one Cloudflare variable", () => {
    const manifest = {
      id: "notes",
      settings: [{ name: "THEME", why: "The color scheme." }],
    };
    expect(workerManifest(manifest)).toBe(manifest);
    expect(workerManifestProblem(manifest)).toBeNull();
  });

  it("drops the setup text of a manifest well over 5 kB, and nothing else", () => {
    const manifest = largeManifest();
    expect(size(manifest)).toBeGreaterThan(7000);
    // It is one the CLI and the Gateway take.
    expect(() =>
      validateManifestStrict(manifest, { unknownCapabilities: "accept" }),
    ).not.toThrow();

    const held = workerManifest(manifest)!;
    expect(size(held)).toBeLessThanOrEqual(WORKER_MANIFEST_MAX_BYTES);
    expect(held).toMatchObject({
      id: "sink",
      name: "Sink",
      description: "Shorten, share and manage links.",
      resources: { d1: ["DB"] },
      public: [{ path: "/s/:slug", methods: ["GET", "HEAD"] }],
      providers: [{ id: "workers-ai" }],
      capabilities: { members: { access: "read" } },
      ai: { models: ["@cf/meta/llama"], chat: true },
      secrets: [{ name: "SITE_TOKEN" }],
    });
    expect(held.settings).toHaveLength(34);
    expect(held.settings[0]).toEqual({
      name: "NUXT_SETTING_0",
      type: "text",
      default: "301",
    });
    // A feature's id is a key like any other: only its text goes.
    expect(Object.keys(held.features)).toEqual([
      "analytics",
      "previews",
      "why",
      "imports",
    ]);
    expect(held.features["why"]).toEqual({
      name: "why",
      settings: [{ name: "FEATURE_WHY" }],
    });
    expect(held.features["analytics"]).not.toHaveProperty("steps");
    expect(held.secrets[0]).not.toHaveProperty("how");
    // The manifest it was given is untouched: the registry keeps every word.
    expect(manifest.settings[0]).toHaveProperty("why");
  });

  it("fits no variable when the manifest is too large even without its setup text, which validation doesn't mind", () => {
    const manifest = {
      id: "huge",
      settings: Array.from({ length: 100 }, (_, index) => ({
        name: `A_RATHER_LONG_SETTING_NAME_FOR_A_VERY_CONFIGURABLE_APP_${index}`,
        why: "One of many.",
      })),
    };
    expect(workerManifest(manifest)).toBeNull();
    expect(workerManifestProblem(manifest)).toMatch(
      /^this build was made with an SDK that puts the manifest in the app's Worker, where it is [\d,]+ bytes .* holds 5,000 at most; rebuild the app with a newer @every-app\/sdk/,
    );
    // The manifest itself is fine: a Worker built today holds no copy.
    expect(() => validateManifestStrict(manifest)).not.toThrow();
  });
});
