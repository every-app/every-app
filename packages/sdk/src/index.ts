/**
 * @every-app/sdk — what `everyapp.config.ts` imports: `defineEveryApp` and
 * the manifest's types. A leaf, like the config itself (see ./manifest.ts).
 */
export {
  defineEveryApp,
  type EveryAppCapabilityEntry,
  type EveryAppClassResource,
  type EveryAppManifest,
  type EveryAppPublicRoute,
  type EveryAppQueueConsumer,
  type EveryAppResources,
  type EveryAppSecretEntry,
  type EveryAppSettingNeed,
  type EveryAppWorkerLimits,
} from "./manifest.js";
