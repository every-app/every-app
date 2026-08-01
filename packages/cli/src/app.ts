import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { name, version, description } from "../package.json";
import { appRoutes } from "./commands/app/command";
import { gatewayRoutes } from "./commands/gateway/commands";
import { devCommand } from "./commands/dev/command";

const loginCommand = buildCommand({
  loader: async () => {
    const { login } = await import("./commands/login");
    return login;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {},
  },
  docs: {
    brief: "Store a gateway deploy token",
  },
});

const logoutCommand = buildCommand({
  loader: async () => {
    const { logout } = await import("./commands/logout");
    return logout;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {},
  },
  docs: {
    brief: "Remove a stored gateway deploy token",
  },
});

const routes = buildRouteMap({
  routes: {
    app: appRoutes,
    dev: devCommand,
    gateway: gatewayRoutes,
    login: loginCommand,
    logout: logoutCommand,
    install: buildInstallCommand("everyapp", {
      bash: "__everyapp_bash_complete",
    }),
    uninstall: buildUninstallCommand("everyapp", { bash: true }),
  },
  docs: {
    brief: description,
    hideRoute: {
      install: true,
      uninstall: true,
    },
  },
});

export const app = buildApplication(routes, {
  name,
  versionInfo: {
    currentVersion: version,
  },
  scanner: {
    allowArgumentEscapeSequence: true,
  },
});
