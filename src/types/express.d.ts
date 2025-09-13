import type { AuthSession } from "../middleware/authSession.js";

declare global {
  namespace Express {
    interface Request {
      auth: AuthSession;
    }
  }
}

export {};
