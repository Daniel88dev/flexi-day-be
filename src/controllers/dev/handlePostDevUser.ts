import type { Request, Response } from "express";
import { z } from "zod";
import {
  addMember,
  findTeam,
  seedTeam,
  seedUser,
  setQuota,
} from "../../services/dev/devSeedServices.js";

export const validatePostDevUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(8).max(256).optional(),
  teamName: z.string().min(1).max(120).optional(),
});

export type ValidatedPostDevUserType = z.infer<typeof validatePostDevUser>;

export const handlePostDevUser = async (req: Request, res: Response) => {
  const data = req.body as ValidatedPostDevUserType;

  const seeded = await seedUser({
    email: data.email,
    name: data.name,
    password: data.password,
  });

  let team: { id: string; groupName: string } | undefined;
  if (data.teamName) {
    team =
      (await findTeam(seeded.id, data.teamName)) ??
      (await seedTeam({
        teamName: data.teamName,
        managerUserId: seeded.id,
      }));
    await addMember({ userId: seeded.id, groupId: team.id, adminAccess: true });
    await setQuota({ userId: seeded.id, groupId: team.id });
  }

  return res.status(201).json({ user: seeded, team: team ?? null });
};
