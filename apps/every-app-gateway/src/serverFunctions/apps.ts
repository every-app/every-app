import { db } from "@/db";
import { userApps } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// ============================================================================
// Embedded App Registry
// ============================================================================

interface EmbeddedAppConfig {
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

// In production, this would be stored in a database
const embeddedAppRegistry: Record<string, EmbeddedAppConfig> = {
  "todo-app-dev": {
    appId: "todo-app-dev",
    name: "Todos (Development)",
    description: "Simple todo app - Development environment",
    appUrl: "http://localhost:3001",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  },
  "todo-app": {
    appId: "todo-app",
    name: "Todos",
    description: "Simple todo app",
    appUrl: "https://todo-app.bensenescu.workers.dev",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  },
};

class AppRegistryService {
  /**
   * Get app configuration by ID from marketplace
   */
  static getApp(appId: string): EmbeddedAppConfig | null {
    return embeddedAppRegistry[appId] || null;
  }

  /**
   * Get all marketplace apps
   */
  static getAllApps(): EmbeddedAppConfig[] {
    return Object.values(embeddedAppRegistry);
  }

  /**
   * Get app configuration by origin from marketplace
   */
  static getAppByOrigin(origin: string): EmbeddedAppConfig | null {
    const app = Object.values(embeddedAppRegistry).find(
      (el) => el.appUrl === origin,
    );
    return app ?? null;
  }
}

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
        where: and(
          eq(userApps.userId, userId),
          eq(userApps.appId, appId),
        ),
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

    // Fallback to marketplace apps
    const marketplaceApp = AppRegistryService.getApp(appId);

    if (marketplaceApp) {
      return {
        appId: marketplaceApp.appId,
        name: marketplaceApp.name,
        description: marketplaceApp.description,
        appUrl: marketplaceApp.appUrl,
        createdAt: marketplaceApp.createdAt,
        updatedAt: marketplaceApp.updatedAt,
        isUserApp: false,
      };
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
        where: and(
          eq(userApps.userId, userId),
          eq(userApps.appUrl, origin),
        ),
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

    // Fallback to marketplace apps
    const marketplaceApp = AppRegistryService.getAppByOrigin(origin);

    if (marketplaceApp) {
      return {
        appId: marketplaceApp.appId,
        name: marketplaceApp.name,
        description: marketplaceApp.description,
        appUrl: marketplaceApp.appUrl,
        createdAt: marketplaceApp.createdAt,
        updatedAt: marketplaceApp.updatedAt,
        isUserApp: false,
      };
    }

    return null;
  }
}
