/**
 * Provider apps as the gateway serves them (`@every-app/sdk/internal`
 * providerApps.ts; the row is written by `everyapp provider on`): a data
 * provider offered to members' AI clients as an app of the gateway's own,
 * with no Worker. Each is an SDK app (`everyApp()` with `defineTools()`)
 * that runs inside the gateway Worker, so the catalog snapshot, tools/list,
 * the per-call identity, policy, the audit row and the usage counters are
 * the ones every app gets; the one seam that differs is how the ToolBus
 * reaches it ({@link providerAppFetcher}: in-process, instead of a service
 * binding).
 *
 * Identity: the gateway mints each call's identity for `aud`
 * {@link providerAudience} (`provider:<row id>`), never a Worker name, and
 * the in-process app verifies it with the gateway's own public key, so a
 * token minted for one organization's row never opens another's. Every
 * tool calls the provider through the capability proxy's rules (./call.ts).
 *
 * The catalog is versioned by its content: {@link providerCatalogVersion}
 * is what a provider row's snapshot records as its version, so a gateway
 * whose provider tools changed re-syncs the snapshot on first use.
 */
import { env, waitUntil } from "cloudflare:workers";
import {
  AppUnreachableError,
  logEvent,
  type AppFetcher,
} from "@every-app/perimeter";
import {
  isProviderAppId,
  mintSystemJwt,
  PROVIDER_APP_IDS,
  SYSTEM_HEADER,
  TOOLS_LIST_PATH,
  TOOLS_PROTOCOL_VERSION,
  type ProviderAppId,
} from "@every-app/sdk/internal";
import { everyApp, type ToolSet } from "@every-app/sdk/server";
import { exportJWK, exportSPKI, importJWK, importPKCS8 } from "jose";
import { dataforseoTools } from "./dataforseo";

const AUDIENCE_PREFIX = "provider:";

/** The `aud` of every token minted for a provider app's row. */
export function providerAudience(rowId: string): string {
  return `${AUDIENCE_PREFIX}${rowId}`;
}

/**
 * The origin the tools contract is called under for a provider app, and
 * the URL `everyapp_list_apps` shows for it: the gateway's own (its tools
 * live on the gateway's /mcp; the in-process app reads no host).
 */
export function providerBaseUrl(): string {
  return gatewayUrl();
}

/** What a provider tool's handler reads from its `env`: the row it serves. */
export interface ProviderAppEnv {
  EVERYAPP_APP_ID: string;
  EVERYAPP_AUDIENCE: string;
  /** The provider row the call is counted against. */
  PROVIDER_APP: { rowId: string; organizationId: string; id: ProviderAppId };
}

const TOOL_SETS: Record<ProviderAppId, ToolSet> = {
  dataforseo: dataforseoTools,
};

/** The registry facts a provider app's fetcher needs. */
interface ProviderAppRoute {
  rowId: string;
  organizationId: string;
  appSlug: string;
}

function settings(): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

/** `GATEWAY_URL` as it is: the `iss` the ToolBus and the catalog sync mint with. */
function issuer(): string {
  const value = settings()["GATEWAY_URL"];
  if (typeof value !== "string" || !value.trim()) {
    throw new AppUnreachableError(
      "Provider apps need GATEWAY_URL on the gateway.",
    );
  }
  return value;
}

/** The gateway's URL as an origin, for the URLs a provider app is shown under. */
function gatewayUrl(): string {
  return issuer().trim().replace(/\/+$/, "");
}

let derivedPublicKey: Promise<string> | undefined;

/**
 * The public key the in-process app verifies identities with: the
 * gateway's `JWT_PUBLIC_KEY`, or, where an install never wrote it, the
 * public half of `JWT_PRIVATE_KEY` (derived once per isolate).
 */
function publicKeyPem(): Promise<string> {
  const set = settings()["JWT_PUBLIC_KEY"];
  if (typeof set === "string" && set.trim()) {
    return Promise.resolve(set.replace(/\\n/g, "\n"));
  }
  derivedPublicKey ??= (async () => {
    const privateKey = settings()["JWT_PRIVATE_KEY"];
    if (typeof privateKey !== "string" || !privateKey.trim()) {
      throw new AppUnreachableError(
        "Provider apps need JWT_PRIVATE_KEY (or JWT_PUBLIC_KEY) on the gateway to verify tool-call identities.",
      );
    }
    const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "RS256", {
      extractable: true,
    });
    // The public half: the private JWK without its private members.
    const { kty, n, e } = await exportJWK(key);
    const publicKey = await importJWK({ kty, n, e }, "RS256", {
      extractable: true,
    });
    if (!(publicKey instanceof CryptoKey)) {
      throw new AppUnreachableError("JWT_PRIVATE_KEY is not an RSA key.");
    }
    return exportSPKI(publicKey);
  })().catch((error: unknown) => {
    derivedPublicKey = undefined;
    throw error;
  });
  return derivedPublicKey;
}

/** The SDK app for a provider, verifying identities minted for `route`'s row. */
async function providerApp(
  route: ProviderAppRoute & { appSlug: ProviderAppId },
) {
  const app = everyApp<ProviderAppEnv>(
    async () => new Response("Not found", { status: 404 }),
    { id: route.appSlug },
    {
      publicKeys: [await publicKeyPem()],
      issuer: issuer(),
      tools: TOOL_SETS[route.appSlug],
    },
  );
  const appEnv: ProviderAppEnv = {
    EVERYAPP_APP_ID: route.appSlug,
    EVERYAPP_AUDIENCE: providerAudience(route.rowId),
    PROVIDER_APP: {
      rowId: route.rowId,
      organizationId: route.organizationId,
      id: route.appSlug,
    },
  };
  const ctx = {
    waitUntil,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return (request: Request) => app.fetch(request, appEnv, ctx);
}

/**
 * Reach a provider app's tools in-process: the SDK app for the provider,
 * verifying identities minted for this row with the gateway's public key.
 * Built per request; `defineTools()` keeps the catalog itself per isolate.
 */
export function providerAppFetcher(route: ProviderAppRoute): AppFetcher {
  if (!isProviderAppId(route.appSlug)) {
    throw new AppUnreachableError(
      `"${route.appSlug}" is not a provider app this gateway serves.`,
    );
  }
  const app = providerApp({ ...route, appSlug: route.appSlug });
  return { fetch: async (request) => (await app)(request) };
}

let catalogVersion: Promise<string> | undefined;

/** What the version reads as while the gateway can't compute it; never remembered. */
const VERSION_UNAVAILABLE = "provider:unavailable";

export function resetProviderCatalogVersionForTests(): void {
  catalogVersion = undefined;
}

/**
 * One version for every provider catalog this gateway serves: a digest of
 * each provider's catalog hash, read through the tools contract itself
 * (the in-process app's `/__everyapp/tools/list` under a system token),
 * once per isolate. A provider row's snapshot records it; a snapshot
 * recording another is re-synced on first use, as a redeployed app's is.
 * Never rejects: a gateway that can't compute it (no signing key) reads
 * {@link VERSION_UNAVAILABLE} for this request, logged, so the other
 * apps' snapshots are synced all the same.
 */
export function providerCatalogVersion(): Promise<string> {
  catalogVersion ??= computeCatalogVersion().catch((error: unknown) => {
    catalogVersion = undefined;
    logEvent(
      "mcp.catalog.provider_version_unavailable",
      { message: error instanceof Error ? error.message : String(error) },
      "warn",
    );
    return VERSION_UNAVAILABLE;
  });
  return catalogVersion;
}

async function computeCatalogVersion(): Promise<string> {
  const iss = issuer();
  const origin = gatewayUrl();
  const privateKeyPem = settings()["JWT_PRIVATE_KEY"];
  if (typeof privateKeyPem !== "string" || !privateKeyPem.trim()) {
    throw new Error("Provider apps need JWT_PRIVATE_KEY on the gateway.");
  }
  const parts: string[] = [];
  for (const id of PROVIDER_APP_IDS) {
    // Any row: the catalog is the provider's, not the row's.
    const route = { rowId: `catalog-${id}`, organizationId: "", appSlug: id };
    const token = await mintSystemJwt(privateKeyPem.replace(/\\n/g, "\n"), {
      audience: providerAudience(route.rowId),
      issuer: iss,
      purpose: "tools.list",
    });
    const response = await providerAppFetcher(route).fetch(
      new Request(new URL(TOOLS_LIST_PATH, origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SYSTEM_HEADER]: token,
        },
        body: JSON.stringify({ v: TOOLS_PROTOCOL_VERSION }),
      }),
    );
    const body = (await response.json()) as { hash?: unknown };
    if (!response.ok || typeof body.hash !== "string") {
      throw new Error(`The ${id} provider app's catalog could not be read.`);
    }
    parts.push(`${id}=${body.hash}`);
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\n")),
  );
  let hex = "";
  for (const byte of new Uint8Array(digest).subarray(0, 16)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `provider:${hex}`;
}
