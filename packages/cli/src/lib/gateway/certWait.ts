import { checkSslReady, GatewayUnreachableError } from "@/lib/gateway";
import type { EventSink } from "@/lib/output/events";

/**
 * Wait for a new hostname's certificate: the first deploy of a Custom
 * Domain takes a minute or two to get one. True once HTTPS answers.
 */
export async function waitForCertificate({
  url,
  out,
  step,
  maxWaitMs = 120_000,
  pollMs = 3_000,
}: {
  url: string;
  out: EventSink;
  step: string;
  maxWaitMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  let announced = false;
  for (;;) {
    try {
      if (await checkSslReady(url)) return true;
    } catch (error) {
      if (!(error instanceof GatewayUnreachableError)) throw error;
    }
    if (Date.now() >= deadline) {
      out.emit({
        type: "warning",
        code: "CERT_PENDING",
        step,
        message: `${url} has no certificate yet; it usually arrives within a few minutes. Check later with \`everyapp gateway status\`.`,
      });
      return false;
    }
    if (!announced) {
      out.emit({
        type: "progress",
        step,
        message: `Waiting for ${url} to get its certificate...`,
      });
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
