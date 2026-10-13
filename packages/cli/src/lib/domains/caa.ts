/**
 * Whether CAA records let Cloudflare issue a Custom Domain's certificate.
 *
 * Each Workers Custom Domain gets its own certificate, from one of the
 * certificate authorities Cloudflare uses (CLOUDFLARE_CAS). Cloudflare adds
 * CAA records for its Universal SSL certificates by itself, not for these,
 * so CAA records that allow only another CA would leave a new app's
 * hostname without a certificate. The records are read from Cloudflare's
 * public DNS-over-HTTPS resolver (no Cloudflare credentials involved). The
 * closest CAA record set applies, climbing from the hostname up to, but
 * not including, the DNS root (RFC 8659, section 3): past the zone's apex
 * too, so a parent domain's records govern a subdomain zone without any.
 */

/**
 * The CAs Cloudflare issues a Workers Custom Domain's certificate from, as
 * CAA `issue` records name them. A Custom Domain gets an Advanced
 * Certificate with default settings
 * (https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
 * which Let's Encrypt, Google Trust Services or SSL.com issue; Sectigo only
 * issues Cloudflare's backup certificates, so a record for it alone doesn't
 * do (https://developers.cloudflare.com/ssl/reference/certificate-authorities/).
 * Cloudflare adds no CAA records for Advanced Certificates by itself
 * (https://developers.cloudflare.com/ssl/edge-certificates/caa-records/).
 */
const CLOUDFLARE_CAS = ["letsencrypt.org", "pki.goog", "ssl.com"];

/**
 * `issue` parameters that narrow what an allowed CA may issue (RFC 8657):
 * only for one ACME account, or by some validation methods. Whether they
 * match Cloudflare's account and method can't be told from here, so a CA
 * allowed only with them may or may not issue.
 */
const NARROWING_PARAMETERS = ["accounturi", "validationmethods"];

/** Property tags a CA understands; a critical record with any other blocks issuance. */
const KNOWN_TAGS = new Set([
  "issue",
  "issuewild",
  "issuemail",
  "iodef",
  "contactemail",
  "contactphone",
]);

interface CaaRecord {
  flags: number;
  tag: string;
  value: string;
}

/** The CAA records at exactly `name` (none: []), or null when it can't be told. */
export type CaaLookup = (name: string) => Promise<CaaRecord[] | null>;

type CaaCheck =
  | { status: "ok" }
  | { status: "blocked"; at: string; issuers: string[] }
  /** Cloudflare's CAs are allowed only with `parameters` it may not meet. */
  | { status: "narrowed"; at: string; issuers: string[]; parameters: string[] }
  | { status: "unknown"; at: string };

const CAA_TYPE = 257;
const DOH_TIMEOUT_MS = 5_000;

/** Ask Cloudflare's DNS-over-HTTPS resolver (1.1.1.1). */
export function dohCaaLookup(fetchImpl: typeof fetch = fetch): CaaLookup {
  return async (name) => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", name);
    url.searchParams.set("type", "CAA");
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        Status?: number;
        Answer?: Array<{ type?: number; data?: string }>;
      };
      // NXDOMAIN: no such name, so no records at it.
      if (body.Status === 3) return [];
      if (body.Status !== 0) return null;
      const records: CaaRecord[] = [];
      for (const answer of body.Answer ?? []) {
        if (answer.type !== CAA_TYPE || typeof answer.data !== "string") continue;
        const record = parseCaaData(answer.data);
        if (!record) return null;
        records.push(record);
      }
      return records;
    } catch {
      return null;
    }
  };
}

/**
 * One record's data, in presentation form (`0 issue "letsencrypt.org"`)
 * or RFC 3597's generic form (`\# 22 00 05 69 73 73 75 65 …`), which some
 * resolvers answer with.
 */
export function parseCaaData(data: string): CaaRecord | null {
  const generic = /^\\#\s+(\d+)\s+([0-9a-f\s]*)$/i.exec(data.trim());
  if (generic) {
    const hex = generic[2]!.replace(/\s+/g, "");
    if (hex.length !== Number(generic[1]) * 2 || hex.length < 4) return null;
    const bytes = Buffer.from(hex, "hex");
    const tagLength = bytes[1]!;
    if (bytes.length < 2 + tagLength) return null;
    return {
      flags: bytes[0]!,
      tag: bytes.subarray(2, 2 + tagLength).toString("latin1").toLowerCase(),
      value: bytes.subarray(2 + tagLength).toString("latin1"),
    };
  }
  const presentation = /^(\d+)\s+([a-z0-9]+)\s+(.*)$/i.exec(data.trim());
  if (!presentation) return null;
  const raw = presentation[3]!.trim();
  return {
    flags: Number(presentation[1]),
    tag: presentation[2]!.toLowerCase(),
    value:
      raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
        ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
        : raw,
  };
}

/**
 * The CA an `issue` value names (`letsencrypt.org; accounturi=…`; "" for
 * none), and the names of its parameters.
 */
function parseIssue(value: string): { issuer: string; parameters: string[] } {
  const [issuer = "", ...parameters] = value.split(";");
  return {
    issuer: issuer.trim().toLowerCase(),
    parameters: parameters
      .map((parameter) => parameter.split("=")[0]!.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Whether Cloudflare may issue a (non-wildcard) certificate for `host`,
 * from the closest CAA record set at it or above it, up to its top-level
 * domain.
 */
export async function checkCaa(
  host: string,
  lookup: CaaLookup,
  {
    fromParent = false,
  }: {
    /** `host` is known to have no records at all: start above it. */
    fromParent?: boolean;
  } = {},
): Promise<CaaCheck> {
  const labels = host.split(".");
  const names = labels.map((_label, index) => labels.slice(index).join("."));
  if (fromParent) names.shift();
  for (const name of names) {
    const records = await lookup(name);
    if (records === null) return { status: "unknown", at: name };
    if (records.length === 0) continue;

    if (records.some((r) => r.flags & 128 && !KNOWN_TAGS.has(r.tag))) {
      return { status: "blocked", at: name, issuers: [] };
    }
    const issue = records
      .filter((r) => r.tag === "issue")
      .map((r) => parseIssue(r.value));
    // Only issuewild (or iodef) here: non-wildcard certificates are free.
    if (issue.length === 0) return { status: "ok" };
    const cloudflares = issue.filter((entry) =>
      CLOUDFLARE_CAS.includes(entry.issuer),
    );
    const narrowing = (entry: { parameters: string[] }) =>
      entry.parameters.filter((p) => NARROWING_PARAMETERS.includes(p));
    if (cloudflares.some((entry) => narrowing(entry).length === 0)) {
      return { status: "ok" };
    }
    if (cloudflares.length > 0) {
      return {
        status: "narrowed",
        at: name,
        issuers: [...new Set(cloudflares.map((entry) => entry.issuer))],
        parameters: [...new Set(cloudflares.flatMap(narrowing))],
      };
    }
    return {
      status: "blocked",
      at: name,
      issuers: [...new Set(issue.map((entry) => entry.issuer).filter(Boolean))],
    };
  }
  return { status: "ok" };
}

/** The record to add so Cloudflare can issue, for messages. */
export function caaFixHint(at: string): string {
  return `add a CAA record at ${at} allowing one of Cloudflare's certificate authorities, e.g. ${CLOUDFLARE_CAS.map((ca) => `\`0 issue "${ca}"\``).join(" or ")}`;
}
