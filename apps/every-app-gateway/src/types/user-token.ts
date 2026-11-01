export type UserAccessToken = {
  id: string;
  userId: string;
  userEmail: string;
  organizationId: string;
  appId: string | null;
  appSlug: string | null;
  appName: string | null;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};
