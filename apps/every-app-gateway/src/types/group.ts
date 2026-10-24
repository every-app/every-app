/** A group as the Admin -> Groups table lists it. */
export type AdminGroup = {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  memberCount: number;
  appCount: number;
};
