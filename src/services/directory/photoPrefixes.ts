/** Everything stored for one organization's photos, for deleting the organization. */
export const organizationPhotosPrefix = (organizationId: string) => `photos/${organizationId}/`;

/** Every photo an Employment ever had, for Erase and retention purges. */
export const employmentPhotosPrefix = (organizationId: string, employmentId: string) =>
  `${organizationPhotosPrefix(organizationId)}${employmentId}/`;

export const photoPrefix = (photo: { organizationId: string; employmentId: string; id: string }) =>
  `${employmentPhotosPrefix(photo.organizationId, photo.employmentId)}${photo.id}/`;

export const photoKeys = (prefix: string) => ({
  small: `${prefix}small.jpg`,
  full: `${prefix}full.jpg`,
});
