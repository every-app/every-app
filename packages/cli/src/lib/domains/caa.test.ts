import { describe, expect, it } from "vitest";
import { checkCaa, dohCaaLookup, parseCaaData, type CaaLookup } from "./caa";

function lookupFrom(records: Record<string, string[] | null>): CaaLookup & { asked: string[] } {
  const asked: string[] = [];
  const lookup = async (name: string) => {
    asked.push(name);
    const data = records[name];
    if (data === null) return null;
    return (data ?? []).map((line) => parseCaaData(line)!);
  };
  return Object.assign(lookup, { asked });
}

describe("parseCaaData", () => {
  it("reads the presentation form", () => {
    expect(parseCaaData('0 issue "letsencrypt.org"')).toEqual({
      flags: 0,
      tag: "issue",
      value: "letsencrypt.org",
    });
    expect(parseCaaData('128 issuewild ";"')).toEqual({
      flags: 128,
      tag: "issuewild",
      value: ";",
    });
  });

  it("reads RFC 3597's generic form, as some resolvers answer", () => {
    const rdata = Buffer.concat([
      Buffer.from([0, 5]),
      Buffer.from("issue"),
      Buffer.from("pki.goog"),
    ]);
    const hex = rdata.toString("hex").match(/../g)!.join(" ");
    expect(parseCaaData(`\\# ${rdata.length} ${hex}`)).toEqual({
      flags: 0,
      tag: "issue",
      value: "pki.goog",
    });
    expect(parseCaaData("\\# 3 00 05")).toBeNull();
  });
});

describe("checkCaa", () => {
  it("passes a zone without CAA records, or one that allows Cloudflare's CAs", async () => {
    await expect(checkCaa("todo.apps.example.com", lookupFrom({}))).resolves.toEqual({ status: "ok" });
    await expect(
      checkCaa(
        "todo.apps.example.com",
        lookupFrom({
          "example.com": ['0 issue "digicert.com"', '0 issue "pki.goog; cansignhttpexchanges=yes"'],
        }),
      ),
    ).resolves.toEqual({ status: "ok" });
  });

  it("uses the closest record set: one below the zone apex overrides it", async () => {
    const lookup = lookupFrom({
      "apps.example.com": ['0 issue "digicert.com"'],
      "example.com": ['0 issue "letsencrypt.org"'],
    });
    await expect(checkCaa("todo.apps.example.com", lookup)).resolves.toEqual({
      status: "blocked",
      at: "apps.example.com",
      issuers: ["digicert.com"],
    });
    expect(lookup.asked).toEqual(["todo.apps.example.com", "apps.example.com"]);
  });

  it("climbs past the zone apex up to the top-level domain, as RFC 8659 has CAs do", async () => {
    // A subdomain zone (apps.example.com) whose parent domain restricts CAs.
    const lookup = lookupFrom({ "example.com": ['0 issue "digicert.com"'] });
    await expect(checkCaa("todo.apps.example.com", lookup)).resolves.toEqual({
      status: "blocked",
      at: "example.com",
      issuers: ["digicert.com"],
    });

    const none = lookupFrom({});
    await checkCaa("todo.apps.example.com", none);
    expect(none.asked).toEqual(["todo.apps.example.com", "apps.example.com", "example.com", "com"]);
  });

  it("doesn't count Sectigo, which issues only Cloudflare's backup certificates", async () => {
    for (const ca of ["sectigo.com", "comodoca.com"]) {
      await expect(
        checkCaa("todo.example.com", lookupFrom({ "example.com": [`0 issue "${ca}"`] })),
      ).resolves.toEqual({ status: "blocked", at: "example.com", issuers: [ca] });
    }
  });

  it("says issuance may fail when Cloudflare's CAs are allowed only for an ACME account or validation method", async () => {
    await expect(
      checkCaa(
        "todo.example.com",
        lookupFrom({
          "example.com": [
            '0 issue "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/1"',
            '0 issue "pki.goog; validationmethods=dns-01"',
            '0 issue "digicert.com"',
          ],
        }),
      ),
    ).resolves.toEqual({
      status: "narrowed",
      at: "example.com",
      issuers: ["letsencrypt.org", "pki.goog"],
      parameters: ["accounturi", "validationmethods"],
    });
    // One of them without: fine.
    await expect(
      checkCaa(
        "todo.example.com",
        lookupFrom({
          "example.com": ['0 issue "letsencrypt.org; validationmethods=dns-01"', '0 issue "ssl.com"'],
        }),
      ),
    ).resolves.toEqual({ status: "ok" });
  });

  it("blocks an empty issuer list and a critical tag no CA knows", async () => {
    await expect(
      checkCaa("todo.example.com", lookupFrom({ "example.com": ['0 issue ";"'] })),
    ).resolves.toMatchObject({ status: "blocked", issuers: [] });
    await expect(
      checkCaa("todo.example.com", lookupFrom({ "example.com": ['128 tbs "x"'] })),
    ).resolves.toMatchObject({ status: "blocked" });
  });

  it("only restricts wildcard certificates with issuewild alone", async () => {
    await expect(
      checkCaa("todo.example.com", lookupFrom({ "example.com": ['0 issuewild "digicert.com"'] })),
    ).resolves.toEqual({ status: "ok" });
  });

  it("starts above a hostname that has no records yet", async () => {
    const lookup = lookupFrom({});
    await checkCaa("todo.apps.example.com", lookup, { fromParent: true });
    expect(lookup.asked).toEqual(["apps.example.com", "example.com", "com"]);
  });

  it("says when it can't tell", async () => {
    await expect(
      checkCaa("todo.example.com", lookupFrom({ "todo.example.com": null })),
    ).resolves.toEqual({ status: "unknown", at: "todo.example.com" });
  });
});

describe("dohCaaLookup", () => {
  const answer = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it("asks Cloudflare's resolver for CAA records", async () => {
    const urls: string[] = [];
    const lookup = dohCaaLookup((async (url: URL) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: [
            { type: 5, data: "other.example.net." },
            { type: 257, data: '0 issue "letsencrypt.org"' },
          ],
        }),
      };
    }) as unknown as typeof fetch);
    await expect(lookup("example.com")).resolves.toEqual([
      { flags: 0, tag: "issue", value: "letsencrypt.org" },
    ]);
    expect(urls).toEqual(["https://cloudflare-dns.com/dns-query?name=example.com&type=CAA"]);
  });

  it("treats NXDOMAIN as no records and anything else odd as unknown", async () => {
    await expect(dohCaaLookup(answer({ Status: 3 }))("x.example.com")).resolves.toEqual([]);
    await expect(dohCaaLookup(answer({ Status: 2 }))("x.example.com")).resolves.toBeNull();
    await expect(dohCaaLookup(answer({}, false))("x.example.com")).resolves.toBeNull();
    await expect(
      dohCaaLookup(answer({ Status: 0, Answer: [{ type: 257, data: "garbage" }] }))("x.example.com"),
    ).resolves.toBeNull();
    await expect(
      dohCaaLookup((async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch)("x.example.com"),
    ).resolves.toBeNull();
  });
});
