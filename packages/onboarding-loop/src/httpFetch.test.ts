import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpFetch } from "./httpFetch";

let server: http.Server;
let base = "";
const seen: Array<{
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/elsewhere" });
        res.end();
      } else if (req.url === "/cookies") {
        res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } else if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`hello ${req.method} ${body}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

describe("createHttpFetch", () => {
  const fetchImpl = createHttpFetch();

  it("sends the method, headers and body, and reads the whole answer", async () => {
    const response = await fetchImpl(`${base}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://x" },
      body: '{"token":"t"}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello POST {"token":"t"}');
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      url: "/claim",
      body: '{"token":"t"}',
    });
    expect(seen.at(-1)?.headers["origin"]).toBe("https://x");
  });

  it("never follows a redirect: the 3xx comes back with its location", async () => {
    const response = await fetchImpl(`${base}/redirect`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/elsewhere");
  });

  it("keeps every set-cookie, the way verify.ts splits them", async () => {
    const response = await fetchImpl(`${base}/cookies`);
    expect(response.headers.get("set-cookie")).toBe("a=1; Path=/, b=2; Path=/");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("a 204 has no body; a connection failure rejects", async () => {
    const response = await fetchImpl(`${base}/empty`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    await expect(
      fetchImpl("http://127.0.0.1:1/", { method: "GET" }),
    ).rejects.toThrow();
  });

  it("uses the lookup it is given", async () => {
    const asked: string[] = [];
    const port = (server.address() as { port: number }).port;
    const pinned = createHttpFetch({
      lookup: (hostname, options, callback) => {
        asked.push(hostname);
        const done = (typeof options === "function" ? options : callback)!;
        const all =
          typeof options === "object" &&
          options !== null &&
          options.all === true;
        if (all) done(null, [{ address: "127.0.0.1", family: 4 }]);
        else done(null, "127.0.0.1", 4);
      },
    });
    const response = await pinned(`http://loop.invalid:${port}/`);
    expect(response.status).toBe(200);
    expect(asked).toEqual(["loop.invalid"]);
  });
});
