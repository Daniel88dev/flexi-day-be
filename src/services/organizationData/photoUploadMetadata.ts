/**
 * S3 object metadata the presigned photo POST pins, so the Lambda learns
 * which photo an object is and where its two sizes go without a database.
 * Kept apart from the store so the Lambda bundle can import it without the
 * API's config.
 */
export const PHOTO_UPLOAD_METADATA = { photoId: "photo-id", storageKey: "storage-key" } as const;
