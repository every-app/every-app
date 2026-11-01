export type AdminUser = {
  id: string;
  invitationId?: string;
  name: string;
  email: string;
  role: string;
  status: "active" | "pending" | string | null;
  /** The account's creation time; for an invitation, when it was sent. */
  createdAt: Date;
  banned: boolean | null;
  /** When the member joined this organization; absent on an invitation. */
  joinedAt?: Date;
  /** A pending invitation's expiry; absent on a member. */
  expiresAt?: Date;
};
