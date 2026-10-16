/**
 * @every-app/sdk/cloudflare — the Worker definition for an app's
 * `cloudflare.config.ts`:
 *
 *   import { defineConfig } from "cf/config";
 *   import * as entrypoint from "./src/entry.worker.ts" with { type: "cf-worker" };
 *   import manifest from "./everyapp.config.ts";
 *   import { everyAppWorker } from "@every-app/sdk/cloudflare";
 *
 *   export default defineConfig((ctx) => ({
 *     worker: everyAppWorker({ manifest, entrypoint, ctx }),
 *   }));
 *
 * This runs in Node while cf and the Vite plugin load the config, never in the
 * Worker. Keep it self-contained: the plugin hides every file the config
 * imports from the Worker in dev, so sharing a module with `/server` or
 * `/internal` would break `cf dev` wherever the SDK is linked from source.
 * (The dev keypair it hands the dev Worker is a leaf the Worker never loads.)
 */
export {
  EVERYAPP_OBSERVABILITY,
  everyAppWorker,
  localD1Id,
  localD1Path,
  workflowNameFor,
  type D1Binding,
  type DurableObjectBinding,
  type DurableObjectExport,
  type EveryAppBinding,
  type EveryAppConfigContext,
  type EveryAppDeployEnv,
  type EveryAppDevEnv,
  type EveryAppExports,
  type EveryAppObservability,
  type EveryAppWorkerConfig,
  type EveryAppWorkerManifest,
  type EveryAppWorkerOptions,
  type GatewayBinding,
  type KvBinding,
  type SecretBinding,
  type TextBinding,
  type VersionMetadataBinding,
  type WorkflowBinding,
  type WorkflowExport,
} from "./worker.js";
export {
  DEPLOY_INPUTS_FILE,
  DeployInputsError,
  parseDeployInputs,
  type EveryAppDeployInputs,
} from "./deployInputs.js";
