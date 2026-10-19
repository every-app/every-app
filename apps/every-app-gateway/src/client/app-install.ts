import { useQuery } from "@tanstack/react-query";

/**
 * Admin → Apps → Install from GitHub, over the session-authenticated admin
 * routes (server/deploy/install.ts): whether this gateway installs apps,
 * starting an install, and the deploy job it answers with.
 */

export interface InstallJob {
  id: string;
  status: "running" | "succeeded" | "failed";
  error: { code: string; message: string } | null;
  source: { repoUrl: string; tag: string | null; version: string } | null;
  app: { id: string; hostname: string | null; url: string | null } | null;
}

/** A refusal, with the route's code (`NO_RELEASE`, `INVALID_REPO_URL`, ...). */
export class AppInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppInstallError";
  }
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;
  if (!response.ok || !body) {
    throw new AppInstallError(
      body?.error ?? "INTERNAL_ERROR",
      body?.message ?? `The gateway answered ${response.status}.`,
    );
  }
  return body;
}

/** Whether this gateway installs apps from GitHub (hosted, past the launch gate). */
export function useAppInstallAvailable(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "app-install"],
    queryFn: async () =>
      (
        await answer<{ available: boolean }>(
          await fetch("/api/admin/apps/install"),
        )
      ).available,
    enabled,
    staleTime: 5 * 60_000,
  });
}

export async function startAppInstall(repoUrl: string): Promise<InstallJob> {
  const response = await fetch("/api/admin/apps/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });
  return (await answer<{ job: InstallJob }>(response)).job;
}

export async function fetchInstallJob(id: string): Promise<InstallJob> {
  const response = await fetch(`/api/admin/deploys/${encodeURIComponent(id)}`);
  return (await answer<{ job: InstallJob }>(response)).job;
}
