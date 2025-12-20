import { db } from "@/db";
import { userOnboarding } from "@/db/schema";
import { eq } from "drizzle-orm";

// Types for repository operations
type CreateOnboarding = {
  id: string;
  userId: string;
};

type UpdateOnboarding = {
  pwaInstallCompleted?: boolean;
  pwaInstallSkipCount?: number;
  pwaInstallSkippedAt?: Date | null;
  pwaInstallSkippedPermanently?: boolean;
};

/**
 * Find onboarding record for a user.
 */
async function findByUserId(userId: string) {
  return db.query.userOnboarding.findFirst({
    where: eq(userOnboarding.userId, userId),
  });
}

/**
 * Create a new onboarding record.
 */
async function create(data: CreateOnboarding) {
  const now = new Date();

  await db.insert(userOnboarding).values({
    id: data.id,
    userId: data.userId,
    pwaInstallCompleted: false,
    pwaInstallSkipCount: 0,
    pwaInstallSkippedAt: null,
    pwaInstallSkippedPermanently: false,
    createdAt: now,
    updatedAt: now,
  });

  return findByUserId(data.userId);
}

/**
 * Update an onboarding record.
 */
async function update(userId: string, data: UpdateOnboarding) {
  await db
    .update(userOnboarding)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(userOnboarding.userId, userId));

  return findByUserId(userId);
}

/**
 * Get or create onboarding record for a user.
 */
async function getOrCreate(userId: string) {
  const existing = await findByUserId(userId);
  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  return create({ id, userId });
}

export const OnboardingRepository = {
  findByUserId,
  create,
  update,
  getOrCreate,
} as const;
