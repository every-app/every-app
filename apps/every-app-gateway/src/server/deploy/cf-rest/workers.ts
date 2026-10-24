import type { CloudflareTransport } from "./client";

/** An account Worker, as the Workers API (`/workers/workers`) reports it. */
export interface AccountWorker {
  id: string;
  name: string;
  tags?: string[];
  created_on?: string;
  updated_on?: string;
  deployed_on?: string | null;
}

const PAGE_SIZE = 100;

/**
 * The account's own Workers (not the ones in a dispatch namespace): the
 * deployer checks the gateway and the shared first-party Workers exist.
 */
export function workers(transport: CloudflareTransport) {
  const path = (...segments: string[]) =>
    transport.accountPath("workers", "workers", ...segments);
  return {
    list: async (): Promise<AccountWorker[]> => {
      const all: AccountWorker[] = [];
      for (let page = 1; ; page++) {
        const { result, resultInfo } = await transport.requestWithInfo<
          AccountWorker[]
        >(
          `${path()}?page=${page}&per_page=${PAGE_SIZE}`,
          {},
          { context: "List Workers" },
        );
        all.push(...result);
        const totalPages = resultInfo?.total_pages;
        const done =
          totalPages !== undefined
            ? page >= totalPages
            : result.length < PAGE_SIZE;
        if (done) return all;
      }
    },
    /** By name or id. */
    get: (worker: string) =>
      transport.request<AccountWorker>(
        path(worker),
        {},
        {
          context: `Get Worker ${worker}`,
        },
      ),
    /** `force` deletes it even while other Workers still bind it. */
    delete: (worker: string, options: { force?: boolean } = {}) =>
      transport.request<null>(
        `${path(worker)}${options.force ? "?force=true" : ""}`,
        { method: "DELETE" },
        { context: `Delete Worker ${worker}` },
      ),
  };
}
