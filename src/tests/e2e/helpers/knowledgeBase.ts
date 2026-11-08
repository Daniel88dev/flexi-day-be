import { config } from "../../../config.js";
import { resetKnowledgeBase } from "../../../services/knowledgeBase/knowledgeBase.js";
import { readKbSnapshot } from "../../fixtures/kbSnapshot.js";
import { listenOnLoopback } from "../../loopbackServer.js";

/**
 * Serves the committed KB snapshot as the frontend serves `/help/kb.json`
 * (ETag, 304 on a match) and points the loader at it. Returns the undo.
 */
export async function serveKnowledgeBase(): Promise<() => Promise<void>> {
  const body = readKbSnapshot();
  const etag = '"kb-snapshot"';
  const server = await listenOnLoopback((req, res) => {
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
    res.end(body);
  });
  const saved = config.knowledgeBase.bundleUrl;
  config.knowledgeBase.bundleUrl = `${server.url}/help/kb.json`;
  resetKnowledgeBase();
  return async () => {
    config.knowledgeBase.bundleUrl = saved;
    resetKnowledgeBase();
    await server.close();
  };
}

/** Points the loader at a port nothing listens on: no bundle ever loads. */
export function withoutKnowledgeBase(): () => void {
  const saved = config.knowledgeBase.bundleUrl;
  config.knowledgeBase.bundleUrl = "http://127.0.0.1:9/help/kb.json";
  resetKnowledgeBase();
  return () => {
    config.knowledgeBase.bundleUrl = saved;
    resetKnowledgeBase();
  };
}
