/**
 * `EveryAppEnv`: what Every App puts in an app Worker's `env`, for an app
 * that types its env by hand. An app built with `everyAppWorker()` needs
 * none of it: `cf workers types` writes the same names into `Env` from the
 * Worker's definition.
 */
import type { EveryAppManifest } from "../manifest.js";

/** The `env` keys Every App sets on an app's Worker, deployed and under `everyapp dev`. */
export interface EveryAppEnv<M extends EveryAppManifest = EveryAppManifest> {
  /** The manifest's `id`. */
  EVERYAPP_APP_ID: string;
  /**
   * The manifest (`everyapp.config.ts`) as JSON: what the app asked for,
   * for a page that shows it. `EveryAppEnv<typeof manifest>` types it as
   * the app's own.
   */
  EVERYAPP_MANIFEST: M;
  /** The Gateway's URL; links back to it go through `gatewayUrl(env)`. */
  GATEWAY_URL: string;
  /** The identity tokens' issuer: the Gateway's URL, or the dev issuer. */
  EVERYAPP_IDENTITY_ISSUER: string;
  /** The public keys (JSON array of PEMs) `everyApp()` verifies identities with. */
  EVERYAPP_IDENTITY_PUBLIC_KEYS: string;
  /** Deployed: the Worker's name, the identity tokens' audience. */
  EVERYAPP_AUDIENCE?: string;
  /** Deployed: the organization the app is installed for. */
  EVERY_APP_ORG_ID?: string;
  /** Deployed, on an app installed for every organization: `"1"`. */
  EVERYAPP_SHARED?: string;
  /** Deployed: the service binding to the Gateway, which capabilities, AI and email go through. */
  EVERY_APP_GATEWAY?: Fetcher;
  /** `"1"` under `everyapp dev`, absent when deployed. */
  EVERYAPP_DEV?: string;
  /** Under `everyapp dev`: the manifest's `capabilities`, as JSON, for the SDK's dev fallbacks. */
  EVERYAPP_DEV_CAPABILITIES?: string;
  /** Under `everyapp dev`: the app's `.everyapp/providers/*.json`, as JSON. */
  EVERYAPP_DEV_PROVIDERS?: string;
  /** Under `everyapp dev`, from `.dev.vars`: the senders standing in for `everyapp email set --sender`. */
  EVERYAPP_EMAIL_SENDERS?: string;
  /** Under `everyapp dev --gateway` (linked dev): the gateway-lite's forwarder, which the SDK's services call the real Gateway through, and the run's nonce. */
  EVERYAPP_LINKED_DEV_URL?: string;
  EVERYAPP_LINKED_DEV_NONCE?: string;
}
