import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { readLogAudience } from "../../db/schema/read-log-schema.js";
import { getAuth } from "../../middleware/authSession.js";
import { isOrganizationAdmin } from "../../services/organization/organizationServices.js";
import {
  assertExportStoreConfigured,
  presentPersonExport,
  requestPersonExport,
} from "../../services/personExport/personExportServices.js";
import { enqueuePersonExport } from "../../services/personExport/personExportQueue.js";
import AppError from "../../utils/appError.js";

export const handlePostEmploymentExport = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const employmentId = z.uuid().parse(req.params.employmentId);
  const context = { userId: auth.userId, employmentId };
  assertExportStoreConfigured();

  const { row, created } = await db.transaction(async (tx) => {
    const [employment] = await tx
      .select({
        organizationId: employments.organizationId,
        userId: employments.userId,
        ownerUserId: organizations.ownerUserId,
      })
      .from(employments)
      .innerJoin(organizations, eq(organizations.id, employments.organizationId))
      .where(eq(employments.id, employmentId));
    if (!employment) {
      throw new AppError({ code: 404, message: "Employment not found", logging: true, context });
    }
    if (!(await isOrganizationAdmin(auth.userId, employment.organizationId, tx))) {
      throw new AppError({
        code: 403,
        message: "No permission for related organization",
        logging: true,
        context,
      });
    }
    return requestPersonExport(
      {
        organizationId: employment.organizationId,
        subjectUserId: employment.userId,
        requestedByUserId: auth.userId,
        audience:
          employment.ownerUserId === auth.userId
            ? readLogAudience.Owner
            : readLogAudience.OrganizationAdmin,
      },
      tx
    );
  });

  if (created) enqueuePersonExport(row.id);
  return res.status(202).json(presentPersonExport(row));
};
