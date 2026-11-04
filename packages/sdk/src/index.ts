/**
 * @every-app/sdk — what `everyapp.config.ts` imports: `defineEveryApp` and
 * the manifest's types. A leaf, like the config itself (see ./manifest.ts).
 */
export {
  defineEveryApp,
  type EveryAppCapabilityEntry,
  type EveryAppKeyCapabilityEntry,
  type EveryAppOAuthCapabilityEntry,
  type EveryAppClassResource,
  type EveryAppFeature,
  type EveryAppFeatureSecretEntry,
  type EveryAppFeatureSettingEntry,
  type EveryAppManifest,
  type EveryAppPublicRoute,
  type EveryAppQueueConsumer,
  type EveryAppResources,
  type EveryAppSecretEntry,
  type EveryAppSettingEntry,
  type EveryAppSettingNeed,
  type EveryAppWorkerLimits,
} from "./manifest.js";
