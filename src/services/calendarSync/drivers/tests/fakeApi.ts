import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type ApiRequest = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};
export type ApiReply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A loopback HTTP API that records each request and answers from `answer`. */
export const startFakeApi = async () => {
  const requests: ApiRequest[] = [];
  let reply: (request: ApiRequest) => ApiReply = () => ({ status: 500, body: {} });

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const request: ApiRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers: req.headers,
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
    };
    requests.push(request);
    const { status, body, headers } = reply(request);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer: (next: (request: ApiRequest) => ApiReply) => {
      reply = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export type FakeApi = Awaited<ReturnType<typeof startFakeApi>>;
