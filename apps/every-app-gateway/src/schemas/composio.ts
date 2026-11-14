import { z } from "zod";
import { CONSENT_FIELDS } from "./consent-decision";

/**
 * What the Gateway's pages send about Composio
 * (docs/design/2026-11-composio.md): the organization's switch, a person's
 * link, and the Composio page's form as it posts to
 * `/connect/<provider>/composio` (server/oauth/flow.ts).
 */

/** Turn Composio on or off for the organization. `confirm`: off may delete links and connections. */
export const composioSwitchSchema = z.object({
  on: z.boolean(),
  confirm: z.boolean().optional(),
});

/** Where a sign-in the person started stands. */
export enum ComposioLinkState {
  /** They haven't approved it in Composio yet. */
  Waiting = "waiting",
  /** Their Composio is linked. */
  Linked = "linked",
  /** It expired, or none was started: start again. */
  Expired = "expired",
}

/** The Gateway's own page where a person uses an account from their Composio in an app. */
export const COMPOSIO_PAGE = "/oauth/composio";

/** The form fields the page posts: the state, the decision, and one account per service. */
export const COMPOSIO_FIELDS = {
  state: "state",
  decision: CONSENT_FIELDS.decision,
  /** `account.<service>`: Composio's id for the account chosen for that service. */
  account: (service: string) => `account.${service}`,
} as const;

/** What the Composio page shows, by what the person has to do next. */
export enum ComposioPageStep {
  /** They haven't linked their Composio: sign in there first. */
  Link = "link",
  /** A service the app needs isn't connected in their Composio. */
  Missing = "missing",
  /** Every service the app needs is there: allow, or don't. */
  Allow = "allow",
}
