/**
 * The proof behind docs/design/multi-gateway.md: every account-wide name a
 * Gateway makes belongs to that Gateway alone. For the default Gateway and
 * two named ones, every kind of name each makes (its own three, its apps'
 * Workers and helpers, their D1/KV/R2/queue/Vectorize/Secrets Store/
 * Workflow/dataset names, their AI Gateway ids) is claimed by exactly one
 * of the three, and no Gateway's prefixes overlap another's.
 */
import { describe, expect, it } from "vitest";
import {
  aiGatewayIdFor,
  analyticsDatasetFor,
  bucketNameFor,
  isRegistryWorkerName,
  isReservedName,
  queueNameFor,
  registryWorkerNameFor,
  resourceNameFor,
  storeSecretNameFor,
  vectorizeNameFor,
} from "./manifest";
import {
  belongsToGateway,
  DEFAULT_GATEWAY_NAMES,
  gatewayNameOf,
  gatewayNames,
  isDefaultAppName,
  isGatewayOwnName,
  isValidGatewayName,
  type GatewayNames,
} from "./gatewayNames";

/** Org keys and app ids chosen to collide with the other Gateways' names wherever they could. */
const ORG_KEYS = ["acme", "demo", "app", "a", "every", "k123456789ab"];
const APP_IDS = [
  "todo",
  "gateway",
  "gateway-demo",
  "demo-todo",
  "a-b-c",
  "activate",
  "x",
];
const BINDINGS = [
  "DB",
  "KV",
  "R2",
  "ARCHIVE",
  "MEDIA_FILES",
  "JOBS",
  "AI_GATEWAY",
];

/** Every account-wide name one Gateway makes, by kind. */
function namesOf(gateway: GatewayNames): Array<{ kind: string; name: string }> {
  const names: Array<{ kind: string; name: string }> = [
    { kind: "worker", name: gateway.worker },
    { kind: "d1", name: gateway.d1 },
    { kind: "kv", name: gateway.oauthKv },
    { kind: "queue", name: gateway.activationQueue },
  ];
  for (const orgKey of ORG_KEYS) {
    for (const appId of APP_IDS) {
      const worker = registryWorkerNameFor({
        appId,
        orgKey,
        gatewayName: gateway.name,
      });
      // Only what the registry would assign: a reserved name (org `app`, app
      // `gateway`: `every-app-gateway`) is refused at registration.
      if (
        !isRegistryWorkerName({
          appId,
          orgKey,
          gatewayName: gateway.name,
          workerName: worker,
        })
      )
        continue;
      names.push({ kind: "worker", name: worker });
      names.push({ kind: "worker", name: `${worker}--helper` });
      names.push({ kind: "workflow", name: `${worker}--nightly` });
      for (const binding of BINDINGS) {
        names.push({ kind: "d1", name: resourceNameFor(worker, binding) });
        names.push({ kind: "kv", name: resourceNameFor(worker, binding) });
        names.push({ kind: "r2", name: bucketNameFor(worker, binding) });
        names.push({ kind: "queue", name: queueNameFor(worker, binding) });
        names.push({
          kind: "vectorize",
          name: vectorizeNameFor(worker, binding),
        });
        names.push({
          kind: "secret",
          name: storeSecretNameFor(worker, binding),
        });
        names.push({
          kind: "dataset",
          name: analyticsDatasetFor(worker, binding),
        });
        names.push({
          kind: "ai-gateway",
          name: aiGatewayIdFor(worker, binding),
        });
      }
    }
  }
  return names;
}

const GATEWAYS = [
  gatewayNames(null),
  gatewayNames("demo"),
  gatewayNames("demo2"),
  gatewayNames("a"),
];

describe("gatewayNames", () => {
  it("keeps the default Gateway's names exactly as they were", () => {
    expect(DEFAULT_GATEWAY_NAMES).toMatchObject({
      name: null,
      worker: "every-app-gateway",
      d1: "every-app-gateway",
      oauthKv: "every-app-gateway-OAUTH_KV",
      activationQueue: "every-app-gateway-activate",
      appPrefix: "every-",
    });
    expect(registryWorkerNameFor({ appId: "todo", orgKey: "acme" })).toBe(
      "every-acme-todo",
    );
    expect(aiGatewayIdFor("every-acme-todo", "AI_GATEWAY")).toBe(
      "every-acme-todo-ai-gateway",
    );
  });

  it("names a named Gateway after the root, and its apps behind every-<name>--", () => {
    expect(gatewayNames("demo")).toMatchObject({
      name: "demo",
      worker: "every-app-gateway-demo",
      d1: "every-app-gateway-demo",
      oauthKv: "every-app-gateway-demo-OAUTH_KV",
      activationQueue: "every-app-gateway-demo-activate",
      appPrefix: "every-demo--",
      aiGatewayPrefix: "every-app-gateway-demo-",
    });
    expect(
      registryWorkerNameFor({
        appId: "todo",
        orgKey: "acme",
        gatewayName: "demo",
      }),
    ).toBe("every-demo--acme-todo");
    expect(resourceNameFor("every-demo--acme-todo", "ARCHIVE")).toBe(
      "every-demo--acme-todo--archive",
    );
    // An AI Gateway id can't hold `--`: it goes under the reserved root instead.
    expect(aiGatewayIdFor("every-demo--acme-todo", "AI_GATEWAY")).toBe(
      "every-app-gateway-demo-acme-todo-ai-gateway",
    );
  });

  it("accepts short lowercase names without hyphens, and refuses the rest", () => {
    for (const name of ["demo", "staging2", "a", "0", "k".repeat(16)]) {
      expect(isValidGatewayName(name), name).toBe(true);
    }
    for (const name of [
      "",
      "Demo",
      "de-mo",
      "de_mo",
      "k".repeat(17),
      "activate",
      "app",
      "gateway",
      "a.b",
    ]) {
      expect(isValidGatewayName(name), name).toBe(false);
    }
    expect(() => gatewayNames("de-mo")).toThrow(/Invalid Gateway name/);
  });

  it("reads a Gateway's name back from its Worker or D1 name, and nothing else's", () => {
    expect(gatewayNameOf("every-app-gateway")?.name).toBeNull();
    expect(gatewayNameOf("every-app-gateway-demo")?.name).toBe("demo");
    for (const other of [
      "every-app-gateway-OAUTH_KV",
      "every-app-gateway-activate",
      "every-app-gateway-demo-OAUTH_KV",
      "every-app-gateway-demo-activate",
      "every-app-gateway-de-mo",
      "every-acme-todo",
      "every-demo--acme-todo",
      "every-app-gateway-demo-acme-todo-ai-gateway",
    ]) {
      expect(gatewayNameOf(other), other).toBeNull();
    }
  });

  it("keeps every Gateway's own names and every app name out of the apps' reach", () => {
    for (const gateway of GATEWAYS) {
      for (const own of [
        gateway.worker,
        gateway.d1,
        gateway.oauthKv,
        gateway.activationQueue,
      ]) {
        expect(isReservedName(own), own).toBe(true);
        expect(isGatewayOwnName(gateway, own), own).toBe(true);
      }
      for (const orgKey of ORG_KEYS) {
        for (const appId of APP_IDS) {
          const workerName = registryWorkerNameFor({
            appId,
            orgKey,
            gatewayName: gateway.name,
          });
          // A name under the reserved root is refused; any other is the row's own.
          expect(
            isRegistryWorkerName({
              appId,
              orgKey,
              gatewayName: gateway.name,
              workerName,
            }),
            workerName,
          ).toBe(!isReservedName(workerName));
          if (isReservedName(workerName)) continue;
          // The same row on another Gateway is never its own.
          for (const other of GATEWAYS) {
            if (other.name === gateway.name) continue;
            expect(
              isRegistryWorkerName({
                appId,
                orgKey,
                gatewayName: other.name,
                workerName,
              }),
              `${workerName} on ${other.worker}`,
            ).toBe(false);
          }
        }
      }
    }
  }, 120_000);

  it("claims every name a Gateway makes for that Gateway alone (the teardown's proof)", () => {
    for (const owner of GATEWAYS) {
      for (const { kind, name } of namesOf(owner)) {
        expect(
          belongsToGateway(owner, name),
          `${owner.worker} owns ${kind} ${name}`,
        ).toBe(true);
        for (const other of GATEWAYS) {
          if (other.name === owner.name) continue;
          expect(
            belongsToGateway(other, name),
            `${other.worker} must not claim ${kind} ${name}`,
          ).toBe(false);
        }
      }
    }
  }, 120_000);

  it("never lets a named Gateway's prefixes match another's names", () => {
    // The default's `every-` is a prefix of everything: that is why
    // belongsToGateway is structural (the test above), not a prefix match.
    for (const owner of GATEWAYS) {
      if (owner.name === null) continue;
      for (const other of GATEWAYS) {
        if (other.name === owner.name) continue;
        for (const { name } of namesOf(other)) {
          expect(
            name.startsWith(owner.appPrefix),
            `${owner.appPrefix} vs ${name}`,
          ).toBe(false);
          expect(
            name.startsWith(owner.aiGatewayPrefix),
            `${owner.aiGatewayPrefix} vs ${name}`,
          ).toBe(false);
          expect(
            name === owner.worker ||
              name === owner.oauthKv ||
              name === owner.activationQueue,
            name,
          ).toBe(false);
        }
      }
    }
  }, 120_000);

  it("never lets an AI Gateway id of a named Gateway be made by another Gateway", () => {
    // Gateway `demo`, org `x`, app `a`, binding `b`.
    const id = aiGatewayIdFor(
      registryWorkerNameFor({ appId: "a", orgKey: "x", gatewayName: "demo" }),
      "b",
    );
    expect(id).toBe("every-app-gateway-demo-x-a-b");
    // The default Gateway can't: the Worker that would make it is reserved
    // (org `app`, app `gateway-demo-x-a`), and no org key holds a hyphen
    // (org `demo-x` doesn't exist).
    const defaultWorker = registryWorkerNameFor({
      appId: "gateway-demo-x-a",
      orgKey: "app",
    });
    expect(aiGatewayIdFor(defaultWorker, "b")).toBe(id);
    expect(
      isRegistryWorkerName({
        appId: "gateway-demo-x-a",
        orgKey: "app",
        workerName: defaultWorker,
      }),
    ).toBe(false);
    expect(isValidGatewayName("demo-x")).toBe(false);
    // Another named Gateway can't either: the segment after the root is its whole name.
    for (const other of ["demox", "dem", "d"]) {
      const worker = registryWorkerNameFor({
        appId: "a",
        orgKey: "x",
        gatewayName: other,
      });
      expect(
        aiGatewayIdFor(worker, "b").startsWith("every-app-gateway-demo-"),
      ).toBe(false);
    }
    expect(belongsToGateway(gatewayNames("demo"), id)).toBe(true);
    expect(belongsToGateway(DEFAULT_GATEWAY_NAMES, id)).toBe(false);
    expect(belongsToGateway(gatewayNames("demox"), id)).toBe(false);
  });

  it("still claims legacy and recorded shapes for the default Gateway, and nothing of a named one", () => {
    // Pre-org-scoped Workers (`every-<appId>`) stay the default's, as before.
    expect(belongsToGateway(DEFAULT_GATEWAY_NAMES, "every-todo")).toBe(true);
    expect(isDefaultAppName("every-acme-todo")).toBe(true);
    expect(isDefaultAppName("every-demo--acme-todo")).toBe(false);
    expect(isDefaultAppName("every-app-gateway-demo")).toBe(false);
    // Nothing that isn't Every App's.
    for (const foreign of [
      "my-worker",
      "everyone-else",
      "every",
      "demo-every-app-gateway",
    ]) {
      for (const gateway of GATEWAYS)
        expect(belongsToGateway(gateway, foreign), foreign).toBe(false);
    }
  });
});
