import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KbBundle } from "../../services/knowledgeBase/types.js";

/** The frontend's `/help/kb.json`, committed: the e2e fixture and the eval's snapshot (`pnpm run eval:kb-sync`). */
export const KB_SNAPSHOT_PATH = fileURLToPath(new URL("./kb-snapshot.json", import.meta.url));

export const readKbSnapshot = (): string => readFileSync(KB_SNAPSHOT_PATH, "utf8");

export const kbSnapshot = (): KbBundle => JSON.parse(readKbSnapshot()) as KbBundle;
