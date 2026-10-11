import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type TokenRequest = { path: string; form: URLSearchParams; authorization?: string };
export type TokenReply = { status: number; body: unknown };

/** A loopback OAuth token endpoint that records each request and answers from `reply`. */
export const startFakeTokenEndpoint = async () => {
  const requests: TokenRequest[] = [];
  let reply: (request: TokenRequest) => TokenReply = () => ({ status: 500, body: {} });

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

  const server = createServer(async (req, res) => {
    const request: TokenRequest = {
      path: req.url ?? "",
      form: new URLSearchParams(await readBody(req)),
      authorization: req.headers.authorization,
    };
    requests.push(request);
    const { status, body } = reply(request);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer: (next: (request: TokenRequest) => TokenReply) => {
      reply = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export type FakeTokenEndpoint = Awaited<ReturnType<typeof startFakeTokenEndpoint>>;
