/**
 * The gateway-lite for one app: the real perimeter with the app registered,
 * and `<app>.localhost/mcp` served by a local ToolBus from the app's live
 * `defineTools()` catalog, with the gateway's policy and identity contract.
 * Both sign with the SDK's well-known dev keypair.
 */
import {
  createDevGatewayHandler,
  type RegisteredApp,
  type SessionAuthenticator,
} from "@every-app/perimeter/dev";
import { DEV_ISSUER, DEV_PRIVATE_KEY_PEM } from "@every-app/sdk/dev";
import { createDevToolBus } from "@every-app/toolbus/dev";
import type { EventSink } from "@/lib/output/events";

/** `destructive_requires_approval` as words. */
const words = (code: string) => code.replaceAll("_", " ");

interface DevAppGatewayOptions {
  app: RegisteredApp;
  appName?: string;
  /** The app's URL on the gateway-lite, e.g. `http://todo.localhost:8787`. */
  appUrl: string;
  /** Reaches the app's dev server. */
  appFetcher: { fetch(request: Request): Promise<Response> };
  /** Mirror mode's remote authenticator; the seeded dev user otherwise. */
  authenticator?: SessionAuthenticator;
  /** Where tool calls and catalog problems are reported. */
  out: EventSink;
}

export function createDevAppGateway(
  options: DevAppGatewayOptions,
): (request: Request) => Promise<Response> {
  const { out } = options;
  const toolBus = createDevToolBus({
    apps: [
      {
        appId: options.app.appId,
        name: options.appName,
        baseUrl: options.appUrl,
        fetcher: options.appFetcher,
      },
    ],
    privateKeyPem: DEV_PRIVATE_KEY_PEM,
    issuer: DEV_ISSUER,
    onToolCall: (event) =>
      out.emit({
        type: "progress",
        step: "dev.mcp",
        message: [
          "MCP",
          event.tool,
          event.decision === "blocked"
            ? `blocked${event.reason ? `: ${words(event.reason)}` : ""}`
            : `${words(event.outcome)}  ${event.durationMs}ms`,
        ].join("  "),
        data: {
          tool: event.tool,
          decision: event.decision,
          reason: event.reason,
          outcome: event.outcome,
          durationMs: event.durationMs,
        },
      }),
    onCatalogProblem: (appId, problem) =>
      out.emit({
        type: "warning",
        code: "TOOLS_CATALOG",
        step: "dev.mcp",
        message: `Agent tools: ${problem}`,
        data: { appId },
      }),
  });
  return createDevGatewayHandler({
    apps: [options.app],
    env: { [`APP__${options.app.workerName}`]: options.appFetcher },
    authenticator: options.authenticator,
    interceptMcp: ({ request, app, session }) =>
      toolBus.serveAppHost(request, app.appId, session),
  });
}
