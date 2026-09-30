import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Hand supertest this server's `url`, never the bare app: for a bare app it listens on `::` and
 * connects to 127.0.0.1, where on macOS another process's loopback listener can hold the port and
 * answer instead. Binding 127.0.0.1 makes the OS refuse a port someone else holds there.
 */
export async function listenOnLoopback(
  app: RequestListener
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return { url: `http://127.0.0.1:${port}`, close };
}
