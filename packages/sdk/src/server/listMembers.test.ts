import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "../../test/inOrganization";
import type { EveryAppUser } from "../internal/index";
import { getEveryAppUser } from "./everyApp";
import { GatewayRefusalError } from "./integrationFetch";
import { listMembers } from "./listMembers";

vi.mock("./everyApp", () => ({ getEveryAppUser: vi.fn() }));

const MEMBERS = {
  members: [
    { id: "u1", email: "ana@acme.test", name: "Ana", role: "owner" },
    { id: "u2", email: "bo@acme.test", name: "", role: "member" },
  ],
};

function gateway(response: () => Response = () => Response.json(MEMBERS)) {
  const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => response(),
  );
  return { env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } }, bindingFetch };
}

const devUser = (overrides: Partial<EveryAppUser> = {}) =>
  ({
    id: "dev-user",
    email: "dev@everyapp.localhost",
    orgId: "dev-org",
    orgRole: "owner",
    channel: "web",
    ...overrides,
  }) as EveryAppUser;

beforeEach(() => {
  vi.mocked(getEveryAppUser).mockResolvedValue(devUser());
});

describe("listMembers through the gateway", () => {
  it("asks the members route with the request's identity", async () => {
    const { env, bindingFetch } = gateway();

    await expect(
      listMembers({
        env,
        for: new Request("https://crm.example.com/", {
          headers: { "x-everyapp-identity": "signed-user-identity" },
        }),
      }),
    ).resolves.toEqual(MEMBERS);

    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.url).toBe(
      "http://every-app-gateway.internal/api/integrations/members/list",
    );
    expect(sent.method).toBe("GET");
    expect(sent.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
  });

  it("throws the gateway's refusal as a GatewayRefusalError", async () => {
    const { env } = gateway(() =>
      Response.json(
        {
          error: "Forbidden",
          code: "capability_not_requested",
          message: "This app doesn't list members in its capabilities.",
        },
        {
          status: 403,
          headers: { "x-everyapp-error": "capability_not_requested" },
        },
      ),
    );
    await expect(listMembers({ env })).rejects.toMatchObject({
      name: "GatewayRefusalError",
      status: 403,
      code: "capability_not_requested",
    });
  });
});

describe("listMembers in local dev", () => {
  const env = { EVERYAPP_DEV: "1" };

  it("answers the request's signed-in user alone", async () => {
    await expect(
      listMembers({ env, for: new Request("https://crm.localhost/") }),
    ).resolves.toEqual({
      members: [
        {
          id: "dev-user",
          email: "dev@everyapp.localhost",
          name: "",
          role: "owner",
        },
      ],
    });
  });

  it("answers no one for background work, which has no person", async () => {
    await expect(
      listMembers({ env, for: { background: true } }),
    ).resolves.toEqual({ members: [] });
  });
});
