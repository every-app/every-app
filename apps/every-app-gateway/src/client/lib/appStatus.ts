import type { ComponentProps } from "react";
import { hasRemoteMcpBlock, PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { Badge } from "@/client/components/ui/badge";
import type { UserAccessApp } from "@/types/app";

/**
 * After this long `binding`, a deploy counts as stalled: the Gateway has
 * had its binding for far longer than a rollout takes (the CLI's own live
 * wait gives up at the same point). Behind Cloudflare Access on a fresh
 * Gateway it can also be the per-minute sweep not running yet, which a
 * visit to the app finishes, so a stalled card still opens the app.
 */
export const DEPLOY_STALL_MS = 10 * 60_000;

/**
 * How often the launcher reads its list again while an app is deploying:
 * the card reads Active within this of the Gateway making it live (a
 * visit, or the per-minute sweep: server/app-activation.ts).
 */
export const DEPLOYING_POLL_MS = 5_000;

/** An app's deploy state, as the launcher and Admin → Apps show it. */
export enum AppStatusLabel {
  Active = "Active",
  Deploying = "Deploying",
  /** `binding` for longer than {@link DEPLOY_STALL_MS}: a visit may finish it, else the deploy needs the CLI again. */
  Stalled = "Deploy stalled",
  Disabled = "Disabled",
  NeedsDeploy = "Needs deploy",
  NeedsSetup = "Needs setup",
  /** An MCP app turned off (`everyapp mcp off`, Turn off): kept, not served. */
  Off = "Off",
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
> & {
  paused?: boolean;
  manifest?: string | null;
  /** When the row last changed: for `binding`, when its Worker was uploaded. */
  updatedAt?: Date | number | string | null;
};

/**
 * The deploy state in a word, as a chip. An app opens only once it has a
 * hostname, its Worker is bound and active, and everything its manifest
 * says it needs is set (`setup`); until then it shows "Needs setup" and
 * the setup dialog opens in its place. An MCP app (tier "provider") never
 * opens: once its key is set it is Active, and its tools are served to AI
 * clients. An MCP app that is off reads "Off" (its access and tokens are
 * kept; Turn on serves it again). An app at its monthly cap (`paused`) shows
 * "Paused" in place of Active and opens as it did: only its provider calls are
 * refused. The deploy and setup states come first,
 * since the person must act on them before a cap matters. An app
 * `binding` for longer than {@link DEPLOY_STALL_MS} (by `updatedAt`, at
 * `now`) reads "Deploy stalled" rather than "Deploying". Both open the
 * app: a visit is what makes a `binding` app live (behind Cloudflare
 * Access the CLI's own request never reaches the Gateway, and the
 * per-minute sweep can take a while to start on a fresh Gateway). A
 * status this gateway doesn't know (a newer CLI's) shows as it is, and
 * doesn't open.
 */
export function appStatus(
  app: AppStatusInput,
  now: number = Date.now(),
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
      if (app.paused) {
        return {
          label: AppStatusLabel.Paused,
          variant: "warning",
          opens: true,
        };
      }
      return { label: AppStatusLabel.Active, variant: "success", opens: true };
    case "binding":
      return deployStalled(app, now)
        ? { label: AppStatusLabel.Stalled, variant: "warning", opens: true }
        : { label: AppStatusLabel.Deploying, variant: "info", opens: true };
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

/** Whether a `binding` app has been so for {@link DEPLOY_STALL_MS} or more at `now`. */
export function deployStalled(
  app: Pick<AppStatusInput, "status" | "updatedAt">,
  now: number = Date.now(),
): boolean {
  if (app.status !== "binding" || app.updatedAt == null) return false;
  const since = new Date(app.updatedAt).getTime();
  return Number.isFinite(since) && now - since >= DEPLOY_STALL_MS;
}

/** Whether any listed app is still `binding`: the launcher polls while one is. */
export function hasDeployingApp(
  apps: readonly Pick<AppStatusInput, "status">[],
): boolean {
  return apps.some((app) => app.status === "binding");
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

/** The kind Admin → Apps lists under "MCP apps": no page, its tools on `/mcp`. */
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
