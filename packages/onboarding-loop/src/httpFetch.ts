/**
 * A `fetch` over `node:https` for the claim and the verifier (design 4.5,
 * 4.7): the global fetch cannot be pointed at a resolver, and every
 * host-side probe must resolve at the zone's authoritative nameservers so a
 * hostname published a minute ago answers at once. `redirect` is always
 * manual (a 3xx comes back as the Response it is), the body is read whole,
 * and the Response is the standard one, so claim.ts and verify.ts see what
 * they would from the global fetch. `http:` works too, for the test server.
 */
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import type { LookupFn } from "./dns";
import type { FetchLike } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;

function headerRecord(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = init.headers;
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const pair of headers) {
      const [key, value] = pair;
      if (key !== undefined && value !== undefined) out[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") out[key] = value;
      else if (Array.isArray(value)) out[key] = value.join(", ");
    }
  }
  return out;
}

interface HttpFetchOptions {
  /** `dns.lookup`'s signature; dns.ts's authoritative lookup in production. */
  lookup?: LookupFn;
  timeoutMs?: number;
}

export function createHttpFetch(options: HttpFetchOptions = {}): FetchLike {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      const transport = url.protocol === "http:" ? http : https;
      const body =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Uint8Array
            ? Buffer.from(init.body)
            : null;
      const request = transport.request(
        url,
        {
          method: init.method ?? "GET",
          headers: headerRecord(init),
          timeout: timeoutMs,
          // `net.LookupFunction` is the type http.request wants for `lookup`.
          ...(options.lookup
            ? { lookup: options.lookup as unknown as net.LookupFunction }
            : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value))
                for (const one of value) headers.append(key, one);
              else if (value !== undefined) headers.append(key, value);
            }
            const content = Buffer.concat(chunks);
            // A Response refuses a body on 204 and 304, and a status outside 200..599.
            const bodyAllowed = status !== 204 && status !== 304;
            resolve(
              new Response(bodyAllowed && content.length ? content : null, {
                status: status >= 200 && status <= 599 ? status : 502,
                headers,
              }),
            );
          });
        },
      );
      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy(
          new Error(`No answer from ${url.host} in ${timeoutMs} ms`),
        );
      });
      init.signal?.addEventListener("abort", () =>
        request.destroy(new Error("aborted")),
      );
      if (body !== null) request.write(body);
      request.end();
    });
}
