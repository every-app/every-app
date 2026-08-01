import { describe, expect, it } from "vitest";
import { AppUnreachableError, getAppFetcher } from "./getAppFetcher";

describe("getAppFetcher", () => {
  it("looks up service bindings with the reserved APP__ prefix", async () => {
    const fetcher = {
      fetch: async () => new Response("ok"),
    };

    expect(
      getAppFetcher(
        { "APP__every-todo-app": fetcher },
        { workerName: "every-todo-app", tier: "service_binding" },
      ),
    ).toBe(fetcher);
  });

  it("does not fall back to raw worker-name bindings", () => {
    expect(() =>
      getAppFetcher(
        {
          "every-todo-app": {
            fetch: async () => new Response("wrong"),
          },
        },
        { workerName: "every-todo-app", tier: "service_binding" },
      ),
    ).toThrow(AppUnreachableError);
  });
});
