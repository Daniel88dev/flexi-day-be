// archiver 8 ships no typings, and @types/archiver describes the v7 factory API.
// Only what the person export uses is declared.
declare module "archiver" {
  import { Transform } from "node:stream";

  interface ZipOptions {
    zlib?: { level?: number };
  }

  interface EntryData {
    name: string;
    date?: Date;
  }

  export class ZipArchive extends Transform {
    constructor(options?: ZipOptions);
    append(source: Buffer | string | NodeJS.ReadableStream, data: EntryData): this;
    finalize(): Promise<void>;
    pointer(): number;
  }
}
