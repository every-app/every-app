import { describe, expect, it } from "vitest";
import { parseDeployInputs } from "./index";

const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----\n";

const valid = {
  schema: 1,
  workerName: "every-todo",
  organizationId: "org_1",
  gatewayUrl: "https://apps.example.com",
  identityIssuer: "https://apps.example.com",
  identityPublicKeys: [PUBLIC_KEY],
  resources: {
    d1: { DB: { name: "every-todo", id: "d1-uuid" } },
    kv: { KV: { id: "kv-id" } },
  },
  createdAt: "2026-10-12T00:00:00.000Z",
};

describe("parseDeployInputs", () => {
  it("accepts the schema the CLI writes", () => {
    expect(parseDeployInputs(valid)).toEqual(valid);
  });

  it("defaults missing resource maps to empty ones", () => {
    expect(
      parseDeployInputs({ ...valid, resources: undefined }).resources,
    ).toEqual({ d1: {}, kv: {} });
  });

  it("rejects other schema versions with an upgrade hint", () => {
    expect(() => parseDeployInputs({ ...valid, schema: 2 })).toThrow(
      /schema 2.*Upgrade/,
    );
  });

  it.each([
    ["an empty worker name", { workerName: "" }],
    ["a relative issuer", { identityIssuer: "/sign-in" }],
    ["no public keys", { identityPublicKeys: [] }],
    ["a key that isn't a PEM public key", { identityPublicKeys: ["abc"] }],
    ["a D1 entry without an id", { resources: { d1: { DB: { name: "x" } } } }],
    ["non-string deleted classes", { deletedDurableObjects: [1] }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseDeployInputs({ ...valid, ...override })).toThrow();
  });

  it("rejects values that aren't objects", () => {
    expect(() => parseDeployInputs(null)).toThrow(/must be an object/);
    expect(() => parseDeployInputs([])).toThrow(/must be an object/);
  });
});
