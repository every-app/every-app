import { z } from "zod";

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
 * Result of an R2 bucket get-or-create operation
 */
export interface R2BucketResult {
  name: string;
  wasCreated: boolean;
}

/**
 * R2 bucket info from Cloudflare API
 */
export interface R2Bucket {
  name: string;
  creation_date?: string;
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
 * Cloudflare membership info from API (includes pending invitations)
 */
export interface MembershipInfo {
  id: string;
  status: "accepted" | "pending" | "rejected";
  account: {
    id: string;
    name: string;
  };
}

/**
 * Worker subdomain info from API
 */
export interface WorkerSubdomain {
  subdomain: string;
}
