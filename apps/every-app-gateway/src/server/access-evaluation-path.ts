/** Where Cloudflare Access asks the Gateway who is a member (access-evaluation.ts), kept apart so the worker entry loads that module only when Access calls. */
export const ACCESS_EVALUATION_PREFIX = "/access-evaluation/";
