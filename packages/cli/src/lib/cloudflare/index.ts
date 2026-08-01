// Cloudflare utilities - pure functions with no logging
// Logging is handled at the call site for flexibility

export type { AccountInfo } from "./types";

export { getOrCreateD1Database, listD1Databases } from "./d1";
export { getOrCreateKVNamespace } from "./kv";
export { getOrCreateR2Bucket } from "./r2";
export {
  getAccountById,
  getDefaultAccountId,
  getValidCloudflareToken,
  getWorkerUrl,
  makeCloudflareAPIRequest,
  requireCloudflareAuth,
} from "./auth";
export { getGatewayPublicUrl } from "./gatewayPublicUrl";
export { formatCloudflareError } from "./errors";
export {
  getMemberships,
  displayAccountInfo,
  resolveAccountFromMemberships,
} from "./memberships";
export { ensureWorkersDevSubdomain } from "./subdomain";
export {
  computeGatewayServiceBindings,
  replaceGatewayServiceBindings,
  type GatewayServiceBinding,
} from "./serviceBindings";
export {
  ensureProxiedWildcardDnsRecord,
  resolvesThroughCloudflare,
  verifyZoneOnAccount,
} from "./domain";
