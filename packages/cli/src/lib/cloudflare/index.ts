// Cloudflare utilities - pure functions with no logging
// Logging is handled at the call site for flexibility

export { applyResourcePrefix } from "./types";

export { getOrCreateD1Database, listD1Databases } from "./d1";
export { getOrCreateKVNamespace } from "./kv";
export {
  getDefaultAccountId,
  getValidOAuthToken,
  getWorkerUrl,
  getWorkersDevSubdomain,
  makeCloudflareAPIRequest,
} from "./auth";
