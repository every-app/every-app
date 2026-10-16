import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

import { handleOutboundRequest, Outbound } from "./outbound";

const APP = {
  appId: "notes",
  organizationId: "org_1",
  workerName: "every-acme-notes",
  egress: ["api.github.com", "Hooks.Slack.com."],
};

const ENV = {
  GATEWAY_URL: "https://app.everyapp.com",
  APP_BASE_DOMAIN: "app.everyapp.com",
  everyapp: APP,
};

function sender() {
  return vi.fn(async (request: Request) =>
    Response.json({ sent: request.url }),
  );
}

async function outbound(url: string, env: object = ENV) {
  const send = sender();
  const response = await handleOutboundRequest(new Request(url), env, send);
  return { response, send };
}

describe("handleOutboundRequest", () => {
  it("forwards a request to a host on the app's allowlist", async () => {
    const { response, send } = await outbound(
      "https://api.github.com/repos/acme/notes",
    );
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    // Hostnames compare case- and trailing-dot-insensitively.
    expect(
      (await outbound("https://hooks.slack.com/services/x")).response.status,
    ).toBe(200);
  });

  it("denies every host off the allowlist and logs it", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const url of [
      "https://example.com/",
      "https://evil.api.github.com/",
      "https://api.github.com.evil.com/",
    ]) {
      const { response, send } = await outbound(url);
      expect(response.status, url).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "egress_denied",
        reason: "not_allowed",
      });
      expect(send).not.toHaveBeenCalled();
    }
    const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      evt: "egress.denied",
      app: "notes",
      org: "org_1",
      worker: "every-acme-notes",
      host: "example.com",
      reason: "not_allowed",
    });
    log.mockRestore();
  });

  it("always denies the providers whose keys the gateway holds, and the gateway itself", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const everything = {
      ...ENV,
      everyapp: {
        ...APP,
        egress: [
          "api.openai.com",
          "openrouter.ai",
          "api.dataforseo.com",
          "api.context.dev",
          "gateway.ai.cloudflare.com",
          "app.everyapp.com",
          "todo.app.everyapp.com",
        ],
      },
    };
    for (const url of [
      "https://api.openai.com/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
      "https://api.dataforseo.com/v3/serp",
      "https://api.context.dev/v1/scrape",
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openai",
      "https://app.everyapp.com/api/ai/openai",
      "https://todo.app.everyapp.com/",
    ]) {
      const { response, send } = await outbound(url, everything);
      expect(response.status, url).toBe(403);
      expect(await response.json()).toMatchObject({ reason: "reserved_host" });
      expect(send).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
  });

  it("denies plain HTTP, and everything when the dispatcher named no app", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const http = await outbound("http://api.github.com/");
    expect(await http.response.json()).toMatchObject({ reason: "not_https" });

    for (const env of [
      { ...ENV, everyapp: undefined },
      { ...ENV, everyapp: { ...APP, egress: "api.github.com" } },
      { ...ENV, everyapp: "notes" },
    ]) {
      const { response, send } = await outbound("https://api.github.com/", env);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: "no_app" });
      expect(send).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
  });
});

describe("Outbound", () => {
  it("judges each fetch with the outbound parameters on its env", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const entrypoint = new (Outbound as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => Outbound)({}, ENV);
    const denied = await entrypoint.fetch(new Request("https://example.com/"));
    expect(denied.status).toBe(403);
    vi.restoreAllMocks();
  });
});
