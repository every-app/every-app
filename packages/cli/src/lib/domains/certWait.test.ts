import { describe, expect, it } from "vitest";
import { createNdjsonSink } from "@/lib/output/events";
import { waitForCertificates } from "./certWait";
import type { HttpsAnswer, NoAnswerKind } from "./https";
import type { LocalDns } from "./localDns";

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

const ANSWERS: HttpsAnswer = { answered: true, status: 200, access: false };
const noAnswer = (kind: NoAnswerKind): HttpsAnswer => ({ answered: false, reason: kind, kind });

function recorder() {
  const events: any[] = [];
  return { events, out: createNdjsonSink((line) => events.push(JSON.parse(line))) };
}

const waitingLines = (events: any[]) =>
  events.filter((e) => e.type === "progress" && e.message.startsWith("Waiting"));

/** This computer's resolver: `missing` hostnames fail the way `code` says. */
function localDns(missing: string[], code = "ENOTFOUND", ttl: number | null = 1800): LocalDns & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (hostname) => {
      asked.push(hostname);
      if (missing.includes(hostname)) {
        throw Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code });
      }
      return [{ address: "104.21.21.211", family: 4 }];
    },
    negativeCacheTtlSeconds: async () => ttl,
  };
}

describe("waitForCertificates", () => {
  it("probes at once and waits for every new hostname, saying so every 15 seconds", async () => {
    const { events, out } = recorder();
    const time = clock();
    const readyAt: Record<string, number> = {
      "https://a.apps.example.com/": 40_000,
      "https://b.apps.example.com/": 70_000,
    };
    const probed: number[] = [];

    const result = await waitForCertificates({
      hosts: ["a.apps.example.com", "b.apps.example.com", "a.apps.example.com"],
      out,
      step: "app.tls",
      probe: async (url) => {
        probed.push(time.now());
        return time.now() >= readyAt[url]! ? ANSWERS : noAnswer("tls");
      },
      ...time,
    });

    expect(result).toEqual({
      ready: ["a.apps.example.com", "b.apps.example.com"],
      pending: [],
      staleLocally: [],
    });
    // No pause before the first probe: the zone's nameservers serve the new
    // record at once. (This replaced a 3 s pause, and progress at 3 s, 18 s, ...)
    expect(probed[0]).toBe(0);
    // At 0 s, 15 s, 30 s, then (a ready at 42 s) 45 s, 60 s.
    expect(waitingLines(events).map((e) => e.data.waitedMs)).toEqual([0, 15_000, 30_000, 45_000, 60_000]);
    expect(waitingLines(events)[0].message).toBe(
      "Waiting for certificates: a.apps.example.com, b.apps.example.com (0s so far; usually under five minutes)...",
    );
    expect(waitingLines(events).at(-1).message).toBe(
      "Waiting for a certificate: b.apps.example.com (1m 00s so far; usually under five minutes)...",
    );
    expect(events.filter((e) => e.message?.endsWith("has its certificate."))).toHaveLength(2);
  });

  it("says what each hostname waits for, from its last probe", async () => {
    const { events, out } = recorder();
    const kinds: Record<string, NoAnswerKind> = {
      "https://gw.example.com/": "dns",
      "https://todo.apps.example.com/": "tls",
      "https://chef.apps.example.com/": "other",
    };

    await waitForCertificates({
      hosts: ["gw.example.com", "todo.apps.example.com", "chef.apps.example.com"],
      out,
      step: "gateway.tls",
      maxWaitMs: 1,
      probe: async (url) => noAnswer(kinds[url]!),
      ...clock(),
    });

    expect(waitingLines(events)[0]).toMatchObject({
      message:
        "Waiting for a certificate: todo.apps.example.com; Waiting for DNS: gw.example.com has no record at the zone's nameservers yet; Waiting for https://chef.apps.example.com to answer (0s so far; usually under five minutes)...",
      data: {
        waitingFor: {
          "gw.example.com": "dns",
          "todo.apps.example.com": "tls",
          "chef.apps.example.com": "other",
        },
      },
    });
  });

  it("gives up with a warning after the limit, failing nothing", async () => {
    const { events, out } = recorder();

    const result = await waitForCertificates({
      hosts: ["todo.apps.example.com"],
      out,
      step: "app.tls",
      probe: async () => noAnswer("tls"),
      ...clock(),
    });

    expect(result).toEqual({ ready: [], pending: ["todo.apps.example.com"], staleLocally: [] });
    expect(events.at(-1)).toMatchObject({
      type: "warning",
      code: "CERT_PENDING",
      message: expect.stringContaining("10m 00s"),
    });
    expect(out.exitCode).toBe(0);
  });

  it("warns when this computer still remembers a ready hostname as missing, failing nothing", async () => {
    const { events, out } = recorder();
    const dns = localDns(["everyapp.example.com"]);

    const result = await waitForCertificates({
      hosts: ["everyapp.example.com", "todo.everyapp.example.com"],
      out,
      step: "gateway.tls",
      probe: async () => ANSWERS,
      localDns: dns,
      ...clock(),
    });

    expect(result).toEqual({
      ready: ["everyapp.example.com", "todo.everyapp.example.com"],
      pending: [],
      staleLocally: ["everyapp.example.com"],
    });
    expect(dns.asked).toEqual(["everyapp.example.com", "todo.everyapp.example.com"]);
    const stale = events.filter((e) => e.code === "LOCAL_DNS_STALE");
    expect(stale).toEqual([
      expect.objectContaining({
        type: "warning",
        step: "gateway.tls",
        data: { host: "everyapp.example.com", negativeCacheTtlSeconds: 1800 },
      }),
    ]);
    expect(stale[0].message).toBe(
      "https://everyapp.example.com has its certificate and the gateway serves it, but this computer's DNS resolver, or this network's, still remembers everyapp.example.com as missing from before it existed. That clears by itself within 30 minutes; a browser with its own DNS, such as Chrome, works now. On macOS, `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` clears this computer's own cache, but not the network's.",
    );
    expect(out.exitCode).toBe(0);
  });

  it.each([
    [1801, "within 31 minutes"],
    [45, "within a minute"],
    [null, "within half an hour"],
  ])("rounds the remembered answer's lifetime up to minutes: %s s", async (ttl, says) => {
    const { events, out } = recorder();

    await waitForCertificates({
      hosts: ["everyapp.example.com"],
      out,
      step: "gateway.tls",
      probe: async () => ANSWERS,
      localDns: localDns(["everyapp.example.com"], "ENOTFOUND", ttl),
      ...clock(),
    });

    expect(events.find((e) => e.code === "LOCAL_DNS_STALE").message).toContain(`clears by itself ${says};`);
  });

  it.each(["ENODATA", "EAI_AGAIN", "EAI_NONAME"])("takes %s from this computer's resolver for a remembered miss", async (code) => {
    const { events, out } = recorder();

    await waitForCertificates({
      hosts: ["everyapp.example.com"],
      out,
      step: "gateway.tls",
      probe: async () => ANSWERS,
      localDns: localDns(["everyapp.example.com"], code),
      ...clock(),
    });

    expect(events.map((e) => e.code)).toContain("LOCAL_DNS_STALE");
  });

  it("doesn't warn when this computer resolves it, or fails for another reason", async () => {
    const { events, out } = recorder();

    await waitForCertificates({
      hosts: ["everyapp.example.com", "todo.everyapp.example.com"],
      out,
      step: "gateway.tls",
      probe: async () => ANSWERS,
      localDns: localDns(["todo.everyapp.example.com"], "ECONNREFUSED"),
      ...clock(),
    });

    expect(events.filter((e) => e.type === "warning")).toEqual([]);
  });

  it("asks this computer nothing with a fake probe and no resolver", async () => {
    const { events, out } = recorder();

    await expect(
      waitForCertificates({
        hosts: ["everyapp.example.com"],
        out,
        step: "gateway.tls",
        probe: async () => ANSWERS,
        ...clock(),
      }),
    ).resolves.toEqual({ ready: ["everyapp.example.com"], pending: [], staleLocally: [] });
    expect(events.filter((e) => e.type === "warning")).toEqual([]);
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
    ).resolves.toEqual({ ready: [], pending: [], staleLocally: [] });
    expect(slept).toBe(false);
  });
});
