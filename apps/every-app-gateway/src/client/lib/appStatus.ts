import type { ComponentProps } from "react";
import type { Badge } from "@/client/components/ui/badge";
import type { UserAccessApp } from "@/types/app";

/** An app's deploy state, as the launcher and Admin → Apps show it. */
enum AppStatusLabel {
  Active = "Active",
  Deploying = "Deploying",
  Disabled = "Disabled",
  NeedsDeploy = "Needs deploy",
}

/**
 * The deploy state in a word, as a chip. An app opens only once it has a
 * hostname and its Worker is bound and active. A status this gateway
 * doesn't know (a newer CLI's) shows as it is, and doesn't open.
 */
export function appStatus(app: Pick<UserAccessApp, "hostname" | "status">): {
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
