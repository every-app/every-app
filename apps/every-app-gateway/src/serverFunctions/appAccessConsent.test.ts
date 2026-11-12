/**
 * The Allow page's server function: the context is built for the person
 * signed in on this request, from the state the page carries; a signed-out
 * page is told to sign in and nothing is read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequest: vi.fn(),
  signedIn: vi.fn(),
  buildAppAccessContext: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn((options: unknown) => {
    const builder: Record<string, unknown> = { options };
    builder.middleware = vi.fn(() => builder);
    builder.validator = vi.fn((validator: unknown) => {
      builder.validatorFn = validator;
      return builder;
    });
    builder.handler = vi.fn((handler: unknown) => {
      builder.serverHandler = handler;
      return builder;
    });
    return builder;
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => mocks.getRequest(),
}));
vi.mock("@/middleware/publicError", () => ({ publicErrorMiddleware: {} }));
vi.mock("@/server/oauth/flow", () => ({ signedIn: mocks.signedIn }));
vi.mock("@/server/oauth/appAccessConsent", () => ({
  buildAppAccessContext: mocks.buildAppAccessContext,
}));

import { getAppAccessContext } from "./appAccessConsent";

const fn = getAppAccessContext as unknown as {
  options: { method?: string };
  validatorFn: (data: unknown) => { state: string };
  serverHandler: (input: { data: { state: string } }) => Promise<unknown>;
};

const REQUEST = new Request("https://gateway.example.com/_serverFn/abc");
const PERSON = {
  id: "user-1",
  email: "ada@example.com",
  org: { orgId: "org-1", userId: "user-1", role: "member" },
};
const CONTEXT = { ok: true, state: "state-1", app: { id: "notes" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRequest.mockReturnValue(REQUEST);
  mocks.signedIn.mockResolvedValue(PERSON);
  mocks.buildAppAccessContext.mockResolvedValue(CONTEXT);
});

describe("getAppAccessContext", () => {
  it("is a POST that takes the page's state and nothing else", () => {
    expect(fn.options).toEqual({ method: "POST" });
    expect(fn.validatorFn({ state: "state-1" })).toEqual({ state: "state-1" });
    expect(() => fn.validatorFn({})).toThrow();
    expect(() => fn.validatorFn({ state: "" })).toThrow();
    expect(() => fn.validatorFn({ state: "x".repeat(257) })).toThrow();
  });

  it("tells a signed-out page to sign in, and reads nothing", async () => {
    mocks.signedIn.mockResolvedValue(null);
    await expect(
      fn.serverHandler({ data: { state: "state-1" } }),
    ).resolves.toEqual({ ok: false, signedOut: true });
    expect(mocks.buildAppAccessContext).not.toHaveBeenCalled();
  });

  it("builds the context for the person signed in on this request, from the state the page carries", async () => {
    await expect(
      fn.serverHandler({ data: { state: "state-1" } }),
    ).resolves.toEqual(CONTEXT);
    expect(mocks.signedIn).toHaveBeenCalledWith(REQUEST);
    expect(mocks.buildAppAccessContext).toHaveBeenCalledWith(PERSON, "state-1");
  });

  it("passes on what the context says when the state isn't this person's to use", async () => {
    const gone = { ok: false, message: "This page was used already." };
    mocks.buildAppAccessContext.mockResolvedValue(gone);
    await expect(
      fn.serverHandler({ data: { state: "someone-elses" } }),
    ).resolves.toEqual(gone);
  });
});
