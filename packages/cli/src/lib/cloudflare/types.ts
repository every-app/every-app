import { z } from "zod";

/**
 * Resource prefix for all Every App managed Cloudflare resources
 */
const RESOURCE_PREFIX = "every-";

/**
 * Apply the resource prefix to a name, but only if it doesn't already have it
 */
export function applyResourcePrefix(name: string): string {
  if (name.startsWith(RESOURCE_PREFIX)) {
    return name;
  }
  return `${RESOURCE_PREFIX}${name}`;
}

/**
 * Result of a D1 database get-or-create operation
 */
export interface D1DatabaseResult {
  id: string;
  name: string;
  wasCreated: boolean;
}

/**
 * Result of a KV namespace get-or-create operation
 */
export interface KVNamespaceResult {
  id: string;
  name: string;
  wasCreated: boolean;
}

/**
 * D1 database info from Cloudflare API
 */
const D1DatabaseSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  created_at: z.string().optional(),
  version: z.string().optional(),
});

export type D1Database = z.infer<typeof D1DatabaseSchema>;

export const D1DatabaseListSchema = z.array(D1DatabaseSchema);

/**
 * KV namespace info from Cloudflare API
 */
export interface KVNamespace {
  id: string;
  title: string;
}

/**
 * Cloudflare account info from API
 */
export interface AccountInfo {
  id: string;
  name: string;
}

/**
 * Worker subdomain info from API
 */
export interface WorkerSubdomain {
  subdomain: string;
}
