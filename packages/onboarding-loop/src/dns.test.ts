import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  createAuthoritativeDns,
  zoneCandidates,
  type DnsDeps,
  type DnsResolverLike,
} from "./dns";

const noRecord = (code: "ENODATA" | "ENOTFOUND") =>
  Object.assign(new Error(code), { code });

/** A fake network: NS records by zone, nameserver addresses, and A/AAAA records per server set. */
function fakeDeps(options: {
  ns?: Record<string, string[]>;
  nsAddresses?: Record<string, string[]>;
  records?: Record<string, { a?: string[]; aaaa?: string[] }>;
  soaMinTtl?: number;
  system?: Record<string, LookupAddress[] | "ENOTFOUND">;
}): DnsDeps & { asked: string[][] } {
  const asked: string[][] = [];
  const createResolver = (servers: string[]): DnsResolverLike => {
    asked.push(servers);
    const authoritative = !servers.includes("1.1.1.1");
    return {
      resolveNs: async (name) => {
        if (authoritative) throw noRecord("ENOTFOUND");
        const names = options.ns?.[name];
        if (!names) throw noRecord("ENOTFOUND");
        return names;
      },
      resolve4: async (name) => {
        if (!authoritative) {
          const ips = options.nsAddresses?.[name];
          if (!ips) throw noRecord("ENOTFOUND");
          return ips;
        }
        const a = options.records?.[name]?.a;
        if (!a) throw noRecord("ENODATA");
        return a;
      },
      resolve6: async (name) => {
        const aaaa = options.records?.[name]?.aaaa;
        if (!aaaa) throw noRecord("ENODATA");
        return aaaa;
      },
      resolveSoa: async () => ({ minttl: options.soaMinTtl ?? 1800 }),
      cancel: () => undefined,
    };
  };
  const osLookup = async (hostname: string): Promise<LookupAddress[]> => {
    const answer = options.system?.[hostname];
    if (!answer || answer === "ENOTFOUND") throw noRecord("ENOTFOUND");
    return answer;
  };
  return { createResolver, osLookup, asked };
}

const zone = {
  ns: {
    "everyapp-loop1.com": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
  },
  nsAddresses: {
    "ada.ns.cloudflare.com": ["173.245.58.1"],
    "bob.ns.cloudflare.com": ["173.245.59.1"],
  },
  records: {
    "apps.everyapp-loop1.com": { a: ["104.21.1.1"], aaaa: ["2606:4700::1"] },
  },
};

describe("dns", () => {
  it("lists the name and its parents as zone candidates", () => {
    expect(zoneCandidates("hello.apps.everyapp-loop1.com.")).toEqual([
      "hello.apps.everyapp-loop1.com",
      "apps.everyapp-loop1.com",
      "everyapp-loop1.com",
    ]);
  });

  it("finds the zone through 1.1.1.1, then asks its nameservers for the host", async () => {
    const deps = fakeDeps(zone);
    const dns = createAuthoritativeDns(deps);
    const answer = await dns.resolve("apps.everyapp-loop1.com");
    expect(answer).toEqual({
      hostname: "apps.everyapp-loop1.com",
      zone: "everyapp-loop1.com",
      nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      addresses: [
        { address: "104.21.1.1", family: 4 },
        { address: "2606:4700::1", family: 6 },
      ],
    });
    expect(deps.asked[0]).toEqual(["1.1.1.1", "1.0.0.1"]);
    expect(deps.asked.at(-1)).toEqual(["173.245.58.1", "173.245.59.1"]);
    // The zone is remembered: the next host asks only the nameservers.
    const before = deps.asked.length;
    await dns.resolve("apps.everyapp-loop1.com");
    expect(deps.asked.length).toBe(before + 1);
  });

  it("no record at the zone is ENOTFOUND, an answer; no zone at all is an error", async () => {
    const dns = createAuthoritativeDns(fakeDeps(zone));
    await expect(dns.resolve("nope.everyapp-loop1.com")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
    await expect(dns.resolve("apps.unknown.example")).rejects.toThrow(
      /No zone found/,
    );
  });

  it("lookup has dns.lookup's shape, with all: true and without, and falls back to the system on a path failure", async () => {
    const dns = createAuthoritativeDns(
      fakeDeps({
        ...zone,
        system: {
          "apps.unknown.example": [{ address: "192.0.2.9", family: 4 }],
        },
      }),
    );
    const one = await new Promise<[string, number | undefined]>(
      (resolve, reject) =>
        dns.lookup("apps.everyapp-loop1.com", 4, (error, address, family) =>
          error ? reject(error) : resolve([address as string, family]),
        ),
    );
    expect(one).toEqual(["104.21.1.1", 4]);
    const all = await new Promise<LookupAddress[]>((resolve, reject) =>
      dns.lookup(
        "apps.everyapp-loop1.com",
        { all: true },
        (error, addresses) =>
          error ? reject(error) : resolve(addresses as LookupAddress[]),
      ),
    );
    expect(all).toHaveLength(2);
    const fallback = await new Promise<string>((resolve, reject) =>
      dns.lookup("apps.unknown.example", (error, address) =>
        error ? reject(error) : resolve(address as string),
      ),
    );
    expect(fallback).toBe("192.0.2.9");
    await expect(
      new Promise((resolve, reject) =>
        dns.lookup("nope.everyapp-loop1.com", (error, address) =>
          error ? reject(error) : resolve(address),
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("names the negative-cache state: the zone answers, the system says NXDOMAIN", async () => {
    const dns = createAuthoritativeDns(
      fakeDeps({
        ...zone,
        system: {
          "apps.everyapp-loop1.com": "ENOTFOUND",
          "nope.everyapp-loop1.com": "ENOTFOUND",
        },
      }),
    );
    expect(await dns.compareWithSystem("apps.everyapp-loop1.com")).toBe(
      "system_nxdomain",
    );
    expect(await dns.compareWithSystem("nope.everyapp-loop1.com")).toBe(
      "authoritative_nxdomain",
    );
    const same = createAuthoritativeDns(
      fakeDeps({
        ...zone,
        system: {
          "apps.everyapp-loop1.com": [{ address: "104.21.1.1", family: 4 }],
        },
      }),
    );
    expect(await same.compareWithSystem("apps.everyapp-loop1.com")).toBe(
      "same",
    );
    expect(await same.compareWithSystem("apps.unknown.example")).toBe(
      "unavailable",
    );
  });

  it("reads the zone's SOA minimum, null when the zone can't be found", async () => {
    const dns = createAuthoritativeDns(fakeDeps({ ...zone, soaMinTtl: 1800 }));
    expect(await dns.negativeCacheTtlSeconds("apps.everyapp-loop1.com")).toBe(
      1800,
    );
    expect(
      await dns.negativeCacheTtlSeconds("apps.unknown.example"),
    ).toBeNull();
  });
});
