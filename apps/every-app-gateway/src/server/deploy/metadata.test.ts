import { describe, expect, it } from "vitest";
import { BUILD_SENTINEL } from "@every-app/sdk/cloudflare/sentinel";
import {
  bindingMismatches,
  buildUserWorkerMetadata,
  bundleProblems,
  type DeployTarget,
} from "./metadata";

const LIMITS = { cpuMs: 5_000, subrequests: 200, durableObjectClasses: 2 };
const MANIFEST = {
  id: "notes",
  resources: { durableObjects: [{ name: "SYNC", className: "SyncDO" }] },
};
const WORKER = {
  name: BUILD_SENTINEL.workerName,
  compatibilityDate: "2026-06-01",
  compatibilityFlags: ["nodejs_compat"],
  workersDev: false,
  previewUrls: false,
  env: {
    EVERYAPP_APP_ID: { type: "text", value: "notes" },
    // The tenant-neutral build's placeholders, which the deployer rewrites.
    EVERYAPP_IDENTITY_ISSUER: {
      type: "text",
      value: BUILD_SENTINEL.gatewayUrl,
    },
    EVERYAPP_IDENTITY_PUBLIC_KEYS: {
      type: "text",
      value: JSON.stringify([BUILD_SENTINEL.publicKey]),
    },
    SYNC: {
      type: "durable-object",
      worker: BUILD_SENTINEL.workerName,
      exportName: "SyncDO",
    },
  },
  exports: { SyncDO: { type: "durable-object", storage: "sqlite" } },
  manifest: { type: "partial", mainModule: "index.js", modules: {} },
};
const TARGET: DeployTarget = {
  appId: "notes",
  organizationId: "org-acme",
  workerName: "every-acme-notes",
  gatewayUrl: "https://gateway.example.com",
  identityPublicKey: "PEM",
  d1: {},
  limits: LIMITS,
  durableObjects: { liveClasses: [], migrationTag: null },
};

describe("bundleProblems", () => {
  it("lets an everyAppWorker() build, placeholders and all, through", () => {
    expect(bundleProblems(WORKER, MANIFEST, LIMITS, false)).toEqual([]);
  });

  it("refuses an assets binding when the upload has no assets", () => {
    const withAssets = {
      ...WORKER,
      env: { ...WORKER.env, ASSETS: { type: "assets" } },
    };
    expect(bundleProblems(withAssets, MANIFEST, LIMITS, true)).toEqual([]);
    expect(bundleProblems(withAssets, MANIFEST, LIMITS, false)).toEqual([
      expect.stringMatching(/^ASSETS .*assets directory is empty/),
    ]);
  });

  it("refuses helper Workers, Workflows, KV, secrets and too many classes", () => {
    const problems = bundleProblems(
      WORKER,
      {
        id: "notes",
        workers: [{ name: "audit" }],
        secrets: ["GITHUB_TOKEN"],
        resources: {
          kv: ["KV"],
          workflows: [{ name: "RUN", className: "Run" }],
          durableObjects: ["A", "B", "C"].map((c) => ({
            name: c,
            className: c,
          })),
        },
      },
      LIMITS,
      false,
    );
    expect(problems.join("\n")).toMatch(
      /helper Workers[\s\S]*Workflows[\s\S]*KV[\s\S]*secrets[\s\S]*3 Durable Object classes/,
    );
  });

  it("refuses an OAuth client with scope sets listed without them, or with ones this gateway doesn't offer", () => {
    const listing = (entry: { access: "write"; scopes?: string[] }) =>
      bundleProblems(
        WORKER,
        { ...MANIFEST, capabilities: { "google-workspace": entry } },
        LIMITS,
        false,
      );
    expect(listing({ access: "write", scopes: ["gmail.read"] })).toEqual([]);
    const withoutSets =
      "it lists Google (Gmail, Calendar, Search Console and Analytics) without the scope sets it may use (one or more of: identity, gmail.read, calendar.read, search-console.read, analytics.read)";
    expect(listing({ access: "write" })).toEqual([withoutSets]);
    expect(listing({ access: "write", scopes: [] })).toEqual([withoutSets]);
    expect(
      listing({
        access: "write",
        scopes: ["gmail.read", "gmail.send", "gmail.read", "constructor"],
      }),
    ).toEqual([
      "it lists a Google (Gmail, Calendar, Search Console and Analytics) scope set this gateway doesn't offer (gmail.send)",
      "it lists the Google (Gmail, Calendar, Search Console and Analytics) scope set gmail.read twice",
      "it lists a Google (Gmail, Calendar, Search Console and Analytics) scope set this gateway doesn't offer (constructor)",
    ]);
    // Clients without a policy, and capabilities this gateway doesn't know,
    // are the token endpoint's and the strict validator's to judge.
    expect(
      bundleProblems(
        WORKER,
        {
          ...MANIFEST,
          capabilities: {
            linkedin: { access: "write" },
            "new-provider": { access: "read", scopes: ["x"] },
          },
        },
        LIMITS,
        false,
      ),
    ).toEqual([]);
  });

  it("refuses a Worker not built with the sentinel inputs, or that sets more", () => {
    expect(
      bundleProblems(
        { ...WORKER, name: "every-acme-notes", tailConsumers: [] },
        MANIFEST,
        LIMITS,
        false,
      ),
    ).toEqual([
      expect.stringContaining('named "every-acme-notes"'),
      "it sets tailConsumers, which third-party Workers can't",
      // Its class now looks like another Worker's.
      expect.stringContaining("SYNC binds another Worker's Durable Object"),
    ]);
    expect(
      bundleProblems(
        { ...WORKER, compatibilityFlags: ["experimental"] },
        MANIFEST,
        LIMITS,
        false,
      ),
    ).toEqual(["compatibility flag experimental isn't allowed"]);
  });
});

describe("buildUserWorkerMetadata", () => {
  it("starts a new Worker's classes with the first migration, then the next", () => {
    expect(
      buildUserWorkerMetadata({
        worker: WORKER,
        manifest: MANIFEST,
        target: TARGET,
      }).migrations,
    ).toEqual({ new_tag: "everyapp-v1", new_sqlite_classes: ["SyncDO"] });
    expect(
      buildUserWorkerMetadata({
        worker: WORKER,
        manifest: MANIFEST,
        target: {
          ...TARGET,
          durableObjects: {
            liveClasses: ["SyncDO"],
            migrationTag: "everyapp-v1",
          },
        },
      }).migrations,
    ).toBeUndefined();
  });

  it("never drops a live class, or follows a tag it didn't write", () => {
    expect(() =>
      buildUserWorkerMetadata({
        worker: { ...WORKER, env: {}, exports: {} },
        manifest: { id: "notes" },
        target: {
          ...TARGET,
          durableObjects: {
            liveClasses: ["SyncDO"],
            migrationTag: "everyapp-v1",
          },
        },
      }),
    ).toThrow(/drops the Durable Object class SyncDO/);
    expect(() =>
      buildUserWorkerMetadata({
        worker: WORKER,
        manifest: MANIFEST,
        target: {
          ...TARGET,
          durableObjects: { liveClasses: [], migrationTag: "v7" },
        },
      }),
    ).toThrow(/migration tag "v7"/);
  });
});

describe("bindingMismatches", () => {
  it("compares by name, whatever the key order, and names every difference", () => {
    const sent = [
      { type: "plain_text" as const, name: "A", text: "1" },
      { type: "d1" as const, name: "DB", id: "x" },
    ];
    expect(
      bindingMismatches(
        sent,
        [
          { id: "x", name: "DB", type: "d1" },
          { text: "1", name: "A", type: "plain_text" },
        ],
        "every-acme-notes",
      ),
    ).toEqual([]);
    expect(
      bindingMismatches(
        sent,
        [
          { type: "plain_text", name: "A", text: "2" },
          { type: "kv_namespace", name: "KV", namespace_id: "y" },
        ],
        "every-acme-notes",
      ),
    ).toEqual(["A", "DB", "KV"]);
  });

  it("accepts the fields Cloudflare adds, but not another Worker's class, a changed prop or a binding twice", () => {
    const sent = [
      {
        type: "service" as const,
        name: "EVERY_APP_GATEWAY",
        service: "every-app-gateway",
        entrypoint: "AppGateway",
        props: { organizationId: "org-acme", appId: "notes" },
      },
      {
        type: "durable_object_namespace" as const,
        name: "SYNC",
        class_name: "SyncDO",
      },
      { type: "d1" as const, name: "DB", id: "x" },
    ];
    // As the live API lists them: an environment on the service binding,
    // the namespace and Worker on the Durable Object binding.
    const listed = [
      { ...sent[0], environment: "production" },
      {
        ...sent[1],
        namespace_id: "0123456789abcdef0123456789abcdef",
        script_name: "every-acme-notes",
      },
      sent[2],
    ];
    expect(bindingMismatches(sent, listed, "every-acme-notes")).toEqual([]);
    expect(
      bindingMismatches(
        sent,
        [
          {
            ...listed[0],
            props: { organizationId: "org-beta", appId: "notes" },
          },
          { ...listed[1], script_name: "every-beta-notes" },
          sent[2],
          { ...sent[2], id: "y" },
        ],
        "every-acme-notes",
      ),
    ).toEqual(["DB", "EVERY_APP_GATEWAY", "SYNC"]);
    // A field the deployer sent may not go missing, or change type.
    expect(
      bindingMismatches(
        sent,
        [
          {
            type: "service",
            name: "EVERY_APP_GATEWAY",
            service: "every-app-gateway",
          },
          { ...listed[1], type: "durable_object_namespace_v2" },
          sent[2],
        ],
        "every-acme-notes",
      ),
    ).toEqual(["EVERY_APP_GATEWAY", "SYNC"]);
  });
});
