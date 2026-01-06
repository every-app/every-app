import type { R2Bucket, R2BucketResult } from "./types";
import { makeCloudflareAPIRequest } from "./auth";

interface R2BucketAPIResponse {
  name: string;
  creation_date?: string;
  location?: string;
  storage_class?: string;
}

interface R2ListBucketsAPIResponse {
  buckets: R2BucketAPIResponse[];
}

/**
 * List all R2 buckets in the account using the Cloudflare REST API
 * GET /accounts/{account_id}/r2/buckets
 * Uses per_page=1000 to minimize pagination issues
 */
async function listR2Buckets(accountId: string): Promise<R2Bucket[]> {
  const result = await makeCloudflareAPIRequest<R2ListBucketsAPIResponse>(
    `/accounts/${accountId}/r2/buckets?per_page=1000`,
  );

  // Map API response to our R2Bucket type
  return result.buckets.map((bucket) => ({
    name: bucket.name,
    creation_date: bucket.creation_date,
  }));
}

/**
 * Create a new R2 bucket using the Cloudflare REST API
 * POST /accounts/{account_id}/r2/buckets
 * @returns The bucket name
 */
async function createR2Bucket(
  bucketName: string,
  accountId: string,
): Promise<string> {
  const result = await makeCloudflareAPIRequest<R2BucketAPIResponse>(
    `/accounts/${accountId}/r2/buckets`,
    {
      method: "POST",
      body: JSON.stringify({ name: bucketName }),
    },
  );

  if (!result || !result.name) {
    throw new Error("Failed to create R2 bucket: no name returned");
  }

  return result.name;
}

/**
 * Get an existing R2 bucket or create a new one
 * Pure function - no logging, returns structured result
 */
export async function getOrCreateR2Bucket(
  bucketName: string,
  accountId: string,
): Promise<R2BucketResult> {
  const buckets = await listR2Buckets(accountId);
  const existingBucket = buckets.find((bucket) => bucket.name === bucketName);

  if (existingBucket) {
    return {
      name: bucketName,
      wasCreated: false,
    };
  }

  await createR2Bucket(bucketName, accountId);
  return {
    name: bucketName,
    wasCreated: true,
  };
}
