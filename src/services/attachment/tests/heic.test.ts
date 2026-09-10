import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { containerIsComplete, decodeHeic } from "../heic.js";

const wasmLoads = vi.hoisted(() => ({ count: 0 }));

// The decoder must never be reached for a truncated file, so the bundle is
// replaced by a stub that counts loads and throws if anything decodes with it.
vi.mock("libheif-js/wasm-bundle.js", () => {
  wasmLoads.count++;
  return {
    default: {
      HeifDecoder: class {
        decode() {
          throw new Error("the extent check must run before the decoder");
        }
      },
    },
  };
});

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const heic = readFileSync(path.join(fixturesDir, "oversized-exif.heic"));

const box = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
};

const boxWithLargeSize = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, "latin1");
  header.writeBigUInt64BE(BigInt(header.length + body.length), 8);
  return Buffer.concat([header, body]);
};

const boxToEndOfFile = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
};

const ftyp = box("ftyp", Buffer.from("heicmif1heic", "latin1"));

describe("containerIsComplete", () => {
  it("accepts a whole HEIC file", () => {
    expect(containerIsComplete(heic)).toBe(true);
  });

  it.each([
    ["half of it", Math.floor(heic.length / 2)],
    ["its first 4096 bytes", 4096],
    ["its first 64 bytes", 64],
  ])("rejects a HEIC cut down to %s", (_, length) => {
    expect(containerIsComplete(heic.subarray(0, length))).toBe(false);
  });

  it("accepts a box that declares its size in 64 bits", () => {
    const file = Buffer.concat([ftyp, boxWithLargeSize("mdat", Buffer.alloc(32, 7))]);

    expect(containerIsComplete(file)).toBe(true);
  });

  it("rejects a 64-bit size that overruns the buffer", () => {
    const file = Buffer.concat([ftyp, boxWithLargeSize("mdat", Buffer.alloc(32, 7))]);

    expect(containerIsComplete(file.subarray(0, file.length - 1))).toBe(false);
  });

  it("rejects a box whose 64-bit size is itself cut off", () => {
    const file = Buffer.concat([ftyp, boxWithLargeSize("mdat", Buffer.alloc(32, 7))]);

    expect(containerIsComplete(file.subarray(0, ftyp.length + 12))).toBe(false);
  });

  it("accepts a last box that runs to the end of the file", () => {
    const file = Buffer.concat([ftyp, boxToEndOfFile("mdat", Buffer.alloc(32, 7))]);

    expect(containerIsComplete(file)).toBe(true);
  });

  it("accepts a tail too short to hold a box header", () => {
    const file = Buffer.concat([ftyp, box("mdat", Buffer.alloc(16, 7)), Buffer.alloc(4)]);

    expect(containerIsComplete(file)).toBe(true);
  });

  it("rejects a longer tail that does not parse as a box", () => {
    const file = Buffer.concat([ftyp, box("mdat", Buffer.alloc(16, 7)), Buffer.alloc(16, 7)]);

    expect(containerIsComplete(file)).toBe(false);
  });

  it("rejects a box that claims fewer bytes than its own header", () => {
    const file = Buffer.concat([ftyp, box("mdat", Buffer.alloc(16, 7))]);
    file.writeUInt32BE(4, ftyp.length);

    expect(containerIsComplete(file)).toBe(false);
  });
});

describe("decodeHeic", () => {
  it("refuses a truncated file without loading the wasm module", async () => {
    await expect(decodeHeic(heic.subarray(0, 4096), 40_000_000)).resolves.toBeUndefined();
    await expect(decodeHeic(heic.subarray(0, 64), 40_000_000)).resolves.toBeUndefined();

    expect(wasmLoads.count).toBe(0);

    // A whole file does reach the stub, so the zero above is the check working
    // rather than a mock that never applied.
    await expect(decodeHeic(heic, 40_000_000)).rejects.toThrow(/before the decoder/);
    expect(wasmLoads.count).toBe(1);
  });
});
