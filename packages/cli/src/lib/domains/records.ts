/**
 * DNS records in a Cloudflare zone, read through the Cloudflare API
 * (`cf dns records list`): those at a name, and the wildcard that answers
 * a name with no records of its own; and deleting one (the teardown).
 */
import { runCfJson, type CfRunner } from "@/lib/cf/runner";
import { DnsRecordListOutput } from "@/lib/cf/schemas";

/** The records at exactly `name` in the zone (a wildcard's name too: `*.example.com`). */
export function dnsRecordsAt(cf: CfRunner, zoneId: string, name: string) {
  return runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "dns",
        "records",
        "list",
        "-z",
        zoneId,
        "--name-exact",
        name,
        "--per-page",
        "100",
      ],
    },
    DnsRecordListOutput,
  );
}

/**
 * Delete one record (`cf dns records delete`, `--force` answering cf's
 * confirmation). Only the teardown does: everyapp otherwise leaves a
 * zone's records alone, Custom Domains' own going with their Worker.
 */
export async function deleteDnsRecord(cf: CfRunner, zoneId: string, recordId: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["dns", "records", "delete", recordId, "-z", zoneId, "--force"],
  });
}

/**
 * The wildcard that answers `host` while it has no records of its own:
 * `*.apps.example.com` for `todo.apps.example.com`.
 */
export function wildcardOver(host: string): string {
  return `*.${host.slice(host.indexOf(".") + 1)}`;
}

/** A record as a person reads it: `CNAME legacy.example.net`. */
export function describeRecord(record: {
  type: string;
  content?: string | null;
}): string {
  return `${record.type}${record.content ? ` ${record.content}` : ""}`;
}
