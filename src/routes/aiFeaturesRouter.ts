import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetAiAvailability } from "../controllers/aiFeatures/handleGetAiAvailability.js";

export const aiFeaturesRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/ai-features/availability:
   *   get:
   *     tags:
   *       - AI features
   *     summary: Whether the Assistant and AI connections are available to the caller
   *     description: |
   *       A feature is available in an organization while its kill switch
   *       (`ASSISTANT_ENABLED`, `AI_CONNECTIONS_ENABLED`) is on, or while the
   *       organization is on the preview list (`AI_PREVIEW_ORGANIZATION_IDS`).
   *       Lists every organization the caller owns, administers, manages a
   *       group in or belongs to, oldest first. The top-level flags are true
   *       when the switch is on or any listed organization has the feature.
   *       The web app hides every entry point of a feature that is unavailable.
   *       Says nothing about plan, settings or standing, except
   *       `newAgreementVersionReady`: true only on the organization the caller
   *       owns, while an AI feature is on there and the AI features agreement
   *       version it last accepted is older than the current one. The web
   *       shows the owner a banner from it.
   *     operationId: handleGetAiAvailability
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Availability per feature and per organization
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [assistant, aiConnections, organizations]
   *               properties:
   *                 assistant:
   *                   type: boolean
   *                 aiConnections:
   *                   type: boolean
   *                 organizations:
   *                   type: array
   *                   items:
   *                     type: object
   *                     required: [organizationId, assistant, aiConnections, newAgreementVersionReady]
   *                     properties:
   *                       organizationId:
   *                         type: string
   *                         format: uuid
   *                       assistant:
   *                         type: boolean
   *                       aiConnections:
   *                         type: boolean
   *                       newAgreementVersionReady:
   *                         type: boolean
   *       '401':
   *         description: Not signed in
   */
  app.get("/availability", tryCatch(handleGetAiAvailability));

  return app;
};
