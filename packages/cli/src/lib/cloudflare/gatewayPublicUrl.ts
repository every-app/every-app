import {
  getDefaultAccountId,
  getWorkerUrl,
  isCloudflareAuthError,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare/auth";

const GATEWAY_WORKER_NAME = "every-app-gateway";

interface WorkerDomain {
  hostname: string;
  service: string;
}

/**
 * Resolve the externally routable gateway URL for the current account.
 *
 * Custom domains are the source of truth for gateway control-plane traffic.
 * Some token logins cannot read the domains endpoint, so 403 keeps the older
 * workers.dev fallback behavior.
 */
export async function getGatewayPublicUrl(accountId?: string): Promise<string> {
  const resolvedAccountId = accountId || (await getDefaultAccountId());

  try {
    const domains = await makeCloudflareAPIRequest<WorkerDomain[]>(
      `/accounts/${resolvedAccountId}/workers/domains?service=${encodeURIComponent(
        GATEWAY_WORKER_NAME,
      )}&per_page=100`,
    );

    const gatewayHostnames = domains
      .filter(
        (domain) =>
          domain.service === GATEWAY_WORKER_NAME &&
          typeof domain.hostname === "string" &&
          domain.hostname.length > 0,
      )
      .map((domain) => domain.hostname)
      .sort((a, b) => a.length - b.length || a.localeCompare(b));

    const hostname = gatewayHostnames[0];
    if (hostname) {
      return `https://${hostname}`;
    }
  } catch (error) {
    if (!isCloudflareAuthError(error)) {
      throw error;
    }
  }

  return getWorkerUrl(GATEWAY_WORKER_NAME, resolvedAccountId);
}
