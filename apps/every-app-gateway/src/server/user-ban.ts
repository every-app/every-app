/**
 * Deactivated users are banned with Better Auth's admin fields. Better Auth
 * itself only checks a ban when a session is created; every credential the
 * gateway accepts on its own (existing sessions, personal access tokens)
 * must check it too.
 */
export function isUserBanned(
  user: {
    banned?: boolean | null;
    banExpires?: Date | number | string | null;
  },
  now = Date.now(),
): boolean {
  if (!user.banned) return false;
  if (!user.banExpires) return true;
  return new Date(user.banExpires).getTime() > now;
}
