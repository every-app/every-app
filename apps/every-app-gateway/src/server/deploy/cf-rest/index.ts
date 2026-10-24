/**
 * A typed client for the Cloudflare REST API calls the hosted deployer
 * makes: Workers for Platforms namespaces and scripts, D1, the account's
 * Workers, and static assets. Pure fetch, so it runs in a Worker as well
 * as in Node; no wrangler, no cf CLI. Two runtimes use it: Node (the
 * CLI's fake-Cloudflare test imports this folder by path, and any Node
 * caller) and Workers (the hosted deployer).
 *
 *   const cf = createCloudflareRest({ apiToken, accountId });
 *   await cf.dispatchScripts.upload("every-app-apps", "acme--todo", { metadata, modules });
 */
import { CloudflareTransport, type CloudflareTransportOptions } from "./client";
import { d1 } from "./d1";
import { dispatchAssets, workerAssets } from "./assets";
import { dispatchNamespaces, dispatchScripts } from "./dispatch";
import { workers } from "./workers";
import { scripts } from "./scripts";

export function createCloudflareRest(options: CloudflareTransportOptions) {
  const transport = new CloudflareTransport(options);
  return {
    accountId: transport.accountId,
    dispatchNamespaces: dispatchNamespaces(transport),
    dispatchScripts: dispatchScripts(transport),
    dispatchAssets: dispatchAssets(transport),
    workerAssets: workerAssets(transport),
    d1: d1(transport),
    workers: workers(transport),
    scripts: scripts(transport),
  };
}

export type CloudflareRest = ReturnType<typeof createCloudflareRest>;

export {
  CLOUDFLARE_API_BASE_URL,
  type CloudflareResultInfo,
  type CloudflareTransportOptions,
} from "./client";
export {
  CLOUDFLARE_ERROR_CODES,
  CloudflareApiError,
  isCloudflareNotFound,
  type CloudflareErrorDetail,
} from "./errors";
export {
  MODULE_CONTENT_TYPES,
  type DeleteByTagsResult,
  type DispatchNamespace,
  type DispatchScript,
  type DispatchScriptDetails,
  type DispatchScriptSecret,
  type TagFilter,
} from "./dispatch";
export type {
  D1Database,
  D1LocationHint,
  D1Param,
  D1QueryResult,
  D1Statement,
} from "./d1";
export type { AccountWorker } from "./workers";
export { assetHash, type AssetFile } from "./assets";
export type * from "./types";
