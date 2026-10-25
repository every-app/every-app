import type { ComponentProps } from "react";
import {
  hasRemoteMcpBlock,
  PROVIDER_APP_TIER,
  remoteMcpOf,
} from "@every-app/sdk/internal";
import type { Badge } from "@/client/components/ui/badge";
import type { UserAccessApp } from "@/types/app";

/** An app's deploy state, as the launcher and Admin → Apps show it. */
export enum AppStatusLabel {
  Active = "Active",
  Deploying = "Deploying",
  Disabled = "Disabled",
  NeedsDeploy = "Needs deploy",
  NeedsSetup = "Needs setup",
  /** An MCP app turned off (`everyapp mcp off`, Turn off): kept, not served. */
  Off = "Off",
  /** A remote MCP server that wants OAuth, which the Gateway doesn't do yet. */
  NotSupported = "Not supported yet",
}

/**
 * The deploy state in a word, as a chip. An app opens only once it has a
 * hostname, its Worker is bound and active, and everything its manifest
 * says it needs is set (`setup`); until then it shows "Needs setup" and
 * the setup dialog opens in its place. An MCP app (tier "provider") never
 * opens: once its key is set it is Active, and its tools are served to AI
 * clients; the card opens the "Use it from your agent" dialog instead
 * ({@link mcpAppUsable}). An MCP app that is off reads "Off" (its access
 * and tokens are kept; Turn on serves it again), and a remote one whose
 * server wants OAuth reads "Not supported yet" where the list carries its
 * manifest (Admin → Apps). A status this gateway doesn't know (a newer
 * CLI's) shows as it is, and doesn't open.
 */
export function appStatus(
  app: Pick<UserAccessApp, "hostname" | "status" | "setup" | "tier"> & {
    manifest?: string | null;
  },
): {
  label: AppStatusLabel | string;
  variant: ComponentProps<typeof Badge>["variant"];
  opens: boolean;
} {
  if (isMcpApp(app)) {
    if (app.status !== "active") {
      return {
        label: AppStatusLabel.Off,
        variant: "secondary",
        opens: false,
      };
    }
    if (remoteMcpAuthKind(app) === "oauth") {
      return {
        label: AppStatusLabel.NotSupported,
        variant: "outline",
        opens: false,
      };
    }
    if (app.setup && !app.setup.ready) {
      return {
        label: AppStatusLabel.NeedsSetup,
        variant: "warning",
        opens: false,
      };
    }
    return { label: AppStatusLabel.Active, variant: "success", opens: false };
  }
  if (!app.hostname || app.status === "pending") {
    return {
      label: AppStatusLabel.NeedsDeploy,
      variant: "outline",
      opens: false,
    };
  }
  switch (app.status) {
    case "active":
      // Bound and running, but a setting it needs isn't set: the perimeter
      // won't open it, so neither does the launcher.
      if (app.setup && !app.setup.ready) {
        return {
          label: AppStatusLabel.NeedsSetup,
          variant: "warning",
          opens: false,
        };
      }
      return { label: AppStatusLabel.Active, variant: "success", opens: true };
    case "binding":
      return { label: AppStatusLabel.Deploying, variant: "info", opens: false };
    case "disabled":
      return {
        label: AppStatusLabel.Disabled,
        variant: "secondary",
        opens: false,
      };
    default:
      return { label: app.status, variant: "outline", opens: false };
  }
}

/**
 * The deploy state in a word from the status alone, for a list that
 * carries no more about the app (a group's apps): the same words as
 * {@link appStatus}, without whether it opens.
 */
export function appStatusLabel(status: string): AppStatusLabel | string {
  switch (status) {
    case "active":
      return AppStatusLabel.Active;
    case "binding":
      return AppStatusLabel.Deploying;
    case "pending":
      return AppStatusLabel.NeedsDeploy;
    case "disabled":
      return AppStatusLabel.Disabled;
    default:
      return status;
  }
}

/** The app shows "Needs setup": where it would open, the setup dialog opens. */
export function appNeedsSetup(
  app: Pick<UserAccessApp, "hostname" | "status" | "setup" | "tier">,
): app is typeof app & { setup: NonNullable<UserAccessApp["setup"]> } {
  return appStatus(app).label === AppStatusLabel.NeedsSetup;
}

/** The kind the launcher calls "MCP apps": a page-less app, its tools on `/mcp`. */
export function isMcpApp(app: Pick<UserAccessApp, "tier">): boolean {
  return app.tier === PROVIDER_APP_TIER;
}

function parsedManifest(manifest: string | null | undefined): unknown {
  if (!manifest) return null;
  try {
    return JSON.parse(manifest);
  } catch {
    return null;
  }
}

/**
 * An MCP app registered by URL (a remote MCP server), rather than one of
 * the Gateway's built-in ones: its stored manifest has a `remote` block.
 * Only a list that carries the manifest (Admin → Apps) can tell.
 */
export function isRemoteMcpApp(
  app: Pick<UserAccessApp, "tier"> & { manifest?: string | null },
): boolean {
  return isMcpApp(app) && hasRemoteMcpBlock(parsedManifest(app.manifest));
}

/** A remote MCP app's auth kind, or null (a built-in, or no manifest to read). */
function remoteMcpAuthKind(
  app: Pick<UserAccessApp, "tier"> & { manifest?: string | null },
): string | null {
  if (!isMcpApp(app)) return null;
  return remoteMcpOf(parsedManifest(app.manifest))?.auth.kind ?? null;
}

/** The chip beside an MCP app's name, on the card and in Admin → Apps. */
export const MCP_APP_KIND_LABEL = "MCP";

/**
 * An MCP app that is on and set up: its tools are served, so where a page
 * would open, the "Use it from your agent" dialog opens.
 */
export function mcpAppUsable(
  app: Pick<UserAccessApp, "hostname" | "status" | "setup" | "tier">,
): boolean {
  return isMcpApp(app) && appStatus(app).label === AppStatusLabel.Active;
}
