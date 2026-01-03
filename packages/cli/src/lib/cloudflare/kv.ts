import { execa } from "execa";
import type { KVNamespace, KVNamespaceResult } from "./types";

/**
 * List all KV namespaces in the account
 */
async function listKVNamespaces(): Promise<KVNamespace[]> {
  const { stdout } = await execa("npx", [
    "wrangler",
    "kv",
    "namespace",
    "list",
  ]);
  return JSON.parse(stdout);
}

/**
 * Create a new KV namespace
 * @returns The namespace ID
 */
async function createKVNamespace(namespaceName: string): Promise<string> {
  const { stdout } = await execa("npx", [
    "wrangler",
    "kv",
    "namespace",
    "create",
    namespaceName,
  ]);

  return parseKVNamespaceId(stdout);
}

/**
 * Parse the namespace ID from wrangler output
 */
function parseKVNamespaceId(output: string): string {
  const idMatch = output.match(/"id":\s*"([a-f0-9]+)"/);
  if (!idMatch || !idMatch[1]) {
    throw new Error("Failed to parse namespace ID from wrangler output");
  }
  return idMatch[1];
}

/**
 * Get an existing KV namespace or create a new one
 * Pure function - no logging, returns structured result
 */
export async function getOrCreateKVNamespace(
  namespaceName: string,
): Promise<KVNamespaceResult> {
  const namespaces = await listKVNamespaces();
  const existingNamespace = namespaces.find(
    (ns) => ns.title === namespaceName,
  );

  if (existingNamespace) {
    return {
      id: existingNamespace.id,
      name: namespaceName,
      wasCreated: false,
    };
  }

  const namespaceId = await createKVNamespace(namespaceName);
  return {
    id: namespaceId,
    name: namespaceName,
    wasCreated: true,
  };
}
