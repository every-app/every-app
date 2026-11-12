/**
 * `everyapp ai show|default|gateway on|off`: the workspace's default model
 * (docs/design/2026-10-model-providers.md). `show` and `default` are each
 * one Gateway tool (`everyapp_ai_show`, `everyapp_ai_default`) run as you
 * (lib/gatewayApi). `ai gateway on|off` stays a Cloudflare job under the
 * login: it finds or makes the AI Gateway resource (lib/cf/aiGateway.ts)
 * and sets the Gateway setting AI_GATEWAY_ID through the same path
 * `secret set` takes.
 */
import { formatAiDefaultChoice, parseAiDefaultChoice } from "@every-app/sdk/internal";
import type { CfRunner } from "@/lib/cf/runner";
import { ensureAiGateway, isValidAiGatewayId, type AiGateway } from "@/lib/cf/aiGateway";
import { EveryAppError } from "@/lib/errors";
import { listGatewaySecretNames } from "@/lib/app/settings";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { formatRows, runTool, type ToolCommandFlags } from "@/lib/gatewayApi/command";
import type { JsonObject } from "@/lib/gatewayApi";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { commandLines, factLines, finish } from "@/lib/output/result";
import { runCommand } from "@/lib/output/run";
import { applyGatewaySettings } from "../secret";
import type { GatewayCommandFlags } from "../flags";

const DEFAULT_AI_GATEWAY_ID = "everyapp";

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** "OpenRouter: anthropic/claude-sonnet-5.5 (the stored choice)". */
const resolved = (answer: JsonObject) =>
  answer["provider"]
    ? `The default model: ${str(answer["label"]) || str(answer["provider"])}, ${str(answer["model"])} (${str(answer["source"])})`
    : `No default model yet${answer["problem"] ? `: ${str(answer["problem"])}` : ""}`;

/** The resolution, then every provider the default could be, in order. */
export const show = (flags: ToolCommandFlags) =>
  runTool(flags, {
    tool: "everyapp_ai_show",
    done: resolved,
    display: (answer) => formatRows(Array.isArray(answer["candidates"]) ? (answer["candidates"] as JsonObject[]) : []),
  });

/** `provider[/model]` or `off`, as `ai default` takes it. */
function defaultArgs(input: string): JsonObject {
  const value = input.trim();
  if (value === "off" || value === "none") return { clear: true };
  const choice = parseAiDefaultChoice(value);
  if (!choice) {
    throw new EveryAppError(
      "AI_DEFAULT_INVALID",
      `${input} isn't a provider: write the provider's id (openrouter), or the id and a model (openrouter/anthropic/claude-haiku-5.5), or off`,
      { fix: `${CLI} ai show names the providers the default can be` },
    );
  }
  return { provider: choice.provider, ...(choice.model ? { model: choice.model } : {}) };
}

export const setDefault = (flags: ToolCommandFlags, choice: string) =>
  runTool(flags, () => {
    const args = defaultArgs(choice);
    return Promise.resolve({
      tool: "everyapp_ai_default",
      args,
      done: (answer: JsonObject) =>
        args["clear"] ? `Cleared the default: ${resolved(answer)}` : `Chose ${formatAiDefaultChoice({ provider: String(args["provider"]), ...(typeof args["model"] === "string" ? { model: args["model"] } : {}) })}. ${resolved(answer)}`,
    });
  });

/** `ai gateway on|off`: what the handlers take, and the seams tests use. */
export interface AiOptions {
  flags: GatewayCommandFlags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** The AI Gateway resource (tests inject a fake; lib/cf/aiGateway.ts by default). */
  ensureAiGateway?: typeof ensureAiGateway;
}

export async function gatewayOn(flags: GatewayCommandFlags & { id?: string }): Promise<void> {
  await runCommand(flags, (out) => turnGatewayOn({ flags, out }, flags.id));
}

export async function gatewayOff(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => turnGatewayOff({ flags, out }));
}

function connect(options: AiOptions) {
  const { flags, out, createCf } = options;
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

export async function turnGatewayOn(options: AiOptions, id = DEFAULT_AI_GATEWAY_ID): Promise<void> {
  const { out } = options;
  const gatewayId = id.trim().toLowerCase();
  if (!isValidAiGatewayId(gatewayId)) {
    throw new EveryAppError(
      "AI_GATEWAY_ID_INVALID",
      `${id} isn't a valid AI Gateway id: lowercase letters, digits and single hyphens, 64 characters at most`,
      { fix: `${CLI} ai gateway on --id <name>` },
    );
  }
  const gateway = await connect(options);
  const ensure = options.ensureAiGateway ?? ensureAiGateway;
  out.emit({ type: "step", step: "ai.gateway", status: "start", message: `Finding AI Gateway ${gatewayId}...` });
  const made: AiGateway & { created: boolean } = await ensure(gateway.cf, { id: gatewayId, accountId: gateway.accountId });
  out.emit({
    type: "step",
    step: "ai.gateway",
    status: "ok",
    message: made.created ? `Made AI Gateway ${made.id}` : `AI Gateway ${made.id} exists`,
    data: { id: made.id, url: made.url, created: made.created },
  });
  await applyGatewaySettings(gateway, { AI_GATEWAY_ID: made.id }, { flags: options.flags, out });
  const account = [
    `Every model call to a provider AI Gateway fronts goes through ${made.url} from the Gateway's next request, the provider's own key still on it.`,
    `Logs: Cloudflare dashboard → AI → AI Gateway → ${made.id}. For an authenticated gateway: ${CLI} secret set AI_GATEWAY_API_KEY.`,
  ];
  finish(out, {
    headline: `Model calls now go through AI Gateway ${made.id}`,
    blocks: [factLines([{ label: "Logs", value: `Cloudflare dashboard → AI → AI Gateway → ${made.id}` }])],
    message: account,
    detail: account,
    data: { id: made.id, url: made.url, created: made.created },
  });
}

export async function turnGatewayOff(options: AiOptions): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const names = await listGatewaySecretNames(gateway.cf, gateway.names);
  if (!names.includes("AI_GATEWAY_ID")) {
    out.emit({ type: "done", message: "AI Gateway isn't in front: AI_GATEWAY_ID isn't set. Nothing changed.", data: { on: false, changed: false } });
    return;
  }
  await applyGatewaySettings(gateway, { AI_GATEWAY_ID: null }, { flags: options.flags, out });
  const keyStays = names.includes("AI_GATEWAY_API_KEY");
  const account = [
    `Model calls go direct from the Gateway's next request. The AI Gateway and its logs stay in the account${keyStays ? `; AI_GATEWAY_API_KEY stays until ${CLI} secret unset AI_GATEWAY_API_KEY` : ""}.`,
  ];
  finish(out, {
    headline: "Model calls now go direct to each provider",
    blocks: [keyStays ? commandLines("Clean up", [`${CLI} secret unset AI_GATEWAY_API_KEY`]) : []],
    message: account,
    detail: account,
    data: { on: false, changed: true },
  });
}
