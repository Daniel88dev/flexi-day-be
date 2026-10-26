import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig, kmsConstructed, kmsSend } = vi.hoisted(() => ({
  mockConfig: {
    api: { env: "test" as "test" | "dev" | "production" },
    organizationData: { kmsKeyArn: undefined as string | undefined, region: "eu-central-1" },
  },
  kmsConstructed: vi.fn(),
  kmsSend: vi.fn(),
}));

vi.mock("../../../config.js", () => ({ config: mockConfig }));

vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: class {
    constructor(options: unknown) {
      kmsConstructed(options);
    }
    send = kmsSend;
  },
  GenerateDataKeyCommand: class {
    readonly name = "GenerateDataKey";
    constructor(readonly input: unknown) {}
  },
  DecryptCommand: class {
    readonly name = "Decrypt";
    constructor(readonly input: unknown) {}
  },
}));

const KEY_ARN = "arn:aws:kms:eu-central-1:123456789012:key/test";
const DAY = 24 * 60 * 60 * 1000;

const loadKeyring = async () => {
  vi.resetModules();
  return import("../keyring.js");
};

const kmsKeyBytes = () => new Uint8Array(32).fill(7);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.api.env = "test";
  mockConfig.organizationData.kmsKeyArn = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(["test", "dev"] as const)("data keys under NODE_ENV=%s", (env) => {
  it("wrap and unwrap with the static local key and never touch KMS", async () => {
    mockConfig.api.env = env;
    mockConfig.organizationData.kmsKeyArn = KEY_ARN;
    const { dataKeyWrapper, unwrapDataKey, forgetDataKeys } = await loadKeyring();

    const wrapper = dataKeyWrapper();
    const { wrappedKey } = await wrapper.generate("org-1");
    forgetDataKeys();
    const key = await unwrapDataKey("org-1", { wrapping: wrapper.kind, wrappedKey, version: 1 });

    expect(wrapper.kind).toBe("local");
    expect(key).toBeDefined();
    expect(kmsConstructed).not.toHaveBeenCalled();
    expect(kmsSend).not.toHaveBeenCalled();
  });

  it("refuse a key KMS wrapped", async () => {
    mockConfig.api.env = env;
    const { unwrapDataKey } = await loadKeyring();

    await expect(
      unwrapDataKey("org-1", { wrapping: "kms" as never, wrappedKey: "AAAA", version: 1 })
    ).rejects.toThrow(/wrapped by kms/);
    expect(kmsConstructed).not.toHaveBeenCalled();
  });
});

describe("data keys in production", () => {
  beforeEach(() => {
    mockConfig.api.env = "production";
    mockConfig.organizationData.kmsKeyArn = KEY_ARN;
  });

  it("asks KMS for a data key bound to the organization", async () => {
    kmsSend.mockResolvedValueOnce({
      Plaintext: kmsKeyBytes(),
      CiphertextBlob: new Uint8Array([1, 2, 3]),
    });
    const { dataKeyWrapper } = await loadKeyring();

    const { wrappedKey } = await dataKeyWrapper().generate("org-1");

    expect(wrappedKey).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(kmsConstructed).toHaveBeenCalledWith({ region: "eu-central-1" });
    expect(kmsSend.mock.calls[0]![0]).toMatchObject({
      name: "GenerateDataKey",
      input: { KeyId: KEY_ARN, KeySpec: "AES_256", EncryptionContext: { organizationId: "org-1" } },
    });
  });

  it("unwraps through KMS once a day per instance", async () => {
    vi.useFakeTimers();
    kmsSend.mockImplementation(async () => ({ Plaintext: kmsKeyBytes() }));
    const { unwrapDataKey } = await loadKeyring();
    const stored = { wrapping: "kms" as never, wrappedKey: "AQID", version: 1 };

    const first = await unwrapDataKey("org-1", stored);
    vi.advanceTimersByTime(DAY - 1000);
    expect(await unwrapDataKey("org-1", stored)).toBe(first);
    expect(kmsSend).toHaveBeenCalledTimes(1);
    expect(kmsSend.mock.calls[0]![0]).toMatchObject({
      name: "Decrypt",
      input: { KeyId: KEY_ARN, EncryptionContext: { organizationId: "org-1" } },
    });

    vi.advanceTimersByTime(2000);
    await unwrapDataKey("org-1", stored);
    expect(kmsSend).toHaveBeenCalledTimes(2);
  });

  it("unwraps again once the stored key changes", async () => {
    kmsSend.mockImplementation(async () => ({ Plaintext: kmsKeyBytes() }));
    const { unwrapDataKey } = await loadKeyring();

    await unwrapDataKey("org-1", { wrapping: "kms" as never, wrappedKey: "AQID", version: 1 });
    await unwrapDataKey("org-1", { wrapping: "kms" as never, wrappedKey: "BAUG", version: 2 });

    expect(kmsSend).toHaveBeenCalledTimes(2);
  });

  it("refuses a key wrapped with the local key", async () => {
    const { unwrapDataKey } = await loadKeyring();

    await expect(
      unwrapDataKey("org-1", { wrapping: "local" as never, wrappedKey: "AAAA", version: 1 })
    ).rejects.toThrow(/wrapped by local/);
    expect(kmsSend).not.toHaveBeenCalled();
  });

  it("refuses to fall back to the local key without a KMS key", async () => {
    mockConfig.organizationData.kmsKeyArn = undefined;
    const { dataKeyWrapper } = await loadKeyring();

    expect(() => dataKeyWrapper()).toThrow(/ORGANIZATION_DATA_KMS_KEY_ARN/);
  });
});
