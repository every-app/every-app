import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { useUsageReports } from "@/client/hooks/useUsageReports";

/**
 * The notice owners and admins read before this Gateway's first usage
 * report, at the top of Manage workspace: what will be sent, from when,
 * and where to see it or turn it off. Gone once the first report's day
 * has come or reports are off.
 */
export function UsageReportsNotice() {
  const { data: status } = useUsageReports();
  if (!status?.notice) return null;
  return (
    <Alert variant="info" role="note" className="mb-6">
      <Info />
      <AlertTitle>{status.notice.headline}</AlertTitle>
      <AlertDescription>
        {status.notice.detail}{" "}
        <Link to="/admin/usage-reports" className="underline">
          See the exact report, or turn it off
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
