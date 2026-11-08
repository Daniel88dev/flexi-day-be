import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KbBundle } from "../../services/knowledgeBase/bundle.js";

/** The frontend's `/help/kb.json`, committed. The e2e fixture now and the eval's snapshot later. */
export const KB_SNAPSHOT_PATH = fileURLToPath(new URL("./kb-snapshot.json", import.meta.url));

export const readKbSnapshot = (): string => readFileSync(KB_SNAPSHOT_PATH, "utf8");

export const kbSnapshot = (): KbBundle => JSON.parse(readKbSnapshot()) as KbBundle;
