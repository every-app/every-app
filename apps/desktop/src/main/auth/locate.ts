// What the person typed on the first screen: their Gateway's address, or the feature's own app
// address. Either way the answer is the app to sign in to (`<appId>.<gateway host>`), found only
// from documents the Gateway already serves to anyone (docs/security.md: nothing here learns which
// apps exist beyond the one we ask about by name):
// - typed an app: its RFC 9728 metadata names itself, so it's used as is (local `everyapp dev`, a
//   hosted Gateway's `scribe-<org>.<base>`, or just the app's address).
// - typed a Gateway: its RFC 8414 metadata names itself as issuer. A Gateway set up by the CLI uses
//   its own host as the app base domain (INVALID_APP_BASE_DOMAIN otherwise), so the app is at
//   `<appId>.<gateway host>`; its metadata must name that same Gateway. If it doesn't answer, the
//   Gateway hasn't got the app yet ("missing"): onboarding asks to install it, then looks again.
// The app has a current id and may have former ones (`appIds`, current first: features.ts). A
// Gateway that got the app before a rename may serve it only under a former id, a fresh one only
// under the current id, a renamed one under both; the first id whose host answers is used, so a new
// sign-in prefers the current host. Every host tried is `<id>.<the host the person typed>`, and its
// metadata must name the Gateway at that typed host, so an extra id never reaches another domain.

import type { Located } from "@shared/ipc";
import { AuthError } from "./errors";
import { OAuthClient } from "./oauth";
import { normalized, typedAppUrl } from "./url";

export type { Located };

/** The app's own host: `<appId>.…`, or a hosted Gateway's `<appId>-<org>.…`. */
function isAppHost(host: string, appIds: readonly string[]): boolean {
  const first = host.split(".")[0] ?? "";
  return appIds.some((appId) => first === appId || first.startsWith(`${appId}-`));
}

export async function locateApp(text: string, appIds: readonly string[], client: OAuthClient, appName: string): Promise<Located> {
  const origin = typedAppUrl(text);
  if (!origin) throw new AuthError("message", "Type your Gateway's address, like apps.yourcompany.com.");
  const url = new URL(origin);

  if (isAppHost(url.hostname, appIds)) {
    const resource = await client.discoverResource(origin).catch(() => undefined);
    if (resource) return { kind: "app", appUrl: normalized(origin) };
  }

  const gateway = await client.discover(origin).catch(() => undefined);
  if (!gateway) {
    throw new AuthError("message", `${url.host} doesn't answer like an Every App Gateway. Check the address and try again.`);
  }
  const gatewayUrl = normalized(gateway.issuer);
  const appUrls = appIds.map((appId) => `${url.protocol}//${appId}.${url.host}`);
  for (const appUrl of appUrls) {
    const resource = await client.discoverResource(appUrl).catch(() => undefined);
    if (!resource) continue;
    if (normalized(resource.authorizationServers[0]!) !== gatewayUrl) {
      throw new AuthError("message", `${appName} at ${new URL(appUrl).host} signs in with a different Gateway.`);
    }
    return { kind: "app", appUrl, gatewayUrl };
  }
  return { kind: "missing", gatewayUrl, appUrl: appUrls[0]! };
}
