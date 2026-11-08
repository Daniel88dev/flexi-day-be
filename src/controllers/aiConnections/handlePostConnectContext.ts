import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../../utils/auth.js";
import { readConnectContext } from "../../services/aiConnections/connectContext.js";
import type { ConnectContextBody } from "../../services/aiConnections/types.js";

const optionalViewer = async (req: Request) => {
  try {
    const current = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!current) return null;
    return {
      userId: current.user.id,
      oauthOrganizationId: current.session.oauthOrganizationId ?? null,
    };
  } catch {
    return null;
  }
};

export const handlePostConnectContext = async (req: Request, res: Response) => {
  const { oauthQuery } = req.body as ConnectContextBody;
  const context = await readConnectContext({ oauthQuery, viewer: await optionalViewer(req) });
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(context);
};
