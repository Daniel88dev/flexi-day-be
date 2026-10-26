# Field encryption

Sensitive section fields (Contact and Personal) are encrypted in the application before they reach
Postgres. A leaked connection string, dump or snapshot yields ciphertext. The decisions behind this
are in fenro T-477; the code is `src/services/fieldEncryption/`.

## Keys

- Each organization has one **Data key**, an AES-256 key, in `organization_data_keys`. The row
  holds it only wrapped, with a `version` that a re-key increments.
- Production wraps it with the customer managed KMS key `ORGANIZATION_DATA_KMS_KEY_ARN`
  (`alias/flexi-day-be-production-organization-data`, `terraform/organization-data.tf`), with the
  encryption context `organizationId`. Only the App Runner role's IAM policy grants
  `kms:GenerateDataKey` and `kms:Decrypt` on it.
- dev and test wrap it with a static key in `keyring.ts` and never build a KMS client. Each side
  refuses a key the other wrapped, so a production row never unwraps locally and a local row never
  reaches production.
- Production without `ORGANIZATION_DATA_KMS_KEY_ARN` boots, and any use of field encryption throws.
  It never falls back to the local key.
- An unwrapped key stays in process memory for up to 24 hours per instance, and is unwrapped again
  sooner if the stored row changes. It lives in a `DataKey`, which prints as `[DataKey]` through
  `toString`, `JSON.stringify` and `util.inspect`, so logging it by mistake leaks nothing.
- `BETTER_AUTH_SECRET` never keys these fields: it rotates every 90 days.

## Values

`openOrganizationCipher(organizationId, tx)` returns `encrypt(value, context)` and
`decrypt(stored, context)`. It creates the organization's key on first use.

- AES-256-GCM with a random 12-byte IV. Stored as `fe1:<key version>:<base64url iv|body|tag>`.
- The additional data binds the organization id and `fieldContext(table, column, rowId)`, so a
  value copied to another organization, row or column fails to decrypt.
- Encrypted fields can't be searched, sorted or kept unique in SQL.
- The cipher share-locks the key row until `tx` ends. Open it in the transaction that reads or
  writes the values.

## Re-key

```bash
npm run rekey:organization -- <organizationId>
```

Issues a new data key for one organization and re-encrypts every value it holds, in one
transaction. The script locks the key row first, so it waits for transactions holding the old key
and holds new ones off until it commits. If one value fails to decrypt, nothing changes. Running
it again just moves to the next version.

The script walks `ENCRYPTED_TABLES` in `rekeyServices.ts`. **A table that stores encrypted fields
must be listed there**, with its id column, its organization column and the encrypted columns,
and must seal each value with `fieldContext(<table>, <column>, <id>)`. A table missing from the
list is left unreadable by the first re-key. Today it holds `directory_sensitive_profiles`
(columns `contact` and `personal`, id `employment_id`).

Run it only when a data key may be compromised. Against production it runs from a terminal (it
refuses without one) with the production environment and AWS credentials allowed to call
`kms:GenerateDataKey` and `kms:Decrypt` on the key.

## Deletion

`organization_data_keys.organization_id` references `organizations` with `ON DELETE CASCADE`, so
every path that deletes an organization (account deletion, `dev:reset`) deletes its key in the
same transaction. Its values in the 7-day RDS backups are unreadable from then on.
