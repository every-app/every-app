// A one-shot HTTP listener on 127.0.0.1, ephemeral port, for the OAuth redirect (port of
// HelperCore/LoopbackServer.swift).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthError } from "./oauth";
import { AuthError } from "./errors";
import { callbackPage, parseRedirect, type CallbackExpectation } from "./redirect";

export class LoopbackServer {
  private server: Server | undefined;
  private waiter:
    | { expectation: CallbackExpectation; resolve: (code: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
    | undefined;

  /** Starts listening; returns the port the system picked. */
  async start(): Promise<number> {
    const server = createServer((req, res) => {
      const reply = (status: number, title: string, message: string) => {
        res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          connection: "close",
        });
        res.end(callbackPage(title, message));
      };
      const waiter = this.waiter;
      if (!waiter) return reply(404, "Not found", "");
      const outcome = parseRedirect(req.method ?? "", req.url ?? "/", waiter.expectation);
      switch (outcome.kind) {
        case "code":
          reply(200, "You're signed in to Every App", "You can close this tab.");
          return this.finish({ code: outcome.code });
        case "denied": {
          reply(200, "Sign-in cancelled", "You can close this tab.");
          if (outcome.error === "invalid_client") return this.finish({ error: new OAuthError("invalidClient") });
          const why =
            outcome.error === "access_denied"
              ? "Sign-in was cancelled."
              : `Sign-in failed: ${outcome.description ?? outcome.error}.`;
          return this.finish({ error: new AuthError("message", why) });
        }
        case "invalid":
          reply(400, "Sign-in failed", outcome.reason);
          return this.finish({ error: new AuthError("message", outcome.reason) });
        case "ignore":
          return reply(404, "Not found", "");
      }
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  /** Waits for one callback meeting `expectation`. Can be called again (a retried sign-in). */
  waitForCode(expectation: CallbackExpectation, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    this.finish({ error: new AuthError("message", "Sign-in was restarted.") });
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => this.finish({ error: new AuthError("message", "Sign-in timed out. Try again.") }),
        timeoutMs,
      );
      this.waiter = { expectation, resolve, reject, timer };
      signal?.addEventListener("abort", () => this.finish({ error: new AuthError("cancelled", "Sign-in was cancelled.") }), {
        once: true,
      });
    });
  }

  stop(): void {
    this.finish({ error: new AuthError("cancelled", "Sign-in was cancelled.") });
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = undefined;
  }

  private finish(outcome: { code: string } | { error: Error }): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = undefined;
    clearTimeout(waiter.timer);
    if ("code" in outcome) waiter.resolve(outcome.code);
    else waiter.reject(outcome.error);
  }
}
