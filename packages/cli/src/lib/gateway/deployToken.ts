/**
 * The Gateway's own Cloudflare token (CF_DEPLOY_TOKEN), for the installs it
 * runs itself: Admin → Apps → Install app, or a Deploy to EveryApp button.
 * The person makes it on Cloudflare's account-token page, opened with its
 * name and permissions filled in, and pastes it at a hidden prompt; the
 * login everyapp runs under can't make API tokens.
 */
import chalk from "chalk";
import { askSecret, confirmYesAtTerminal, tellPerson } from "@/lib/output/prompt";
import { openInBrowser } from "./setup-link";

/** Cloudflare permission groups without a template short key, by ID. */
enum PermissionGroup {
  HyperdriveWrite = "721b2f51fba74871bd361de65aeb7e03",
  VectorizeWrite = "64156ba5be47441096c83c7fc17c488b",
  AiGatewayWrite = "6c8a3737f07f46369c1ea1f22138daaf",
  SecretsStoreWrite = "adc8fa2bc6124928a8b3314dc63a1235",
  EmailRoutingRulesWrite = "79b3ec0d10ce4148a8f8bdc0cc5f97f2",
}

/**
 * What the Gateway's installer calls, as an account-token template takes it
 * (https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/):
 * Cloudflare's short keys where they exist, else the permission group's ID
 * (its `type` is then ignored). Workers Scripts also covers Workflows, Queue
 * consumers, cron schedules and Custom Domains; Zone, Zone Settings and
 * Email Routing Rules are inbound email's (Zone Settings Edit turns Email
 * Routing on for a zone that has it off).
 */
const PERMISSIONS = [
  { key: "workers_scripts", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "workers_r2", type: "edit" },
  { key: "queues", type: "edit" },
  { key: "dns", type: "read" },
  { key: "access", type: "edit" },
  { key: "zone", type: "read" },
  { key: "zone_settings", type: "edit" },
  // Permission group IDs (no short key), the same in Cloudflare's API dumps and
  // the Alchemy provider's generated list.
  { key: PermissionGroup.HyperdriveWrite, type: "edit" },
  { key: PermissionGroup.VectorizeWrite, type: "edit" },
  { key: PermissionGroup.AiGatewayWrite, type: "edit" },
  { key: PermissionGroup.SecretsStoreWrite, type: "edit" },
  { key: PermissionGroup.EmailRoutingRulesWrite, type: "edit" },
] as const;

/** Cloudflare's page for a new account token, filled in for this Gateway. */
function deployTokenUrl(gatewayHost: string): string {
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(
    JSON.stringify(PERMISSIONS),
  )}&name=${encodeURIComponent(`EveryApp ${gatewayHost}`)}`;
}

/** Where the token is made: the Gateway's host (its name), account and zone. */
interface DeployTokenFor {
  gatewayHost: string;
  /** The account's name, else its id: picked on Cloudflare's page when the login has several. */
  account: string;
  /** The Gateway's zone, the one zone its DNS permission needs. */
  zone: string;
}

/**
 * Say what to pick on Cloudflare's page first, open it only when the person
 * says so (the link is printed instead on No, or with no browser to open),
 * then take the token they paste.
 */
export async function askDeployToken({ gatewayHost, account, zone }: DeployTokenFor): Promise<string> {
  const url = deployTokenUrl(gatewayHost);
  // The steps are what the person must do, so they read at full weight, not as dim context.
  tellPerson(
    [
      `${chalk.cyan("→")} Create a Cloudflare API token for ${gatewayHost} (its permissions are filled in):`,
      `  1. Account: ${account}`,
      `  2. Zone resources: ${zone}`,
      "  3. Continue to Review Token, then Create Token, and copy it.",
    ].join("\n"),
  );
  const open = await confirmYesAtTerminal("Open Cloudflare in your browser?");
  if (!(open && (await openInBrowser(url)))) tellPerson(`Open this link to create it:\n  ${url}`);
  const token = await askSecret("Cloudflare API token (stored only on your Gateway)");
  return token.trim();
}
