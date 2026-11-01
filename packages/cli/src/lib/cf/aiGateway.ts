import { aiGatewaySettings, aiGatewayUpdate } from "@every-app/perimeter/install";
/**
 * Cloudflare AI Gateways, by id. An app's own (`resources.aiGateway`,
 * lib/app/resources.ts) and the Gateway's account-level one (the Model
 * providers' `AI_GATEWAY_ID`, `everyapp` by default) both come through
 * here.
 *
 * The contract other commands call (the Model providers' `everyapp ai
 * gateway`): `findAiGateway`, `ensureAiGateway` (`{ id, accountId,
 * collectLogs?, cacheTtl? }` → `{ id, url, created }`), `deleteAiGateway`,
 * `listAiGateways`, `aiGatewayUrl` and `isValidAiGatewayId`. The deploy also
 * uses `createAiGateway` (a create that fails on a taken id, for the
 * resource ledger) and `updateAiGateway`.
 *
 * A gateway is created with Cloudflare's required settings in a body file
 * (`--body @<file>`): logs collected unless `collectLogs` is false, no
 * cache unless `cacheTtl` says how many seconds, no rate limit, and no
 * authentication (callers send their own provider keys; an authenticated
 * gateway would need a Cloudflare token the app doesn't have). Ids are
 * lowercase letters and digits joined by single hyphens, at most 64
 * characters (`isAiGatewayId`): `[7001] not valid ID format` otherwise.
 */
import { isAiGatewayId } from "@every-app/perimeter/manifest";
import { aiGatewayUrl } from "@every-app/sdk/cloudflare";
import { isCfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import {
  AiGatewayListOutput,
  AiGatewayOutput,
  type AiGateway as AiGatewayRecord,
} from "./schemas";

/**
 * A gateway as the callers of {@link ensureAiGateway} see it (the Model
 * providers' `everyapp ai gateway on` and the deploy): its id and its URL,
 * `https://gateway.ai.cloudflare.com/v1/<accountId>/<id>`. The account's
 * full record is {@link AiGatewayRecord}.
 */
export interface AiGateway {
  id: string;
  url: string;
}

export { aiGatewayUrl };

/**
 * Whether Cloudflare takes `id` as a gateway's: lowercase letters and
 * digits joined by single hyphens (no `--`), at most 64 characters.
 */
export function isValidAiGatewayId(id: string): boolean {
  return isAiGatewayId(id);
}

/** The settings the deploy keeps as the manifest says. */
interface AiGatewaySettings {
  /** Whether the gateway logs each request; true unless false. */
  collectLogs?: boolean;
  /** Seconds a response stays cached; 0 (nothing cached) unless set. */
  cacheTtl?: number;
}

function assertId(id: string): void {
  if (!isValidAiGatewayId(id)) {
    throw new Error(
      `"${id}" isn't an AI Gateway id Cloudflare takes: lowercase letters and digits joined by single hyphens, at most 64 characters.`,
    );
  }
}

/** The gateway with this id, or null when the account has none. */
export async function findAiGateway(cf: CfRunner, id: string): Promise<AiGatewayRecord | null> {
  try {
    return await runCfJson(
      cf,
      { plane: "account", args: ["ai-gateway", "gateways", "get", id] },
      AiGatewayOutput,
    );
  } catch (error) {
    // `[7002] Not Found` (404), seen live.
    if (isCfError(error, "not_found")) return null;
    throw error;
  }
}

/**
 * Create a gateway; fails (`already_exists`: `[7001] An object with this
 * id already exists`) when the id is taken.
 */
export async function createAiGateway(
  cf: CfRunner,
  id: string,
  settings: AiGatewaySettings = {},
): Promise<AiGatewayRecord> {
  assertId(id);
  const { collectLogs, cacheTtl } = aiGatewaySettings(settings);
  return runCfJson(
    cf,
    {
      plane: "account",
      files: {
        "ai-gateway.json": {
          id,
          collect_logs: collectLogs,
          cache_ttl: cacheTtl,
          cache_invalidate_on_update: false,
          rate_limiting_interval: 0,
          rate_limiting_limit: 0,
          authentication: false,
        },
      },
      args: (files) => ["ai-gateway", "gateways", "create", "--body", `@${files["ai-gateway.json"]!}`],
    },
    AiGatewayOutput,
  );
}

/**
 * The gateway with this id, created when the account has none (also when
 * another run created it meanwhile: idempotent). An existing one is used
 * as it is, its settings untouched. `created` says whether this call made it.
 */
export async function ensureAiGateway(
  cf: CfRunner,
  options: { id: string; accountId: string } & AiGatewaySettings,
): Promise<{ id: string; url: string; created: boolean }> {
  const { id, accountId, ...settings } = options;
  assertId(id);
  const result = (created: boolean) => ({ id, url: aiGatewayUrl(accountId, id), created });
  if (await findAiGateway(cf, id)) return result(false);
  try {
    await createAiGateway(cf, id, settings);
    return result(true);
  } catch (error) {
    if (isCfError(error, "already_exists") && (await findAiGateway(cf, id))) {
      return result(false);
    }
    throw error;
  }
}

/**
 * Change a gateway's logging and caching, keeping every other setting it
 * reads back (the update is a PUT).
 */
export async function updateAiGateway(
  cf: CfRunner,
  gateway: AiGatewayRecord,
  settings: AiGatewaySettings,
): Promise<AiGatewayRecord> {
  return runCfJson(
    cf,
    {
      plane: "account",
      files: {
        "ai-gateway.json": aiGatewayUpdate(gateway, settings),
      },
      args: (files) => ["ai-gateway", "gateways", "update", gateway.id, "--body", `@${files["ai-gateway.json"]!}`],
    },
    AiGatewayOutput,
  );
}

/**
 * Delete a gateway, its settings and its stored logs. `--force` answers
 * cf's confirmation, which nobody can answer for a piped call, so callers
 * decide first (lib/cf/resources.ts deleteD1). A missing one throws
 * `not_found`.
 */
export async function deleteAiGateway(cf: CfRunner, id: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["ai-gateway", "gateways", "delete", id, "--force"],
  });
}

const PAGE_SIZE = 20;
const MAX_PAGES = 50;

/**
 * The account's gateways whose id matches `search` (Cloudflare's search by
 * id), every page. A page that brings nothing new ends the listing too,
 * so an API that ignores the page asked for can't loop.
 */
export async function listAiGateways(cf: CfRunner, search: string): Promise<AiGatewayRecord[]> {
  const gateways = new Map<string, AiGatewayRecord>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await runCfJson(
      cf,
      {
        plane: "account",
        args: [
          "ai-gateway",
          "gateways",
          "list",
          "--search",
          search,
          "--per-page",
          String(PAGE_SIZE),
          "--page",
          String(page),
        ],
      },
      AiGatewayListOutput,
    );
    const before = gateways.size;
    for (const gateway of batch) gateways.set(gateway.id, gateway);
    if (batch.length < PAGE_SIZE || gateways.size === before) break;
  }
  return [...gateways.values()];
}
