/**
 * `everyapp provider link composio` and `provider unlink composio`: the
 * Composio link of the person the credential acts as
 * (docs/design/2026-11-composio.md), as thin clients of the Gateway's
 * `everyapp_provider_composio*` tools (lib/gatewayApi). The Gateway holds
 * the sign-in and the key. `link` hands the sign-in's page to the person
 * (an `action_required` the run waits for), asks the Gateway every two
 * seconds whether they approved it, and ends by listing what is in their
 * Composio. Linking adds no connection: an account becomes one when an app
 * asks for it and the person says yes, on the Gateway's page.
 */
import chalk from "chalk";
import { EveryAppError } from "@/lib/errors";
import { openInBrowser } from "@/lib/gateway/setup-link";
import { openGatewayApi, type GatewayApi, type JsonObject } from "@/lib/gatewayApi";
import { runTool, type ToolCommandFlags } from "@/lib/gatewayApi/command";
import { CLI, thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { factLines, finish } from "@/lib/output/result";
import { runCommand } from "@/lib/output/run";

const STATUS_TOOL = "everyapp_provider_composio";
const LINK_TOOL = "everyapp_provider_composio_link";
const FINISH_TOOL = "everyapp_provider_composio_link_finish";
const UNLINK_TOOL = "everyapp_provider_composio_unlink";

const LINK_STEP = "provider.composio.link";
/** How long `link` waits between asking the Gateway whether the sign-in was approved. */
const CHECK_MS = 2000;

/** What linking did to the person's connections: said under whatever was found. */
const NOTHING_ADDED = "An account becomes a connection when an app asks for it and you say yes.";

const str = (value: unknown) => (typeof value === "string" ? value : "");
const rows = (value: unknown): JsonObject[] => (Array.isArray(value) ? (value as JsonObject[]) : []);

/** A provider's services found in the person's Composio, each with its accounts' names: "Gmail (alex@example.com), Calendar (alex@example.com)". */
function servicesOf(provider: JsonObject): string {
  return rows(provider["services"])
    .map((service) => {
      const accounts = (Array.isArray(service["accounts"]) ? service["accounts"] : []).map(String);
      return accounts.length > 0 ? `${str(service["name"])} (${accounts.join(", ")})` : str(service["name"]);
    })
    .join(", ");
}

/**
 * The run's result once the person's Composio is linked: who it is linked
 * as, what was found there that EveryApp supports (each provider with its
 * services and their accounts; one whose connection the person already
 * made through Composio says so), and that nothing was added.
 */
function reportLinked(api: GatewayApi, out: EventSink, tool: string, answer: JsonObject, already: boolean): void {
  const account = str(answer["account"]);
  const headline = `${already ? "Composio is already linked" : "Linked Composio"}${account ? ` as ${account}` : ""}`;
  const providers = Array.isArray(answer["providers"]) ? rows(answer["providers"]) : null;
  const found =
    providers === null
      ? ["Composio didn't answer, so what is in your Composio isn't listed."]
      : providers.length === 0
        ? ["Nothing EveryApp supports is connected in your Composio yet."]
        : factLines(
            providers.map((provider) => ({
              label: str(provider["providerName"]) || str(provider["provider"]),
              value: `${servicesOf(provider)}${provider["connected"] === true ? chalk.dim(" · connected") : ""}`,
            })),
            "In your Composio",
          );
  finish(out, {
    headline,
    blocks: [found, [NOTHING_ADDED]],
    message: [
      headline,
      ...(providers !== null && providers.length > 0
        ? [
            `In your Composio: ${providers
              .map((provider) => `${str(provider["providerName"]) || str(provider["provider"])}: ${servicesOf(provider)}`)
              .join("; ")}`,
          ]
        : found),
      NOTHING_ADDED,
    ],
    data: {
      gateway: api.gateway,
      tool,
      ...answer,
      // Composio didn't answer: the same command lists it once it does.
      ...(providers === null ? { next: [{ command: `${CLI} provider link composio`, note: "lists what is in it" }] } : {}),
    },
  });
}

/**
 * `provider link composio`. Someone already linked gets the list alone.
 * Otherwise a sign-in is started at Composio and its page goes to the
 * person as `action_required composio_sign_in` with `waiting: true` (at a
 * terminal it opens in their browser too); the Gateway is asked every two
 * seconds until they approved it (the list, as `done`) or it ran out
 * (COMPOSIO_LINK_EXPIRED, whose rerun starts another). While the
 * organization has Composio off, COMPOSIO_OFF names the command that turns
 * it on.
 */
export const link = (flags: ToolCommandFlags) =>
  runCommand(flags, async (out) => {
    const api = await openGatewayApi({ flags, out });
    const status = await api.call(STATUS_TOOL);
    if (status["linked"] === true) {
      reportLinked(api, out, STATUS_TOOL, status, true);
      return;
    }
    if (status["composio"] === "off") {
      throw new EveryAppError(
        "COMPOSIO_OFF",
        "Composio is off for this organization\nAn owner or admin turns it on. Nothing was linked.",
        { rerun: `${CLI} workspace composio on`, rerunNote: "then link again", data: { gateway: api.gateway } },
      );
    }
    const started = await api.call(LINK_TOOL);
    const url = str(started["url"]);
    out.emit({
      type: "action_required",
      action: "composio_sign_in",
      step: LINK_STEP,
      message: "Approve the sign-in at Composio",
      data: {
        url,
        expiresAt: str(started["expiresAt"]),
        waiting: true,
        waitingFor: "your approval",
        gateway: api.gateway,
      },
    });
    if (canPromptInTerminal(flags.json ?? false)) await openInBrowser(url);
    let answer: JsonObject;
    do {
      await new Promise((resolve) => setTimeout(resolve, CHECK_MS));
      answer = await api.call(FINISH_TOOL);
    } while (answer["state"] === "waiting");
    if (answer["state"] !== "linked") {
      throw new EveryAppError(
        "COMPOSIO_LINK_EXPIRED",
        "The Composio sign-in ran out before it was approved\nNothing was linked.",
        { rerun: thisCommand(), rerunNote: "starts a new one", data: { gateway: api.gateway } },
      );
    }
    reportLinked(api, out, FINISH_TOOL, answer, false);
  });

/** What unlinking removed, and what it left at Composio. */
const UNLINKED = [
  "The connections made through it are gone.",
  "The key stays valid at Composio until you revoke it there.",
];

/** `provider unlink composio`: the Gateway drops the key and every connection the person made through it. */
export const unlink = (flags: ToolCommandFlags) =>
  runTool(flags, {
    tool: UNLINK_TOOL,
    done: (answer) => (answer["removed"] === true ? ["Unlinked Composio", ...UNLINKED].join("\n") : "Composio was already unlinked"),
    display: () => "",
    short: (answer) =>
      answer["removed"] === true ? { headline: "Unlinked Composio", blocks: [UNLINKED] } : { headline: "Composio was already unlinked" },
  });
