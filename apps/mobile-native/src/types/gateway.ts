export interface GatewayUser {
  id: string;
  email: string;
  name: string | null;
  role?: string | null;
  status?: string | null;
}

export interface GatewaySession {
  user: GatewayUser;
  session?: {
    id: string;
    expiresAt: string;
    token: string;
    userId: string;
  };
}

export interface UserApp {
  id: string;
  organizationId: string;
  appId: string;
  name: string;
  description: string;
  hostname: string;
  // "active" | "disabled" | "deploying" today, but the gateway column is free
  // text — treat anything non-"active" as unlaunchable instead of failing.
  status: string;
  isDefault: boolean;
  createdAt: string | number;
  updatedAt: string | number;
  grantedAt: string | number;
}
