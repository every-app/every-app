import { buildCommand } from "@stricli/core";
import {
  accountFlag,
  forceDnsFlag,
  gatewayFlag,
  jsonFlag,
  verboseFlag,
} from "../flags";

export const registerCommand = buildCommand({
  loader: async () => {
    const { registerCommandHandler } = await import(".");
    return registerCommandHandler;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "App id (the manifest's id)",
          parse: String,
          placeholder: "appId",
        },
      ],
    },
    flags: {
      worker: {
        kind: "parsed",
        parse: String,
        brief:
          "The Worker, in the Gateway's account; the name the Gateway gives the app (it says which if this isn't it)",
      },
      manifest: {
        kind: "parsed",
        parse: String,
        brief: "The app's everyapp.config.ts",
      },
      gateway: gatewayFlag,
      "account-id": accountFlag,
      "force-dns": {
        ...forceDnsFlag,
        brief:
          "Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)",
      },
      "no-wait": {
        kind: "boolean",
        brief: "Don't wait for the app to go live; it goes live on its first visit",
        optional: true,
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Add a Worker deployed elsewhere as a shared app",
    fullDescription: [
      "Puts a Worker deployed some other way (an Alchemy stage, wrangler, a pipeline) behind a hosted",
      "Gateway as a shared app, with your Cloudflare login, in the Gateway's account:",
      "  1. Checks the Gateway is hosted, loads and validates the manifest as deploy does, and checks",
      "     the Worker exists in the account",
      "  2. Registers the app in the platform organization at <appId>.<base>, under the Worker name",
      "     the Gateway gives it (every-<orgKey>-<appId>), which --worker must be",
      "  3. Records the Worker's live version, redeploys the Gateway from this checkout to bind it",
      "     (APP__<worker>) and publish its hostname, then waits for it to go live",
      "",
      "Nothing about the Worker changes, and delete --purge keeps it. The app.register event lists",
      "what its own pipeline must give it (data.worker): the identity keys and issuer, and the",
      "AppGateway binding's props. Only owners and admins of the platform organization register",
      "shared apps; an organization's own app deploys with everyapp deploy.",
    ].join("\n"),
  },
});
