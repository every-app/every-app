import type { ComponentProps } from "react";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { Badge } from "@/client/components/ui/badge";
import type { UserAccessApp } from "@/types/app";

/** An app's deploy state, as the launcher and Admin → Apps show it. */
export enum AppStatusLabel {
  Active = "Active",
  Deploying = "Deploying",
  Disabled = "Disabled",
  NeedsDeploy = "Needs deploy",
  NeedsSetup = "Needs setup",
  /** A provider app: no page to open; its tools are on the gateway's /mcp. */
  AiTools = "AI tools",
}

/**
 * The deploy state in a word, as a chip. An app opens only once it has a
 * hostname, its Worker is bound and active, and everything its manifest
 * says it needs is set (`setup`); until then it shows "Needs setup" and
 * the setup dialog opens in its place. A provider app (tier "provider")
 * never opens: once its key is set it is its tools, served to AI clients.
 * A status this gateway doesn't know (a newer CLI's) shows as it is, and
 * doesn't open.
 */
export function appStatus(
  app: Pick<UserAccessApp, "hostname" | "status" | "setup" | "tier">,
): {
  label: AppStatusLabel | string;
  variant: ComponentProps<typeof Badge>["variant"];
  opens: boolean;
} {
  if (app.tier === PROVIDER_APP_TIER) {
    if (app.status !== "active") {
      return {
        label: AppStatusLabel.Disabled,
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
    return { label: AppStatusLabel.AiTools, variant: "info", opens: false };
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
