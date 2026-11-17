import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { setUsageReports, usageReportStatus } from "@/server/telemetry/report";

// Usage reports (server/telemetry/): the Gateway's daily report to Every
// App. Manage workspace → Usage reports shows the exact report and the
// switch, to owners and admins.

/** Whether this Gateway sends usage reports, and the next and last report. */
export const getUsageReports = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(() => usageReportStatus());

/** Turn usage reports on or off. Off stops them at once. */
export const setUsageReportsSwitch = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => z.object({ on: z.boolean() }).parse(data))
  .handler(({ data, context }) => setUsageReports(context.org, data.on));
