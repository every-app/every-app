import { DEFAULT_GATEWAY_NAMES } from "@every-app/perimeter/manifest";
import { describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import { preflightDomains } from "./preflight";

const ZONE = { id: "zone-1", name: "example.com" };

/** `cf workers list`: the Gateway Worker holding `hosts` as Custom Domains. */
const gatewayHolding = (...hosts: string[]) => ({
  stdout: JSON.stringify([
    { id: "w-1", name: "marketing-site", references: { domains: [{ hostname: "www.example.com", zone_id: "zone-1", zone_name: "example.com" }] } },
    { id: "w-2", name: "every-app-gateway", references: { domains: hosts.map((hostname) => ({ hostname, zone_id: "zone-1", zone_name: "example.com" })) } },
  ]),
});

/** The record Cloudflare keeps at a Workers Custom Domain. */
const placeholder = (name: string) => ({ id: `r-${name}`, name, type: "AAAA", content: "100::" });

function run(cf: FakeCf, options: Partial<Parameters<typeof preflightDomains>[0]> = {}) {
  const events: any[] = [];
  const result = preflightDomains({
    cf,
    names: DEFAULT_GATEWAY_NAMES,
    out: createNdjsonSink((line) => events.push(JSON.parse(line))),
    step: "test",
    zone: ZONE,
    domains: ["apps.example.com", "todo.apps.example.com"],
    liveDomains: ["apps.example.com"],
    cfAsks: true,
    ...options,
  });
  return { result, events };
}

describe("preflightDomains", () => {
  it("checks only the hostnames a deploy adds", async () => {
    const cf = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    await expect(run(cf).result).resolves.toEqual(["todo.apps.example.com"]);
    expect(cf.calls.map((call) => call.args)).toEqual([
      ["dns", "records", "list", "-z", "zone-1", "--name-exact", "todo.apps.example.com", "--per-page", "100"],
      // It has none of its own: is it answered by a wildcard?
      ["dns", "records", "list", "-z", "zone-1", "--name-exact", "*.apps.example.com", "--per-page", "100"],
    ]);

    const none = new FakeCf();
    await expect(run(none, { domains: ["apps.example.com"] }).result).resolves.toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it("refuses records a Custom Domain would replace, and leaves mail and TXT records be", async () => {
    const records = (rows: Array<{ type: string; content: string }>) =>
      new FakeCf()
        .on(["dns", "records", "list"], {
          stdout: JSON.stringify(
            rows.map((row, i) => ({ id: `r${i}`, name: "todo.apps.example.com", ...row })),
          ),
        })
        .on(["workers", "list"], gatewayHolding("apps.example.com"));
    await expect(
      run(records([{ type: "MX", content: "mx.example.net" }, { type: "TXT", content: "v=spf1 -all" }])).result,
    ).resolves.toEqual(["todo.apps.example.com"]);
    for (const type of ["A", "AAAA", "CNAME", "NS"]) {
      await expect(run(records([{ type, content: "x" }])).result, type).rejects.toMatchObject({
        code: "DNS_RECORD_CONFLICT",
      });
    }
  });

  it("refuses new hostnames a wildcard answers, like a record of their own", async () => {
    const records: Record<string, Array<{ type: string; content: string }>> = {
      "*.apps.example.com": [{ type: "CNAME", content: "site.example.net" }, { type: "TXT", content: "x" }],
      // Its own record: the wildcard doesn't answer it.
      "chef.apps.example.com": [{ type: "TXT", content: "v=spf1 -all" }],
    };
    const cf = () =>
      new FakeCf()
        .on(["dns", "records", "list"], (call) => {
          const name = call.args[call.args.indexOf("--name-exact") + 1]!;
          return {
            stdout: JSON.stringify((records[name] ?? []).map((row, i) => ({ id: `r${i}`, name, ...row }))),
          };
        })
        .on(["workers", "list"], gatewayHolding("apps.example.com"));
    const domains = ["apps.example.com", "todo.apps.example.com", "notes.apps.example.com", "chef.apps.example.com"];

    const refused = cf();
    await expect(run(refused, { domains }).result).rejects.toMatchObject({
      code: "DNS_RECORD_CONFLICT",
      message: expect.stringContaining(
        "todo.apps.example.com (CNAME site.example.net, through *.apps.example.com); notes.apps.example.com (CNAME site.example.net, through *.apps.example.com).",
      ),
    });
    // The wildcard is read once for both.
    const asked = refused.calls.map((call) => call.args[call.args.indexOf("--name-exact") + 1]);
    expect(asked.filter((name) => name === "*.apps.example.com")).toHaveLength(1);

    // The operator says the names may go.
    const { result, events } = run(cf(), { domains, forceDns: true });
    await expect(result).resolves.toEqual(["todo.apps.example.com", "notes.apps.example.com", "chef.apps.example.com"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "DNS_RECORD_REPLACED",
        message: expect.stringContaining("keeps answering every other name"),
      }),
    );
  });

  it("refuses unless it can read the zone's DNS, or is told to go on", async () => {
    const denied = () =>
      new FakeCf().on(["dns", "records", "list"], {
        exitCode: 1,
        stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
      });
    await expect(run(denied()).result).rejects.toMatchObject({
      code: "DNS_UNREADABLE",
      fix: "give the API token Zone → DNS → Read",
      rerun: expect.stringMatching(/ --force-dns$/),
      authorize: true,
    });
    await expect(run(denied(), { forceDns: true }).result).resolves.toEqual([
      "todo.apps.example.com",
    ]);
  });

  it("takes a record at a hostname that is the Gateway's own Custom Domain as the Gateway's, not a conflict", async () => {
    // A run that stopped after publishing the hostname (a workers.dev
    // subdomain to register) left the Custom Domain, with Cloudflare's
    // placeholder record at the name; the install row never recorded it.
    const byName = (call: { args: string[] }) => {
      const name = call.args[call.args.indexOf("--name-exact") + 1]!;
      return { stdout: JSON.stringify(name.startsWith("*.") ? [] : [placeholder(name)]) };
    };
    const cf = new FakeCf()
      .on(["dns", "records", "list"], byName)
      .on(["workers", "list"], gatewayHolding("apps.example.com", "todo.apps.example.com"));

    const { result, events } = run(cf, {
      domains: ["apps.example.com", "todo.apps.example.com"],
      liveDomains: [],
      cfAsks: false,
    });

    await expect(result).resolves.toEqual(["apps.example.com", "todo.apps.example.com"]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "progress",
        step: "test",
        message: "apps.example.com is already this Gateway's Custom Domain (an earlier run published it, then stopped)",
        data: { host: "apps.example.com" },
      }),
      expect.objectContaining({ type: "progress", data: { host: "todo.apps.example.com" } }),
    ]);
    // The Workers are read once, for both hostnames; nothing is said about
    // another Worker holding them: they are this one's.
    expect(cf.calls.filter((call) => call.args[0] === "workers")).toHaveLength(1);
    expect(events.some((event) => event.code === "CUSTOM_DOMAIN_OWNER_UNCHECKED")).toBe(false);

    // The Gateway holds one of two: the other is still warned about.
    const partly = run(
      new FakeCf()
        .on(["dns", "records", "list"], (call) =>
          call.args.includes("apps.example.com") && !call.args.includes("todo.apps.example.com")
            ? byName(call)
            : { stdout: "[]" },
        )
        .on(["workers", "list"], gatewayHolding("apps.example.com")),
      { domains: ["apps.example.com", "todo.apps.example.com"], liveDomains: [], cfAsks: false },
    );
    await partly.result;
    expect(partly.events).toContainEqual(
      expect.objectContaining({ code: "CUSTOM_DOMAIN_OWNER_UNCHECKED", data: { hosts: ["todo.apps.example.com"] } }),
    );
  });

  it("still refuses the record of another Worker's Custom Domain, and one it can't tell about", async () => {
    const records = { stdout: JSON.stringify([placeholder("todo.apps.example.com")]) };
    // Another Worker's: a record like any other.
    const theirs = new FakeCf()
      .on(["dns", "records", "list"], records)
      .on(["workers", "list"], {
        stdout: JSON.stringify([
          { id: "w-1", name: "marketing-site", references: { domains: [{ hostname: "todo.apps.example.com" }] } },
          { id: "w-2", name: "every-app-gateway", references: { domains: [{ hostname: "apps.example.com" }] } },
        ]),
      });
    await expect(run(theirs).result).rejects.toMatchObject({
      code: "DNS_RECORD_CONFLICT",
      message: "todo.apps.example.com already points somewhere else\nIts DNS record: AAAA 100::. Publishing it replaces the record.",
    });

    // No Gateway Worker at all: the record is somebody's.
    const none = new FakeCf().on(["dns", "records", "list"], records).on(["workers", "list"], { stdout: "[]" });
    await expect(run(none).result).rejects.toMatchObject({ code: "DNS_RECORD_CONFLICT" });

    // A login that can't list the Workers learns nothing: the record stands.
    const denied = new FakeCf().on(["dns", "records", "list"], records).on(["workers", "list"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });
    await expect(run(denied).result).rejects.toMatchObject({ code: "DNS_RECORD_CONFLICT" });

    // With nothing in the way, the Workers aren't read at all.
    const clear = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    await expect(run(clear).result).resolves.toEqual(["todo.apps.example.com"]);
    expect(clear.calls.some((call) => call.args[0] === "workers")).toBe(false);
  });

  it("never takes a hostname another Gateway in the account publishes, even with --force-dns", async () => {
    const records = { stdout: JSON.stringify([placeholder("todo.apps.example.com")]) };
    const workers = {
      stdout: JSON.stringify([
        { id: "w-2", name: "every-app-gateway", references: { domains: [{ hostname: "apps.example.com" }] } },
        { id: "w-3", name: "every-app-gateway-demo", references: { domains: [{ hostname: "todo.apps.example.com" }] } },
      ]),
    };
    const cf = () => new FakeCf().on(["dns", "records", "list"], records).on(["workers", "list"], workers);
    await expect(run(cf()).result).rejects.toMatchObject({ code: "HOST_OWNED_BY_OTHER_GATEWAY" });
    await expect(run(cf(), { forceDns: true }).result).rejects.toMatchObject({
      code: "HOST_OWNED_BY_OTHER_GATEWAY",
      message: expect.stringContaining("todo.apps.example.com is every-app-gateway-demo's"),
    });
    // An app Worker of another Gateway counts too.
    const appOfDemo = new FakeCf().on(["dns", "records", "list"], records).on(["workers", "list"], {
      stdout: JSON.stringify([
        { id: "w-4", name: "every-demo--acme-todo", references: { domains: [{ hostname: "todo.apps.example.com" }] } },
      ]),
    });
    await expect(run(appOfDemo, { forceDns: true }).result).rejects.toMatchObject({ code: "HOST_OWNED_BY_OTHER_GATEWAY" });
  });

  it("warns that a hostname another Worker serves is replaced when cf can't ask", async () => {
    const cf = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    const attended = run(cf);
    await attended.result;
    expect(attended.events.some((e) => e.code === "CUSTOM_DOMAIN_OWNER_UNCHECKED")).toBe(false);

    const unattended = run(cf, { cfAsks: false });
    await unattended.result;
    expect(unattended.events).toContainEqual(
      expect.objectContaining({ code: "CUSTOM_DOMAIN_OWNER_UNCHECKED", data: { hosts: ["todo.apps.example.com"] } }),
    );
  });
});
