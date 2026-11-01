import type { InstallationError } from "./error";
import type { HyperdriveOrigin } from "./secrets";

export interface HyperdriveConfig {
  id: string;
  name: string;
  origin?: {
    host?: string | null;
    port?: number | null;
    database?: string | null;
    user?: string | null;
    scheme?: string | null;
  } | null;
  caching?: { disabled?: boolean | null } | null;
}
export type HyperdriveCaching = "off" | "default";
export type VectorizeShape =
  { dimensions: number; metric: string } | { preset: string };
export interface VectorizeIndex {
  name: string;
  config?: {
    dimensions?: number | null;
    metric?: string | null;
    preset?: string | null;
  } | null;
}
export interface Queue {
  queue_id: string;
  queue_name: string;
}
export interface AiGateway {
  [key: string]: unknown;
  id: string;
  collect_logs?: boolean | null;
  cache_ttl?: number | null;
  authentication?: boolean | null;
}
export interface SecretsStore {
  id: string;
  name: string;
}
export interface SecretsStoreSecret {
  id: string;
  name: string;
  status?: string | null;
}
export interface AiGatewaySettings {
  collectLogs?: boolean;
  cacheTtl?: number;
}

/** Account API operations. The CLI uses cf; the Worker uses Cloudflare REST. */
export interface ResourceOperations<C> {
  Error: new (
    code: string,
    message: string,
    options?: InstallationError["options"],
  ) => Error;
  CLI: string;
  thisCommand(): string;
  isCfError(
    error: unknown,
    kind: "already_exists" | "unknown" | "r2_not_enabled",
  ): boolean;
  findD1(cf: C, name: string): Promise<string | null>;
  createD1(cf: C, name: string): Promise<string>;
  findKv(cf: C, name: string): Promise<string | null>;
  createKv(cf: C, name: string): Promise<string>;
  findR2Bucket(cf: C, name: string): Promise<boolean>;
  createR2Bucket(cf: C, name: string): Promise<void>;
  getWorkerDeployment(cf: C, name: string): Promise<unknown | null>;
  findHyperdrive(cf: C, name: string): Promise<HyperdriveConfig | null>;
  createHyperdrive(
    cf: C,
    name: string,
    origin: HyperdriveOrigin,
    caching: HyperdriveCaching,
  ): Promise<string>;
  updateHyperdrive(
    cf: C,
    id: string,
    change: { origin?: HyperdriveOrigin; caching?: HyperdriveCaching },
  ): Promise<void>;
  listQueues(cf: C): Promise<Queue[]>;
  getQueue(cf: C, id: string): Promise<Queue | null>;
  createQueue(cf: C, name: string): Promise<string>;
  getVectorizeIndex(cf: C, name: string): Promise<VectorizeIndex | null>;
  createVectorizeIndex(
    cf: C,
    name: string,
    shape: VectorizeShape,
  ): Promise<VectorizeIndex>;
  findAiGateway(cf: C, id: string): Promise<AiGateway | null>;
  createAiGateway(
    cf: C,
    id: string,
    settings: AiGatewaySettings,
  ): Promise<AiGateway>;
  updateAiGateway(
    cf: C,
    existing: AiGateway,
    settings: AiGatewaySettings,
  ): Promise<AiGateway>;
  listSecretsStores(cf: C): Promise<SecretsStore[]>;
  findStoreSecret(
    cf: C,
    storeId: string,
    name: string,
  ): Promise<SecretsStoreSecret | null>;
  createStoreSecret(
    cf: C,
    storeId: string,
    name: string,
    value: string,
  ): Promise<string>;
}
