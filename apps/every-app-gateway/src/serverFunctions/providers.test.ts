/**
 * Admin → Providers' server functions: every one is behind the public
 * error and organization admin gate (owners and admins); the validators
 * refuse what the dialogs must never send (a secret without its id, a
 * preset and a spec at once, an id outside the rule); the presets listing
 * carries no value and names every shipped preset and every catalog client
 * with a Gateway flow; the handlers hand the service the actor.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  isOAuthProvider,
  oauthPresetIds,
} from "@every-app/sdk/internal";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  registersProviders: vi.fn(() => true),
  service: {
    redirectUriFor: vi.fn(
      (id: string) => `https://gw.test/connect/${id}/callback`,
    ),
    listProviders: vi.fn(),
    listOAuthProviders: vi.fn(),
    addOAuthProvider: vi.fn(),
    setOAuthClient: vi.fn(),
    removeOAuthClient: vi.fn(),
    removeProvider: vi.fn(),
    addScopeSet: vi.fn(),
    removeScopeSet: vi.fn(),
  },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.middleware = vi.fn((middlewares: unknown[]) => {
      builder.middlewares = middlewares;
      return builder;
    });
    builder.validator = vi.fn((validator: (data: unknown) => unknown) => {
      builder.validatorFn = validator;
      return builder;
    });
    builder.handler = vi.fn((handler: (input: unknown) => unknown) => {
      builder.serverHandler = handler;
      return builder;
    });
    return builder;
  }),
}));
vi.mock("@/middleware/auth", () => ({
  organizationAdminMiddleware: mocks.organizationAdminMiddleware,
  organizationMemberMiddleware: { name: "organizationMemberMiddleware" },
}));
vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));
vi.mock("@/server/oauth/service", () => mocks.service);
vi.mock("@/server/toolbus/runtime", () => ({
  registersProviders: mocks.registersProviders,
}));

import {
  addOAuthProvider,
  addScopeSet,
  listOAuthPresets,
  listOAuthProviders,
  listProviders,
  removeOAuthClient,
  removeProvider,
  removeScopeSet,
  setOAuthClient,
  type OAuthPresetSummary,
} from "./providers";

type ServerFnBuilder = {
  middlewares: unknown[];
  validatorFn?: (data: unknown) => unknown;
  serverHandler: (input: {
    data?: unknown;
    context: {
      org: { orgId: string; userId: string; role: string };
      user: { id: string; email?: string | null; name?: string | null };
    };
  }) => Promise<unknown>;
};

const serverFns = {
  listProviders,
  listOAuthProviders,
  listOAuthPresets,
  addOAuthProvider,
  setOAuthClient,
  removeOAuthClient,
  removeProvider,
  addScopeSet,
  removeScopeSet,
} as unknown as Record<string, ServerFnBuilder>;

const context = {
  org: { orgId: "org_1", userId: "user_1", role: "admin" },
  user: { id: "user_1", email: "ada@example.com", name: "Ada" },
};

describe("provider server functions", () => {
  it.each(Object.keys(serverFns))(
    "%s is behind the public error and organization admin gate",
    (name) => {
      expect(serverFns[name]!.middlewares).toEqual([
        mocks.publicErrorMiddleware,
        mocks.organizationAdminMiddleware,
      ]);
    },
  );

  describe("addOAuthProvider's validator", () => {
    const validate = serverFns["addOAuthProvider"]!.validatorFn!;

    it("takes a preset with a client", () => {
      expect(
        validate({
          preset: "github-oauth",
          clientId: "Iv1.abc",
          clientSecret: "s3",
        }),
      ).toEqual({
        preset: "github-oauth",
        clientId: "Iv1.abc",
        clientSecret: "s3",
      });
    });

    it("takes a custom spec without a client", () => {
      expect(validate({ spec: { id: "acme" } })).toEqual({
        spec: { id: "acme" },
      });
    });

    it("refuses a preset and a spec at once, neither, a secret without its id, and a bad preset id", () => {
      expect(() => validate({ preset: "github-oauth", spec: {} })).toThrow();
      expect(() => validate({})).toThrow();
      expect(() =>
        validate({ preset: "github-oauth", clientSecret: "s3" }),
      ).toThrow();
      expect(() => validate({ preset: "GitHub!" })).toThrow();
    });
  });

  describe("setOAuthClient's validator", () => {
    const validate = serverFns["setOAuthClient"]!.validatorFn!;

    it("needs a provider id and a client id; the secret is optional (a public client)", () => {
      expect(
        validate({ providerId: "github-oauth", clientId: " id " }),
      ).toEqual({
        providerId: "github-oauth",
        clientId: "id",
      });
      expect(() =>
        validate({ providerId: "github-oauth", clientId: "" }),
      ).toThrow();
      expect(() => validate({ providerId: "Bad Id", clientId: "x" })).toThrow();
    });
  });

  it("hands the service the organization and the acting user", async () => {
    mocks.service.setOAuthClient.mockResolvedValueOnce({ id: "github-oauth" });
    await serverFns["setOAuthClient"]!.serverHandler({
      data: { providerId: "github-oauth", clientId: "id", clientSecret: "s" },
      context,
    });
    expect(mocks.service.setOAuthClient).toHaveBeenCalledWith(
      context.org,
      { kind: "user", id: "user_1", email: "ada@example.com", name: "Ada" },
      "github-oauth",
      { clientId: "id", clientSecret: "s" },
    );

    await serverFns["removeProvider"]!.serverHandler({
      data: { providerId: "acme" },
      context,
    });
    expect(mocks.service.removeProvider).toHaveBeenCalledWith(
      context.org,
      expect.objectContaining({ id: "user_1" }),
      "acme",
    );
  });

  it("lists the organization's providers with whether each is set up, as the service reports it (readable on a hosted gateway too)", async () => {
    const listed = [
      {
        id: "dataforseo",
        name: "DataForSEO",
        source: "catalog",
        kind: "api_key",
        hosts: ["api.dataforseo.com"],
        configured: false,
        settings: ["DATAFORSEO_API_KEY"],
        apps: [{ name: "notes", needs: true }],
      },
    ];
    mocks.service.listProviders.mockResolvedValueOnce(listed);
    mocks.registersProviders.mockReturnValue(false);
    try {
      await expect(
        serverFns["listProviders"]!.serverHandler({ context }),
      ).resolves.toEqual({ providers: listed });
    } finally {
      mocks.registersProviders.mockReturnValue(true);
    }
    expect(mocks.service.listProviders).toHaveBeenCalledWith(context.org);
  });

  it("refuses every write on a hosted gateway, where providers would be every tenant's", async () => {
    mocks.registersProviders.mockReturnValue(false);
    mocks.service.addOAuthProvider.mockClear();
    mocks.service.removeProvider.mockClear();
    try {
      for (const [name, data] of [
        ["addOAuthProvider", { preset: "github-oauth" }],
        ["setOAuthClient", { providerId: "github-oauth", clientId: "x" }],
        ["removeOAuthClient", { providerId: "github-oauth" }],
        ["removeProvider", { providerId: "github-oauth" }],
      ] as const) {
        await expect(
          serverFns[name]!.serverHandler({ data, context }),
        ).rejects.toMatchObject({ code: "PROVIDER_HOSTED" });
      }
      expect(mocks.service.addOAuthProvider).not.toHaveBeenCalled();
      expect(mocks.service.removeProvider).not.toHaveBeenCalled();
    } finally {
      mocks.registersProviders.mockReturnValue(true);
    }
  });

  describe("listOAuthPresets", () => {
    it("names every shipped preset and every catalog client with a Gateway flow, built in first, with no value", async () => {
      const result = (await serverFns["listOAuthPresets"]!.serverHandler({
        context,
      })) as { presets: OAuthPresetSummary[] };
      const ids = result.presets.map((preset) => preset.id);
      const builtIn = CAPABILITY_IDS.filter((id) =>
        isOAuthProvider(CAPABILITIES[id]),
      );
      expect(builtIn.length).toBeGreaterThan(0);
      expect(ids.slice(0, builtIn.length)).toEqual(builtIn);
      expect(ids.slice(builtIn.length)).toEqual(oauthPresetIds());
      for (const preset of result.presets) {
        expect(preset.builtIn).toBe(builtIn.includes(preset.id as never));
        expect(preset.redirectUri).toBe(
          `https://gw.test/connect/${preset.id}/callback`,
        );
        expect(preset.console).toMatch(/^https:\/\//);
        expect(preset.settings.clientId).toMatch(/^[A-Z][A-Z0-9_]+$/);
        // A listing carries names only: nothing shaped like a value.
        expect(JSON.stringify(preset)).not.toMatch(/secret"\s*:\s*"[^A-Z]/);
      }
      const github = result.presets.find(
        (preset) => preset.id === "github-oauth",
      )!;
      expect(github.scopeSets.map((set) => set.name)).toContain("repo.read");
      expect(github.pkce).toBe(true);
    });
  });
});

describe("the scope-set server functions", () => {
  const validate = serverFns["addScopeSet"]!.validatorFn!;
  const input = {
    providerId: "google-workspace",
    name: "gmail.send",
    label: "Gmail (send)",
    access: "write",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    routes: [
      {
        host: "gmail.googleapis.com",
        paths: ["/gmail/v1/users/"],
        posts: ["^/gmail/v1/users/[^/]+/messages/send$"],
      },
    ],
  };

  it("takes a set with one route, and refuses a bad name, no scope and no route", () => {
    expect(validate(input)).toEqual(input);
    expect(() => validate({ ...input, name: "Gmail Send" })).toThrow();
    expect(() => validate({ ...input, scopes: [] })).toThrow();
    expect(() => validate({ ...input, routes: [] })).toThrow();
    expect(() => validate({ ...input, access: "admin" })).toThrow();
  });

  it("hands the service the client, the name, the set and the actor; removal the same", async () => {
    mocks.service.addScopeSet.mockResolvedValue({ id: "google-workspace" });
    await serverFns["addScopeSet"]!.serverHandler({ data: input, context });
    expect(mocks.service.addScopeSet).toHaveBeenCalledWith(
      context.org,
      { kind: "user", id: "user_1", email: "ada@example.com", name: "Ada" },
      {
        providerId: "google-workspace",
        name: "gmail.send",
        spec: {
          label: input.label,
          access: "write",
          scopes: input.scopes,
          routes: input.routes,
        },
      },
    );
    mocks.service.removeScopeSet.mockResolvedValue({ id: "google-workspace" });
    await serverFns["removeScopeSet"]!.serverHandler({
      data: { providerId: "google-workspace", name: "gmail.send" },
      context,
    });
    expect(mocks.service.removeScopeSet).toHaveBeenCalledWith(
      context.org,
      { kind: "user", id: "user_1", email: "ada@example.com", name: "Ada" },
      { providerId: "google-workspace", name: "gmail.send" },
    );
  });

  it("are refused on a hosted gateway", async () => {
    mocks.registersProviders.mockReturnValueOnce(false);
    await expect(
      serverFns["addScopeSet"]!.serverHandler({ data: input, context }),
    ).rejects.toMatchObject({ code: "PROVIDER_HOSTED" });
  });
});
