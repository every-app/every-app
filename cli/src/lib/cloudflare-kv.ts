import { execa } from "execa";
import chalk from "chalk";

async function listKVNamespaces(): Promise<any[]> {
  const { stdout } = await execa("npx", [
    "wrangler",
    "kv",
    "namespace",
    "list",
  ]);
  return JSON.parse(stdout);
}

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

function parseKVNamespaceId(output: string): string {
  const idMatch = output.match(/"id":\s*"([a-f0-9]+)"/);
  if (!idMatch || !idMatch[1]) {
    throw new Error("Failed to parse namespace ID from wrangler output");
  }
  return idMatch[1];
}

export async function getOrCreateKVNamespace(
  namespaceName: string,
): Promise<string> {
  console.log(chalk.bold(`Checking KV namespace: ${namespaceName}\n`));

  try {
    const namespaces = await listKVNamespaces();
    const existingNamespace = namespaces.find(
      (ns: any) => ns.title === namespaceName,
    );

    if (existingNamespace) {
      console.log(
        chalk.green(
          `Linking to existing KV namespace: ${namespaceName} (${existingNamespace.id})\n`,
        ),
      );
      return existingNamespace.id;
    }

    console.log(chalk.bold(`Creating new KV namespace: ${namespaceName}\n`));
    const namespaceId = await createKVNamespace(namespaceName);
    console.log(
      chalk.green(`Created KV namespace: ${namespaceName} (${namespaceId})\n`),
    );

    return namespaceId;
  } catch (error) {
    console.error(
      chalk.red(`\nFailed to get or create KV namespace: ${namespaceName}`),
      error instanceof Error ? chalk.dim(`\n   ${error.message}`) : "",
    );
    throw error;
  }
}
