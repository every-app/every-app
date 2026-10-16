import { json, type CloudflareTransport } from "./client";
import { CloudflareApiError } from "./errors";

export interface D1Database {
  uuid: string;
  name: string;
  created_at?: string;
  version?: string;
  num_tables?: number;
  file_size?: number;
}

export type D1Param = string | number | boolean | null;

export interface D1Statement {
  sql: string;
  params?: D1Param[];
}

export interface D1QueryResult<Row = Record<string, unknown>> {
  results: Row[];
  success: boolean;
  meta?: {
    changes?: number;
    changed_db?: boolean;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
    duration?: number;
  };
}

export type D1LocationHint = "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";

/** D1 over the REST API: what the deployer provisions and migrates for an app. */
export function d1(transport: CloudflareTransport) {
  const path = (...segments: string[]) =>
    transport.accountPath("d1", "database", ...segments);

  const run = async <Row>(
    databaseId: string,
    body: D1Statement | { batch: D1Statement[] },
    context: string,
  ): Promise<D1QueryResult<Row>[]> => {
    const results = await transport.request<D1QueryResult<Row>[]>(
      path(databaseId, "query"),
      json("POST", body),
      { context },
    );
    // Cloudflare reports a failed statement in an otherwise successful
    // envelope only in theory; fail closed if it ever does.
    if (results.some((result) => result.success === false)) {
      throw new CloudflareApiError({
        status: 200,
        context,
        message: "a statement did not succeed",
      });
    }
    return results;
  };

  return {
    create: (
      name: string,
      options: {
        primaryLocationHint?: D1LocationHint;
        jurisdiction?: "eu" | "fedramp";
      } = {},
    ) =>
      transport.request<D1Database>(
        path(),
        json("POST", {
          name,
          ...(options.primaryLocationHint
            ? { primary_location_hint: options.primaryLocationHint }
            : {}),
          ...(options.jurisdiction
            ? { jurisdiction: options.jurisdiction }
            : {}),
        }),
        { context: `Create D1 database ${name}` },
      ),
    get: (databaseId: string) =>
      transport.request<D1Database>(
        path(databaseId),
        {},
        {
          context: `Get D1 database ${databaseId}`,
        },
      ),
    delete: (databaseId: string) =>
      transport.request<null>(
        path(databaseId),
        { method: "DELETE" },
        {
          context: `Delete D1 database ${databaseId}`,
        },
      ),
    /** One statement with `?` parameters; its rows. */
    query: async <Row = Record<string, unknown>>(
      databaseId: string,
      sql: string,
      params: D1Param[] = [],
    ): Promise<D1QueryResult<Row>> => {
      const [result] = await run<Row>(
        databaseId,
        { sql, params },
        `Query D1 database ${databaseId}`,
      );
      if (!result) {
        throw new CloudflareApiError({
          status: 200,
          context: `Query D1 database ${databaseId}`,
          message: "no result for the statement",
        });
      }
      return result;
    },
    /** Statements run in order, in one transaction; a result for each. */
    batch: async <Row = Record<string, unknown>>(
      databaseId: string,
      statements: D1Statement[],
    ): Promise<D1QueryResult<Row>[]> => {
      const context = `Batch on D1 database ${databaseId}`;
      const results = await run<Row>(
        databaseId,
        { batch: statements },
        context,
      );
      if (results.length !== statements.length) {
        throw new CloudflareApiError({
          status: 200,
          context,
          message: `${results.length} results for ${statements.length} statements`,
        });
      }
      return results;
    },
  };
}
