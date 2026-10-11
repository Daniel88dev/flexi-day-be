/**
 * Hands targets whose `syncDueAt` is set to the sync queue. A no-op until BE-4
 * (T-295) puts the in-process queue behind it; the due marker is what persists.
 */
export const enqueueSync = (configIds: string[]): void => {
  void configIds;
};
