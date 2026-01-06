// Cloudflare utilities - pure functions with no logging
// Logging is handled at the call site for flexibility

export { applyResourcePrefix } from "./types";
export type { AccountInfo, WorkerSubdomain } from "./types";

export { getOrCreateD1Database, listD1Databases } from "./d1";
export { getOrCreateKVNamespace } from "./kv";
export { getOrCreateR2Bucket } from "./r2";
export {
  getDefaultAccountId,
  getValidCloudflareToken,
  getWorkerUrl,
  getWorkersDevSubdomain,
  makeCloudflareAPIRequest,
  requireCloudflareAuth,
} from "./auth";
