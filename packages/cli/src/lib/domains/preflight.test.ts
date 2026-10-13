import { describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import { preflightDomains } from "./preflight";

const ZONE = { id: "zone-1", name: "example.com" };

function run(cf: FakeCf, options: Partial<Parameters<typeof preflightDomains>[0]> = {}) {
  const events: any[] = [];
  const result = preflightDomains({
    cf,
    out: createNdjsonSink((line) => events.push(JSON.parse(line))),
    step: "test",
    zone: ZONE,
    domains: ["apps.example.com", "todo.apps.example.com"],
    liveDomains: ["apps.example.com"],
    interactive: true,
    lookupCaa: async () => [],
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
      new FakeCf().on(["dns", "records", "list"], {
        stdout: JSON.stringify(
          rows.map((row, i) => ({ id: `r${i}`, name: "todo.apps.example.com", ...row })),
        ),
      });
    await expect(
      run(records([{ type: "MX", content: "mx.example.net" }, { type: "TXT", content: "v=spf1 -all" }])).result,
    ).resolves.toEqual(["todo.apps.example.com"]);
    for (const type of ["A", "AAAA", "CNAME", "NS"]) {
      await expect(run(records([{ type, content: "x" }])).result, type).rejects.toMatchObject({
        code: "DNS_RECORD_CONFLICT",
      });
    }
  });

  it("says which new hostnames a wildcard answers now, and goes on", async () => {
    const records: Record<string, Array<{ type: string; content: string }>> = {
      "*.apps.example.com": [{ type: "CNAME", content: "legacy.example.net" }, { type: "TXT", content: "x" }],
      // Its own record: the wildcard doesn't answer it.
      "chef.apps.example.com": [{ type: "TXT", content: "v=spf1 -all" }],
    };
    const cf = new FakeCf().on(["dns", "records", "list"], (call) => {
      const name = call.args[call.args.indexOf("--name-exact") + 1]!;
      return {
        stdout: JSON.stringify((records[name] ?? []).map((row, i) => ({ id: `r${i}`, name, ...row }))),
      };
    });
    const { result, events } = run(cf, {
      domains: ["apps.example.com", "todo.apps.example.com", "notes.apps.example.com", "chef.apps.example.com"],
    });

    await expect(result).resolves.toEqual(["todo.apps.example.com", "notes.apps.example.com", "chef.apps.example.com"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "DNS_WILDCARD_ANSWERS",
        message: expect.stringContaining("todo.apps.example.com (*.apps.example.com: CNAME legacy.example.net)"),
        data: { hosts: ["todo.apps.example.com", "notes.apps.example.com"] },
      }),
    );
    // The wildcard is read once for both.
    const asked = cf.calls.map((call) => call.args[call.args.indexOf("--name-exact") + 1]);
    expect(asked.filter((name) => name === "*.apps.example.com")).toHaveLength(1);
  });

  it("refuses unless it can read the zone's DNS, or is told to go on", async () => {
    const denied = () =>
      new FakeCf().on(["dns", "records", "list"], {
        exitCode: 1,
        stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
      });
    await expect(run(denied()).result).rejects.toMatchObject({
      code: "DNS_UNREADABLE",
      message: expect.stringContaining("Zone → DNS → Read"),
    });
    await expect(run(denied(), { forceDns: true }).result).resolves.toEqual([
      "todo.apps.example.com",
    ]);
  });

  it("asks public DNS about a new hostname only once it has a record", async () => {
    const asked: string[] = [];
    const lookupCaa = async (name: string) => {
      asked.push(name);
      return [];
    };
    const empty = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    await run(empty, { lookupCaa }).result;
    expect(asked).toEqual(["apps.example.com", "example.com", "com"]);
  });

  it("applies a parent domain's CAA records to a subdomain zone", async () => {
    // The zone is apps.example.com; example.com, above it, allows only digicert.com.
    const cf = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    const lookupCaa = async (name: string) =>
      name === "example.com" ? [{ flags: 0, tag: "issue", value: "digicert.com" }] : [];
    await expect(
      run(cf, { zone: { id: "zone-2", name: "apps.example.com" }, lookupCaa }).result,
    ).rejects.toMatchObject({
      code: "CAA_BLOCKS_ISSUANCE",
      message: expect.stringContaining("CAA at example.com allows digicert.com"),
    });
  });

  it("warns, and goes on, when CAA allows Cloudflare's CAs only for one ACME account or method", async () => {
    const cf = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    const lookupCaa = async (name: string) =>
      name === "example.com"
        ? [{ flags: 0, tag: "issue", value: "letsencrypt.org; validationmethods=dns-01" }]
        : [];
    const { result, events } = run(cf, { lookupCaa });
    await expect(result).resolves.toEqual(["todo.apps.example.com"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "CAA_MAY_BLOCK_ISSUANCE",
        message: expect.stringContaining("allows letsencrypt.org only with validationmethods"),
        data: { hosts: ["todo.apps.example.com"] },
      }),
    );
  });

  it("says when CAA can't be read, and goes on", async () => {
    const cf = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    const { result, events } = run(cf, { lookupCaa: async () => null });
    await expect(result).resolves.toEqual(["todo.apps.example.com"]);
    expect(events).toContainEqual(expect.objectContaining({ code: "CAA_UNCHECKED" }));
  });

  it("warns unattended that cf can't tell which Worker holds a hostname", async () => {
    const cf = new FakeCf().on(["dns", "records", "list"], { stdout: "[]" });
    const attended = run(cf);
    await attended.result;
    expect(attended.events.some((e) => e.code === "CUSTOM_DOMAIN_OWNER_UNCHECKED")).toBe(false);

    const unattended = run(cf, { interactive: false });
    await unattended.result;
    expect(unattended.events).toContainEqual(
      expect.objectContaining({ code: "CUSTOM_DOMAIN_OWNER_UNCHECKED", data: { hosts: ["todo.apps.example.com"] } }),
    );
  });
});
