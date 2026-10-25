/**
 * Cloudflare AI Gateway resources through `cf ai-gateway gateways …`: find
 * one, make one when it is missing, delete one. The contract agreed with
 * the Resource provisioners thread on 2026-10-25 (its PR "AI Gateway"
 * lands the probed implementation and the fake account's commands; this
 * file is the same signature so `everyapp ai gateway on` compiles and
 * tests inject a fake). An id is lowercase letters, digits and single
 * hyphens, 64 characters at most (Cloudflare refuses `--`, `_` and
 * uppercase); new gateways are made unauthenticated.
 */
import { z } from "zod";
import { CfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";

export interface AiGateway {
  id: string;
  /** `https://gateway.ai.cloudflare.com/v1/<accountId>/<id>`. */
  url: string;
}

const AI_GATEWAY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `id` is a name Cloudflare accepts for a gateway. */
export function isValidAiGatewayId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && AI_GATEWAY_ID.test(id);
}

function aiGatewayUrl(accountId: string, id: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(id)}`;
}

const GatewayOutput = z.object({ id: z.string() }).passthrough();

/** The gateway `id`, or null when the account has none by that name. */
async function findAiGateway(cf: CfRunner, id: string): Promise<{ id: string } | null> {
  try {
    const found = await runCfJson(cf, { plane: "account", args: ["ai-gateway", "gateways", "get", id] }, GatewayOutput);
    return { id: found.id };
  } catch (error) {
    if (error instanceof CfError && (error.kind === "not_found" || /not[_ ]found/i.test(error.message))) return null;
    throw error;
  }
}

/**
 * The gateway `id` in the account, made when it is missing (logs
 * collected, no cache unless `cacheTtl`), with its URL. Idempotent.
 */
export async function ensureAiGateway(
  cf: CfRunner,
  options: { id: string; accountId: string; collectLogs?: boolean; cacheTtl?: number },
): Promise<AiGateway & { created: boolean }> {
  const { id, accountId } = options;
  if (!isValidAiGatewayId(id)) {
    throw new Error(`${id} isn't a valid AI Gateway id: lowercase letters, digits and single hyphens, 64 at most`);
  }
  const found = await findAiGateway(cf, id);
  if (found) return { id: found.id, url: aiGatewayUrl(accountId, found.id), created: false };
  const made = await runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "ai-gateway",
        "gateways",
        "create",
        id,
        "--collect-logs",
        String(options.collectLogs ?? true),
        ...(options.cacheTtl === undefined ? [] : ["--cache-ttl", String(options.cacheTtl)]),
      ],
    },
    GatewayOutput,
  );
  return { id: made.id, url: aiGatewayUrl(accountId, made.id), created: true };
}

