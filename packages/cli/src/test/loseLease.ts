/**
 * A deploy that loses its lease mid-run: right before its `nth` renewal of
 * lease `id` (the heartbeat's 30 seconds never pass in a test, so each
 * renewal is a `check()` before a step that can't be undone), another
 * deploy takes the lease over.
 */
import type { FakeCloudflare } from "./fakeCloudflare";
import { sqliteD1Script } from "./sqliteD1";

export const OTHER_HOLDER = "other:1:beef";

export function loseLeaseAtCheck(
  account: FakeCloudflare,
  id: string,
  nth: number,
): void {
  let renewals = 0;
  account.cf.override(["d1", "query"], (call) => {
    const databaseId = call.args[2]!;
    const { db } = account.databases.get(databaseId)!;
    const body = call.files["query.json"] ?? "";
    if (
      body.includes("UPDATE _everyapp_deploy_lease SET expires_at") &&
      body.includes(JSON.stringify(id)) &&
      (renewals += 1) === nth
    ) {
      db.sqlite
        .prepare("UPDATE _everyapp_deploy_lease SET holder = ? WHERE id = ?")
        .run(OTHER_HOLDER, id);
    }
    return sqliteD1Script({ [databaseId]: db })(call);
  });
}
