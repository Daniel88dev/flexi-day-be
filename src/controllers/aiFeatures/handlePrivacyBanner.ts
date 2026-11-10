import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import {
  dismissPrivacyBanner,
  privacyBannerShows,
} from "../../services/aiFeatures/privacyBanner.js";

export const handleGetPrivacyBanner = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  res.status(200).json({ show: await privacyBannerShows(userId) });
};

export const handleDismissPrivacyBanner = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  await dismissPrivacyBanner(userId);
  res.status(204).end();
};
