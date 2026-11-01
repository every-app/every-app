/**
 * Where a hosted account's verification link brings it back to: the
 * /verify-email page, signed in, with the destination it signed up or in
 * for. Relative, so Better Auth's origin check accepts it.
 */
export function verifyEmailCallbackURL(search: {
  redirect?: string;
  return_to?: string;
}): string {
  const params = new URLSearchParams();
  if (search.redirect) params.set("redirect", search.redirect);
  if (search.return_to) params.set("return_to", search.return_to);
  const query = params.toString();
  return query ? `/verify-email?${query}` : "/verify-email";
}

/** The /verify-email page's search for an address waiting for its link. */
export function verifyEmailSearch(search: {
  email: string;
  redirect?: string;
  return_to?: string;
}) {
  return {
    email: search.email,
    ...(search.redirect ? { redirect: search.redirect } : {}),
    ...(search.return_to ? { return_to: search.return_to } : {}),
  };
}
