export const JSON_HEADERS = {
  "Content-Type": "application/json",
};

export const SENSITIVE_JSON_HEADERS = {
  ...JSON_HEADERS,
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

export function jsonResponse(
  payload: unknown,
  status = 200,
  headers: HeadersInit = JSON_HEADERS,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}
