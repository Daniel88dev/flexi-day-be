import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetAiAvailability } from "../controllers/aiFeatures/handleGetAiAvailability.js";
import {
  handleDismissPrivacyBanner,
  handleGetPrivacyBanner,
} from "../controllers/aiFeatures/handlePrivacyBanner.js";

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

  /**
   * @openapi
   * /api/ai-features/privacy-banner:
   *   get:
   *     tags:
   *       - AI features
   *     summary: Whether the caller sees the Privacy Policy update banner
   *     description: |
   *       The banner announces the Privacy Policy changes for the AI features. It
   *       shows to every signed-in user for 30 days from `PRIVACY_BANNER_FROM`,
   *       only while `AI_CONNECTIONS_ENABLED` is on (the preview list does not
   *       count), until the user dismisses it. A dismissal from before the
   *       current start date doesn't count, so a later update shows it again.
   *     operationId: handleGetPrivacyBanner
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Whether to show the banner
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [show]
   *               properties:
   *                 show:
   *                   type: boolean
   *       '401':
   *         description: Not signed in
   */
  app.get("/privacy-banner", tryCatch(handleGetPrivacyBanner));

  /**
   * @openapi
   * /api/ai-features/privacy-banner/dismiss:
   *   post:
   *     tags:
   *       - AI features
   *     summary: Dismiss the Privacy Policy update banner for the caller
   *     description: |
   *       Records the time of the dismissal for the caller only. Idempotent, and
   *       accepted whether or not the banner is showing. Takes no body.
   *     operationId: handleDismissPrivacyBanner
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '204':
   *         description: Dismissed
   *       '401':
   *         description: Not signed in
   */
  app.post("/privacy-banner/dismiss", tryCatch(handleDismissPrivacyBanner));

  return app;
};
