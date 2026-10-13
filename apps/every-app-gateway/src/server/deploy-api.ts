/**
 * Shared pieces of the deploy-token API (`/api/deploy/*`) that
 * `everyapp app deploy` and `everyapp gateway …` call.
 */
import type { z } from "zod";
import { appBindingName } from "@every-app/perimeter/manifest";
import { jsonResponse } from "@/server/deploy-token-auth";
import { AppRegistrationError } from "@/server/services/AppRegistrationService";

/** The oldest CLI and SDK that speak this gateway's deploy protocol. */
export const MIN_CLI_VERSION = "0.3.0";
export const MIN_SDK_VERSION = "0.3.0";

/** Map a registry error to its JSON response; anything else is rethrown. */
export function deployErrorResponse(error: unknown): Response {
  if (error instanceof AppRegistrationError) {
    return jsonResponse(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      },
      error.status,
    );
  }
  throw error;
}

/** Parse a JSON body with `schema`, or the 400 to answer instead. */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "Invalid JSON payload" }, 400),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonResponse(
        { error: parsed.error.issues[0]?.message || "Invalid request payload" },
        400,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * Whether this gateway version can reach an app's Worker: it has the
 * service binding, and a request through it gets any HTTP response.
 */
export async function probeAppBinding(
  env: object,
  app: { workerName: string; hostname: string },
): Promise<boolean> {
  const binding = (env as Record<string, unknown>)[
    appBindingName(app.workerName)
  ] as ServiceBinding | undefined;
  if (typeof binding?.fetch !== "function") return false;
  try {
    await binding.fetch(
      new Request(`https://${app.hostname}/__everyapp/health`),
    );
    return true;
  } catch {
    return false;
  }
}
