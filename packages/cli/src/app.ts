import { buildApplication, buildRouteMap } from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { name, version, description } from "../package.json";
import { appRoutes } from "./commands/app/command";
import { gatewayRoutes } from "./commands/gateway/commands";
import { devCommand } from "./commands/dev/command";
import { setupCommand } from "./commands/setup/command";

const routes = buildRouteMap({
  routes: {
    app: appRoutes,
    dev: devCommand,
    gateway: gatewayRoutes,
    setup: setupCommand,
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
