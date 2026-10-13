/**
 * The gateway-lite for one app: the real perimeter with the app registered,
 * and `<app>.localhost/mcp` served by a local ToolBus from the app's live
 * `defineTools()` catalog, with the gateway's policy and identity contract.
 */
import chalk from "chalk";
import {
  createDevGatewayHandler,
  DEV_ISSUER,
  type RegisteredApp,
  type SessionAuthenticator,
} from "@every-app/perimeter/dev";
import { createDevToolBus } from "@every-app/toolbus/dev";

interface DevAppGatewayOptions {
  app: RegisteredApp;
  appName?: string;
  /** The app's URL on the gateway-lite, e.g. `http://todo.localhost:8787`. */
  appUrl: string;
  /** Reaches the app's dev server. */
  appFetcher: { fetch(request: Request): Promise<Response> };
  privateKeyPem: string;
  /** Mirror mode's remote authenticator; the seeded dev user otherwise. */
  authenticator?: SessionAuthenticator;
  log?: (line: string) => void;
}

export function createDevAppGateway(
  options: DevAppGatewayOptions,
): (request: Request) => Promise<Response> {
  const log = options.log ?? ((line: string) => console.log(line));
  const toolBus = createDevToolBus({
    apps: [
      {
        appId: options.app.appId,
        name: options.appName,
        baseUrl: options.appUrl,
        fetcher: options.appFetcher,
      },
    ],
    privateKeyPem: options.privateKeyPem,
    issuer: DEV_ISSUER,
    onToolCall: (event) =>
      log(
        chalk.dim(
          `  mcp ${event.tool} → ${event.decision === "blocked" ? `blocked (${event.reason})` : event.outcome} (${event.durationMs}ms)`,
        ),
      ),
    onCatalogProblem: (_appId, problem) =>
      log(chalk.yellow(`  Agent tools: ${problem}`)),
  });
  return createDevGatewayHandler({
    apps: [options.app],
    privateKeyPem: options.privateKeyPem,
    env: { [`APP__${options.app.workerName}`]: options.appFetcher },
    authenticator: options.authenticator,
    interceptMcp: ({ request, app, session }) =>
      toolBus.serveAppHost(request, app.appId, session),
  });
}
