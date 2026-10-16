/**
 * `deploy` when no account the Cloudflare login sees has a Gateway yet. At
 * a terminal it offers to install one at apps.<zone> (the account and the
 * zone picked as `setup` picks them), runs setup's pipeline right there,
 * owner link included, and the deploy goes on. Anyone else (--json, CI,
 * piped output) gets `action_required install_gateway`, whose rerun is the
 * setup command; the deploy comes after it.
 */
import { resolveAccount } from "@/lib/cf/account";
import { confirmAtTerminal, type Confirm } from "@/lib/cf/deploy";
import type { CfWhoami } from "@/lib/cf/schemas";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { discoverGateway, type Discovery } from "@/lib/gateway/discover";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import {
  activeZones,
  installGateway,
  type SetupDeps,
} from "@/commands/setup/runSetup";

interface GatewayOffer {
  /** setup's dependencies, `interactive` included (tests swap them). */
  deps: SetupDeps;
  /** --account-id */
  accountId?: string;
  /** --yes: install at apps.<zone> without asking. */
  yes?: boolean;
  /** Asks the person at the terminal (tests answer for them). */
  confirm?: Confirm;
  forceDns?: boolean;
  verbose?: boolean;
}

export async function offerGateway({
  whoami,
  discovery,
  out,
  offer,
}: {
  whoami: CfWhoami;
  discovery: Discovery;
  out: EventSink;
  offer: GatewayOffer;
}): Promise<Discovery> {
  const { deps } = offer;
  const accountFlag = offer.accountId ? ["--account-id", offer.accountId] : [];
  if (!deps.interactive) {
    // What setup would pick on its own, when it can tell.
    const host = await suggestedHost(whoami, offer).catch(() => null);
    const rerun = [CLI, "setup", "--domain", host ?? "<hostname>", ...accountFlag].join(" ");
    throw new ActionRequiredError(
      "install_gateway",
      `No Gateway in ${describeAccounts(discovery)} yet, and apps deploy behind one. Install it with setup (creating its owner account takes a person, once), then deploy again.`,
      undefined,
      {
        rerun,
        data: { accounts: discovery.probed, ...(host ? { domain: host } : {}) },
      },
    );
  }

  const account = await resolveAccount({
    whoami,
    flag: offer.accountId,
    interactive: true,
  });
  const name = account.name ?? account.id;
  const zones = await activeZones(deps.createCf(account.id), account.id);
  const zone = zones.length === 1 ? zones[0]! : await deps.prompts.pickZone(zones);
  const host = `apps.${zone}`;
  const agreed =
    offer.yes ||
    (await (offer.confirm ?? confirmAtTerminal)(
      `No Gateway in ${name} yet. Install one at ${host}?`,
    ));
  if (!agreed) {
    throw new EveryAppError(
      "GATEWAY_NOT_FOUND",
      `Nothing deployed: apps deploy behind a Gateway, and ${name} has none yet. Install one where you want it (setup --domain <hostname>), then deploy again.`,
      { rerun: [CLI, "setup", "--domain", host, ...accountFlag].join(" ") },
    );
  }
  await installGateway({
    whoami,
    discovery,
    flags: {
      domain: host,
      "account-id": account.id,
      "force-dns": offer.forceDns,
      verbose: offer.verbose,
    },
    out,
    deps,
  });
  return discoverGateway({
    whoami,
    createCf: deps.createCf,
    accountId: account.id,
    interactive: true,
  });
}

/** apps.<the first active zone> of the account setup would install in. */
async function suggestedHost(whoami: CfWhoami, offer: GatewayOffer): Promise<string> {
  const account = await resolveAccount({
    whoami,
    flag: offer.accountId,
    interactive: false,
  });
  const zones = await activeZones(offer.deps.createCf(account.id), account.id);
  return `apps.${zones[0]!}`;
}

function describeAccounts(discovery: Discovery): string {
  const names = discovery.probed.map((account) => account.name ?? account.id);
  return names.length === 1 ? names[0]! : `any of ${names.join(", ")}`;
}
