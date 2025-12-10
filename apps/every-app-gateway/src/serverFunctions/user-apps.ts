import { createServerFn } from "@tanstack/react-start";
import z from "zod";
import { db } from "@/db";
import { userApps } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authMiddleware, type AuthContext } from "@/middleware/auth";

export const getUserApps = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }: { context: AuthContext }) => {
    const apps = await db.query.userApps.findMany({
      where: eq(userApps.userId, context.user.id),
    });

    return { apps };
  });

const createUserAppSchema = z.object({
  appId: z.string().min(1, "App ID is required"),
  name: z.string().min(1, "Name is required").max(255, "Name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  appUrl: z.string().url("Invalid URL format"),
});

export const createUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => createUserAppSchema.parse(app))
  .handler(
    async ({
      data: app,
      context,
    }: {
      data: ReturnType<typeof createUserAppSchema.parse>;
      context: AuthContext;
    }) => {
      const appId = crypto.randomUUID();

      // Check if user already has an app with this appId
      const existingApp = await db.query.userApps.findFirst({
        where: and(
          eq(userApps.userId, context.user.id),
          eq(userApps.appId, app.appId),
        ),
      });

      if (existingApp) {
        throw new Error("App with this ID already exists");
      }

      const now = new Date();
      await db.insert(userApps).values([
        {
          id: appId,
          userId: context.user.id,
          appId: app.appId,
          name: app.name,
          description: app.description,
          appUrl: app.appUrl,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      return { success: true, appId };
    },
  );

const updateUserAppSchema = z.object({
  id: z.string().uuid("Invalid app ID"),
  name: z.string().min(1, "Name is required").max(255, "Name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  appUrl: z.string().url("Invalid URL format"),
});

export const updateUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => updateUserAppSchema.parse(app))
  .handler(
    async ({
      data: app,
      context,
    }: {
      data: ReturnType<typeof updateUserAppSchema.parse>;
      context: AuthContext;
    }) => {
      // Verify the app belongs to the user
      const existingApp = await db.query.userApps.findFirst({
        where: and(
          eq(userApps.userId, context.user.id),
          eq(userApps.id, app.id),
        ),
      });

      if (!existingApp) {
        throw new Error("App not found or does not belong to user");
      }

      const now = new Date();
      await db
        .update(userApps)
        .set({
          name: app.name,
          description: app.description,
          appUrl: app.appUrl,
          updatedAt: now,
        })
        .where(
          and(eq(userApps.userId, context.user.id), eq(userApps.id, app.id)),
        );

      return { success: true };
    },
  );

const deleteUserAppSchema = z.object({
  id: z.string().uuid("Invalid app ID"),
});

export const deleteUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => deleteUserAppSchema.parse(app))
  .handler(
    async ({
      data: app,
      context,
    }: {
      data: ReturnType<typeof deleteUserAppSchema.parse>;
      context: AuthContext;
    }) => {
      // Verify the app belongs to the user
      const existingApp = await db.query.userApps.findFirst({
        where: and(
          eq(userApps.userId, context.user.id),
          eq(userApps.id, app.id),
        ),
      });

      if (!existingApp) {
        throw new Error("App not found or does not belong to user");
      }

      // Hard delete the app
      await db
        .delete(userApps)
        .where(
          and(eq(userApps.userId, context.user.id), eq(userApps.id, app.id)),
        );

      return { success: true };
    },
  );
