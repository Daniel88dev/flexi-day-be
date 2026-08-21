import type { Request, Response } from "express";
import { searchOrganizationsForSupport } from "../../services/support/supportServices.js";

export const handleSearchOrganizations = async (req: Request, res: Response) => {
  const raw = req.query.query;
  const query = typeof raw === "string" ? raw.slice(0, 200) : undefined;

  const organizations = await searchOrganizationsForSupport(query);

  return res.status(200).json({ organizations });
};
