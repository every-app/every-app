import chalk from "chalk";
import type { DeploymentMode } from "@/lib/gateway/secretsFile";
import { gatewayReleaseSource } from "@/lib/gateway/source";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts } from "@/lib/output/table";
import { duration } from "@/lib/output/time";
import type { UsageReportsAtSetup } from "@/lib/gateway/usageReports";
import { cliVersion } from "@/lib/version";
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
    const gateway = gatewayReleaseSource({
      release: flags.release,
      out,
      verbose: flags.verbose,
      cliVersion,
    });
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
 * What the run did, as its `done` event: where the Gateway is, whether
 * Cloudflare Access went in front (`data.accessOn`, a fact when it did)
 * and, for a new one or an owner just made, what to set up next
 * (`data.next`; `access on` is left out once Access is on).
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
    accessOn: result.accessOn,
    ...(result.usageReports ? { usageReports: result.usageReports } : {}),
  };
  const gatewayFact = { label: "Gateway", value: gatewayUrl };
  const accessFacts = result.accessOn
    ? [{ label: "Access", value: "on", note: "everyone signs in through Cloudflare Access first" }]
    : [];

  const usage = usageReportLines(result.usageReports);

  // An upgrade says what it upgraded to, in how long, and what an owner
  // must know before the Gateway's first usage report.
  if (result.gateway === "upgraded" && !result.ownerCreated) {
    out.emit({
      type: "done",
      message: [`Upgraded to ${releaseName}`, ...usage.said].join("\n"),
      data,
      display: [
        ...formatFacts([{ label: "Gateway", value: chalk.cyan(gatewayUrl) }]),
        chalk.dim(`Upgraded to ${releaseName} in ${duration(Date.now() - began)}`),
        ...usage.display,
      ].join("\n"),
    });
    return;
  }
  // Nobody to claim it (CI): where it is; the warning said the rest.
  if (!owner) {
    out.emit({ type: "done", data: { ...data, facts: [gatewayFact, ...usage.facts] } });
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
          ...accessFacts,
          ...usage.facts,
        ],
        next: [...nextAfterInstall(mode, result.accessOn === true), ...usage.next],
      },
    });
    return;
  }
  // Up to date, or repaired: where it is, and where to look next.
  out.emit({
    type: "done",
    data: {
      ...data,
      facts: [gatewayFact, ...accessFacts, ...usage.facts],
      ...(result.gateway === "up-to-date"
        ? { next: [{ command: `${CLI} status`, note: "see apps, domains and certificates" }, ...usage.next] }
        : usage.next.length > 0
          ? { next: usage.next }
          : {}),
    },
  });
}

const usageOffBecause = {
  "no-telemetry": "setup ran with --no-telemetry",
  "do-not-track": "DO_NOT_TRACK is set in this shell",
} as const;

/**
 * What a run says about the Gateway's daily usage report to Every App
 * (lib/gateway/usageReports.ts): the notice before the first one, or that
 * this run left them off. `display` is the block under an upgrade's lines,
 * `said` the same for --json's message, and `facts` and `next` the line and
 * the command where the result is drawn as facts.
 */
function usageReportLines(usage: UsageReportsAtSetup): {
  display: string[];
  said: string[];
  facts: Array<{ label: string; value: string; note: string }>;
  next: Array<{ command: string; note: string }>;
} {
  if (!usage) return { display: [], said: [], facts: [], next: [] };
  if (usage.usageReports === "off") {
    const line = `Usage reports are off for this Gateway: ${usageOffBecause[usage.because]}.`;
    return {
      display: ["", line],
      said: [line],
      facts: [{ label: "Usage reports", value: "off", note: usageOffBecause[usage.because] }],
      next: [],
    };
  }
  const { headline, detail } = usage.notice;
  return {
    display: ["", headline, detail, "", "See the exact report, or turn it off:", `  ${CLI} telemetry`, `  ${CLI} telemetry off`],
    said: [headline, detail, `See the exact report: ${CLI} telemetry`, `Turn it off: ${CLI} telemetry off`],
    facts: [
      {
        label: "Usage reports",
        value: "on",
        note: `${headline.replace(/^Usage reports start/, "start").replace(/ for this Gateway\.$/, "")}: a few rounded counts a day, never names or content`,
      },
    ],
    next: [{ command: `${CLI} telemetry`, note: `see the daily usage report, or turn it off (${CLI} telemetry off)` }],
  };
}

/**
 * What to set up once the Gateway has its owner: an app, Cloudflare Access
 * in front (recommended, unless setup just turned it on), AI for apps,
 * then email, which the Gateway sends only with both EMAIL_FROM and
 * EMAIL_FROM_NAME set. A hosted Gateway ignores Access (`access on`
 * refuses it), so its list has no Access line.
 */
function nextAfterInstall(mode: DeploymentMode, accessOn: boolean): Array<{ command: string; note: string }> {
  if (mode === "hosted") {
    return [
      { command: `${CLI} create ../my-app`, note: "start your first app" },
      { command: `${CLI} secret set OPENAI_API_KEY`, note: "turn on AI for apps" },
      {
        command: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
        note: "email invites; needs Cloudflare Email Sending",
      },
    ];
  }
  return [
    { command: `${CLI} create ../my-app`, note: "start your first app" },
    ...(accessOn
      ? []
      : [
          {
            command: `${CLI} access on`,
            note: "put Cloudflare Access in front of your Gateway (recommended)",
          },
        ]),
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
