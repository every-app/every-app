import chalk from "chalk";
import { getValidOAuthToken } from "@/lib/cloudflare";

interface D1QueryResponse<T = any> {
  results: T[];
  success: boolean;
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

interface D1APIResponse<T = any> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: D1QueryResponse<T>[];
}

/**
 * Query a D1 database using the HTTP API
 * @param accountId - Cloudflare account ID
 * @param databaseId - D1 database UUID
 * @param sql - SQL query to execute (use ? for parameterized queries)
 * @param params - Optional array of parameters to bind to the query
 * @returns Array of results
 */
export async function queryD1Database<T = any>(
  accountId: string,
  databaseId: string,
  sql: string,
  params?: (string | number | null)[],
): Promise<T[]> {
  try {
    const accessToken = await getValidOAuthToken();

    const body: { sql: string; params?: (string | number | null)[] } = { sql };
    if (params && params.length > 0) {
      body.params = params;
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const data = (await response.json()) as D1APIResponse<T>;

    if (!response.ok || !data.success) {
      const errorDetails = data.errors
        ? data.errors.map((e) => `[${e.code}] ${e.message}`).join(", ")
        : response.statusText;
      console.error(chalk.red("\nD1 Query Error:"));
      console.error(chalk.dim(`SQL: ${sql}`));
      console.error(chalk.dim(`Error: ${errorDetails}`));
      throw new Error(`D1 query failed: ${errorDetails}`);
    }

    const result = data.result;
    if (!result || result.length === 0) {
      throw new Error("No results returned from D1 query");
    }

    const firstResult = result[0];
    if (!firstResult) {
      throw new Error("First result is undefined");
    }

    return firstResult.results;
  } catch (error) {
    if (error instanceof Error && !error.message.includes("D1 query failed")) {
      console.error(chalk.red("\nD1 Query Error:"));
      console.error(chalk.dim(`SQL: ${sql}`));
    }
    throw error;
  }
}
