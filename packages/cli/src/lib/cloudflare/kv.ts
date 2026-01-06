import type { KVNamespace, KVNamespaceResult } from "./types";
import { makeCloudflareAPIRequest } from "./auth";

interface KVNamespaceAPIResponse {
  id: string;
  title: string;
  supports_url_encoding?: boolean;
}

/**
 * List all KV namespaces in the account using the Cloudflare REST API
 * GET /accounts/{account_id}/storage/kv/namespaces
 * Uses per_page=1000 to minimize pagination issues
 */
async function listKVNamespaces(accountId: string): Promise<KVNamespace[]> {
  const result = await makeCloudflareAPIRequest<KVNamespaceAPIResponse[]>(
    `/accounts/${accountId}/storage/kv/namespaces?per_page=1000`,
  );

  // Map API response to our KVNamespace type
  return result.map((ns) => ({
    id: ns.id,
    title: ns.title,
  }));
}

/**
 * Create a new KV namespace using the Cloudflare REST API
 * POST /accounts/{account_id}/storage/kv/namespaces
 * @returns The namespace ID
 */
async function createKVNamespace(
  namespaceName: string,
  accountId: string,
): Promise<string> {
  const result = await makeCloudflareAPIRequest<KVNamespaceAPIResponse>(
    `/accounts/${accountId}/storage/kv/namespaces`,
    {
      method: "POST",
      body: JSON.stringify({ title: namespaceName }),
    },
  );

  if (!result || !result.id) {
    throw new Error("Failed to create KV namespace: no ID returned");
  }

  return result.id;
}

/**
 * Get an existing KV namespace or create a new one
 * Pure function - no logging, returns structured result
 */
export async function getOrCreateKVNamespace(
  namespaceName: string,
  accountId: string,
): Promise<KVNamespaceResult> {
  const namespaces = await listKVNamespaces(accountId);
  const existingNamespace = namespaces.find((ns) => ns.title === namespaceName);

  if (existingNamespace) {
    return {
      id: existingNamespace.id,
      name: namespaceName,
      wasCreated: false,
    };
  }

  const namespaceId = await createKVNamespace(namespaceName, accountId);
  return {
    id: namespaceId,
    name: namespaceName,
    wasCreated: true,
  };
}
