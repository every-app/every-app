/**
 * `everyapp ai show|list|default|gateway on|off`: the Gateway's default
 * model provider (docs/design/2026-10-model-providers.md), from the
 * terminal under the Cloudflare login. The reading and writing is
 * lib/gateway/aiDefault.ts; this file says what happened. The AI Gateway
 * switch creates a Cloudflare resource (lib/cf/aiGateway.ts, the Resource
 * provisioners thread's library) and records its id as a Gateway setting
 * through the same path `secret set` takes.
 */
import chalk from "chalk";
import { formatAiDefaultChoice, type AiDefaultCandidate, type AiDefaultResolution } from "@every-app/sdk/internal";
import type { CfRunner } from "@/lib/cf/runner";
import { ensureAiGateway, isValidAiGatewayId, type AiGateway } from "@/lib/cf/aiGateway";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { aiReport, parseAiDefaultArgument, setAiDefault, type AiReport } from "@/lib/gateway/aiDefault";
import { openWorkspace, type Workspace } from "@/lib/gateway/workspace";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { listed } from "@/lib/output/text";
import { applyGatewaySettings } from "../secret";
import type { GatewayCommandFlags } from "../flags";

/** What the handlers take from the command line, and the seams tests use. */
export interface AiOptions {
  flags: GatewayCommandFlags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  now?: () => number;
  /** The AI Gateway resource (tests inject a fake; lib/cf/aiGateway.ts by default). */
  ensureAiGateway?: typeof ensureAiGateway;
}

const DEFAULT_AI_GATEWAY_ID = "everyapp";
const STEP = "ai.update";

export async function show(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => showDefault({ flags, out }));
}

export async function list(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => listCandidates({ flags, out }));
}

export async function setDefault(flags: GatewayCommandFlags, choice: string): Promise<void> {
  await runCommand(flags, (out) => chooseDefault({ flags, out }, choice));
}

export async function gatewayOn(flags: GatewayCommandFlags & { id?: string }): Promise<void> {
  await runCommand(flags, (out) => turnGatewayOn({ flags, out }, flags.id));
}

export async function gatewayOff(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => turnGatewayOff({ flags, out }));
}

interface Connected {
  gateway: Awaited<ReturnType<typeof connectToGateway>>;
  ws: Workspace;
}

/** The Gateway through the login, and the install organization's workspace. */
async function connect(options: AiOptions): Promise<Connected> {
  const { flags, out, createCf } = options;
  const gateway = await connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
  const ws = await openWorkspace(gateway.db, gateway.deployer, { now: options.now?.() });
  return { gateway, ws };
}

/** The resolution as `--json` carries it, with the AI Gateway state. */
function reportData(report: AiReport): Record<string, unknown> {
  const { resolution, aiGateway } = report;
  return {
    provider: resolution.provider,
    label: resolution.label,
    model: resolution.model,
    source: resolution.source,
    configured: resolution.configured,
    settings: resolution.settings,
    via: resolution.via,
    chat: resolution.chat,
    ...(resolution.embeddings ? { embeddings: resolution.embeddings } : {}),
    candidates: resolution.candidates,
    ...(resolution.problem ? { problem: resolution.problem } : {}),
    aiGateway,
  };
}

/** "OpenRouter (anthropic/claude-haiku-5.5)". */
const named = (resolution: Pick<AiDefaultResolution, "label" | "model">) => `${resolution.label} (${resolution.model})`;

/** One line per candidate: the id, its name, the key, set or not, and the model. */
function candidateRows(candidates: readonly AiDefaultCandidate[], current: string): string[][] {
  return candidates.map((candidate) => [
    candidate.id === current ? chalk.bold(candidate.id) : candidate.id,
    candidate.label,
    candidate.configured ? chalk.green("set") : chalk.dim("not set"),
    candidate.settings.join(" "),
    candidate.model,
    candidate.id === current ? chalk.green("← the default") : "",
  ]);
}

function sourceSentence(report: AiReport): string {
  const { resolution } = report;
  switch (resolution.source) {
    case "setting":
      return resolution.configured
        ? `Chosen with ${CLI} ai default; ${resolution.settings.join(" and ")} ${resolution.settings.length === 1 ? "is" : "are"} set.`
        : `Chosen with ${CLI} ai default, but ${listed(resolution.settings)} ${resolution.settings.length === 1 ? "isn't" : "aren't"} set: apps get ai_default_not_configured until ${CLI} secret set ${resolution.settings.join(" ")}.`;
    case "order":
      return `Nothing chosen: the first provider of the order whose key is set. ${CLI} ai default <provider> picks another.`;
    case "none":
      return `Nothing is set yet: apps that need a chat model show "Needs setup" until one key is set (${CLI} secret set ${resolution.settings.join(" ")}, or any provider's below).`;
  }
}

export async function showDefault(options: AiOptions): Promise<void> {
  const { out } = options;
  const { gateway, ws } = await connect(options);
  const report = await aiReport(gateway.cf, ws);
  const { resolution, aiGateway } = report;
  const lines = [
    ...formatFacts([
      { label: "Default", value: resolution.configured ? named(resolution) : `${named(resolution)} ${chalk.yellow("not configured")}` },
      { label: "Route", value: `/api/ai/default/v1/chat/completions → ${resolution.chat.path}${resolution.embeddings ? `; /v1/embeddings → ${resolution.embeddings.path}` : ""}` },
      { label: "Through", value: aiGateway.on ? "Cloudflare AI Gateway" : `direct (${CLI} ai gateway on puts AI Gateway in front)` },
    ]),
    "",
    sourceSentence(report),
    ...(resolution.problem ? [chalk.yellow(`The stored choice can't serve: ${resolution.problem}.`)] : []),
    "",
    ...formatTable(["Provider", "Name", "Key", "Setting", "Model", ""], candidateRows(resolution.candidates, resolution.provider)),
  ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    data: reportData(report),
  });
}

export async function listCandidates(options: AiOptions): Promise<void> {
  const { out } = options;
  const { gateway, ws } = await connect(options);
  const report = await aiReport(gateway.cf, ws);
  const { resolution } = report;
  out.emit({
    type: "done",
    message: [
      ...formatTable(["Provider", "Name", "Key", "Setting", "Model", ""], candidateRows(resolution.candidates, resolution.provider)),
      "",
      `An app that pins a provider lists it under providers; one that takes the default says ai: { chat: true }. ${CLI} ai default <provider>[/<model>] chooses.`,
    ].join("\n"),
    data: { candidates: resolution.candidates, provider: resolution.provider, aiGateway: report.aiGateway },
  });
}

export async function chooseDefault(options: AiOptions, argument: string): Promise<void> {
  const { out } = options;
  const choice = parseAiDefaultArgument(argument);
  const { gateway, ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: "Setting the default model provider..." });
  const change = await setAiDefault(ws, choice);
  const report = await aiReport(gateway.cf, ws);
  const { resolution } = report;
  const says = (value: typeof choice) => (value === null ? "the shipped order" : formatAiDefaultChoice(value));
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `${ws.organization.name}: the default model provider is ${says(choice)}`,
    data: { choice: choice === null ? null : formatAiDefaultChoice(choice), was: change.was === null ? null : formatAiDefaultChoice(change.was) },
  });
  const lines = [
    change.changed
      ? `${ws.organization.name}: the default is ${says(choice)} (was ${says(change.was)}).`
      : `${ws.organization.name} had ${says(choice)} already. Nothing changed.`,
    `Apps that ask for the default get ${named(resolution)} on the Gateway within 30 seconds.`,
  ];
  if (!resolution.configured) {
    lines.push(
      chalk.yellow(
        `${listed(resolution.settings)} ${resolution.settings.length === 1 ? "isn't" : "aren't"} set: until then those apps get ai_default_not_configured. Set it: ${CLI} secret set ${resolution.settings.join(" ")}`,
      ),
    );
  }
  out.emit({ type: "done", message: lines.join("\n"), data: reportData(report) });
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
  const connection = await connect(options);
  const ensure = options.ensureAiGateway ?? ensureAiGateway;
  out.emit({ type: "step", step: "ai.gateway", status: "start", message: `Finding AI Gateway ${gatewayId}...` });
  const made: AiGateway & { created: boolean } = await ensure(connection.gateway.cf, {
    id: gatewayId,
    accountId: connection.gateway.accountId,
  });
  out.emit({
    type: "step",
    step: "ai.gateway",
    status: "ok",
    message: made.created ? `Made AI Gateway ${made.id}` : `AI Gateway ${made.id} exists`,
    data: { id: made.id, url: made.url, created: made.created },
  });
  await applyGatewaySettings(connection.gateway, { AI_GATEWAY_ID: made.id }, { flags: options.flags, out });
  out.emit({
    type: "done",
    message: [
      `Every model call to a provider AI Gateway fronts goes through ${made.url} from the Gateway's next request, the provider's own key still on it.`,
      `Logs: Cloudflare dashboard → AI → AI Gateway → ${made.id}. For an authenticated gateway: ${CLI} secret set AI_GATEWAY_API_KEY.`,
    ].join("\n"),
    data: { id: made.id, url: made.url, created: made.created },
  });
}

export async function turnGatewayOff(options: AiOptions): Promise<void> {
  const { out } = options;
  const connection = await connect(options);
  const report = await aiReport(connection.gateway.cf, connection.ws);
  if (!report.names.includes("AI_GATEWAY_ID")) {
    out.emit({ type: "done", message: "AI Gateway isn't in front: AI_GATEWAY_ID isn't set. Nothing changed.", data: { on: false, changed: false } });
    return;
  }
  await applyGatewaySettings(connection.gateway, { AI_GATEWAY_ID: null }, { flags: options.flags, out });
  out.emit({
    type: "done",
    message: `Model calls go direct from the Gateway's next request. The AI Gateway and its logs stay in the account${report.names.includes("AI_GATEWAY_API_KEY") ? `; AI_GATEWAY_API_KEY stays until ${CLI} secret unset AI_GATEWAY_API_KEY` : ""}.`,
    data: { on: false, changed: true },
  });
}
