import type { LocalContext } from "@/context";
import { cfD1Database } from "@/lib/cf/d1";
import { canPromptInTerminal, confirmAtTerminal } from "@/lib/cf/deploy";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { EveryAppError } from "@/lib/errors";
import {
  adoptGateway,
  assertServesGateway,
  describeInventory,
  inventoryGateway,
} from "@/lib/gateway/adopt";
import { readInstall } from "@/lib/gateway/install";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import {
  cliVersion,
  connectToAccount,
  eventSink,
  rememberedInstall,
  runReported,
} from "../shared";

interface AdoptFlags {
  domain?: string;
  "account-id"?: string;
  "dry-run"?: boolean;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `everyapp gateway adopt --domain <host>`: record a gateway deployed
 * before everyapp used cf as this everyapp's, exactly as it is (its domain,
 * wildcard route and app hostnames). Looks first and, with --dry-run, only
 * looks. `everyapp gateway upgrade` from a terminal deploys it next.
 */
export async function adopt(
  this: LocalContext,
  flags: AdoptFlags,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      const domain = normalizeHostname(flags.domain);
      if (!domain) {
        throw new EveryAppError(
          "DOMAIN_REQUIRED",
          "Pass --domain with the host the gateway serves at (its GATEWAY_URL), e.g. --domain example.com.",
        );
      }
      const cached = await rememberedInstall(domain);
      const { cf, account } = await connectToAccount({
        json: flags.json,
        accountId: flags["account-id"],
        remembered: cached?.accountId,
      });
      const databaseId = await findGatewayDatabase(cf);
      if (!databaseId) {
        throw new EveryAppError(
          "GATEWAY_NOT_DEPLOYED",
          `No gateway database in ${account.name ?? account.id}: nothing to adopt. \`everyapp setup\` installs a gateway.`,
        );
      }
      const db = cfD1Database(cf, databaseId);
      const existing = await readInstall(db);
      if (existing) {
        out.emit({
          type: "done",
          message: `The gateway at https://${existing.gatewayHost} is everyapp's already (${existing.routing === "custom-domains" ? "per-app Custom Domains" : "wildcard route"}, release ${existing.releaseVersion}). \`everyapp gateway upgrade\` deploys this everyapp's release.`,
          data: { adopted: true, gatewayHost: existing.gatewayHost, routing: existing.routing },
        });
        return;
      }

      const inventory = await inventoryGateway({ cf, db, accountId: account.id, domain });
      const hosted = inventory.apps.filter((app) => app.hostname);
      if (hosted.length > 0 && inventory.strayApps.length === hosted.length) {
        throw new EveryAppError(
          "DOMAIN_MISMATCH",
          `None of this gateway's apps live one label below ${domain} (${hosted[0]!.appId} is at ${hosted[0]!.hostname}). Pass the domain the gateway serves at.`,
        );
      }
      if (inventory.strayApps.length > 0) {
        out.emit({
          type: "warning",
          code: "APP_HOST_OUTSIDE_BASE",
          message: `${inventory.strayApps.map((app) => `${app.appId} (${app.hostname})`).join(", ")} ${inventory.strayApps.length === 1 ? "isn't" : "aren't"} one label below ${domain}: the wildcard route keeps serving ${inventory.strayApps.length === 1 ? "it" : "them"} only if ${domain} covers ${inventory.strayApps.length === 1 ? "its" : "their"} host.`,
        });
      }
      // Its apps' hostnames needn't say (it may have none): the host must
      // answer as this account's gateway, or the upgrade would publish the
      // gateway over whatever it serves.
      const matchedBy = await assertServesGateway({ domain, inventory });
      out.emit({
        type: "progress",
        step: "gateway.adopt",
        message:
          matchedBy === "version"
            ? `https://${domain} serves this account's gateway: it answers from the version its Worker serves.`
            : `https://${domain} serves an Every App gateway from before /api/deploy/status, whose owner matches this account's gateway database.`,
      });
      out.emit({
        type: "step",
        step: "gateway.adopt",
        status: "ok",
        message: describeInventory(inventory).join("\n"),
        data: {
          domain,
          zone: inventory.zone.name,
          servingVersionId: inventory.servingVersionId,
          wildcardRecords: inventory.wildcardRecords,
          apps: inventory.apps,
          claimed: inventory.claimed,
        },
      });
      if (flags["dry-run"]) {
        out.emit({
          type: "done",
          message: `Dry run: nothing changed. Adopting records this gateway at ${domain} as it is (wildcard route, app hostnames kept) and creates the release cache namespace; then \`everyapp gateway upgrade\` deploys it.`,
        });
        return;
      }
      if (
        !flags.yes &&
        canPromptInTerminal(flags.json ?? false) &&
        !(await confirmAtTerminal(`Record the gateway at ${domain} as this everyapp's, as it is?`))
      ) {
        out.emit({ type: "done", message: "Nothing changed." });
        return;
      }
      await adoptGateway({ cf, db, databaseId, accountId: account.id, inventory, cliVersion });
      out.emit({
        type: "done",
        message: [
          `Adopted the gateway at https://${domain}: it keeps its wildcard route and app hostnames.`,
          "Next, from a terminal (cf asks before replacing a Worker last changed outside it):",
          "  everyapp gateway upgrade     bookmark, carry the migration history over, migrate, deploy",
          "  everyapp gateway status      check it serves, then deploy each app again from a terminal",
          "Later, if you like: everyapp gateway use-per-app-domains (each app its own Custom Domain).",
        ].join("\n"),
        data: { adopted: true, gatewayHost: domain, routing: "wildcard-route" },
      });
    },
    { verbose: flags.verbose },
  );
}
