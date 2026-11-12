/**
 * What an app needs of one person before it opens for them
 * (docs/design/2026-11-oauth-one-connection.md): each OAuth provider the
 * app requires, connected, holding the scopes the app lists, and allowed
 * for this app. Required as the settings model says it (`appSettings`): a
 * provider an optional feature lists is optional, as the app works without
 * it (OpenSEO's Google, OpenCRM's Google and Microsoft 365), and never
 * blocks.
 * The same rule a call to the provider is held to (capabilities/heldToken.ts),
 * asked before the app opens: the perimeter sends a page navigation to the
 * setup dialog while anything is needed, and the launcher's list carries
 * the needs so the dialog shows one button per provider. A remote MCP app
 * is left out: its own dialog connects its server.
 */
import {
  appSettings,
  remoteMcpOf,
  type ProviderRegistry,
  type SettingsManifestLike,
} from "@every-app/sdk/internal";
import type { ConnectionNeed } from "@/schemas/app-access";
import { parsedManifest } from "@/server/app-setup";
import { connectPathFor } from "@/server/capabilities/heldToken";
import { gatewayProviders } from "@/server/providers";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { connectionAction, declaredScopes } from "./appAccess";

/**
 * The OAuth providers `manifest` requires that this person hasn't
 * connected, or allowed this app, as the app lists them now. Empty when the
 * app opens for them.
 */
export async function connectionNeeds(input: {
  organizationId: string;
  userId: string;
  app: { rowId: string; slug: string; manifest: unknown };
  /** The registry, when the caller has read it already. */
  registry?: ProviderRegistry;
}): Promise<ConnectionNeed[]> {
  const manifest = parsedManifest(input.app.manifest);
  if (!manifest || remoteMcpOf(manifest)) return [];
  // A feature's capabilities are listed under `capabilities` too.
  const listed = manifest["capabilities"];
  if (!listed || typeof listed !== "object") return [];
  const registry = input.registry ?? (await gatewayProviders());
  const required = appSettings(manifest as SettingsManifestLike, registry)
    .filter(
      (setting) =>
        setting.kind === "capability" && setting.need.kind === "required",
    )
    .map((setting) => setting.id);
  const needs: ConnectionNeed[] = [];
  for (const providerId of required) {
    const capability = registry.get(providerId);
    if (capability?.mode !== "oauth_client") continue;
    const declared = declaredScopes(manifest, providerId) ?? [];
    const key = {
      organizationId: input.organizationId,
      providerId,
      userId: input.userId,
    };
    const connection = await ProviderConnectionRepository.find(key);
    const access = connection
      ? await ProviderAppAccessRepository.find({
          ...key,
          appRowId: input.app.rowId,
        })
      : null;
    const action = connectionAction(
      capability.flow,
      connection,
      access,
      declared,
    );
    if (action === null) continue;
    needs.push({
      provider: providerId,
      label: capability.label,
      action,
      connectPath: connectPathFor(providerId, input.app.slug),
    });
  }
  return needs;
}
