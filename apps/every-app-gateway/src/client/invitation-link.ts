/** What an invite link opens, as the gateway tells it before sign-in. */
interface InvitationPeek {
  organizationName: string;
  /** Masked: `b•••@example.com`. */
  invitedEmail: string;
}

/**
 * Look an invite link up by its token before the person signs in: the
 * organization and the masked invited address for a live link, or null
 * for one the gateway refuses (unknown, used, canceled, expired, or not a
 * token at all). Anything else (rate limited, down) throws, and the page
 * falls back to the sign-in card without a name.
 */
export async function lookupInvitation(
  token: string,
): Promise<InvitationPeek | null> {
  const response = await fetch("/api/invitations/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    // Drop the unread body, or the browser keeps the request open.
    await response.body?.cancel();
    if (response.status === 404 || response.status === 400) return null;
    throw new Error(`Invitation lookup failed (${response.status})`);
  }
  return (await response.json()) as InvitationPeek;
}
