import { describe, expect, it, vi } from "vitest";
import { aiStatus } from "./ai";
import { withOrganization } from "./context";

/** Background work for one organization. */
const FOR = { background: true, organizationId: "org-1" } as const;

function binding(answer: Response) {
  const fetch = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => answer);
  return { env: { EVERY_APP_GATEWAY: { fetch } }, fetch };
}

describe("aiStatus", () => {
  it("asks the Gateway about the default model, with whom it is for", async () => {
    const answer = {
      provider: "default",
      requested: true,
      configured: false,
      ready: false,
      resolved: null,
      settings: ["OPENROUTER_API_KEY"],
      setup:
        "A chat model (OpenRouter) isn't set up on this Gateway: it needs OPENROUTER_API_KEY. An admin runs: pnpm everyapp configure inbox (or picks another model provider with pnpm everyapp ai default <provider>)",
      command: "pnpm everyapp configure inbox",
    };
    const { env, fetch } = binding(Response.json(answer));
    const status = await aiStatus({
      env,
      for: new Request("https://inbox.example.com/", {
        headers: { "x-everyapp-identity": "signed" },
      }),
    });
    expect(status).toEqual(answer);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://every-app-gateway.internal/api/ai/default",
    );
    expect(new Headers(init?.headers).get("x-everyapp-identity")).toBe(
      "signed",
    );
  });

  it("asks about a named provider", async () => {
    const { env, fetch } = binding(
      Response.json({
        provider: "openrouter",
        requested: true,
        configured: true,
        ready: true,
        resolved: null,
        settings: [],
        setup: null,
        command: null,
      }),
    );
    await expect(
      aiStatus({ for: FOR, env, provider: "openrouter" }),
    ).resolves.toMatchObject({ ready: true, setup: null });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "http://every-app-gateway.internal/api/ai/openrouter",
    );
  });

  it("is not ready when the Gateway refuses the status call", async () => {
    const { env } = binding(
      Response.json(
        { code: "caller_not_registered" },
        {
          status: 403,
          headers: { "x-everyapp-error": "caller_not_registered" },
        },
      ),
    );
    await expect(aiStatus({ for: FOR, env })).resolves.toEqual({
      provider: "default",
      requested: false,
      configured: false,
      ready: false,
      resolved: null,
      settings: [],
      setup: null,
      command: null,
    });
  });

  it("answers from .dev.vars in local development, by the Gateway's order", async () => {
    await expect(
      aiStatus({ for: FOR, env: { EVERYAPP_DEV: "1" } }),
    ).resolves.toEqual({
      provider: "default",
      requested: true,
      configured: false,
      ready: false,
      resolved: null,
      settings: ["OPENROUTER_API_KEY"],
      setup:
        "A chat model isn't set up for local development: set OPENROUTER_API_KEY (or another model provider's key) in .dev.vars.",
      command: null,
    });
    await expect(
      aiStatus({ for: FOR, env: { EVERYAPP_DEV: "1", OPENAI_API_KEY: "sk" } }),
    ).resolves.toMatchObject({
      ready: true,
      resolved: { provider: "openai", label: "OpenAI" },
      settings: [],
      setup: null,
    });
  });

  it("names every setting a provider needs in local development", async () => {
    await expect(
      aiStatus({
        for: FOR,
        env: { EVERYAPP_DEV: "1", WORKERS_AI_API_TOKEN: "t" },
        provider: "workers-ai",
      }),
    ).resolves.toMatchObject({
      ready: false,
      settings: ["WORKERS_AI_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    });
    await expect(
      aiStatus({ for: FOR, env: { EVERYAPP_DEV: "1" }, provider: "nope" }),
    ).resolves.toMatchObject({ requested: false, ready: false });
  });

  it("takes whom it is for from withOrganization() when `for` is left out", async () => {
    const { env, fetch } = binding(Response.json({ requested: true }));
    await withOrganization("org-7", () => aiStatus({ env }));
    const init = fetch.mock.calls[0]![1];
    expect(new Headers(init?.headers).get("x-everyapp-org")).toBe("org-7");
  });

  it("is not ready with neither a binding nor local development", async () => {
    await expect(
      aiStatus({ for: FOR, env: { OPENAI_API_KEY: "sk" } }),
    ).resolves.toMatchObject({ requested: false, ready: false });
  });
});
