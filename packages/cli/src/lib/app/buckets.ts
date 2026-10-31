import type { EventSink } from "@/lib/output/events";
import { ensureAppBuckets } from "./resources";

/** Create or reuse only buckets the shared resource ledger assigns to this app. */
export async function ensureR2Buckets({
  out,
  ...options
}: Parameters<typeof ensureAppBuckets>[0] & { out: EventSink }): Promise<string[]> {
  const created = await ensureAppBuckets({
    ...options,
    onCreated: undefined,
    onRecreated: undefined,
    onAdopted: (name) =>
      out.emit({
        type: "progress",
        step: "app.build",
        message: `Adopted R2 bucket "${name}": an earlier deploy of this app made it before buckets were recorded.`,
        data: { bucket: name, adopted: true },
      }),
  });
  for (const name of created)
    out.emit({
      type: "progress",
      step: "app.build",
      message: `Created R2 bucket "${name}".`,
      data: { bucket: name },
    });
  return created;
}
