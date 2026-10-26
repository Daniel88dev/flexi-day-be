import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetDirectoryOrganizations } from "../controllers/directory/handleGetDirectoryOrganizations.js";

export const directoryRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/directory/organizations:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The organizations whose directory concerns the caller
   *     description: |
   *       Every organization the caller owns or administers, plus every one
   *       where they hold an open Employment, with whether its directory is
   *       on and whether its plan passes the directory gate. The web builds
   *       the People section from it: members see the Directory entry only
   *       where the directory is on; owners and org admins see it on every
   *       plan, with an Enterprise chip while the plan does not pass.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The caller's organizations
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   organizationId:
   *                     type: string
   *                   name:
   *                     type: string
   *                   role:
   *                     type: string
   *                     enum: [OWNER, ORGANIZATION_ADMIN, MEMBER]
   *                   enabled:
   *                     type: boolean
   *                   writable:
   *                     type: boolean
   *                   newAgreementVersionReady:
   *                     type: boolean
   *                     description: True only for the owner, while a newer agreement waits.
   *       '401':
   *         description: Not signed in
   */
  app.get("/organizations", tryCatch(handleGetDirectoryOrganizations));

  return app;
};
