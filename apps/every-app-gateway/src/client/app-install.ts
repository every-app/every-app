import { useQuery } from "@tanstack/react-query";

/**
 * Admin → Apps → Install app, over the session-authenticated admin
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

interface AppInstallContext {
  available: boolean;
  workspaces: Array<{ id: string; name: string }>;
  defaultOrganizationId: string | null;
}

interface InstallReleaseReview {
  sha256: string;
  appId: string;
  installed: { name: string; status: string } | null;
  name: string;
  version: string;
  resources: Record<string, unknown>;
  providers: Array<{
    id: string;
    name: string;
    hosts: string[];
    settings: string[];
  }>;
  fields: Array<{
    name: string;
    label: string;
    secret: boolean;
    optional: boolean;
    default?: string;
  }>;
}

export async function reviewAppInstall(input: {
  sourceUrl: string;
  organizationId: string;
}): Promise<InstallReleaseReview> {
  return (
    await answer<{ release: InstallReleaseReview }>(
      await installRequest(input, { review: true }),
    )
  ).release;
}

function installRequest(
  input: { sourceUrl: string; organizationId: string },
  options: Record<string, unknown> = {},
): Promise<Response> {
  return fetch("/api/admin/apps/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: input.organizationId,
      ...options,
      ...(input.sourceUrl.startsWith("https://github.com/")
        ? { repoUrl: input.sourceUrl }
        : { releaseUrl: input.sourceUrl }),
    }),
  });
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

/** Whether this Gateway installs apps itself. */
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

/** Workspaces the signed-in user can install into, with their active one preferred. */
/** `enabled`: false until this page load's session check has answered. */
export function useAppInstallContext(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "app-install", "context"],
    enabled,
    queryFn: async () =>
      answer<AppInstallContext>(await fetch("/api/admin/apps/install/context")),
    staleTime: 0,
  });
}

export async function startAppInstall({
  sourceUrl,
  organizationId,
  sha256,
  configuration,
}: {
  sourceUrl: string;
  organizationId: string;
  sha256?: string;
  configuration?: {
    values: Record<string, string>;
    allowDeleteDurableObjectData?: boolean;
    allowDeleteWorkflows?: boolean;
    replaceChangedWorkers?: boolean;
    registerProviders?: boolean;
    enableEmailRouting?: boolean;
  };
}): Promise<InstallJob> {
  const response = await installRequest(
    { sourceUrl, organizationId },
    { sha256, configuration },
  );
  return (await answer<{ job: InstallJob }>(response)).job;
}

export async function fetchInstallJob(
  id: string,
  organizationId: string,
): Promise<InstallJob> {
  const response = await fetch(
    `/api/admin/deploys/${encodeURIComponent(id)}?organizationId=${encodeURIComponent(organizationId)}`,
  );
  return (await answer<{ job: InstallJob }>(response)).job;
}
