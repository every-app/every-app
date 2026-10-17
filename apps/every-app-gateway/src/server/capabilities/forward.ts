import { IDENTITY_HEADER, PUBLIC_HEADER } from "@every-app/sdk/internal";

/** Headers an app's capability call never takes to the provider. */
const STRIPPED_HEADERS = [
  // The gateway's key decides the account, never the app.
  "authorization",
  "x-api-key",
  "cookie",
  IDENTITY_HEADER,
  PUBLIC_HEADER,
  "x-user-id",
  "x-user-email",
  "x-user-sub",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];
// Every gateway trust header: none of them is the provider's business.
const STRIPPED_HEADER_PREFIX = "x-everyapp-";

/**
 * The app's request headers as the provider may see them: no credentials,
 * cookies, identities, gateway trust headers or hop-by-hop headers.
 */
export function forwardableHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const header of STRIPPED_HEADERS) headers.delete(header);
  for (const header of [...headers.keys()]) {
    if (header.startsWith(STRIPPED_HEADER_PREFIX)) headers.delete(header);
  }
  return headers;
}
