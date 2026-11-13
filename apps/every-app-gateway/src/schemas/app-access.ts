import { CONSENT_FIELDS } from "./consent-decision";

/**
 * The Allow page's form (routes/oauth/app-access.tsx) as it posts to
 * `/connect/<provider>/allow` (server/oauth/flow.ts): the page's path and
 * the field names and value both sides use
 * (docs/design/2026-11-oauth-one-connection.md).
 */

/** The Gateway's own page where a person allows an app to use their connection. */
export const ALLOW_PAGE = "/oauth/app-access";

/** The form fields the page posts; the decision is the consent pages' shared buttons' (consentParts.tsx). */
export const ALLOW_FIELDS = {
  state: "state",
  decision: CONSENT_FIELDS.decision,
} as const;

/** The decision that allows the app: the shared Allow button's value. */
export const ALLOW_APPROVE = "approve";

/**
 * What Reconnect on Your connections → Accounts did
 * (`startReconnect` in server/oauth/flow.ts, the `reconnectConnection`
 * server function).
 */
export enum ReconnectOutcome {
  /** The provider has to be asked: send the browser to `url`. */
  Provider = "provider",
  /** No provider was asked: the person's apps were allowed for what they list now. */
  Allowed = "allowed",
}

/**
 * What a person still has to do before an app that requires an OAuth
 * provider opens for them (server/oauth/connection-needs.ts): the setup
 * dialog's button for it, which goes to the app's connect link either way.
 */
export enum ConnectionAction {
  /** No connection to the provider yet: the provider is asked. */
  Connect = "connect",
  /** The connection works and was asked for what the app lists, but this app isn't allowed: the Allow page. */
  Allow = "allow",
  /** The connection expired, or the provider was never asked for a scope the app lists: the provider is asked again. */
  Reconnect = "reconnect",
}

/** One provider a person still has to connect, reconnect or allow for an app. */
export interface ConnectionNeed {
  provider: string;
  /** The provider's name, as the dialog says it ("GitHub"). */
  label: string;
  action: ConnectionAction;
  /** The app's connect link (`/connect/<provider>?app=<app>`), without `return`. */
  connectPath: string;
}
