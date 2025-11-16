import { buildApplication, buildRouteMap } from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { name, version, description } from "../package.json";
import { appRoutes } from "./commands/app/command";
import { gatewayRoutes } from "./commands/gateway/commands";

const routes = buildRouteMap({
  routes: {
    app: appRoutes,
    gateway: gatewayRoutes,
    install: buildInstallCommand("every", { bash: "__every_bash_complete" }),
    uninstall: buildUninstallCommand("every", { bash: true }),
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
