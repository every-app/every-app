import {
  createEmailRoutingRule,
  deleteEmailRoutingRule,
  enableEmailRouting,
  getEmailRoutingCatchAll,
  getEmailRoutingRule,
  getEmailRoutingSettings,
  listEmailRoutingRules,
  updateEmailRoutingCatchAll,
  updateEmailRoutingRule,
} from "@/lib/cf/emailRouting";
import { isCfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { dnsRecordsAt } from "@/lib/domains/records";
import { resolveZone } from "@/lib/domains/zones";
import { EveryAppError } from "@/lib/errors";
import { appIdOfWorker } from "@/lib/gateway/registry";
import { CLI } from "@/lib/output/command";
import { confirmAtTerminal, confirmOrCancel } from "@/lib/output/prompt";

import { createEmailInstaller } from "@every-app/perimeter/install";
const installer = createEmailInstaller<CfRunner>({
  Error: EveryAppError,
  createEmailRoutingRule,
  deleteEmailRoutingRule,
  enableEmailRouting,
  getEmailRoutingCatchAll,
  getEmailRoutingRule,
  getEmailRoutingSettings,
  listEmailRoutingRules,
  updateEmailRoutingCatchAll,
  updateEmailRoutingRule,
  isCfError,
  dnsRecordsAt,
  resolveZone,
  appIdOfWorker,
  CLI,
  confirmAtTerminal,
  confirmOrCancel,
});
export const {
  planEmailRoutes,
  applyEmailRoutes,
  removeEmailRoutes,
  emailRouteProblems,
  emailDeclarations,
  routeRuleName,
  describeMailRoutes,
  unsentDomains,
} = installer;
export type EmailRouteProblem = Awaited<ReturnType<typeof emailRouteProblems>>[number];
