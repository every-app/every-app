import chalk from "chalk";
import type { DeploymentMode } from "@/lib/gateway/secretsFile";
import { checkoutGateway } from "@/lib/gateway/checkoutRelease";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts } from "@/lib/output/table";
import { duration } from "@/lib/output/time";
import {
  runSetup,
  setupDeps,
  type SetupDeps,
  type SetupFlags,
  type SetupResult,
} from "./runSetup";

export async function setup(flags: SetupFlags,
): Promise<void> {
  await runGatewayCommand(flags, (out, deps) => runSetup(flags, out, deps));
}

/** `setup` or `update`, run with their dependencies, then what it did to the Gateway. */
export async function runGatewayCommand(
  flags: SetupFlags,
  run: (out: EventSink, deps: SetupDeps) => Promise<SetupResult>,
): Promise<void> {
  const began = Date.now();
  await runCommand(flags, async (out) => {
    const gateway = checkoutGateway({ out, verbose: flags.verbose });
    const result = await run(
      out,
      setupDeps({
        gateway: { openRelease: gateway.open, source: gateway.describe },
        interactive: canPromptInTerminal(flags.json ?? false),
      }),
    );
    reportGatewayResult(out, result, began);
  });
}

/**
 * What the run did, as its `done` event: where the Gateway is and, for a
 * new one or an owner just made, what to set up next (`data.next`).
 */
export function reportGatewayResult(
  out: EventSink,
  result: SetupResult,
  /** When the run started: an upgrade says how long it took. */
  began: number,
): void {
  const { gatewayUrl, organizationName, release, releaseName, owner, mode } = result;
  const adminUrl = `${gatewayUrl}/admin`;
  const data = {
    gatewayUrl,
    adminUrl,
    organizationName,
    owner,
    release,
    mode,
    gateway: result.gateway,
  };
  const gatewayFact = { label: "Gateway", value: gatewayUrl };

  // An upgrade says what it upgraded to, in how long.
  if (result.gateway === "upgraded" && !result.ownerCreated) {
    out.emit({
      type: "done",
      message: `Upgraded to ${releaseName}`,
      data,
      display: [
        ...formatFacts([{ label: "Gateway", value: chalk.cyan(gatewayUrl) }]),
        chalk.dim(`Upgraded to ${releaseName} in ${duration(Date.now() - began)}`),
      ].join("\n"),
    });
    return;
  }
  // Nobody to claim it (CI): where it is; the warning said the rest.
  if (!owner) {
    out.emit({ type: "done", data: { ...data, facts: [gatewayFact] } });
    return;
  }
  // A new Gateway, or its owner just made: what to do next.
  if (result.gateway === "installed" || result.ownerCreated) {
    out.emit({
      type: "done",
      data: {
        ...data,
        facts: [
          gatewayFact,
          { label: "Admin", value: adminUrl, note: "invite people, choose who opens which app" },
        ],
        next: nextAfterInstall(mode),
      },
    });
    return;
  }
  // Up to date, or repaired: where it is, and where to look next.
  out.emit({
    type: "done",
    data: {
      ...data,
      facts: [gatewayFact],
      ...(result.gateway === "up-to-date"
        ? { next: [{ command: `${CLI} status`, note: "see apps, domains and certificates" }] }
        : {}),
    },
  });
}

/**
 * What to set up once the Gateway has its owner: an app, Cloudflare Access
 * in front (recommended), AI for apps, then email, which the Gateway sends
 * only with both EMAIL_FROM and EMAIL_FROM_NAME set. A hosted Gateway
 * ignores Access (`access on` refuses it), so its list has no Access line.
 */
function nextAfterInstall(mode: DeploymentMode): Array<{ command: string; note: string }> {
  if (mode === "hosted") {
    return [
      { command: `${CLI} create my-app`, note: "start your first app" },
      { command: `${CLI} secret set OPENAI_API_KEY`, note: "turn on AI for apps" },
      {
        command: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
        note: "email invites; needs Cloudflare Email Sending",
      },
    ];
  }
  return [
    { command: `${CLI} create my-app`, note: "start your first app" },
    {
      command: `${CLI} access on`,
      note: "put Cloudflare Access in front of your Gateway (recommended)",
    },
    {
      command: `${CLI} secret set OPENAI_API_KEY`,
      note: "AI for apps (or OPENROUTER_API_KEY, WORKERS_AI_API_TOKEN)",
    },
    {
      command: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
      note: "email invites and password resets; needs Cloudflare Email Sending",
    },
  ];
}
