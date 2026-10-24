import type { ComponentProps } from "react";
import type { Badge } from "@/client/components/ui/badge";
import type { UserAccessApp } from "@/types/app";

/** An app's deploy state, as the launcher and Admin → Apps show it. */
export enum AppStatusLabel {
  Active = "Active",
  Deploying = "Deploying",
  Disabled = "Disabled",
  NeedsDeploy = "Needs deploy",
  NeedsSetup = "Needs setup",
}

/**
 * The deploy state in a word, as a chip. An app opens only once it has a
 * hostname, its Worker is bound and active, and everything its manifest
 * says it needs is set (`setup`); until then it shows "Needs setup" and
 * the setup dialog opens in its place. A status this gateway doesn't know
 * (a newer CLI's) shows as it is, and doesn't open.
 */
export function appStatus(
  app: Pick<UserAccessApp, "hostname" | "status" | "setup">,
): {
  label: AppStatusLabel | string;
  variant: ComponentProps<typeof Badge>["variant"];
  opens: boolean;
} {
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

/** The app shows "Needs setup": where it would open, the setup dialog opens. */
export function appNeedsSetup(
  app: Pick<UserAccessApp, "hostname" | "status" | "setup">,
): app is typeof app & { setup: NonNullable<UserAccessApp["setup"]> } {
  return appStatus(app).label === AppStatusLabel.NeedsSetup;
}
