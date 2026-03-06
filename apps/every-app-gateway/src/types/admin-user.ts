export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: "active" | "pending" | string | null;
  createdAt: Date;
  banned: boolean | null;
};
