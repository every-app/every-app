/**
 * D1 databases and KV namespaces, found by their exact name (KV: title) on
 * every run and created when missing. Names are unique per account, so a
 * get-or-create is safe without a lock: a create that loses a race reads
 * the winner's. (App resources never take a winner's: lib/app/resources.ts
 * creates them with createD1/createKv and records what it created.)
 */
import type { z } from "zod";
import { CfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import {
  D1DatabaseListOutput,
  D1DatabaseOutput,
  KvNamespaceListOutput,
  KvNamespaceOutput,
} from "./schemas";

interface Resource {
  id: string;
  created: boolean;
}

const KV_PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** Every page of a list command, `perPage` at a time. */
export async function listAll<T>(
  cf: CfRunner,
  args: readonly string[],
  schema: z.ZodType<T[]>,
  perPage: number,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await runCfJson(
      cf,
      {
        plane: "account",
        args: [...args, "--per-page", String(perPage), "--page", String(page)],
      },
      schema,
    );
    items.push(...batch);
    if (batch.length < perPage) break;
  }
  return items;
}

export async function findD1(
  cf: CfRunner,
  name: string,
): Promise<string | null> {
  // --name matches loosely; only an exact name is this database.
  const databases = await runCfJson(
    cf,
    { plane: "account", args: ["d1", "list", "--name", name, "--per-page", "100"] },
    D1DatabaseListOutput,
  );
  return databases.find((database) => database.name === name)?.uuid ?? null;
}

/** Create a D1 database; fails (`already_exists`) when the name is taken. */
export async function createD1(cf: CfRunner, name: string): Promise<string> {
  const database = await runCfJson(
    cf,
    { plane: "account", args: ["d1", "create", "--name", name] },
    D1DatabaseOutput,
  );
  return database.uuid;
}

export async function getOrCreateD1(
  cf: CfRunner,
  name: string,
): Promise<Resource> {
  const existing = await findD1(cf, name);
  if (existing) return { id: existing, created: false };
  try {
    return { id: await createD1(cf, name), created: true };
  } catch (error) {
    const winner =
      error instanceof CfError && error.kind === "already_exists"
        ? await findD1(cf, name)
        : null;
    if (winner) return { id: winner, created: false };
    throw error;
  }
}

export async function findKv(
  cf: CfRunner,
  title: string,
): Promise<string | null> {
  const namespaces = await listAll(
    cf,
    ["kv", "namespaces", "list"],
    KvNamespaceListOutput,
    KV_PAGE_SIZE,
  );
  return namespaces.find((namespace) => namespace.title === title)?.id ?? null;
}

/** Create a KV namespace; fails (`already_exists`) when the title is taken. */
export async function createKv(cf: CfRunner, title: string): Promise<string> {
  const namespace = await runCfJson(
    cf,
    { plane: "account", args: ["kv", "namespaces", "create", "--title", title] },
    KvNamespaceOutput,
  );
  return namespace.id;
}

export async function getOrCreateKv(
  cf: CfRunner,
  title: string,
): Promise<Resource> {
  const existing = await findKv(cf, title);
  if (existing) return { id: existing, created: false };
  try {
    return { id: await createKv(cf, title), created: true };
  } catch (error) {
    const winner =
      error instanceof CfError && error.kind === "already_exists"
        ? await findKv(cf, title)
        : null;
    if (winner) return { id: winner, created: false };
    throw error;
  }
}

/**
 * Delete a D1 database. `--force` answers cf's confirmation, which nobody
 * can answer for a piped call, so callers decide first: only a resource the
 * registry recorded as the app's, after a person typed the app id.
 */
export async function deleteD1(cf: CfRunner, id: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["d1", "delete", id, "--force"],
  });
}

/** Delete a KV namespace and its keys, decided as for {@link deleteD1}. */
export async function deleteKv(cf: CfRunner, id: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["kv", "namespaces", "delete", id, "--force"],
  });
}
