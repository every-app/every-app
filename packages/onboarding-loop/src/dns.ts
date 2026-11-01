/**
 * Authoritative DNS for every host-side probe and the claim (design 4.5,
 * must-fix 6): the zone's own nameservers, found through 1.1.1.1, are asked
 * directly with `node:dns/promises` Resolver, so a hostname published a
 * minute ago answers at once instead of after this Mac's resolver forgets
 * the "no such name" it cached during the previous teardown (Cloudflare's
 * SOA minimum: 30 minutes). `compareWithSystem` names that exact state,
 * `dns_negative_cache`, for the decision table. Same approach as
 * packages/cli's lib/domains/authoritativeDns.ts, without importing it.
 */
import dns, { type LookupAddress } from "node:dns";
import { isIP } from "node:net";

/** Cloudflare's public resolver, which finds the zone's nameservers. */
const PUBLIC_RESOLVERS = ["1.1.1.1", "1.0.0.1"];
const QUERY_TIMEOUT_MS = 2_000;
const QUERY_TRIES = 2;
/** The whole path, zone discovery included. */
const PATH_DEADLINE_MS = 5_000;

/** "This name has no such record": an answer, not a failure. */
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND"]);

export interface DnsResolverLike {
  resolveNs(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveSoa(hostname: string): Promise<{ minttl: number }>;
  cancel(): void;
}

export interface DnsDeps {
  /** A resolver that asks only `servers`. */
  createResolver: (servers: string[]) => DnsResolverLike;
  /** The operating system's resolver, every address. */
  osLookup: (hostname: string) => Promise<LookupAddress[]>;
}

const defaultDnsDeps: DnsDeps = {
  createResolver: (servers) => {
    const resolver = new dns.promises.Resolver({
      timeout: QUERY_TIMEOUT_MS,
      tries: QUERY_TRIES,
    });
    resolver.setServers(servers);
    return resolver;
  },
  osLookup: (hostname) => dns.promises.lookup(hostname, { all: true }),
};

interface AuthoritativeAnswer {
  hostname: string;
  zone: string;
  nameservers: string[];
  addresses: LookupAddress[];
}

type SystemComparison =
  /** Both resolve. */
  | "same"
  /** The zone's nameservers answer, this computer's resolver says NXDOMAIN: the negative cache. */
  | "system_nxdomain"
  /** The zone's nameservers have no record either. */
  | "authoritative_nxdomain"
  /** The authoritative path failed (no network, UDP 53 blocked). */
  | "unavailable";

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
type LookupOptions = dns.LookupOptions | number;
/** `https.request`'s `lookup` option: `dns.lookup`'s signature. */
export type LookupFn = (
  hostname: string,
  options: LookupOptions | LookupCallback,
  callback?: LookupCallback,
) => void;

interface AuthoritativeDns {
  resolve(hostname: string): Promise<AuthoritativeAnswer>;
  /** For `https.request({ lookup })`; falls back to the system resolver when the authoritative path fails. */
  lookup: LookupFn;
  /** The zone's SOA minimum, or null when it can't be learnt. */
  negativeCacheTtlSeconds(hostname: string): Promise<number | null>;
  compareWithSystem(hostname: string): Promise<SystemComparison>;
}

/** The name and each parent that could be a zone: a.b.example.com, b.example.com, example.com. */
export function zoneCandidates(host: string): string[] {
  const labels = host.replace(/\.$/, "").split(".");
  const candidates: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1)
    candidates.push(labels.slice(i).join("."));
  return candidates;
}

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

function notFound(hostname: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`${hostname} has no address at its zone's nameservers.`),
    {
      code: "ENOTFOUND",
      hostname,
    },
  );
}

export function createAuthoritativeDns(
  deps: DnsDeps = defaultDnsDeps,
): AuthoritativeDns {
  /** zone -> its nameservers' addresses, for this process. */
  const nameservers = new Map<string, { names: string[]; ips: string[] }>();
  const publicResolver = deps.createResolver(PUBLIC_RESOLVERS);

  /** The longest of the name and its parents with NS records. */
  async function findZone(hostname: string): Promise<string> {
    for (const candidate of zoneCandidates(hostname)) {
      if (nameservers.has(candidate)) return candidate;
      let names: string[];
      try {
        names = await publicResolver.resolveNs(candidate);
      } catch (error) {
        if (NO_RECORD.has(errorCode(error) ?? "")) continue;
        throw error;
      }
      if (names.length === 0) continue;
      const settled = await Promise.allSettled(
        names.map((name) => publicResolver.resolve4(name)),
      );
      const ips = [
        ...new Set(
          settled.flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
          ),
        ),
      ];
      if (ips.length === 0)
        throw new Error(`No address for ${candidate}'s nameservers.`);
      nameservers.set(candidate, { names, ips });
      return candidate;
    }
    throw new Error(`No zone found for ${hostname}.`);
  }

  async function withDeadline<T>(
    hostname: string,
    work: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `No answer for ${hostname} within ${PATH_DEADLINE_MS / 1000} s.`,
            ),
          ),
        PATH_DEADLINE_MS,
      );
    });
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolve(hostname: string): Promise<AuthoritativeAnswer> {
    if (isIP(hostname)) {
      return {
        hostname,
        zone: "",
        nameservers: [],
        addresses: [{ address: hostname, family: isIP(hostname) }],
      };
    }
    return withDeadline(hostname, async () => {
      const zone = await findZone(hostname);
      const { names, ips } = nameservers.get(zone)!;
      const resolver = deps.createResolver(ips);
      const ask = async (query: () => Promise<string[]>): Promise<string[]> => {
        try {
          return await query();
        } catch (error) {
          if (NO_RECORD.has(errorCode(error) ?? "")) return [];
          throw error;
        }
      };
      try {
        const [v4, v6] = await Promise.all([
          ask(() => resolver.resolve4(hostname)),
          ask(() => resolver.resolve6(hostname)),
        ]);
        const addresses: LookupAddress[] = [
          ...v4.map((address) => ({ address, family: 4 })),
          ...v6.map((address) => ({ address, family: 6 })),
        ];
        if (addresses.length === 0) throw notFound(hostname);
        return { hostname, zone, nameservers: names, addresses };
      } finally {
        resolver.cancel();
      }
    });
  }

  const lookup: LookupFn = (hostname, options, callback) => {
    const done = (typeof options === "function" ? options : callback)!;
    const all =
      typeof options === "object" && options !== null && options.all === true;
    resolve(hostname)
      .then((answer) => answer.addresses)
      .catch(async (error: unknown) => {
        // "No such name" at the zone is an answer; anything else falls back to the system resolver.
        if (errorCode(error) === "ENOTFOUND") throw error;
        return deps.osLookup(hostname);
      })
      .then(
        (addresses) => {
          if (all) done(null, addresses);
          else done(null, addresses[0]!.address, addresses[0]!.family);
        },
        (error: NodeJS.ErrnoException) => done(error, all ? [] : ""),
      );
  };

  return {
    resolve,
    lookup,
    async negativeCacheTtlSeconds(hostname) {
      try {
        return await withDeadline(hostname, async () => {
          const zone = await findZone(hostname);
          const resolver = deps.createResolver(nameservers.get(zone)!.ips);
          try {
            return (await resolver.resolveSoa(zone)).minttl;
          } finally {
            resolver.cancel();
          }
        });
      } catch {
        return null;
      }
    },
    async compareWithSystem(hostname) {
      let authoritative: AuthoritativeAnswer | null;
      try {
        authoritative = await resolve(hostname);
      } catch (error) {
        if (errorCode(error) === "ENOTFOUND") authoritative = null;
        else return "unavailable";
      }
      if (!authoritative) return "authoritative_nxdomain";
      try {
        await deps.osLookup(hostname);
        return "same";
      } catch (error) {
        return NO_RECORD.has(errorCode(error) ?? "")
          ? "system_nxdomain"
          : "unavailable";
      }
    },
  };
}
