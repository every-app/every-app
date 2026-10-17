import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthoritativeDns, type AuthoritativeDnsDeps } from "./authoritativeDns";

const PUBLIC = "1.1.1.1,1.0.0.1";
const NAMESERVERS = "172.64.33.1,173.245.59.1";

function dnsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`query ${code}`), { code });
}

type Records = Record<string, string[] | string>;

/**
 * Cloudflare's public resolver and the zone's nameservers, as fakes: a
 * record list answers, a string is the error code a query fails with, and
 * a name with neither has no such record (ENODATA). `silent` lists the
 * servers ("public", "zone") that drop every query: it never settles
 * until the resolver is cancelled.
 */
function fakeDns({
  ns = { "example.com": ["ns1.cloudflare.example", "ns2.cloudflare.example"] },
  nsAddresses = {
    "ns1.cloudflare.example": ["172.64.33.1"],
    "ns2.cloudflare.example": ["173.245.59.1"],
  },
  a = { "todo.apps.example.com": ["104.21.21.211", "172.67.200.90"] },
  aaaa = { "todo.apps.example.com": ["2606:4700:3036::6815:15d3"] },
  soa = { "example.com": 1800 } as Record<string, number | string>,
  publicDown,
  silent = [],
  os = async () => [{ address: "198.51.100.7", family: 4 }],
}: {
  ns?: Records;
  nsAddresses?: Records;
  a?: Records;
  aaaa?: Records;
  soa?: Record<string, number | string>;
  publicDown?: string;
  silent?: ("public" | "zone")[];
  os?: AuthoritativeDnsDeps["osLookup"];
} = {}) {
  const queries: string[] = [];
  const resolved: string[] = [];
  const created: string[] = [];
  const cancelled: string[] = [];
  const answer = async (records: Records, name: string) => {
    const record = records[name];
    if (typeof record === "string") throw dnsError(record);
    if (!record) throw dnsError("ENODATA");
    return record;
  };
  const deps: AuthoritativeDnsDeps = {
    createResolver: (servers) => {
      const at = servers.join(",");
      const who = at === PUBLIC ? "public" : at === NAMESERVERS ? "zone" : at;
      created.push(who);
      const dropped: (() => void)[] = [];
      const ask = async (type: string, name: string) => {
        queries.push(`${who} ${type} ${name}`);
        if (silent.includes(who as "public" | "zone")) {
          await new Promise((_resolve, reject) => dropped.push(() => reject(dnsError("ECANCELLED"))));
        }
        if (at === PUBLIC && publicDown) throw dnsError(publicDown);
      };
      return {
        resolveNs: async (name) => {
          await ask("NS", name);
          return answer(at === PUBLIC ? ns : {}, name);
        },
        resolve4: async (name) => {
          await ask("A", name);
          return answer(at === PUBLIC ? nsAddresses : a, name);
        },
        resolve6: async (name) => {
          await ask("AAAA", name);
          return answer(at === PUBLIC ? {} : aaaa, name);
        },
        resolveSoa: async (name) => {
          await ask("SOA", name);
          const minttl = soa[name];
          if (typeof minttl === "string") throw dnsError(minttl);
          if (minttl === undefined) throw dnsError("ENODATA");
          return { minttl };
        },
        cancel: () => {
          cancelled.push(who);
          for (const drop of dropped.splice(0)) drop();
        },
      };
    },
    osLookup: async (hostname) => {
      resolved.push(hostname);
      return os(hostname);
    },
  };
  return { deps, queries, resolved, created, cancelled };
}

/** `lookup` as a promise of the callback's arguments. */
function lookupWith(
  lookup: ReturnType<typeof createAuthoritativeDns>["lookup"],
  hostname: string,
  options?: Parameters<typeof lookup>[1],
): Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve) => {
    const callback = (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => resolve({ error, address, family });
    if (options === undefined) lookup(hostname, callback);
    else lookup(hostname, options, callback);
  });
}

describe("the authoritative lookup", () => {
  it("finds the zone by walking up the name, and asks its nameservers for A and AAAA", async () => {
    const dns = fakeDns();
    const { lookup } = createAuthoritativeDns(dns.deps);

    await expect(lookupWith(lookup, "todo.apps.example.com", { all: true })).resolves.toEqual({
      error: null,
      address: [
        { address: "104.21.21.211", family: 4 },
        { address: "172.67.200.90", family: 4 },
        { address: "2606:4700:3036::6815:15d3", family: 6 },
      ],
      family: undefined,
    });
    expect(dns.queries).toEqual([
      "public NS todo.apps.example.com",
      "public NS apps.example.com",
      "public NS example.com",
      "public A ns1.cloudflare.example",
      "public A ns2.cloudflare.example",
      "zone A todo.apps.example.com",
      "zone AAAA todo.apps.example.com",
    ]);
    expect(dns.resolved).toEqual([]);
  });

  it("keeps net's lookup contract: one address, all of them, one family", async () => {
    const { lookup } = createAuthoritativeDns(fakeDns().deps);
    const host = "todo.apps.example.com";

    await expect(lookupWith(lookup, host)).resolves.toEqual({
      error: null,
      address: "104.21.21.211",
      family: 4,
    });
    await expect(lookupWith(lookup, host, {})).resolves.toMatchObject({
      address: "104.21.21.211",
      family: 4,
    });
    await expect(lookupWith(lookup, host, { family: 6 })).resolves.toEqual({
      error: null,
      address: "2606:4700:3036::6815:15d3",
      family: 6,
    });
    await expect(lookupWith(lookup, host, 6)).resolves.toMatchObject({ family: 6 });
    await expect(lookupWith(lookup, host, { family: "IPv6" })).resolves.toMatchObject({
      family: 6,
    });
    await expect(lookupWith(lookup, host, { family: 4, all: true })).resolves.toMatchObject({
      address: [
        { address: "104.21.21.211", family: 4 },
        { address: "172.67.200.90", family: 4 },
      ],
    });
  });

  it("fails with ENOTFOUND for a family the name has no address in", async () => {
    const { lookup } = createAuthoritativeDns(fakeDns({ aaaa: {} }).deps);

    const { error } = await lookupWith(lookup, "todo.apps.example.com", { family: 6 });

    expect(error).toMatchObject({ code: "ENOTFOUND" });
  });

  it("fails with ENOTFOUND, and asks no one else, when the zone's nameservers have no record yet", async () => {
    const dns = fakeDns({ a: {}, aaaa: {} });
    const { lookup } = createAuthoritativeDns(dns.deps);

    const { error } = await lookupWith(lookup, "todo.apps.example.com", { all: true });

    expect(error).toMatchObject({
      code: "ENOTFOUND",
      message: expect.stringContaining("no address at its zone's nameservers"),
    });
    expect(dns.resolved).toEqual([]);
  });

  it("goes on with one family when the other's query fails", async () => {
    const { lookup } = createAuthoritativeDns(fakeDns({ aaaa: { "todo.apps.example.com": "ETIMEOUT" } }).deps);

    await expect(lookupWith(lookup, "todo.apps.example.com", { all: true })).resolves.toMatchObject({
      address: [
        { address: "104.21.21.211", family: 4 },
        { address: "172.67.200.90", family: 4 },
      ],
    });
  });

  it.each([
    ["no network, or UDP 53 blocked", { publicDown: "ECONNREFUSED" }],
    ["the public resolver times out", { publicDown: "ETIMEOUT" }],
    ["no zone found", { ns: {} }],
    ["a zone lookup that fails", { ns: { "todo.apps.example.com": "ESERVFAIL" } }],
    ["nameservers without an address", { nsAddresses: {} }],
    [
      "nameservers that don't answer",
      {
        a: { "todo.apps.example.com": "ETIMEOUT" },
        aaaa: { "todo.apps.example.com": "ECONNREFUSED" },
      },
    ],
  ])("falls back to the operating system's resolver: %s", async (_case, setup) => {
    const dns = fakeDns(setup);
    const { lookup } = createAuthoritativeDns(dns.deps);

    await expect(lookupWith(lookup, "todo.apps.example.com")).resolves.toEqual({
      error: null,
      address: "198.51.100.7",
      family: 4,
    });
    expect(dns.resolved).toEqual(["todo.apps.example.com"]);
  });

  it("passes the operating system's failure on as it is", async () => {
    const { lookup } = createAuthoritativeDns(
      fakeDns({
        publicDown: "ECONNREFUSED",
        os: async (hostname) => {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        },
      }).deps,
    );

    const { error } = await lookupWith(lookup, "todo.apps.example.com");

    expect(error).toMatchObject({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND todo.apps.example.com" });
  });

  it("finds each zone's nameservers once per process", async () => {
    const dns = fakeDns({
      a: { "todo.apps.example.com": ["104.21.21.211"], "chef.apps.example.com": ["104.21.21.212"] },
    });
    const { lookup } = createAuthoritativeDns(dns.deps);

    await lookupWith(lookup, "todo.apps.example.com");
    await lookupWith(lookup, "todo.apps.example.com");
    await lookupWith(lookup, "chef.apps.example.com");

    expect(dns.queries.filter((query) => query.startsWith("public"))).toEqual([
      "public NS todo.apps.example.com",
      "public NS apps.example.com",
      "public NS example.com",
      "public A ns1.cloudflare.example",
      "public A ns2.cloudflare.example",
      "public NS chef.apps.example.com",
      "public NS apps.example.com",
    ]);
    expect(dns.queries.filter((query) => query === "zone A todo.apps.example.com")).toHaveLength(2);
  });

  it("builds one resolver per server list, however many questions it asks", async () => {
    const dns = fakeDns({
      a: { "todo.apps.example.com": ["104.21.21.211"], "chef.apps.example.com": ["104.21.21.212"] },
    });
    const { lookup, negativeCacheTtlSeconds } = createAuthoritativeDns(dns.deps);

    await lookupWith(lookup, "todo.apps.example.com");
    await lookupWith(lookup, "chef.apps.example.com");
    await negativeCacheTtlSeconds("todo.apps.example.com");
    await lookupWith(lookup, "todo.apps.example.com");

    expect(dns.created).toEqual(["public", "zone"]);
  });

  it("answers an IP address as it is, asking no one", async () => {
    const dns = fakeDns();
    const { lookup } = createAuthoritativeDns(dns.deps);

    await expect(lookupWith(lookup, "192.0.2.1")).resolves.toEqual({
      error: null,
      address: "192.0.2.1",
      family: 4,
    });
    expect(dns.queries).toEqual([]);
  });

  it("calls back once, after it returns, never throwing", async () => {
    const { lookup } = createAuthoritativeDns(
      fakeDns({
        publicDown: "ECONNREFUSED",
        os: () => {
          throw new Error("the resolver broke");
        },
      }).deps,
    );
    const calls: unknown[] = [];
    let returned = false;

    expect(() =>
      lookup("todo.apps.example.com", {}, (error) => {
        calls.push({ message: error?.message, returned });
      }),
    ).not.toThrow();
    returned = true;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toEqual([{ message: "the resolver broke", returned: true }]);
  });
});

describe("negativeCacheTtlSeconds", () => {
  it("is the SOA minimum at the zone's nameservers", async () => {
    const dns = fakeDns();
    const { negativeCacheTtlSeconds } = createAuthoritativeDns(dns.deps);

    await expect(negativeCacheTtlSeconds("todo.apps.example.com")).resolves.toBe(1800);
    expect(dns.queries.at(-1)).toBe("zone SOA example.com");
  });

  it("is null when it can't be learnt", async () => {
    await expect(
      createAuthoritativeDns(fakeDns({ publicDown: "ECONNREFUSED" }).deps).negativeCacheTtlSeconds(
        "todo.apps.example.com",
      ),
    ).resolves.toBeNull();
    await expect(
      createAuthoritativeDns(fakeDns({ soa: { "example.com": "ETIMEOUT" } }).deps).negativeCacheTtlSeconds(
        "todo.apps.example.com",
      ),
    ).resolves.toBeNull();
  });
});

describe("on a network that drops DNS packets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Calls back on the operating system's answer at the path's deadline, not before. */
  async function fallsBackAtTheDeadline(
    lookup: ReturnType<typeof createAuthoritativeDns>["lookup"],
  ) {
    const answer = lookupWith(lookup, "todo.apps.example.com");
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ error: null, address: "198.51.100.7", family: 4 });
  }

  it("gives up on a public resolver that never answers at the deadline, and never asks it again", async () => {
    vi.useFakeTimers();
    const dns = fakeDns({ silent: ["public"] });
    const { lookup, negativeCacheTtlSeconds } = createAuthoritativeDns(dns.deps);

    await fallsBackAtTheDeadline(lookup);
    expect(dns.cancelled).toEqual(["public"]);
    expect(dns.resolved).toEqual(["todo.apps.example.com"]);

    const queriesBefore = dns.queries.length;
    await expect(lookupWith(lookup, "todo.apps.example.com")).resolves.toMatchObject({
      address: "198.51.100.7",
    });
    await expect(negativeCacheTtlSeconds("todo.apps.example.com")).resolves.toBeNull();
    expect(dns.queries).toHaveLength(queriesBefore);
    expect(dns.resolved).toEqual(["todo.apps.example.com", "todo.apps.example.com"]);
  });

  it("gives up on zone nameservers that never answer at the deadline, and never asks them again", async () => {
    vi.useFakeTimers();
    const dns = fakeDns({ silent: ["zone"] });
    const { lookup } = createAuthoritativeDns(dns.deps);

    await fallsBackAtTheDeadline(lookup);
    expect(dns.cancelled).toEqual(["public", "zone"]);

    const queriesBefore = dns.queries.length;
    await lookupWith(lookup, "todo.apps.example.com");
    expect(dns.queries).toHaveLength(queriesBefore);
    expect(dns.resolved).toEqual(["todo.apps.example.com", "todo.apps.example.com"]);
  });

  it("keeps asking servers that have answered before when one question runs out of time", async () => {
    vi.useFakeTimers();
    const silent: ("public" | "zone")[] = [];
    const dns = fakeDns({ silent });
    const { lookup } = createAuthoritativeDns(dns.deps);
    await lookupWith(lookup, "todo.apps.example.com");

    silent.push("zone");
    await fallsBackAtTheDeadline(lookup);
    silent.pop();

    await expect(lookupWith(lookup, "todo.apps.example.com")).resolves.toMatchObject({
      address: "104.21.21.211",
    });
    expect(dns.resolved).toEqual(["todo.apps.example.com"]);
  });
});
