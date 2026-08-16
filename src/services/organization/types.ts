export type OrganizationType = {
  id: string;
  name: string;
  ownerUserId: string;
  billingEmail: string;
  paddleCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
