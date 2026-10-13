import { describe, expect, it } from "vitest";
import { createNdjsonSink } from "@/lib/output/events";
import { waitForCertificates } from "./certWait";

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe("waitForCertificates", () => {
  it("waits for every new hostname, saying so every 15 seconds", async () => {
    const events: any[] = [];
    const out = createNdjsonSink((line) => events.push(JSON.parse(line)));
    const time = clock();
    const readyAt: Record<string, number> = {
      "https://a.apps.example.com/": 40_000,
      "https://b.apps.example.com/": 70_000,
    };

    const result = await waitForCertificates({
      hosts: ["a.apps.example.com", "b.apps.example.com", "a.apps.example.com"],
      out,
      step: "app.tls",
      isReady: async (url) => time.now() >= readyAt[url]!,
      ...time,
    });

    expect(result).toEqual({
      ready: ["a.apps.example.com", "b.apps.example.com"],
      pending: [],
    });
    const waiting = events.filter((e) => e.type === "progress" && e.message.startsWith("Waiting"));
    // At 3 s, 18 s, 33 s, then (a ready at 40 s) 48 s, 63 s.
    expect(waiting.map((e) => e.data.waitedMs)).toEqual([3_000, 18_000, 33_000, 48_000, 63_000]);
    expect(events.filter((e) => e.message?.endsWith("has its certificate."))).toHaveLength(2);
  });

  it("gives up with a warning after the limit, failing nothing", async () => {
    const events: any[] = [];
    const out = createNdjsonSink((line) => events.push(JSON.parse(line)));

    const result = await waitForCertificates({
      hosts: ["todo.apps.example.com"],
      out,
      step: "app.tls",
      isReady: async () => false,
      ...clock(),
    });

    expect(result).toEqual({ ready: [], pending: ["todo.apps.example.com"] });
    expect(events.at(-1)).toMatchObject({
      type: "warning",
      code: "CERT_PENDING",
      message: expect.stringContaining("10m 00s"),
    });
    expect(out.exitCode).toBe(0);
  });

  it("does nothing without new hostnames", async () => {
    let slept = false;
    await expect(
      waitForCertificates({
        hosts: [],
        out: createNdjsonSink(() => undefined),
        step: "app.tls",
        sleep: async () => {
          slept = true;
        },
      }),
    ).resolves.toEqual({ ready: [], pending: [] });
    expect(slept).toBe(false);
  });
});
