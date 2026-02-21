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

export interface AppConfig {
  id: string;
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  devUrl: string | null;
  isDefault?: boolean;
  grantedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTokenResponse {
  token: string;
  expiresAt: string;
  audience: string;
  appId: string;
}
