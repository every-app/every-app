/**
 * `deploy` when no account the Cloudflare login sees has a Gateway yet. At
 * a terminal it offers to install one at apps.<zone> (the account and the
 * zone picked as `setup` picks them), runs setup's pipeline right there,
 * owner link included, and the deploy goes on. Anyone else (--json, CI,
 * piped output) gets `action_required install_gateway`, whose rerun is the
 * setup command; the deploy comes after it.
 *
 * Never when a Gateway Worker already runs in an account the login sees:
 * its database couldn't be read, or was removed, and a second Gateway
 * beside it (at apps.<its own zone>) is the one thing not to do.
 */
import chalk from "chalk";
import { resolveAccount } from "@/lib/cf/account";
import type { CfWhoami } from "@/lib/cf/schemas";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { listWorkers } from "@/lib/cf/workers";
import { ActionRequiredError, CancelledError, EveryAppError } from "@/lib/errors";
import { discoverGateway, type Discovery } from "@/lib/gateway/discover";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { confirmAtTerminal, tellPerson, type Confirm } from "@/lib/output/prompt";
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
  await refuseServingGateway(discovery, deps.createCf);
  if (!deps.interactive) {
    // What setup would pick on its own, when it can tell.
    const host = await suggestedHost(whoami, offer).catch(() => null);
    const rerun = [CLI, "setup", "--domain", host ?? "<hostname>", ...accountFlag].join(" ");
    throw new ActionRequiredError(
      "install_gateway",
      `Install a Gateway first: ${noGatewayIn(discovery)}\nApps deploy behind one. Setup needs a person once, to create the owner account.`,
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
  if (offer.yes) {
    tellPerson(chalk.dim(`${name} has no Gateway yet, so --yes installs one at ${host} first.`));
  } else {
    const agreed = await (offer.confirm ?? confirmAtTerminal)(`Install a Gateway at ${host}?`, [
      `${name} has no Gateway yet. Apps deploy behind one, so it's installed first.`,
    ]);
    if (!agreed) {
      throw new CancelledError(
        `Cancelled. Nothing deployed.\nApps deploy behind a Gateway. To install one elsewhere: ${[CLI, "setup", "--domain", "<hostname>", ...accountFlag].join(" ")}`,
      );
    }
  }
  await installGateway({
    whoami,
    discovery,
    flags: {
      domain: host,
      "account-id": account.id,
      "force-dns": offer.forceDns,
      // setup's own questions take the deploy's --yes too (browser installs: No).
      yes: offer.yes,
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

/** "Acme has none yet", "none of Personal, Acme has one yet". */
function noGatewayIn(discovery: Discovery): string {
  const names = discovery.probed.map((account) => account.name ?? account.id);
  return names.length === 1 ? `${names[0]} has none yet` : `none of ${names.join(", ")} has one yet`;
}

/**
 * GATEWAY_CHECK_FAILED when an account already runs the Gateway Worker
 * (or its Workers can't be listed, so that can't be told), though no
 * Gateway database was found there.
 */
async function refuseServingGateway(
  discovery: Discovery,
  createCf: SetupDeps["createCf"],
): Promise<void> {
  for (const account of discovery.probed) {
    const name = account.name ?? account.id;
    let hosts: string[] | null;
    try {
      const worker = (await listWorkers(createCf(account.id))).find((w) => w.name === GATEWAY_WORKER_NAME);
      hosts = worker ? (worker.references?.domains ?? []).map((domain) => domain.hostname.toLowerCase()) : null;
    } catch {
      throw new EveryAppError(
        "GATEWAY_CHECK_FAILED",
        `Couldn't check ${name} for a Gateway\nCloudflare didn't list its Workers, so whether a Gateway already runs there is unknown. Nothing was installed.`,
        { retryable: true, rerunNote: "in a moment", data: { accounts: discovery.probed, account: account.id } },
      );
    }
    if (hosts === null) continue;
    throw new EveryAppError(
      "GATEWAY_CHECK_FAILED",
      `${name} already runs a Gateway${hosts.length ? ` at ${hosts.join(", ")}` : ""}, but its database couldn't be found\nNothing was installed: a second Gateway beside it is never offered.`,
      {
        retryable: true,
        rerunNote: `in a moment; if it fails again, ${CLI} status --account-id ${account.id} says what is there`,
        data: { accounts: discovery.probed, account: account.id, hosts },
      },
    );
  }
}
