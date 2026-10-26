import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import TransportStream from "winston-transport";
import { logger } from "../../middleware/logger.js";
import { db } from "../../db/db.js";
import {
  dataKeyWrapping,
  organizationDataKeys,
} from "../../db/schema/organization-data-key-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { deleteAccountRows } from "../../services/accountDeletion/accountDeletionServices.js";
import { DataKey } from "../../services/fieldEncryption/dataKey.js";
import { forgetDataKeys, unwrapDataKey } from "../../services/fieldEncryption/keyring.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  fieldContext,
  openOrganizationCipher,
} from "../../services/fieldEncryption/fieldEncryptionServices.js";
import {
  rekeyOrganization,
  type EncryptedTable,
} from "../../services/fieldEncryption/rekeyServices.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";

const seedOrganization = async (label: string) => {
  const owner = await createTestUser(`${label}-owner@field-encryption.test`, `${label}`, "x");
  return ensureOrganizationForUser(owner.id);
};

const PHONE = fieldContext("employment_contacts", "private_phone", "employment-1");

describe("per-organization field encryption", () => {
  beforeEach(cleanupTestData);
  afterAll(cleanupTestData);

  it("round-trips a value and stores nothing readable", async () => {
    const organization = await seedOrganization("roundtrip");

    const stored = await db.transaction(async (tx) => {
      const cipher = await openOrganizationCipher(organization.id, tx);
      return cipher.encrypt("+420 777 123 456", PHONE);
    });

    expect(stored).not.toContain("777");
    expect(Buffer.from(stored, "utf8").toString("latin1")).not.toContain("+420");

    const read = await db.transaction(async (tx) =>
      (await openOrganizationCipher(organization.id, tx)).decrypt(stored, PHONE)
    );
    expect(read).toBe("+420 777 123 456");
  });

  it("cannot read a value without the organization's own key", async () => {
    const mine = await seedOrganization("mine");
    const theirs = await seedOrganization("theirs");

    const stored = await db.transaction(async (tx) =>
      (await openOrganizationCipher(mine.id, tx)).encrypt("1990-04-12", PHONE)
    );

    await expect(
      db.transaction(async (tx) =>
        (await openOrganizationCipher(theirs.id, tx)).decrypt(stored, PHONE)
      )
    ).rejects.toThrow();
    await expect(
      db.transaction(async (tx) =>
        (await openOrganizationCipher(mine.id, tx)).decrypt(
          stored,
          fieldContext("employment_contacts", "private_phone", "employment-2")
        )
      )
    ).rejects.toThrow();

    const [row] = await db
      .select()
      .from(organizationDataKeys)
      .where(eq(organizationDataKeys.organizationId, mine.id));
    expect(row?.wrapping).toBe(dataKeyWrapping.Local);
    expect(row?.version).toBe(1);

    // The stored ciphertext opened with a fresh, unrelated key fails too.
    const body = Buffer.from(stored.split(":")[2]!, "base64url");
    expect(() => DataKey.generate().open(body, Buffer.alloc(0))).toThrow();
  });

  describe("re-keying one organization", () => {
    const PROBE: EncryptedTable = {
      table: "field_encryption_probe",
      id: "id",
      organizationId: "organization_id",
      columns: ["phone", "address"],
    };

    beforeAll(async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS field_encryption_probe (
          id text PRIMARY KEY,
          organization_id text NOT NULL,
          phone text,
          address text
        )`);
    });
    afterAll(async () => {
      await db.execute(sql`DROP TABLE IF EXISTS field_encryption_probe`);
    });
    beforeEach(async () => {
      await db.execute(sql`DELETE FROM field_encryption_probe`);
    });

    const ctx = (column: string, id: string) => fieldContext(PROBE.table, column, id);

    const seedRow = async (
      organizationId: string,
      id: string,
      phone: string,
      address: string | null
    ) => {
      await db.transaction(async (tx) => {
        const cipher = await openOrganizationCipher(organizationId, tx);
        await tx.execute(sql`
          INSERT INTO field_encryption_probe (id, organization_id, phone, address)
          VALUES (${id}, ${organizationId}, ${cipher.encrypt(phone, ctx("phone", id))},
            ${address === null ? null : cipher.encrypt(address, ctx("address", id))})`);
      });
    };

    const storedRow = async (id: string) => {
      const { rows } = await db.execute<{ phone: string | null; address: string | null }>(
        sql`SELECT phone, address FROM field_encryption_probe WHERE id = ${id}`
      );
      return rows[0]!;
    };

    const readRow = async (organizationId: string, id: string) => {
      const stored = await storedRow(id);
      return db.transaction(async (tx) => {
        const cipher = await openOrganizationCipher(organizationId, tx);
        return {
          phone: stored.phone && cipher.decrypt(stored.phone, ctx("phone", id)),
          address: stored.address && cipher.decrypt(stored.address, ctx("address", id)),
        };
      });
    };

    const keyRow = async (organizationId: string) =>
      (
        await db
          .select()
          .from(organizationDataKeys)
          .where(eq(organizationDataKeys.organizationId, organizationId))
      )[0]!;

    it("re-encrypts the organization's rows under a new key, twice without harm", async () => {
      const mine = await seedOrganization("rekey-mine");
      const other = await seedOrganization("rekey-other");
      await seedRow(mine.id, "row-1", "+420 111", "Main Street 1");
      await seedRow(mine.id, "row-2", "+420 222", null);
      await seedRow(other.id, "row-3", "+420 333", "Side Street 3");
      const before = await keyRow(mine.id);
      const beforeRow = await storedRow("row-1");
      const otherBefore = await storedRow("row-3");

      expect(await rekeyOrganization(mine.id, { tables: [PROBE] })).toEqual({
        organizationId: mine.id,
        version: 2,
        values: 3,
      });

      const after = await keyRow(mine.id);
      expect(after.version).toBe(2);
      expect(after.wrappedKey).not.toBe(before.wrappedKey);
      expect(after.rotatedAt).not.toBeNull();
      expect((await storedRow("row-1")).phone).not.toBe(beforeRow.phone);
      expect((await storedRow("row-1")).phone).toMatch(/^fe1:2:/);
      expect(await readRow(mine.id, "row-1")).toEqual({
        phone: "+420 111",
        address: "Main Street 1",
      });
      expect(await readRow(mine.id, "row-2")).toEqual({ phone: "+420 222", address: null });

      expect(await rekeyOrganization(mine.id, { tables: [PROBE] })).toMatchObject({ version: 3 });
      expect(await readRow(mine.id, "row-1")).toEqual({
        phone: "+420 111",
        address: "Main Street 1",
      });

      expect(await storedRow("row-3")).toEqual(otherBefore);
      expect((await keyRow(other.id)).version).toBe(1);
      expect(await readRow(other.id, "row-3")).toEqual({
        phone: "+420 333",
        address: "Side Street 3",
      });
    });

    it("changes nothing when one value cannot be read", async () => {
      const mine = await seedOrganization("rekey-broken");
      await seedRow(mine.id, "row-1", "+420 111", "Main Street 1");
      await seedRow(mine.id, "row-2", "+420 222", "Main Street 2");
      // A value copied from another row fails its context check.
      const copied = await storedRow("row-1");
      await db.execute(
        sql`UPDATE field_encryption_probe SET address = ${copied.address} WHERE id = 'row-2'`
      );
      const before = await keyRow(mine.id);
      const row1Before = await storedRow("row-1");

      await expect(rekeyOrganization(mine.id, { tables: [PROBE] })).rejects.toThrow();

      expect(await keyRow(mine.id)).toEqual(before);
      expect(await storedRow("row-1")).toEqual(row1Before);
      expect(await readRow(mine.id, "row-1")).toEqual({
        phone: "+420 111",
        address: "Main Street 1",
      });
    });

    it("leaves an organization with no data key alone", async () => {
      const fresh = await seedOrganization("rekey-fresh");
      expect(await rekeyOrganization(fresh.id, { tables: [PROBE] })).toEqual({
        organizationId: fresh.id,
        version: null,
        values: 0,
      });
      expect(
        await db
          .select()
          .from(organizationDataKeys)
          .where(eq(organizationDataKeys.organizationId, fresh.id))
      ).toEqual([]);
    });
  });

  it("deletes the wrapped key in the transaction that deletes the organization", async () => {
    const organization = await seedOrganization("deleted");
    await db.transaction(async (tx) => {
      await openOrganizationCipher(organization.id, tx);
    });
    const keyRows = () =>
      db
        .select()
        .from(organizationDataKeys)
        .where(eq(organizationDataKeys.organizationId, organization.id));

    const rolledBack = new Error("rolled back");
    await expect(
      db.transaction(async (tx) => {
        await tx.delete(organizations).where(eq(organizations.id, organization.id));
        expect(
          await tx
            .select()
            .from(organizationDataKeys)
            .where(eq(organizationDataKeys.organizationId, organization.id))
        ).toEqual([]);
        throw rolledBack;
      })
    ).rejects.toBe(rolledBack);
    expect(await keyRows()).toHaveLength(1);

    await db.transaction(async (tx) => {
      await tx.delete(organizations).where(eq(organizations.id, organization.id));
    });
    expect(await keyRows()).toEqual([]);
  });

  it("deletes the wrapped key when the owner's account deletion takes the organization", async () => {
    const organization = await seedOrganization("account-deleted");
    await db.transaction(async (tx) => {
      await openOrganizationCipher(organization.id, tx);
    });

    await db.transaction((tx) => deleteAccountRows(organization.ownerUserId, tx));

    expect(
      await db
        .select()
        .from(organizationDataKeys)
        .where(eq(organizationDataKeys.organizationId, organization.id))
    ).toEqual([]);
  });

  it("keeps key material and values out of the logs", async () => {
    const lines: string[] = [];
    const capture = new TransportStream({
      log(info: Record<string | symbol, unknown>, done: () => void) {
        lines.push(String(info[Symbol.for("message")]));
        done();
      },
    });
    logger.add(capture);
    try {
      const organization = await seedOrganization("logs");
      const stored = await db.transaction(async (tx) => {
        const cipher = await openOrganizationCipher(organization.id, tx);
        logger.info("cipher opened", { cipher, organizationId: organization.id });
        return cipher.encrypt("Emergency Contact Jana", PHONE);
      });

      const [row] = await db
        .select()
        .from(organizationDataKeys)
        .where(eq(organizationDataKeys.organizationId, organization.id));
      forgetDataKeys();
      const key = await unwrapDataKey(organization.id, row!);
      logger.info("data key", { key, nested: { key } });
      logger.info(`interpolated ${key}`);

      const failure = await db
        .transaction(async (tx) =>
          (await openOrganizationCipher(organization.id, tx)).decrypt(stored, "another.field:x")
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      logger.error("decrypt failed", { error: failure });

      await rekeyOrganization(organization.id, { tables: [] });

      const raw = key.exportBytes();
      const forbidden = [
        raw.toString("hex"),
        raw.toString("base64"),
        raw.toString("base64url"),
        JSON.stringify([...raw]),
        "Emergency Contact Jana",
      ];
      const output = lines.join("\n");
      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(output).toContain("[DataKey]");
      for (const secret of forbidden) expect(output).not.toContain(secret);
    } finally {
      logger.remove(capture);
    }
  });
});
