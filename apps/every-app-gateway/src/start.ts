import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/**
 * Server functions are cookie-authenticated RPC endpoints, so only same-origin
 * calls may reach them (Sec-Fetch-Site, falling back to Origin, then Referer);
 * anything else gets a 403. TanStack Start applies this same middleware on its
 * own, but only while no src/start.ts exists, so it is declared here to keep
 * it once start options are added.
 *
 * Same-origin top-level navigations still pass, which is why every server
 * function that changes state is declared POST (see
 * serverFunctions/methods.test.ts).
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}));
