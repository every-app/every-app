import { afterEach, describe, expect, it, vi } from "vitest";
import { ORG_HEADER, type EveryAppUser } from "../internal/index";
import {
  IDENTITY_EXPIRY_MARGIN_MS,
  OrganizationMismatchError,
  RequestContextError,
  attributionFromContext,
  currentUser,
  serveRequest,
  withOrganization,
} from "./context";
import { sendEmail } from "./sendEmail";
import { createGatewayFetch } from "./gatewayFetch";

const user: EveryAppUser = {
  id: "user_1",
  email: "a@b.com",
  orgId: "org_1",
  orgRole: "member",
  channel: "web",
  actor: { sub: "user_1" },
  scopes: ["*"],
  jti: "j1",
};

const request = () =>
  new Request("https://todo.example.com/tasks", {
    headers: { "x-everyapp-identity": "signed-user-identity" },
  });

const served = (expiresAt = Date.now() + 120_000) => ({
  request: request(),
  user,
  expiresAt,
});

function binding() {
  return vi.fn<(request: Request) => Promise<Response>>(async () =>
    Response.json({ status: "queued", id: "m1" }),
  );
}
const MESSAGE = { to: "x@example.com", subject: "s", text: "t" };

afterEach(() => {
  vi.useRealTimers();
});

describe("the request context", () => {
  it("keeps the user across awaits, timers and work the handler schedules", async () => {
    const seen: Array<EveryAppUser | null> = [];
    const scheduled: Promise<unknown>[] = [];
    await serveRequest(served(), async () => {
      seen.push(currentUser());
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(currentUser());
      // ctx.waitUntil(): work that outlives the response.
      scheduled.push(
        (async () => {
          await Promise.resolve();
          seen.push(currentUser());
        })(),
      );
      await Promise.all([
        (async () => seen.push(currentUser()))(),
        new Promise<void>((resolve) =>
          queueMicrotask(() => {
            seen.push(currentUser());
            resolve();
          }),
        ),
      ]);
    });
    await Promise.all(scheduled);
    expect(seen).toHaveLength(5);
    for (const one of seen) expect(one).toBe(user);
  });

  it("keeps requests served at once apart", async () => {
    const other = { ...user, id: "user_2" };
    const [a, b] = await Promise.all([
      serveRequest(served(), async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return currentUser()?.id;
      }),
      serveRequest({ ...served(), user: other }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentUser()?.id;
      }),
    ]);
    expect([a, b]).toEqual(["user_1", "user_2"]);
  });

  it("is null on a public route, and throws outside every context", () => {
    expect(
      serveRequest({ ...served(), user: null, expiresAt: null }, () =>
        currentUser(),
      ),
    ).toBeNull();
    expect(() => currentUser()).toThrowError(RequestContextError);
    expect(() => currentUser()).toThrow(/code|withOrganization/);
    let error: unknown;
    try {
      currentUser();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "request_context_missing" });
  });
});

describe("attribution from the context", () => {
  it("is the request while its identity is good", () => {
    const scope = served();
    expect(serveRequest(scope, () => attributionFromContext("sendEmail"))).toBe(
      scope.request,
    );
  });

  it("switches to the organization's background work near the identity's expiry", () => {
    const now = 1_700_000_000_000;
    const expiresAt = now + 120_000;
    vi.useFakeTimers({ now });
    const scope = served(expiresAt);
    const before = expiresAt - IDENTITY_EXPIRY_MARGIN_MS - 1;
    const at = expiresAt - IDENTITY_EXPIRY_MARGIN_MS;
    expect(
      serveRequest(scope, () => attributionFromContext("sendEmail", before)),
    ).toBe(scope.request);
    expect(
      serveRequest(scope, () => attributionFromContext("sendEmail", at)),
    ).toEqual({ background: true, organizationId: "org_1" });
    // Date.now() is the default clock.
    vi.setSystemTime(at);
    expect(
      serveRequest(scope, () => attributionFromContext("sendEmail")),
    ).toEqual({ background: true, organizationId: "org_1" });
  });

  it("falls back for a long-running call made through a fetch created earlier", async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers({ now });
    const fetch = binding();
    const env = { EVERY_APP_GATEWAY: { fetch } };
    await serveRequest(served(now + 120_000), async () => {
      const ai = createGatewayFetch({ env });
      await ai("https://x/api/ai/openai/v1/models");
      vi.setSystemTime(now + 120_000 - IDENTITY_EXPIRY_MARGIN_MS);
      await ai("https://x/api/ai/openai/v1/models");
    });
    const [first, second] = fetch.mock.calls.map(([sent]) => sent);
    expect(first!.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
    expect(first!.headers.get(ORG_HEADER)).toBeNull();
    expect(second!.headers.get("x-everyapp-identity")).toBeNull();
    expect(second!.headers.get(ORG_HEADER)).toBe("org_1");
  });

  it("is the app's own on a public route, and nobody's outside every context", () => {
    expect(
      serveRequest({ ...served(), user: null, expiresAt: null }, () =>
        attributionFromContext("sendEmail"),
      ),
    ).toBeUndefined();
    expect(() => attributionFromContext("sendEmail")).toThrowError(
      RequestContextError,
    );
  });
});

describe("withOrganization", () => {
  it("makes a Workflow step's calls the organization's background work", async () => {
    // A Workflow step: no request, several awaits, a Gateway call at the end.
    const fetch = binding();
    const env = { EVERY_APP_GATEWAY: { fetch }, EVERYAPP_SHARED: "1" };
    const step = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentUser()).toBeNull();
      await Promise.resolve();
      return sendEmail({ env, message: MESSAGE });
    };
    await withOrganization("org-acme", step);
    const [sent] = fetch.mock.calls[0]!;
    expect(sent.headers.get(ORG_HEADER)).toBe("org-acme");
    expect(sent.headers.get("x-everyapp-identity")).toBeNull();
  });

  it("returns what fn returns, sync or async", async () => {
    expect(withOrganization("org_1", () => 7)).toBe(7);
    await expect(withOrganization("org_1", async () => "x")).resolves.toBe("x");
  });

  it("needs a non-empty organization id", () => {
    for (const bad of ["", "  ", undefined, 7]) {
      expect(() => withOrganization(bad as string, () => 1)).toThrow(
        /EVERY_APP_ORG_ID/,
      );
    }
  });

  it("keeps the person attributed inside their own organization's request, and refuses another's", () => {
    const scope = served();
    expect(
      serveRequest(scope, () =>
        withOrganization("org_1", () => attributionFromContext("emit")),
      ),
    ).toBe(scope.request);
    expect(() =>
      serveRequest(scope, () => withOrganization("org_2", () => 1)),
    ).toThrowError(OrganizationMismatchError);
    let error: unknown;
    try {
      serveRequest(scope, () => withOrganization("org_2", () => 1));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "attribution_organization_mismatch",
    });
  });

  it("names the organization on a public route of a shared app", () => {
    expect(
      serveRequest({ ...served(), user: null, expiresAt: null }, () =>
        withOrganization("org-acme", () => attributionFromContext("emit")),
      ),
    ).toEqual({ background: true, organizationId: "org-acme" });
  });
});
