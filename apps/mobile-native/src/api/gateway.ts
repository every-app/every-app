import { authClient, getGatewayUrl } from "@/src/lib/auth-client";
import { z } from "zod";
import type { UserApp } from "@/src/types/gateway";

const timestampSchema = z.union([z.string(), z.number()]);

export const userAppSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string(),
  hostname: z.string(),
  status: z.string(),
  isDefault: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  grantedAt: timestampSchema,
});

export const userAppsResponseSchema = z.object({
  apps: z.array(userAppSchema),
});

async function getAuthHeaders(extraHeaders?: Record<string, string>) {
  const cookie = await authClient.getCookie();
  return {
    "Content-Type": "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
    ...extraHeaders,
  };
}

async function parseError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: string;
      message?: string;
    };

    if (data.error || data.message) {
      return (
        data.error ?? data.message ?? `Request failed (${response.status})`
      );
    }

    return `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function fetchUserApps(): Promise<UserApp[]> {
  const response = await fetch(`${getGatewayUrl()}/api/me/apps`, {
    method: "GET",
    headers: await getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  const result = userAppsResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Invalid response from /api/me/apps");
  }

  return result.data.apps;
}

export const signInMethodsSchema = z.object({
  emailPassword: z.boolean(),
  providers: z.array(z.object({ id: z.string(), label: z.string() })),
});

export type SignInMethods = z.infer<typeof signInMethodsSchema>;

/** A gateway that doesn't say (one from before Cloudflare Access sign-in). */
const PASSWORD_ONLY: SignInMethods = { emailPassword: true, providers: [] };

/**
 * How the gateway lets people sign in: passwords (unless turned off) and
 * "Continue with <label>" through Cloudflare Access, which the app runs in
 * the system browser. Falls back to passwords only if the gateway can't say.
 */
export async function fetchSignInMethods(): Promise<SignInMethods> {
  try {
    const response = await fetch(
      `${getGatewayUrl()}/api/auth/sign-in-methods`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    if (!response.ok) return PASSWORD_ONLY;
    const result = signInMethodsSchema.safeParse(await response.json());
    return result.success ? result.data : PASSWORD_ONLY;
  } catch {
    return PASSWORD_ONLY;
  }
}
