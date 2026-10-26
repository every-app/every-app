import {
  ConfigurationError,
  serviceRoutePath,
  type ListMembersResult,
} from "../internal/index.js";
import {
  applyAttribution,
  attributionFor,
  isRequest,
  type GatewayCallFor,
} from "./attribution.js";
import { getEveryAppUser } from "./everyApp.js";
import { BINDING_ORIGIN, type GatewayServiceBinding } from "./gatewayFetch.js";
import { GatewayRefusalError, gatewayRefusal } from "./integrationFetch.js";

export interface ListMembersOptions {
  /** The Worker env: the EVERY_APP_GATEWAY binding when deployed; EVERYAPP_DEV in local dev. */
  env: object;
  /**
   * Whom the list is for: the inbound request (its user), or
   * `{ background: true, organizationId }` for work no person started (a
   * cron sending reports). An organization's own app may omit it for
   * background work; a shared app's Worker must pass one or the other
   * ({@link AttributionError}).
   */
  for?: GatewayCallFor;
}

/**
 * The organization's members who can open the app now, through the
 * gateway's `members` capability: people deactivated, removed from the
 * organization or (for an organization's own app) not granted the app are
 * left out. Read it when acting for members who aren't in a request, such
 * as choosing whom a scheduled report goes to, instead of a copy the app
 * kept. The app lists `capabilities: { members: { access: "read" } }`.
 *
 * Throws {@link GatewayRefusalError} when the gateway won't list
 * (`capability_not_requested`, `integration_agent_not_allowed` for an
 * agent's tool call, ...).
 *
 * In local dev (`everyapp dev`, no binding) there is no directory: a call
 * for a request answers its signed-in user alone, and background work
 * answers no one.
 */
export async function listMembers({
  env,
  for: explicitTarget,
}: ListMembersOptions): Promise<ListMembersResult> {
  const target = attributionFor(env, explicitTarget, "listMembers");
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  if (binding) {
    if (typeof binding.fetch !== "function") {
      throw new ConfigurationError(
        "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
      );
    }
    return listThroughGateway(binding, target);
  }
  if (!values["EVERYAPP_DEV"]) {
    throw new ConfigurationError(
      "Members are unavailable: deploy with the EVERY_APP_GATEWAY binding (everyapp deploy), or run under everyapp dev.",
    );
  }
  return listInDev(env, target);
}

async function listThroughGateway(
  binding: GatewayServiceBinding,
  target: GatewayCallFor | undefined,
): Promise<ListMembersResult> {
  const headers = new Headers();
  applyAttribution(headers, target);
  const response = await binding.fetch(
    new Request(`${BINDING_ORIGIN}${serviceRoutePath("members", "list")}`, {
      method: "GET",
      headers,
    }),
  );
  const refusal = await gatewayRefusal(response);
  if (refusal) throw new GatewayRefusalError(refusal);
  if (!response.ok) {
    throw new GatewayRefusalError({
      status: response.status,
      code: "members_list_failed",
      message: `The EveryApp gateway answered ${response.status} to the members list.`,
    });
  }
  return (await response.json()) as ListMembersResult;
}

/** The dev gateway has one person: the request's, if the call is for one. */
async function listInDev(
  env: object,
  target: GatewayCallFor | undefined,
): Promise<ListMembersResult> {
  const user =
    target && isRequest(target) ? await getEveryAppUser(target, env) : null;
  if (!user) return { members: [] };
  return {
    members: [
      {
        id: user.id,
        email: user.email,
        name: "",
        role: user.orgRole,
      },
    ],
  };
}
