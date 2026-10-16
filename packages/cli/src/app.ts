import { buildApplication, buildRouteMap } from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { name, version, description } from "../package.json";
import { createCommand } from "./commands/create/command";
import { dbRoutes } from "./commands/db/command";
import { deleteCommand } from "./commands/delete/command";
import { deployCommand } from "./commands/deploy/command";
import { devCommand } from "./commands/dev/command";
import { registerCommand } from "./commands/register/command";
import { secretRoutes } from "./commands/secret/command";
import { setupCommand } from "./commands/setup/command";
import { statusCommand } from "./commands/status/command";
import { workflowsRoutes } from "./commands/workflows/command";

const routes = buildRouteMap({
  routes: {
    setup: setupCommand,
    status: statusCommand,
    create: createCommand,
    dev: devCommand,
    deploy: deployCommand,
    register: registerCommand,
    delete: deleteCommand,
    secret: secretRoutes,
    db: dbRoutes,
    workflows: workflowsRoutes,
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
