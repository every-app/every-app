import { describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import { deleteHostCertificates } from "./certificates";

describe("deleteHostCertificates", () => {
  it("deletes only packs that cover exactly the hostname, confirming cf's prompt", async () => {
    const cf = new FakeCf().on(["ssl", "certificate-packs", "list"], (call) => ({
      stdout: JSON.stringify(
        call.args.includes("1")
          ? [
              { id: "own", hosts: ["todo.apps.example.com"] },
              { id: "shared", hosts: ["todo.apps.example.com", "apps.example.com"] },
              { id: "universal", hosts: ["example.com", "*.example.com"] },
              { id: "other", hosts: ["chef.apps.example.com"] },
            ]
          : [],
      ),
    }));

    await expect(
      deleteHostCertificates({
        cf,
        out: createNdjsonSink(() => undefined),
        step: "app.delete",
        zoneId: "zone-1",
        hostname: "todo.apps.example.com",
      }),
    ).resolves.toEqual(["own"]);
    expect(cf.calls.at(-1)!.args).toEqual([
      "ssl",
      "certificate-packs",
      "delete",
      "own",
      "-z",
      "zone-1",
      "--force",
    ]);
  });

  it("warns instead of failing when the packs can't be read", async () => {
    const events: any[] = [];
    const cf = new FakeCf().on(["ssl"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });
    await expect(
      deleteHostCertificates({
        cf,
        out: createNdjsonSink((line) => events.push(JSON.parse(line))),
        step: "app.delete",
        zoneId: "zone-1",
        hostname: "todo.apps.example.com",
      }),
    ).resolves.toEqual([]);
    expect(events).toEqual([expect.objectContaining({ code: "CERT_CLEANUP_FAILED" })]);
  });
});
