/**
 * A provider tool's one way to the provider: the capability proxy
 * (../integration-proxy.ts), the same path an app's Worker takes, so the
 * same rules hold: the provider's hosts only, account-wide paths refused,
 * the key put on the call and never seen here, redirects refused, the
 * answer's `cost` read off its head. The call is attributed to the member
 * whose client called (the tool's verified identity) and counted in the
 * usage tables against the provider row, as an app's capability call is
 * counted against the app.
 *
 * The provider's answer comes back as parsed JSON; a refusal of the
 * gateway's own (no key, a path no app may reach) or an answer that isn't
 * JSON becomes a {@link ToolError}, which the model reads. Neither carries
 * the key or the raw answer.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  GATEWAY_ERROR_HEADER,
  PROVIDER_APPS,
  providerAppManifest,
} from "@every-app/sdk/internal";
import { ToolError, type ToolContext } from "@every-app/sdk/server";
import { checkMonthlyCap } from "@/server/app-cap";
import { noteCapCheck } from "@/server/events/cap-events";
import {
  handleIntegrationProxyRequest,
  type IntegrationProxyEnv,
} from "@/server/integration-proxy";
import { OrgAppSettingsRepository } from "@/server/repositories/OrgAppSettingsRepository";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import { dollarsToMicros, type UsageEvent } from "@/server/usage-event";
import type { ProviderAppEnv } from "./index";

/**
 * The most of a provider's answer a tool relays: under the ToolBus's 1 MiB
 * result cap with room for the result envelope.
 */
const MAX_ANSWER_BYTES = 768 * 1024;

let upstreamFetch: typeof fetch | undefined;

/** Tests stand in for the provider; `undefined` restores `fetch`. */
export function setProviderUpstreamFetchForTests(
  fetcher: typeof fetch | undefined,
): void {
  upstreamFetch = fetcher;
}

interface ProviderCallInput {
  /** One of the capability's hosts (`api.dataforseo.com`). */
  host: string;
  /** The path on it, with its leading slash. */
  path: string;
  method?: "GET" | "POST";
  /** The JSON body of a POST. */
  body?: unknown;
}

export interface ProviderAnswer {
  status: number;
  body: unknown;
}

/**
 * Call the provider for a tool handler. Resolves with the parsed JSON
 * answer and its status (the provider's own errors come back as answers,
 * for the tool to read); rejects with a {@link ToolError} for a refusal of
 * the gateway's or an answer that can't be relayed.
 */
export async function providerCall(
  context: ToolContext<ProviderAppEnv>,
  call: ProviderCallInput,
): Promise<ProviderAnswer> {
  const { PROVIDER_APP: app } = context.env;
  const { user } = context;
  const provider = PROVIDER_APPS[app.id];
  if (user.orgId !== app.organizationId) {
    // The ToolBus serves an organization's own rows to its members only.
    throw new ToolError(
      `${provider.name} isn't available to this organization.`,
    );
  }
  // The organization's monthly cap on the row's provider calls (Admin →
  // Usage), checked before anything reaches the provider, as the AppGateway
  // entrypoint checks it for an app's calls. A refused call is not counted.
  const cap = await checkMonthlyCap(
    {
      monthlyCallCap: OrgAppSettingsRepository.getMonthlyCap,
      monthlyCalls: UsageRepository.monthlyCalls,
    },
    app.organizationId,
    app.rowId,
  );
  // The standing goes to the event bus after the answer (cap.warning,
  // cap.reached, app.paused_cap), as the AppGateway entrypoint reports it.
  if (cap.cap !== undefined) {
    waitUntil(
      noteCapCheck(app.organizationId, app.rowId, cap).catch((error: unknown) =>
        logEvent(
          "events.cap_failed",
          {
            app: app.id,
            message: error instanceof Error ? error.message : String(error),
          },
          "warn",
        ),
      ),
    );
  }
  if (cap.exceeded) {
    logEvent(
      "usage.cap_exceeded",
      {
        organizationId: app.organizationId,
        appId: app.id,
        appRowId: app.rowId,
        cap: cap.cap,
        calls: cap.calls,
        month: cap.month,
      },
      "warn",
    );
    throw new ToolError(
      `${provider.name} has reached this organization's monthly cap of ${cap.cap} calls; an owner or admin raises it in Admin → Usage, or it resets with the next UTC month.`,
    );
  }
  const method = call.method ?? "POST";
  const request = new Request(
    `https://every-app-gateway.internal/api/integrations/${provider.capability}/${call.host}${call.path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(call.body ?? []) }),
      // The ToolBus's deadline (30 s) aborts the tools/call request it sent
      // in-process; carried here, it cancels the provider call too.
      signal: context.request.signal,
    },
  );
  const count = (
    event: Pick<UsageEvent, "status" | "calls" | "costMicros">,
  ) => {
    waitUntil(
      UsageRepository.record({
        organizationId: app.organizationId,
        appRowId: app.rowId,
        userId: user.id,
        kind: "capability",
        target: provider.capability,
        ...event,
      }).catch((error: unknown) =>
        logEvent(
          "usage.record.failed",
          {
            app: app.id,
            message: error instanceof Error ? error.message : String(error),
          },
          "warn",
        ),
      ),
    );
  };
  const response = await handleIntegrationProxyRequest({
    request,
    capabilities: providerAppManifest(app.id).capabilities,
    env: env as unknown as IntegrationProxyEnv,
    admit: async () => ({
      caller: {
        organizationId: app.organizationId,
        appId: app.id,
        worker: context.env.EVERYAPP_AUDIENCE,
        orgSource: "provider",
      },
      user,
    }),
    fetchUpstream: (upstream) => (upstreamFetch ?? fetch)(upstream),
    // Never reached: a provider app's manifest lists an api_key capability only.
    listMembers: async () => {
      throw new Error("A provider app lists no members.");
    },
    onCall: (report) => count({ status: report.status, calls: 1 }),
    onCost: (report) =>
      count({
        status: report.status,
        calls: 0,
        costMicros: dollarsToMicros(report.cost),
      }),
  });

  let text: string;
  try {
    text = await readCapped(response, provider.name);
  } catch (error) {
    if (context.request.signal.aborted) {
      throw new ToolError(`${provider.name} did not answer in time.`);
    }
    throw error;
  }
  if (context.request.signal.aborted) {
    throw new ToolError(`${provider.name} did not answer in time.`);
  }
  const refusal = response.headers.get(GATEWAY_ERROR_HEADER);
  if (refusal) {
    throw new ToolError(refusalMessage(provider.name, refusal, text));
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ToolError(
      `${provider.name} answered ${response.status} with something other than JSON.`,
    );
  }
  return { status: response.status, body };
}

/** The answer's text, or a tool error when it is more than a tool may relay. */
async function readCapped(response: Response, label: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ToolError(
        `${label}'s answer is larger than ${Math.round(MAX_ANSWER_BYTES / 1024)} KB; ask for fewer results (a smaller limit or depth).`,
      );
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * What the model reads for a refusal of the gateway's own: the refusal's
 * message (which names the fix: `everyapp secret set DATAFORSEO_API_KEY`),
 * never its body verbatim.
 */
function refusalMessage(label: string, code: string, text: string): string {
  let message: string | undefined;
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string") message = body.message;
  } catch {
    message = undefined;
  }
  if (code === "integration_not_configured") {
    return (
      message ??
      `${label} isn't set up on this gateway: its operator sets the key with everyapp secret set.`
    );
  }
  return `The gateway refused the call (${code})${message ? `: ${message}` : "."}`;
}
