# Attachments bypass the API: presigned S3 upload, Lambda processing, signed callback

Attachments (a doctor's note on a sick request, designed in Daniel88dev/flexi-day-workspace#7) are
the first binary payload the product handles. The obvious path is a multipart endpoint on Express.
We chose not to build one. The browser uploads straight to S3 under a presigned POST the API
issues, an S3 event triggers the `attachment-processor` Lambda, which validates the bytes,
rewrites every image to JPEG and stores the result under the final key, and the Lambda then calls
one internal API endpoint, signed with a shared secret, to mark the row `READY` or `REJECTED`.
No file bytes ever pass through App Runner.

The alternatives were streaming through Express, and posting from the browser to a Lambda URL.
Express runs with the default 100 kB body limit and has no multipart parser, the frontend client
speaks JSON only, and every upload and download would spend App Runner memory and bandwidth. A
Lambda URL caps a request at 6 MB, below the 10 MB limit we wanted, and cannot check the session
cookie without the database. The chosen shape keeps the API stateless about bytes, and the Lambda
runs outside the VPC, so there is no NAT cost. The trade is a two-phase upload: an attachment
exists in `UPLOADING` state before its bytes are usable, the API trusts a callback rather than its
own parser, and a second deployable rides in CD. Locally the same processing module runs in-process
behind a disk-backed store, so nothing here needs AWS to develop against.

## What would reverse this

Attachments growing into a general document feature with server-side rendering or search, where
the API needs the bytes anyway. At that point stream through the API and delete the Lambda; the
`attachments` table and its statuses stay as they are.

## Note: the Person export reads bytes inside App Runner

Since the Person export (`docs/person-export.md`), one path does pass file bytes through App Runner.
The background build reads each held attachment from the attachments bucket, writes the ZIP to the
instance's temporary disk and puts it in the organization-data bucket. The download itself still
goes straight from S3 under a signed link. Uploads are unchanged: they still go to S3 and through
the Lambda. The build holds one attachment in memory at a time, so its cost is temporary disk the
size of the ZIP and the bucket reads.
