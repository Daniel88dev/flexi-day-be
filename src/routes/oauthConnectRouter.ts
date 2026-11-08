import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { requireAiFeature } from "../middleware/aiFeatureGuard.js";
import {
  validateConnectContextBody,
  validateConnectOrganizationBody,
  type ConnectOrganizationBody,
} from "../services/aiConnections/types.js";
import { handlePostConnectContext } from "../controllers/aiConnections/handlePostConnectContext.js";
import { handlePostConnectOrganization } from "../controllers/aiConnections/handlePostConnectOrganization.js";

/** Mounted ahead of the `/api` session block: the sign-in page asks before anyone is signed in. */
export const oauthConnectContextRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/oauth-connect/context:
   *   post:
   *     tags:
   *       - AI connections
   *     summary: What the connect pages show about one OAuth authorization request
   *     description: |
   *       The static sign-in, organization picker and consent pages an AI app
   *       opens post their own query string, the one the authorization server
   *       signed. The signature and expiry are checked before anything is read,
   *       so a page never shows what an altered URL claims; the authorization
   *       server checks the same signature again when the page posts consent.
   *
   *       `client.verified` is true for a Client ID Metadata Document, whose
   *       address was fetched: `client.host` is then the `client_id` host.
   *       Otherwise the name is the app's own claim and `client.host` is the
   *       redirect host. Logo and policy links are returned only when they are
   *       `https:`. `redirect.local` is true when the code goes to a loopback
   *       address, a program on the user's computer.
   *
   *       Works signed out. With a session, `organizations` lists where the user
   *       may connect (standing, AI connections not Off, a Paid plan) with the
   *       access each allows, and the organizations left out with the reason
   *       (`TURNED_OFF` or `PLAN`) and the owner's name; `organization` is the
   *       one picked for this flow, while it is still eligible.
   *     operationId: handlePostConnectContext
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [oauthQuery]
   *             properties:
   *               oauthQuery:
   *                 type: string
   *                 maxLength: 8192
   *                 description: The page's query string without the leading `?`
   *     responses:
   *       '200':
   *         description: The request's client, redirect, scopes and organizations
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [client, redirect, scopes, signedIn, organization, organizations]
   *               properties:
   *                 client:
   *                   type: object
   *                   required: [clientId, name, verified, host, logoUri, clientUri, policyUri, tosUri]
   *                   properties:
   *                     clientId: { type: string }
   *                     name: { type: string, nullable: true }
   *                     verified: { type: boolean }
   *                     host: { type: string }
   *                     logoUri: { type: string, nullable: true }
   *                     clientUri: { type: string, nullable: true }
   *                     policyUri: { type: string, nullable: true }
   *                     tosUri: { type: string, nullable: true }
   *                 redirect:
   *                   type: object
   *                   required: [host, local]
   *                   properties:
   *                     host: { type: string }
   *                     local: { type: boolean }
   *                 scopes:
   *                   type: array
   *                   items:
   *                     type: string
   *                     enum: [flexiday.read, flexiday.write]
   *                 signedIn:
   *                   type: boolean
   *                 organization:
   *                   nullable: true
   *                   allOf:
   *                     - $ref: '#/components/schemas/ConnectOrganization'
   *                 organizations:
   *                   type: object
   *                   nullable: true
   *                   required: [eligible, leftOut]
   *                   properties:
   *                     eligible:
   *                       type: array
   *                       items:
   *                         $ref: '#/components/schemas/ConnectOrganization'
   *                     leftOut:
   *                       type: array
   *                       items:
   *                         type: object
   *                         required: [organizationId, organizationName, ownerName, reason]
   *                         properties:
   *                           organizationId: { type: string, format: uuid }
   *                           organizationName: { type: string }
   *                           ownerName: { type: string }
   *                           reason:
   *                             type: string
   *                             enum: [TURNED_OFF, PLAN]
   *       '400':
   *         description: The query is unsigned, altered or expired, or names an unknown client (`INVALID_OAUTH_QUERY`)
   *       '404':
   *         description: AI connections are unavailable (switch off and nobody in preview)
   *       '422':
   *         description: Invalid body
   */
  app.post(
    "/context",
    requireAiFeature("aiConnections", "public"),
    bodyValidationMiddleware(validateConnectContextBody),
    tryCatch(handlePostConnectContext)
  );

  return app;
};

/** Mounted after `authSession`. */
export const oauthConnectRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * components:
   *   schemas:
   *     ConnectOrganization:
   *       type: object
   *       required: [organizationId, organizationName, access]
   *       properties:
   *         organizationId:
   *           type: string
   *           format: uuid
   *         organizationName:
   *           type: string
   *         access:
   *           type: string
   *           enum: [read, write]
   *           description: The organization's AI connections setting, Read only or Read and write
   * /api/oauth-connect/organization:
   *   post:
   *     tags:
   *       - AI connections
   *     summary: Pick the organization an AI app being connected will act in
   *     description: |
   *       The organization picker's choice. Stored on the caller's session, where
   *       the authorization server reads it at consent and makes it the consent's
   *       reference id, and from there the access token's
   *       `https://flexi-day.com/organization` claim. The page then calls
   *       `POST /api/auth/oauth2/continue` with `postLogin: true`. Every new
   *       authorization clears the stored choice, so the picker is shown each
   *       time. Eligibility is checked here and again at consent.
   *     operationId: handlePostConnectOrganization
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [organizationId]
   *             properties:
   *               organizationId:
   *                 type: string
   *     responses:
   *       '200':
   *         description: The organization now picked
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ConnectOrganization'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           `AI_ORGANIZATION_NOT_ELIGIBLE`, with `reason` `NO_STANDING`,
   *           `TURNED_OFF` or `PLAN`
   *       '404':
   *         description: AI connections are unavailable in that organization
   *       '422':
   *         description: Invalid body
   */
  app.post(
    "/organization",
    bodyValidationMiddleware(validateConnectOrganizationBody),
    requireAiFeature("aiConnections", {
      organizationId: (req) => (req.body as ConnectOrganizationBody).organizationId,
    }),
    tryCatch(handlePostConnectOrganization)
  );

  return app;
};
