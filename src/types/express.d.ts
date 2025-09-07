import { AuthSession } from "../middleware/getAuthSession";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthSession;
    }
  }
}

export {};
