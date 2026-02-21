import type { AppConfig } from "@/src/types/gateway";

export interface SessionTokenUpdateMessage {
  type: "SESSION_TOKEN_UPDATE";
  token: string;
  expiresAt?: string;
  audience?: string;
  appId?: string;
}

export interface ChildToParentRouteChangeMessage {
  type: "ROUTE_CHANGE";
  route: string;
  direction: "child-to-parent";
  appId?: string;
}

export interface ParentToChildRouteChangeMessage {
  type: "ROUTE_CHANGE";
  route: string;
  direction: "parent-to-child";
  appId?: string;
}

export interface EmbeddedAppReadyMessage {
  type: "EMBEDDED_APP_READY";
}

export type NativeToWebViewMessage =
  | ParentToChildRouteChangeMessage
  | SessionTokenUpdateMessage
  | EmbeddedAppReadyMessage;

export function resolveAppById(
  apps: AppConfig[],
  appId: string,
): AppConfig | undefined {
  return apps.find((app) => app.appId === appId);
}
