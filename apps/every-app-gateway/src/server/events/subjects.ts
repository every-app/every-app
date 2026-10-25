/**
 * The names an event carries, looked up by id: the organization's slug
 * and name for the envelope, a member as `{ id, email, name }`, an app as
 * `{ id, rowId, name }`, and the actor object for a user. Each is one D1
 * read, cached per isolate for 30 seconds like the caller and host caches
 * are, so an emit point that only holds an id (a service with its
 * OrgContext, a cap check with a row id) costs a read a request at most.
 * A subject that no longer exists still names its id, so an event about
 * a removed member or a tombstoned app is never dropped for want of a name.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apps, organizations, users } from "@/db/schema";
import type { EventActor, EventApp, EventUser } from "./catalogue";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 500;

class SubjectCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) this.entries.delete(key);
    const value = await load();
    this.entries.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    if (this.entries.size > CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

interface OrganizationSubject {
  id: string;
  slug: string;
  name: string;
}

const organizationsCache = new SubjectCache<OrganizationSubject>();
const usersCache = new SubjectCache<EventUser>();
const appsCache = new SubjectCache<EventApp>();

export function clearEventSubjectCachesForTests(): void {
  organizationsCache.clear();
  usersCache.clear();
  appsCache.clear();
}

/** The organization as the envelope names it; the id alone when it is gone. */
export function organizationSubject(
  organizationId: string,
): Promise<OrganizationSubject> {
  return organizationsCache.get(organizationId, async () => {
    const [row] = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return (
      row ?? { id: organizationId, slug: organizationId, name: organizationId }
    );
  });
}

/** A member as events carry them; email and name null once the account is gone. */
export function userSubject(userId: string): Promise<EventUser> {
  return usersCache.get(userId, async () => {
    const [row] = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row
      ? { id: row.id, email: row.email, name: row.name || null }
      : { id: userId, email: null, name: null };
  });
}

/** An app as events carry it, by registry row; the row id stands in for a gone row. */
export function appSubject(appRowId: string): Promise<EventApp> {
  return appsCache.get(appRowId, async () => {
    const [row] = await db
      .select({ id: apps.id, appSlug: apps.appSlug, name: apps.name })
      .from(apps)
      .where(eq(apps.id, appRowId))
      .limit(1);
    return row
      ? { id: row.appSlug, rowId: row.id, name: row.name }
      : { id: appRowId, rowId: appRowId, name: appRowId };
  });
}

/** The actor object for a signed-in member. */
export async function userActor(userId: string): Promise<EventActor> {
  const member = await userSubject(userId);
  return {
    kind: "user",
    id: member.id,
    email: member.email,
    name: member.name,
  };
}

/** A user row already in hand, as the actor. */
export function actorOf(member: EventUser): EventActor {
  return {
    kind: "user",
    id: member.id,
    email: member.email,
    name: member.name,
  };
}

export const GATEWAY_ACTOR: EventActor = { kind: "gateway" };
