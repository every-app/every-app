import { describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { listZones, resolveZone } from "./zones";

const ACCOUNT = "0123456789abcdef0123456789abcd01";

function zonesCf(zones: Array<{ id: string; name: string; status: string }>) {
  return new FakeCf().on(["zones", "list"], (call) => {
    const name = call.args[call.args.indexOf("--name") + 1];
    const page = Number(call.args[call.args.indexOf("--page") + 1] ?? "1");
    return {
      stdout: JSON.stringify(
        call.args.includes("--name")
          ? zones.filter((zone) => zone.name === name)
          : zones.slice((page - 1) * 50, page * 50),
      ),
    };
  });
}

describe("resolveZone", () => {
  it("picks the longest of the name and its parents that is a zone", async () => {
    const cf = zonesCf([
      { id: "zone-company", name: "company.com", status: "active" },
      { id: "zone-apps", name: "apps.company.com", status: "active" },
    ]);
    await expect(resolveZone(cf, "apps.company.com", ACCOUNT)).resolves.toEqual({
      id: "zone-apps",
      name: "apps.company.com",
    });
    await expect(resolveZone(cf, "home.company.com", ACCOUNT)).resolves.toEqual({
      id: "zone-company",
      name: "company.com",
    });
    // Each candidate asked of this account, by exact name.
    expect(cf.calls[0]!.args).toEqual([
      "zones",
      "list",
      "--name",
      "apps.company.com",
      "--account-id",
      ACCOUNT,
    ]);
  });

  it("says to finish a pending zone's nameserver setup", async () => {
    const cf = zonesCf([{ id: "z", name: "company.com", status: "pending" }]);
    await expect(resolveZone(cf, "apps.company.com", ACCOUNT)).rejects.toMatchObject({
      code: "ZONE_NOT_ACTIVE",
      fix: expect.stringContaining("nameserver"),
    });
  });

  it("says where to buy a domain when no zone holds the name", async () => {
    const cf = zonesCf([{ id: "z", name: "other.com", status: "active" }]);
    await expect(resolveZone(cf, "apps.company.com", ACCOUNT)).rejects.toMatchObject({
      code: "ZONE_NOT_FOUND",
      message: expect.stringContaining(`https://dash.cloudflare.com/${ACCOUNT}/domains/overview`),
    });
  });
});

describe("listZones", () => {
  it("reads every page", async () => {
    const zones = Array.from({ length: 73 }, (_, i) => ({
      id: `z${i}`,
      name: `zone${i}.com`,
      status: "active",
    }));
    const listed = await listZones(zonesCf(zones), ACCOUNT);
    expect(listed).toHaveLength(73);
    expect(listed[72]).toEqual({ id: "z72", name: "zone72.com", status: "active" });
  });
});
