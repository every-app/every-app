/**
 * Composio's server functions (docs/design/2026-11-composio.md): the
 * switch is an owner's or admin's, a link is every member's own, and the
 * Composio page's context is built for the person signed in on the
 * request. What the browser gets back from a finished link is its state
 * and nothing of the link, and reading the status asks Composio nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationMemberMiddleware: { name: "organizationMemberMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  service: {
    composioSwitch: vi.fn(),
    setComposio: vi.fn(),
    turnComposioOff: vi.fn(),
    composioStatus: vi.fn(),
    startComposioLink: vi.fn(),
    finishComposioLink: vi.fn(),
    unlinkComposio: vi.fn(),
  },
  getRequest: vi.fn(),
  signedIn: vi.fn(),
  buildComposioContext: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn((options: unknown) => {
    const builder: Record<string, unknown> = { options };
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
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => mocks.getRequest(),
}));
vi.mock("@/middleware/auth", () => ({
  organizationMemberMiddleware: mocks.organizationMemberMiddleware,
  organizationAdminMiddleware: mocks.organizationAdminMiddleware,
}));
vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));
vi.mock("@/server/composio/service", () => mocks.service);
vi.mock("@/server/composio/connect", () => ({
  buildComposioContext: mocks.buildComposioContext,
}));
vi.mock("@/server/oauth/flow", () => ({ signedIn: mocks.signedIn }));

import { ComposioLinkState } from "@/schemas/composio";
import {
  finishComposioLink,
  getComposioContext,
  getComposioStatus,
  getComposioSwitch,
  setComposioSwitch,
  startComposioLink,
  unlinkComposio,
} from "./composio";

type ServerFnBuilder = {
  options?: { method?: string };
  middlewares: unknown[];
  validatorFn?: (data: unknown) => unknown;
  serverHandler: (input: {
    data?: unknown;
    context?: { org: { orgId: string; userId: string; role: string } };
  }) => Promise<unknown>;
};

const fns = {
  getComposioSwitch,
  setComposioSwitch,
  getComposioStatus,
  startComposioLink,
  finishComposioLink,
  unlinkComposio,
  getComposioContext,
} as unknown as Record<string, ServerFnBuilder>;

const member = { org: { orgId: "org_1", userId: "user_m", role: "member" } };
const admin = { org: { orgId: "org_1", userId: "user_a", role: "admin" } };
const STATUS = {
  composio: "on",
  linked: true,
  account: "alex@example.com",
  providers: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Composio's server functions", () => {
  it("keep the switch to owners and admins, and let every member reach their own link", () => {
    for (const name of ["getComposioSwitch", "setComposioSwitch"]) {
      expect(fns[name]!.middlewares, name).toEqual([
        mocks.publicErrorMiddleware,
        mocks.organizationAdminMiddleware,
      ]);
    }
    for (const name of [
      "getComposioStatus",
      "startComposioLink",
      "finishComposioLink",
      "unlinkComposio",
    ]) {
      expect(fns[name]!.middlewares, name).toEqual([
        mocks.publicErrorMiddleware,
        mocks.organizationMemberMiddleware,
      ]);
    }
  });

  it("turn Composio on or off for the caller's organization, and off deletes only once confirmed", async () => {
    const validate = fns["setComposioSwitch"]!.validatorFn!;
    expect(validate({ on: false })).toEqual({ on: false });
    expect(validate({ on: false, confirm: true })).toEqual({
      on: false,
      confirm: true,
    });
    expect(() => validate({ on: "yes" })).toThrow();
    expect(() => validate({ on: false, confirm: "yes" })).toThrow();
    expect(() => validate({})).toThrow();

    const run = (data: { on: boolean; confirm?: boolean }) =>
      fns["setComposioSwitch"]!.serverHandler({ data, context: admin });

    mocks.service.setComposio.mockResolvedValue({ composio: "on" });
    await expect(run({ on: true })).resolves.toEqual({ composio: "on" });
    expect(mocks.service.setComposio).toHaveBeenCalledWith(admin.org, true);

    // Off goes through the rule that asks first, confirmed only when the page said so.
    const asks = { needsConfirm: { links: 2, connections: 3 } };
    mocks.service.turnComposioOff.mockResolvedValue(asks);
    await expect(run({ on: false })).resolves.toEqual(asks);
    expect(mocks.service.turnComposioOff).toHaveBeenLastCalledWith(
      admin.org,
      false,
    );
    const turned = {
      composio: "off",
      changed: true,
      removed: { links: 2, connections: 3 },
    };
    mocks.service.turnComposioOff.mockResolvedValue(turned);
    await expect(run({ on: false, confirm: true })).resolves.toEqual(turned);
    expect(mocks.service.turnComposioOff).toHaveBeenLastCalledWith(
      admin.org,
      true,
    );
    // Never the unconditional delete.
    expect(mocks.service.setComposio).toHaveBeenCalledTimes(1);

    const counted = { composio: "on", links: 2, connections: 3 };
    mocks.service.composioSwitch.mockResolvedValue(counted);
    await expect(
      fns["getComposioSwitch"]!.serverHandler({ context: admin }),
    ).resolves.toEqual(counted);
    expect(mocks.service.composioSwitch).toHaveBeenCalledWith(admin.org);
  });

  it("read the caller's own link from the Gateway alone: what is in their Composio is not asked for", async () => {
    mocks.service.composioStatus.mockResolvedValue(STATUS);
    await expect(
      fns["getComposioStatus"]!.serverHandler({ context: member }),
    ).resolves.toEqual(STATUS);
    // No `list`: a GET never calls Composio.
    expect(mocks.service.composioStatus).toHaveBeenCalledWith(member.org);
  });

  it("start the caller's own sign-in, and answer a finished one with its state and nothing of the link", async () => {
    const started = {
      url: "https://dashboard.composio.dev/?cliKey=abc",
      expiresAt: 1,
    };
    mocks.service.startComposioLink.mockResolvedValue(started);
    await expect(
      fns["startComposioLink"]!.serverHandler({ context: member }),
    ).resolves.toEqual(started);
    expect(mocks.service.startComposioLink).toHaveBeenCalledWith(member.org);

    mocks.service.finishComposioLink.mockResolvedValue({
      state: ComposioLinkState.Linked,
      status: { ...STATUS, providers: [{ providerId: "github-oauth" }] },
    });
    await expect(
      fns["finishComposioLink"]!.serverHandler({ context: member }),
    ).resolves.toEqual({ state: "linked" });
    expect(mocks.service.finishComposioLink).toHaveBeenCalledWith(member.org);

    mocks.service.unlinkComposio.mockResolvedValue({ removed: true });
    await expect(
      fns["unlinkComposio"]!.serverHandler({ context: member }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.service.unlinkComposio).toHaveBeenCalledWith(member.org);
  });
});

describe("getComposioContext", () => {
  const fn = fns["getComposioContext"]!;
  const REQUEST = new Request("https://gateway.example.com/_serverFn/abc");
  const PERSON = {
    id: "user-1",
    email: "ada@example.com",
    org: { orgId: "org-1", userId: "user-1", role: "member" },
  };

  beforeEach(() => {
    mocks.getRequest.mockReturnValue(REQUEST);
    mocks.signedIn.mockResolvedValue(PERSON);
  });

  it("is a POST that takes the page's state and nothing else, with no organization middleware of its own", () => {
    expect(fn.options).toEqual({ method: "POST" });
    expect(fn.middlewares).toEqual([mocks.publicErrorMiddleware]);
    expect(fn.validatorFn!({ state: "state-1" })).toEqual({ state: "state-1" });
    expect(() => fn.validatorFn!({})).toThrow();
    expect(() => fn.validatorFn!({ state: "" })).toThrow();
    expect(() => fn.validatorFn!({ state: "x".repeat(257) })).toThrow();
  });

  it("tells a signed-out page to sign in, and reads nothing", async () => {
    mocks.signedIn.mockResolvedValue(null);
    await expect(
      fn.serverHandler({ data: { state: "state-1" } }),
    ).resolves.toEqual({ ok: false, signedOut: true });
    expect(mocks.buildComposioContext).not.toHaveBeenCalled();
  });

  it("builds the page for the person signed in on this request, from the state the page carries", async () => {
    const context = { ok: true, state: "state-1", step: "link" };
    mocks.buildComposioContext.mockResolvedValue(context);
    await expect(
      fn.serverHandler({ data: { state: "state-1" } }),
    ).resolves.toEqual(context);
    expect(mocks.signedIn).toHaveBeenCalledWith(REQUEST);
    expect(mocks.buildComposioContext).toHaveBeenCalledWith(PERSON, "state-1");
  });
});
