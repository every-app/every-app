export type AdminAppToken = {
  id: string;
  appId: string;
  appSlug: string;
  appName: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
  createdByEmail: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};
