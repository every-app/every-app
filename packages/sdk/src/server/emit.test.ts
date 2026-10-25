import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../internal/index";
import { AttributionError } from "./attribution";
import { emit } from "./emit";
import { GatewayRefusalError } from "./integrationFetch";

afterEach(() => {
  vi.restoreAllMocks();
});

const EVENT = {
  event: "invoice.paid",
  data: { invoiceId: "inv_42", total: 1200 },
};

function gateway(
  response: () => Response = () =>
    Response.json({
      id: "evt_01k8m3z9qx7s4v2b6n8p0r1t3y",
      type: "app.crm.invoice.paid",
    }),
) {
  const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => response(),
  );
  return { env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } }, bindingFetch };
}

describe("emit through the gateway", () => {
  it("posts the event to the events route with the request's identity", async () => {
    const { env, bindingFetch } = gateway();

    await expect(
      emit({
        env,
        for: new Request("https://crm.example.com/invoices", {
          headers: { "x-everyapp-identity": "signed-user-identity" },
        }),
        ...EVENT,
      }),
    ).resolves.toEqual({
      id: "evt_01k8m3z9qx7s4v2b6n8p0r1t3y",
      type: "app.crm.invoice.paid",
    });

    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.url).toBe("http://every-app-gateway.internal/api/events/emit");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
    await expect(sent.json()).resolves.toEqual(EVENT);
  });

  it("leaves the checks to the gateway when deployed", async () => {
    // The gateway is the authority; the SDK doesn't refuse on its behalf.
    const { env, bindingFetch } = gateway();
    await emit({ env, event: "Not A Name", data: { apiKey: "x" } });
    expect(bindingFetch).toHaveBeenCalledOnce();
  });

  it("names the organization for a shared app's background event", async () => {
    const { env, bindingFetch } = gateway();
    await emit({
      env: { ...env, EVERYAPP_SHARED: "1" },
      for: { background: true, organizationId: "org-acme" },
      ...EVENT,
    });
    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.headers.get("x-everyapp-org")).toBe("org-acme");
    expect(sent.headers.get("x-everyapp-identity")).toBeNull();
  });

  it("refuses a shared app's event that doesn't say whom it is for, before calling", async () => {
    const { env, bindingFetch } = gateway();
    await expect(
      emit({ env: { ...env, EVERYAPP_SHARED: "1" }, ...EVENT }),
    ).rejects.toBeInstanceOf(AttributionError);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("throws the gateway's refusal as a GatewayRefusalError", async () => {
    const { env } = gateway(() =>
      Response.json(
        {
          error: "Too Many Requests",
          code: "event_rate_limited",
          message: "This app emitted 600 events this hour.",
        },
        {
          status: 429,
          headers: {
            "x-everyapp-error": "event_rate_limited",
            "retry-after": "1200",
          },
        },
      ),
    );
    const refused = await emit({ env, ...EVENT }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(GatewayRefusalError);
    expect(refused).toMatchObject({
      name: "GatewayRefusalError",
      status: 429,
      code: "event_rate_limited",
      message: "This app emitted 600 events this hour.",
    });
  });

  it("throws on a failure that isn't a refusal", async () => {
    const { env } = gateway(() => new Response("boom", { status: 500 }));
    await expect(emit({ env, ...EVENT })).rejects.toMatchObject({
      name: "GatewayRefusalError",
      status: 500,
      code: "event_emit_failed",
    });
  });

  it("refuses a binding that isn't one", async () => {
    await expect(
      emit({ env: { EVERY_APP_GATEWAY: {} }, ...EVENT }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("refuses a deployed-shaped env with no binding", async () => {
    await expect(
      emit({ env: { EVERYAPP_APP_ID: "crm" }, ...EVENT }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe("emit in local dev", () => {
  const DEV = { EVERYAPP_DEV: "1", EVERYAPP_APP_ID: "crm" };

  it("prints the event's type and answers a dev id, sending nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await emit({ env: DEV, ...EVENT });

    expect(result.type).toBe("app.crm.invoice.paid");
    expect(result.id).toMatch(/^dev-[0-9a-f-]{36}$/);
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "[everyapp dev] event app.crm.invoice.paid (not delivered: no Gateway)",
    );
    // The payload may hold a person's content; the console says only that it fired.
    expect(info.mock.calls[0]![0]).not.toContain("inv_42");
  });

  it("stands in app for the id when the env has none", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(
      emit({ env: { EVERYAPP_DEV: "1" }, event: "todo.completed", data: {} }),
    ).resolves.toMatchObject({ type: "app.app.todo.completed" });
  });

  it("refuses a name the gateway would refuse", async () => {
    for (const event of [
      "",
      "Invoice.Paid",
      "invoice..paid",
      "9lives",
      "a".repeat(65),
    ]) {
      await expect(emit({ env: DEV, event, data: {} })).rejects.toMatchObject({
        name: "GatewayRefusalError",
        status: 400,
        code: "event_name_invalid",
      });
    }
  });

  it("refuses data that isn't a JSON object", async () => {
    await expect(
      emit({
        env: DEV,
        event: "invoice.paid",
        data: [1, 2] as unknown as Record<string, unknown>,
      }),
    ).rejects.toMatchObject({ status: 400, code: "event_data_invalid" });
  });

  it("refuses a key named like a credential, at any depth, naming it", async () => {
    await expect(
      emit({
        env: DEV,
        event: "invoice.paid",
        data: { invoice: { lines: [{ stripeApiKey: "sk_live_x" }] } },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "event_data_refused",
      message: expect.stringContaining('"stripeApiKey"'),
    });
  });

  it("refuses data over 8 KiB as too large", async () => {
    await expect(
      emit({
        env: DEV,
        event: "invoice.paid",
        data: { note: "x".repeat(8 * 1024) },
      }),
    ).rejects.toMatchObject({ status: 413, code: "event_data_too_large" });
  });

  it("prints nothing for a refused event", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await emit({ env: DEV, event: "invoice.paid", data: { token: "t" } }).catch(
      () => undefined,
    );
    expect(info).not.toHaveBeenCalled();
  });
});
