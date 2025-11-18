import { db } from "@/db";
import { userApps } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// ============================================================================
// App Resolver
// ============================================================================

interface ResolvedApp {
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  createdAt: Date;
  updatedAt: Date;
  isUserApp?: boolean;
}

export class AppResolver {
  /**
   * Get app configuration by ID, checking user apps first, then marketplace
   */
  static async getApp(
    appId: string,
    userId?: string,
  ): Promise<ResolvedApp | null> {
    // First check user apps if userId is provided
    if (userId) {
      const userApp = await db.query.userApps.findFirst({
        where: and(eq(userApps.userId, userId), eq(userApps.appId, appId)),
      });

      if (userApp) {
        return {
          appId: userApp.appId,
          name: userApp.name,
          description: userApp.description,
          appUrl: userApp.appUrl,
          createdAt: userApp.createdAt,
          updatedAt: userApp.updatedAt,
          isUserApp: true,
        };
      }
    }

    return null;
  }

  /**
   * Get app configuration by origin, checking user apps first, then marketplace
   */
  static async getAppByOrigin(
    origin: string,
    userId?: string,
  ): Promise<ResolvedApp | null> {
    // First check user apps if userId is provided
    if (userId) {
      const userApp = await db.query.userApps.findFirst({
        where: and(eq(userApps.userId, userId), eq(userApps.appUrl, origin)),
      });

      if (userApp) {
        return {
          appId: userApp.appId,
          name: userApp.name,
          description: userApp.description,
          appUrl: userApp.appUrl,
          createdAt: userApp.createdAt,
          updatedAt: userApp.updatedAt,
          isUserApp: true,
        };
      }
    }

    return null;
  }
}
