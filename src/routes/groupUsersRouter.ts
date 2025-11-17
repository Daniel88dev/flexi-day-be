import { Router } from "express";
import { handleGetGroupUsers } from "../controllers/groupUser/handleGetGroupUsers.js";
import { handlePostGroupUser } from "../controllers/groupUser/handlePostGroupUser.js";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { handleUpdateGroupUsers } from "../controllers/groupUser/handleUpdateGroupUsers.js";
import { validatePutGroupUserUpdate } from "../services/groupUser/types.js";

export const groupUsersRouter = (): Router => {
  const app = Router();

  app.get("/:groupId", tryCatch(handleGetGroupUsers));
  app.post("/code/:validationCode", tryCatch(handlePostGroupUser));
  app.put(
    "/",
    bodyValidationMiddleware(validatePutGroupUserUpdate),
    tryCatch(handleUpdateGroupUsers)
  );

  return app;
};
