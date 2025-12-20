export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  status: string | null;
  createdAt: Date;
  banned: boolean | null;
};
