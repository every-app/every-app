// What the person typed on the first screen: their Gateway's address, or the feature's own app
// address. Either way the answer is the app to sign in to (`<appId>.<gateway host>`), found only
// from documents the Gateway already serves to anyone (docs/security.md: nothing here learns which
// apps exist beyond the one we ask about by name):
// - typed an app: its RFC 9728 metadata names itself, so it's used as is (local `everyapp dev`, a
//   hosted Gateway's `talk-<org>.<base>`, or just the app's address).
// - typed a Gateway: its RFC 8414 metadata names itself as issuer. A Gateway set up by the CLI uses
//   its own host as the app base domain (INVALID_APP_BASE_DOMAIN otherwise), so the app is at
//   `<appId>.<gateway host>`; its metadata must name that same Gateway. If it doesn't answer, the
//   Gateway hasn't got the app yet ("missing"): onboarding asks to install it, then looks again.

import type { Located } from "@shared/ipc";
import { AuthError } from "./errors";
import { OAuthClient } from "./oauth";
import { normalized, typedAppUrl } from "./url";

export type { Located };

/** The app's own host: `<appId>.…`, or a hosted Gateway's `<appId>-<org>.…`. */
function isAppHost(host: string, appId: string): boolean {
  const first = host.split(".")[0] ?? "";
  return first === appId || first.startsWith(`${appId}-`);
}

export async function locateApp(text: string, appId: string, client: OAuthClient, appName: string): Promise<Located> {
  const origin = typedAppUrl(text);
  if (!origin) throw new AuthError("message", "Type your Gateway's address, like apps.yourcompany.com.");
  const url = new URL(origin);

  if (isAppHost(url.hostname, appId)) {
    const resource = await client.discoverResource(origin).catch(() => undefined);
    if (resource) return { kind: "app", appUrl: normalized(origin) };
  }

  const gateway = await client.discover(origin).catch(() => undefined);
  if (!gateway) {
    throw new AuthError("message", `${url.host} doesn't answer like an Every App Gateway. Check the address and try again.`);
  }
  const gatewayUrl = normalized(gateway.issuer);
  const appUrl = `${url.protocol}//${appId}.${url.host}`;
  const resource = await client.discoverResource(appUrl).catch(() => undefined);
  if (!resource) return { kind: "missing", gatewayUrl, appUrl };
  if (normalized(resource.authorizationServers[0]!) !== gatewayUrl) {
    throw new AuthError("message", `${appName} at ${new URL(appUrl).host} signs in with a different Gateway.`);
  }
  return { kind: "app", appUrl, gatewayUrl };
}
