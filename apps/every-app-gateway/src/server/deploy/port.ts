/**
 * What the deploy pipeline (./pipeline.ts) asks of Cloudflare, and nothing
 * more: the app's D1 databases, its Worker in the dispatch namespace, and
 * the bindings Cloudflare says that Worker has. CfRestDeployer
 * (./cfRestDeployer.ts) is the one implementation; the port keeps the
 * pipeline's rules apart from the REST calls.
 */
import type {
  ListedWorkerBinding,
  WorkerMetadata,
  WorkerModule,
} from "@/server/deploy/cf-rest";

interface DeployStatement {
  sql: string;
  params?: Array<string | number | null>;
}

export interface DeployerPort {
  /** Create a D1 database; its id. */
  createDatabase(name: string): Promise<string>;
  /** The id of the database named exactly `name`, or null. */
  findDatabase(name: string): Promise<string | null>;
  /** Statements run in order, in one transaction; each one's rows. */
  batch(
    databaseId: string,
    statements: readonly DeployStatement[],
  ): Promise<Array<Array<Record<string, unknown>>>>;
  /**
   * The namespaced Worker's Durable Object migration tag: null when it has
   * none, undefined when there is no such Worker.
   */
  scriptMigrationTag(workerName: string): Promise<string | null | undefined>;
  /** Upload static assets; the completion token for the upload's metadata. */
  uploadAssets(
    workerName: string,
    files: Record<string, { bytes: Uint8Array; contentType?: string }>,
  ): Promise<string>;
  /** Upload a version of the Worker; its version, as Cloudflare names it. */
  upload(
    workerName: string,
    upload: { metadata: WorkerMetadata; modules: WorkerModule[] },
  ): Promise<{ versionId: string }>;
  /** The bindings Cloudflare holds for the Worker now. */
  bindings(workerName: string): Promise<ListedWorkerBinding[]>;
  deleteScript(workerName: string): Promise<void>;
}
