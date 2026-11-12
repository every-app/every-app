/**
 * The perimeter's connection gate (`GatewayDeps.needsConnection`): an app
 * that requires an OAuth provider (one no optional feature of the app
 * lists) doesn't open for a person until they have connected it and
 * allowed the app (server/oauth/connection-needs.ts). A
 * page navigation goes to the launcher's setup dialog for the app
 * (`?setup=<appId>`), which shows each provider with the button that does
 * it: Connect, Allow or Reconnect. Anything else passes: the app's own call
 * to the provider is refused with `integration_not_connected` and its
 * `connectPath`, as before, and a background job never comes through here.
 */
import type { NeedsConnectionInput } from "@every-app/perimeter";
import { isHtmlNavigation, toSetupDialog } from "./app-needs-setup";
import { connectionNeeds } from "./oauth/connection-needs";

export async function refuseUnconnectedApp({
  request,
  app,
  session,
}: NeedsConnectionInput): Promise<Response | null> {
  if (!isHtmlNavigation(request) || !app.rowId) return null;
  const needs = await connectionNeeds({
    organizationId: session.orgId,
    userId: session.sub,
    app: { rowId: app.rowId, slug: app.appId, manifest: app.manifest },
  });
  return needs.length === 0 ? null : toSetupDialog(app.appId);
}
