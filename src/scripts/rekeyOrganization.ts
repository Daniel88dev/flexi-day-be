// Usage: npm run rekey:organization -- <organizationId>
// docs/field-encryption.md says when and how to run it against production.
import { config } from "../config.js";
import { pool } from "../db/db.js";
import { rekeyOrganization } from "../services/fieldEncryption/rekeyServices.js";

const organizationId = process.argv[2];

if (!organizationId) {
  console.error("Usage: npm run rekey:organization -- <organizationId>");
  process.exit(1);
}

// The same rule as db:migrate:prod: a production write only from a person at a terminal.
if (config.api.env === "production" && !process.stdin.isTTY) {
  console.error("Re-keying production needs an interactive terminal");
  process.exit(1);
}

try {
  const result = await rekeyOrganization(organizationId);
  if (result.version === null) {
    console.log(`Organization ${organizationId} has no data key yet; nothing to re-key.`);
  } else {
    console.log(
      `Organization ${organizationId} is on data key version ${result.version}; ` +
        `${result.values} values re-encrypted.`
    );
  }
} finally {
  await pool.end();
}
