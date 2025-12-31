export type UserApp = {
  id: string;
  userId: string;
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  devUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};
