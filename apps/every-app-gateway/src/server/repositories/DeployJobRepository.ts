import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { deployJobs } from "@/db/schema";

/**
 * How long a job may run: the deployer works inside the request that
 * started it (20 seconds inline, routes.ts) and the 30 seconds Workers give
 * `waitUntil` after it, so a job still `running` this long after it
 * started lost its isolate, and the app is free to deploy again.
 */
const DEPLOY_JOB_DEADLINE_MS = 5 * 60 * 1000;

type DeployJobStatus = "running" | "succeeded" | "failed";

/** The GitHub release a job deploys (server/deploy/install.ts). */
export interface DeployJobSource {
  repoUrl: string;
  /** The release's tag, as GitHub's redirect named it. */
  tag: string | null;
  version: string;
  gitSha: string;
}

export interface DeployJob {
  id: string;
  organizationId: string;
  appRowId: string;
  status: DeployJobStatus;
  error: { code: string; message: string } | null;
  source: DeployJobSource | null;
  createdAt: Date;
  finishedAt: Date | null;
}

function parseError(raw: string | null): DeployJob["error"] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    return { code: String(parsed.code), message: String(parsed.message) };
  } catch {
    return { code: "DEPLOY_FAILED", message: raw };
  }
}

function parseSource(raw: string | null): DeployJobSource | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeployJobSource;
  } catch {
    return null;
  }
}

function toJob(
  row: typeof deployJobs.$inferSelect,
  now = Date.now(),
): DeployJob {
  const stale =
    row.status === "running" &&
    row.createdAt.getTime() + DEPLOY_JOB_DEADLINE_MS <= now;
  return {
    id: row.id,
    organizationId: row.organizationId,
    appRowId: row.appRowId,
    status: stale ? "failed" : (row.status as DeployJobStatus),
    error: stale
      ? {
          code: "DEPLOY_ABANDONED",
          message:
            "The deploy stopped without finishing: the gateway gives a deploy about 50 seconds, and a large app (many assets, slow migrations) can run out of them. Deploy again.",
        }
      : parseError(row.error),
    source: parseSource(row.source),
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * Start a job for the app, unless one is running (and not past its
 * deadline): one statement, so two deploys of one app never both start.
 * Null when another is running.
 */
async function start(
  organizationId: string,
  appRowId: string,
  source: DeployJobSource | null,
): Promise<DeployJob | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = (await db.all(
    sql`INSERT INTO deploy_jobs (id, organization_id, app_row_id, status, source, created_at)
SELECT ${id}, ${organizationId}, ${appRowId}, 'running', ${source ? JSON.stringify(source) : null}, ${now}
WHERE NOT EXISTS (
  SELECT 1 FROM deploy_jobs WHERE app_row_id = ${appRowId} AND status = 'running'
    AND created_at > ${now - DEPLOY_JOB_DEADLINE_MS}
)
RETURNING id`,
  )) as Array<{ id: string }>;
  if (inserted.length === 0) return null;
  return {
    id,
    organizationId,
    appRowId,
    status: "running",
    error: null,
    source,
    createdAt: new Date(now),
    finishedAt: null,
  };
}

async function finish(
  id: string,
  outcome:
    | { status: "succeeded" }
    | { status: "failed"; code: string; message: string },
): Promise<void> {
  await db
    .update(deployJobs)
    .set({
      status: outcome.status,
      error:
        outcome.status === "failed"
          ? JSON.stringify({ code: outcome.code, message: outcome.message })
          : null,
      finishedAt: new Date(),
    })
    .where(and(eq(deployJobs.id, id), eq(deployJobs.status, "running")));
}

/** The organization's job, or null (another organization's included). */
async function findForOrganization(
  id: string,
  organizationId: string,
): Promise<DeployJob | null> {
  const [row] = await db
    .select()
    .from(deployJobs)
    .where(
      and(eq(deployJobs.id, id), eq(deployJobs.organizationId, organizationId)),
    );
  return row ? toJob(row) : null;
}

export const DeployJobRepository = {
  start,
  finish,
  findForOrganization,
} as const;
