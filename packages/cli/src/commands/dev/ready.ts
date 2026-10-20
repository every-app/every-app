import chalk from "chalk";
import { DEV_USER } from "@every-app/perimeter/dev";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { formatFacts } from "@/lib/output/table";
import { CRON_PATH } from "./gatewayServer";
import { DevMode } from "./mode";

interface ReadyBlockOptions {
  manifest: EveryAppCliManifest;
  mode: DevMode;
  appUrl: string;
  appPort: number;
  /** Mirror mode: the separately-run Gateway, and where to log in through the gateway-lite. */
  gatewayUrl: string;
  loginUrl: string;
  /** cloudflare.config.ts declares crons. */
  crons: boolean;
}

/** What's running and how to reach it, as one block of facts. */
export function readyBlock({
  manifest,
  mode,
  appUrl,
  appPort,
  gatewayUrl,
  loginUrl,
  crons,
}: ReadyBlockOptions): string {
  const facts = [
    { label: "App", value: chalk.cyan(appUrl) },
    {
      label: "MCP",
      value: `${chalk.cyan(`${appUrl}/mcp`)}  ${chalk.dim(
        mode === DevMode.Mirror
          ? "bearer: a personal access token from the local Gateway"
          : "any bearer token acts as the dev user",
      )}`,
    },
    ...(mode === DevMode.Mirror
      ? [
          {
            label: "Log in",
            value: `${chalk.cyan(loginUrl)}  ${chalk.dim("the session carries to the app")}`,
          },
          {
            label: "Gateway",
            value: `${gatewayUrl} ${chalk.dim("(real login and launcher)")}`,
          },
        ]
      : [
          {
            label: "Dev user",
            value: `${DEV_USER.email} ${chalk.dim(`(${DEV_USER.orgRole} of ${DEV_USER.orgId})`)}`,
          },
        ]),
    // Workflows run under cf dev too; the Vite plugin's local explorer, on
    // the app's own dev server, starts, inspects, pauses and restarts their
    // instances.
    ...(manifest.resources?.workflows?.length
      ? [
          {
            label: "Workflows",
            value: chalk.cyan(`http://127.0.0.1:${appPort}/cdn-cgi/local/explorer`),
          },
        ]
      : []),
    ...emailHint(manifest, appPort),
    // Crons (everyAppWorker's `crons`) run on demand through the gateway-lite.
    ...(crons
      ? [
          {
            label: "Cron",
            value: `curl -X POST ${appUrl}${CRON_PATH} -d '<schedule>'`,
          },
        ]
      : []),
  ];
  return ["", ...formatFacts(facts).map((line) => `  ${line}`), ""].join("\n");
}

/**
 * How to deliver a message to the app's email() handler locally, when the
 * manifest declares one: miniflare's local delivery endpoint on the app's
 * own dev server (`everyapp dev --help` says what the message needs).
 */
export function emailHint(
  manifest: Pick<EveryAppCliManifest, "email">,
  appPort: number,
): Array<{ label: string; value: string }> {
  if (manifest.email?.inbound !== true) return [];
  return [
    {
      label: "Email",
      value: `curl -X POST "http://127.0.0.1:${appPort}/cdn-cgi/local/email?from=someone@example.net&to=hello@example.com" --data-binary @message.eml`,
    },
  ];
}
