import { describe, expect, it, vi } from "vitest";
import {
  AppUnreachableError,
  getAppFetcher,
  OUTBOUND_PARAMETER,
  type AppFetcherTarget,
} from "./getAppFetcher";

const TODO: AppFetcherTarget = {
  appId: "todo",
  organizationId: "org_1",
  workerName: "every-acme-todo",
  tier: "service_binding",
};

const DISPATCHED: AppFetcherTarget = { ...TODO, tier: "dispatch" };

function unreachable(run: () => unknown): AppUnreachableError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppUnreachableError);
    return error as AppUnreachableError;
  }
  throw new Error("expected getAppFetcher to throw");
}

/** A fake Workers for Platforms namespace holding the named scripts. */
function fakeDispatcher(scripts: Record<string, (r: Request) => Response>) {
  const get = vi.fn(
    (
      name: string,
      _args?: Record<string, unknown>,
      _options?: Record<string, unknown>,
    ) => {
      const script = scripts[name];
      if (!script) throw new Error(`Worker not found: ${name}`);
      return { fetch: async (request: Request) => script(request) };
    },
  );
  return { get };
}

describe("getAppFetcher", () => {
  it("looks up service bindings with the reserved APP__ prefix", async () => {
    const fetcher = {
      fetch: async () => new Response("ok"),
    };

    expect(getAppFetcher({ "APP__every-acme-todo": fetcher }, TODO)).toBe(
      fetcher,
    );
  });

  it("does not fall back to raw worker-name bindings", () => {
    const error = unreachable(() =>
      getAppFetcher(
        {
          "every-acme-todo": {
            fetch: async () => new Response("wrong"),
          },
        },
        TODO,
      ),
    );
    expect(error.reason).toBe("no_binding");
  });

  it("never reaches a dispatch app over a service binding, nor the reverse", () => {
    const binding = { fetch: async () => new Response("binding") };
    expect(
      unreachable(() =>
        getAppFetcher({ "APP__every-acme-todo": binding }, DISPATCHED),
      ).reason,
    ).toBe("no_dispatcher");
    expect(
      unreachable(() =>
        getAppFetcher(
          {
            DISPATCHER: fakeDispatcher({
              "every-acme-todo": () => new Response(),
            }),
          },
          TODO,
        ),
      ).reason,
    ).toBe("no_binding");
  });

  it("refuses a tier it doesn't know", () => {
    expect(() =>
      getAppFetcher({}, {
        ...TODO,
        tier: "direct",
      } as unknown as AppFetcherTarget),
    ).toThrow(AppUnreachableError);
  });
});

describe("getAppFetcher (dispatch)", () => {
  it("dispatches to the app's Worker in the namespace", async () => {
    const dispatcher = fakeDispatcher({
      "every-acme-todo": (request) =>
        new Response(`hello from ${new URL(request.url).pathname}`),
    });

    const fetcher = getAppFetcher({ DISPATCHER: dispatcher }, DISPATCHED);
    const response = await fetcher.fetch(
      new Request("https://todo-acme.example.com/tasks"),
    );

    expect(await response.text()).toBe("hello from /tasks");
    expect(dispatcher.get).toHaveBeenCalledOnce();
    expect(dispatcher.get.mock.calls[0]?.[0]).toBe("every-acme-todo");
  });

  it("passes the limits and the app's egress allowlist to the outbound Worker", () => {
    const dispatcher = fakeDispatcher({
      "every-acme-todo": () => new Response(),
    });

    getAppFetcher(
      { DISPATCHER: dispatcher },
      {
        ...DISPATCHED,
        limits: { cpuMs: 50, subrequests: 10 },
        egress: ["api.github.com"],
      },
    );

    expect(dispatcher.get).toHaveBeenCalledWith(
      "every-acme-todo",
      {},
      {
        limits: { cpuMs: 50, subRequests: 10 },
        outbound: {
          [OUTBOUND_PARAMETER]: {
            appId: "todo",
            organizationId: "org_1",
            workerName: "every-acme-todo",
            egress: ["api.github.com"],
          },
        },
      },
    );
  });

  it("defaults to platform limits and an empty allowlist (deny all)", () => {
    const dispatcher = fakeDispatcher({
      "every-acme-todo": () => new Response(),
    });

    getAppFetcher({ DISPATCHER: dispatcher }, DISPATCHED);

    const options = dispatcher.get.mock.calls[0]?.[2] as {
      limits: { cpuMs: number; subRequests: number };
      outbound: Record<string, { egress: string[] }>;
    };
    expect(options.limits.cpuMs).toBeGreaterThan(0);
    expect(options.limits.subRequests).toBeGreaterThan(0);
    expect(options.outbound[OUTBOUND_PARAMETER]?.egress).toEqual([]);
  });

  it("maps a Worker the namespace doesn't hold to AppUnreachableError", async () => {
    // From get() …
    const missing = unreachable(() =>
      getAppFetcher({ DISPATCHER: fakeDispatcher({}) }, DISPATCHED),
    );
    expect(missing.reason).toBe("worker_not_found");

    // … and from the first fetch, where the runtime may report it instead.
    const lazy = {
      get: () => ({
        fetch: async () => {
          throw new Error("Worker not found.");
        },
      }),
    };
    const fetcher = getAppFetcher({ DISPATCHER: lazy }, DISPATCHED);
    await expect(
      fetcher.fetch(new Request("https://todo-acme.example.com/")),
    ).rejects.toMatchObject({
      name: "AppUnreachableError",
      reason: "worker_not_found",
    });
  });

  it("lets the app's own errors through as errors, not unreachable", async () => {
    const crashing = {
      get: () => ({
        fetch: async () => {
          throw new Error("TypeError in the app");
        },
      }),
    };
    const fetcher = getAppFetcher({ DISPATCHER: crashing }, DISPATCHED);
    const failure = await fetcher
      .fetch(new Request("https://todo-acme.example.com/"))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AppUnreachableError);
  });

  it("fails closed without a DISPATCHER binding", () => {
    expect(unreachable(() => getAppFetcher({}, DISPATCHED)).reason).toBe(
      "no_dispatcher",
    );
    expect(
      unreachable(() =>
        getAppFetcher(
          { DISPATCHER: { fetch: async () => new Response() } },
          DISPATCHED,
        ),
      ).reason,
    ).toBe("no_dispatcher");
  });

  it("re-checks the registry naming rule before dispatching", () => {
    const dispatcher = fakeDispatcher({
      "every-app-gateway": () => new Response("the gateway"),
      "every-acme-chef": () => new Response("another app"),
      "every-acme-beta-todo": () => new Response("ambiguous"),
      "my-worker": () => new Response("any script"),
    });
    for (const workerName of [
      "every-app-gateway",
      "every-acme-chef",
      "every-acme-beta-todo",
      "my-worker",
      "every--todo",
    ]) {
      const error = unreachable(() =>
        getAppFetcher(
          { DISPATCHER: dispatcher },
          { ...DISPATCHED, workerName },
        ),
      );
      expect(error.reason, workerName).toBe("invalid_worker_name");
    }
    expect(
      unreachable(() =>
        getAppFetcher(
          { DISPATCHER: dispatcher },
          {
            ...DISPATCHED,
            appId: "app-gateway",
            workerName: "every-app-gateway",
          },
        ),
      ).reason,
    ).toBe("invalid_worker_name");
    expect(dispatcher.get).not.toHaveBeenCalled();
  });
});
