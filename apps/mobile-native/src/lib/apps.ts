import type { UserApp } from "@/src/types/gateway";

export function resolveAppById(
  apps: UserApp[],
  appId: string,
): UserApp | undefined {
  return apps.find((app) => app.appId === appId);
}
