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
  /**
   * At the organization's monthly cap on provider calls: the app opens,
   * but the Gateway refuses its AI and provider calls until the month ends
   * or an owner or admin raises the cap under Manage workspace → Usage.
   */
  Paused = "Paused",
}

/**
 * What {@link appStatus} reads: `paused` is absent where no cap is read
 * (Admin → Apps), `manifest` where the list doesn't carry it (the launcher).
 */
type AppStatusInput = Pick<
  UserAccessApp,
  "hostname" | "status" | "setup" | "tier"
> & { paused?: boolean; manifest?: string | null };

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
 * manifest (Admin → Apps). Either kind, at its monthly cap (`paused`),
 * shows "Paused" in place of Active and opens as it did: only its
 * provider calls are refused. The deploy and setup states come first,
 * since the person must act on them before a cap matters. A status this
 * gateway doesn't know (a newer CLI's) shows as it is, and doesn't open.
 */
export function appStatus(app: AppStatusInput): {
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
    if (app.paused) return paused(false);
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
      if (app.paused) return paused(true);
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

function paused(opens: boolean) {
  return { label: AppStatusLabel.Paused, variant: "warning" as const, opens };
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
  app: AppStatusInput,
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
 * would open, the "Use it from your agent" dialog opens. A pause doesn't
 * change that: the tools stay served and only their provider calls are
 * refused, so the dialog still says how an agent reaches them.
 */
export function mcpAppUsable(app: AppStatusInput): boolean {
  if (!isMcpApp(app)) return false;
  const { label } = appStatus(app);
  return label === AppStatusLabel.Active || label === AppStatusLabel.Paused;
}
