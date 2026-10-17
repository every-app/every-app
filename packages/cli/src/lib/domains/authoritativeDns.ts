/**
 * Resolving a hostname the CLI just published at its zone's own nameservers,
 * not through this computer's resolver. A resolver on the way (the
 * computer's, the router's, the ISP's) that was asked for the name while
 * it had no record remembers "no such name" for up to the zone's SOA
 * minimum, half an hour on Cloudflare: after a teardown and a reinstall,
 * the probes would wait out that half hour for a hostname that already
 * works. The nameservers that hold the zone never answer from a cache, so
 * they serve a new Custom Domain's record the moment it exists.
 *
 * Any failure on that path (no network, UDP 53 blocked, no zone found,
 * nameservers that don't answer) falls back to the operating system's
 * resolver, exactly what the probes used before. The path has a deadline
 * well inside a probe's 10 s, and servers that fail without ever having
 * answered are not asked again in this process: on a network that drops
 * DNS packets, the first probe pays the deadline once and every later one
 * goes straight to the operating system's resolver.
 */
import dns, { type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { zoneCandidates } from "./hostnames";

/** Cloudflare's public resolver, which finds the zone's nameservers. */
const PUBLIC_RESOLVERS = ["1.1.1.1", "1.0.0.1"];
const QUERY_TIMEOUT_MS = 2_000;
const QUERY_TRIES = 2;
/**
 * The whole authoritative step, zone discovery included. c-ares retries
 * each server in turn with backoff, so 2 s x 2 tries x 2 servers alone
 * runs past the probe's 10 s abort.
 */
const PATH_DEADLINE_MS = 3_000;

/** "This name has no such record": an answer, not a failure. */
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND"]);

/** The part of `dns.promises.Resolver` this uses. */
interface DnsResolver {
  resolveNs(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveSoa(hostname: string): Promise<{ minttl: number }>;
  /** Ends its outstanding queries, which would otherwise hold the process open until they time out. */
  cancel(): void;
}

export interface AuthoritativeDnsDeps {
  /** A resolver that asks only `servers`. */
  createResolver: (servers: string[]) => DnsResolver;
  /** The operating system's resolver, every address. */
  osLookup: (hostname: string) => Promise<LookupAddress[]>;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

type LookupOptions = dns.LookupOptions | number;

/** `net`/`tls`'s `lookup` option: `dns.lookup`'s signature. */
type Lookup = (
  hostname: string,
  options: LookupOptions | LookupCallback,
  callback?: LookupCallback,
) => void;

interface AuthoritativeDns {
  lookup: Lookup;
  /**
   * How long a resolver may remember "no such name" for the hostname's
   * zone (its SOA minimum, at the zone's nameservers), or null when that
   * can't be learnt.
   */
  negativeCacheTtlSeconds: (hostname: string) => Promise<number | null>;
}

const defaultDeps: AuthoritativeDnsDeps = {
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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function notFound(hostname: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    code: "ENOTFOUND",
    hostname,
  });
}

export function createAuthoritativeDns(
  deps: AuthoritativeDnsDeps = defaultDeps,
): AuthoritativeDns {
  /** server list -> its resolver, for this process. */
  const resolvers = new Map<string, DnsResolver>();
  /** Server lists that have answered a query in this process. */
  const answered = new Set<string>();
  /** Server lists that failed before ever answering: not asked again. */
  const unreachable = new Set<string>();
  /** zone name -> its nameservers' addresses, for this process. */
  const nameservers = new Map<string, string[]>();
  /** hostname -> the zone it is in, for this process. */
  const zoneOf = new Map<string, string>();
  const publicServers = PUBLIC_RESOLVERS.join(",");

  /** Records which server lists have answered: a record, or "no such record". */
  function heard<T>(servers: string, query: Promise<T>): Promise<T> {
    return query.then(
      (value) => {
        answered.add(servers);
        return value;
      },
      (error: unknown) => {
        if (NO_RECORD.has(errorCode(error) ?? "")) answered.add(servers);
        throw error;
      },
    );
  }

  function resolverFor(servers: string): DnsResolver {
    if (unreachable.has(servers)) {
      throw new Error(`${servers} didn't answer earlier in this run.`);
    }
    const known = resolvers.get(servers);
    if (known) return known;
    const resolver = deps.createResolver(servers.split(","));
    const tracked: DnsResolver = {
      resolveNs: (name) => heard(servers, resolver.resolveNs(name)),
      resolve4: (name) => heard(servers, resolver.resolve4(name)),
      resolve6: (name) => heard(servers, resolver.resolve6(name)),
      resolveSoa: (name) => heard(servers, resolver.resolveSoa(name)),
      cancel: () => resolver.cancel(),
    };
    resolvers.set(servers, tracked);
    return tracked;
  }

  /** The longest of the name and its parents with NS records. */
  async function findZone(hostname: string): Promise<string> {
    const known = zoneOf.get(hostname);
    if (known) return known;
    const publicResolver = resolverFor(publicServers);
    for (const candidate of zoneCandidates(hostname)) {
      if (!nameservers.has(candidate)) {
        let names: string[];
        try {
          names = await publicResolver.resolveNs(candidate);
        } catch (error) {
          if (NO_RECORD.has(errorCode(error) ?? "")) continue;
          throw error;
        }
        if (names.length === 0) continue;
        const addresses = await Promise.allSettled(
          names.map((name) => publicResolver.resolve4(name)),
        );
        const ips = addresses.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
        if (ips.length === 0) {
          throw new Error(`No address for ${candidate}'s nameservers.`);
        }
        nameservers.set(candidate, [...new Set(ips)]);
      }
      zoneOf.set(hostname, candidate);
      return candidate;
    }
    throw new Error(`No zone found for ${hostname}.`);
  }

  /** The server lists a question about the hostname has gone to so far. */
  function asked(hostname: string): string[] {
    const zone = zoneOf.get(hostname);
    const zoneServers = zone && nameservers.get(zone)?.join(",");
    return zoneServers ? [publicServers, zoneServers] : [publicServers];
  }

  /**
   * Asks the hostname's zone's nameservers through `question`, within the
   * path's deadline. A server list that fails without ever having
   * answered is remembered as unreachable, so the next question skips it.
   */
  async function atZone<T>(
    hostname: string,
    question: (zone: string, resolver: DnsResolver) => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        for (const servers of asked(hostname)) resolvers.get(servers)?.cancel();
        reject(
          new Error(
            `No answer for ${hostname} within ${PATH_DEADLINE_MS / 1000} s.`,
          ),
        );
      }, PATH_DEADLINE_MS);
    });
    const answer = (async () => {
      const zone = await findZone(hostname);
      return question(zone, resolverFor(nameservers.get(zone)!.join(",")));
    })();
    try {
      return await Promise.race([answer, deadline]);
    } catch (error) {
      for (const servers of asked(hostname)) {
        if (!answered.has(servers)) unreachable.add(servers);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The addresses the zone's nameservers give; throws if they can't say. */
  async function zoneAddresses(
    hostname: string,
    resolver: DnsResolver,
  ): Promise<LookupAddress[]> {
    const queries = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    const addresses = queries.flatMap((result, index) =>
      result.status === "fulfilled"
        ? result.value.map((address) => ({
            address,
            family: index === 0 ? 4 : 6,
          }))
        : [],
    );
    if (addresses.length > 0) return addresses;
    // No address and a query that failed: that says nothing about the name.
    const failure = queries.find(
      (result) =>
        result.status === "rejected" &&
        !NO_RECORD.has(errorCode(result.reason) ?? ""),
    );
    if (failure?.status === "rejected") throw failure.reason;
    return addresses;
  }

  /** Every address of the hostname: the zone's answer, else the OS's. */
  async function resolveAddresses(hostname: string): Promise<LookupAddress[]> {
    if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
    let addresses: LookupAddress[];
    try {
      addresses = await atZone(hostname, (_zone, resolver) =>
        zoneAddresses(hostname, resolver),
      );
    } catch {
      return deps.osLookup(hostname);
    }
    if (addresses.length === 0) {
      throw notFound(
        hostname,
        `${hostname} has no address at its zone's nameservers yet`,
      );
    }
    return addresses;
  }

  const lookup: Lookup = (hostname, options, callback) => {
    const done = (typeof options === "function" ? options : callback)!;
    const opts: dns.LookupOptions =
      typeof options === "function"
        ? {}
        : typeof options === "number"
          ? { family: options }
          : (options ?? {});
    const family =
      opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : (opts.family ?? 0);
    // The callback runs outside the promise chain: an exception it throws
    // surfaces as one, rather than calling it a second time with it.
    const settle = (...args: Parameters<LookupCallback>) =>
      process.nextTick(() => done(...args));
    resolveAddresses(hostname).then(
      (all) => {
        const addresses = family ? all.filter((a) => a.family === family) : all;
        const first = addresses[0];
        if (!first) {
          settle(notFound(hostname, `${hostname} has no IPv${family} address`), "");
        } else if (opts.all) {
          settle(null, addresses);
        } else {
          settle(null, first.address, first.family);
        }
      },
      (error: unknown) =>
        settle(
          error instanceof Error
            ? (error as NodeJS.ErrnoException)
            : notFound(hostname, String(error)),
          "",
        ),
    );
  };

  async function negativeCacheTtlSeconds(
    hostname: string,
  ): Promise<number | null> {
    try {
      const minttl = await atZone(hostname, async (zone, resolver) => {
        const soa = await resolver.resolveSoa(zone);
        return soa.minttl;
      });
      return Number.isFinite(minttl) ? minttl : null;
    } catch {
      return null;
    }
  }

  return { lookup, negativeCacheTtlSeconds };
}

const processDns = createAuthoritativeDns();

/** `dns.lookup` for `net`/`tls`, through the zone's nameservers. */
export const lookup = processDns.lookup;

export const negativeCacheTtlSeconds = processDns.negativeCacheTtlSeconds;
