/**
 * The shapes of Cloudflare's Workers upload API that the hosted deployer
 * sends and reads, named as the API names them. Not exhaustive: a binding
 * kind or metadata field the deployer has no use for is left out, so the
 * compiler rejects it rather than letting it through untyped.
 */

export type WorkerModuleType =
  "esm" | "cjs" | "text" | "data" | "wasm" | "sourcemap";

export interface WorkerModule {
  /** The part name and filename; `main_module` names one of these. */
  name: string;
  type: WorkerModuleType;
  content: string | Uint8Array;
}

export type WorkerBinding =
  | { type: "plain_text"; name: string; text: string }
  | { type: "json"; name: string; json: unknown }
  /** Write-only: Cloudflare lists it back without `text`. */
  | { type: "secret_text"; name: string; text: string }
  | { type: "d1"; name: string; id: string }
  | { type: "kv_namespace"; name: string; namespace_id: string }
  | {
      type: "r2_bucket";
      name: string;
      bucket_name: string;
      jurisdiction?: string;
    }
  | {
      type: "service";
      name: string;
      service: string;
      entrypoint?: string;
      environment?: string;
      /** Static props the target's WorkerEntrypoint reads as `ctx.props`. */
      props?: Record<string, unknown>;
    }
  | {
      type: "durable_object_namespace";
      name: string;
      class_name: string;
      script_name?: string;
      namespace_id?: string;
    }
  | {
      type: "workflow";
      name: string;
      workflow_name: string;
      class_name?: string;
      script_name?: string;
    }
  | { type: "hyperdrive"; name: string; id: string }
  | { type: "assets"; name: string }
  | { type: "ai"; name: string }
  | { type: "version_metadata"; name: string }
  /** Keep the binding of this name from the script's latest version. */
  | { type: "inherit"; name: string; old_name?: string; version_id?: string };

/** A binding as Cloudflare lists it back: secrets carry no `text`. */
export type ListedWorkerBinding =
  | Exclude<WorkerBinding, { type: "secret_text" }>
  | { type: "secret_text"; name: string };

export interface WorkerLimits {
  cpu_ms?: number;
  subrequests?: number;
}

export interface WorkerObservability {
  enabled: boolean;
  head_sampling_rate?: number | null;
  logs?: {
    enabled: boolean;
    invocation_logs: boolean;
    head_sampling_rate?: number | null;
  } | null;
}

export interface WorkerAssetsConfig {
  html_handling?:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";
  not_found_handling?: "404-page" | "single-page-application" | "none";
  run_worker_first?: boolean | string[];
}

export interface WorkerMigrations {
  old_tag?: string;
  new_tag?: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: Array<{ from: string; to: string }>;
}

export interface TailConsumer {
  service: string;
  environment?: string;
  namespace?: string;
}

/** The `metadata` part of a module Worker upload. */
export interface WorkerMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings?: WorkerBinding[];
  /** Binding types to carry over from the latest version, e.g. ["secret_text"]. */
  keep_bindings?: Array<WorkerBinding["type"]>;
  limits?: WorkerLimits;
  /** Replaces the script's tags. At most 10; no "," or "&". */
  tags?: string[];
  observability?: WorkerObservability;
  /** `jwt` is the completion token of an assets upload session. */
  assets?: { jwt?: string; config?: WorkerAssetsConfig };
  keep_assets?: boolean;
  migrations?: WorkerMigrations;
  placement?: { mode: "smart" };
  tail_consumers?: TailConsumer[];
  logpush?: boolean;
  usage_model?: "standard";
}

/** Script settings: what PATCH /settings changes without new code. */
export interface WorkerSettings {
  bindings?: WorkerBinding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  limits?: WorkerLimits;
  /** Replaces the script's tags. At most 10; no "," or "&". */
  tags?: string[];
  observability?: WorkerObservability;
  placement?: { mode: "smart" };
  tail_consumers?: TailConsumer[];
  logpush?: boolean;
  usage_model?: "standard";
}

/** Script settings as Cloudflare reports them. */
export interface WorkerSettingsResult extends Omit<WorkerSettings, "bindings"> {
  bindings?: ListedWorkerBinding[];
}
