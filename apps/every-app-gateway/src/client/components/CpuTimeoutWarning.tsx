import { CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { StatusScreen } from "@/client/components/StatusScreen";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";

interface CpuTimeoutWarningProps {
  attemptCount: number;
  maxRetries: number;
  hasExhaustedRetries: boolean;
  secondsUntilRetry: number;
  isSuccess?: boolean;
  onContinue?: () => void;
}

/**
 * Full-page warning component displayed when retrying due to Cloudflare Worker CPU timeout.
 * Explains the retry state and the Cloudflare CPU limit that caused it.
 */
export function CpuTimeoutWarning({
  attemptCount,
  maxRetries,
  hasExhaustedRetries,
  secondsUntilRetry,
  isSuccess,
  onContinue,
}: CpuTimeoutWarningProps) {
  return (
    <StatusScreen logo>
      {isSuccess ? (
        <Alert variant="success">
          <CheckCircle />
          <AlertTitle>You're signed in!</AlertTitle>
          <AlertDescription>
            Your sign in was successful. Continue when you're ready.
          </AlertDescription>
        </Alert>
      ) : hasExhaustedRetries ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Max Retries Reached</AlertTitle>
          <AlertDescription>
            <p>
              We tried {maxRetries} times but the request keeps timing out.
              Please wait a few minutes before trying again.
            </p>
            <p>
              Upgrading to the $5/month paid plan will resolve this. Go to
              Cloudflare: Compute & AI &gt; Workers Plans
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>
            {secondsUntilRetry && secondsUntilRetry > 0
              ? `Retrying in ${secondsUntilRetry} seconds (${attemptCount} of ${maxRetries})...`
              : `Retrying request (${attemptCount} of ${maxRetries})...`}
          </AlertTitle>
          <AlertDescription>
            <p>
              Hashing passwords sometimes takes more CPU time than the
              Cloudflare Free Plan allows. We're automatically retrying your
              request.
            </p>
            <p>
              Upgrading to the $5/month Cloudflare paid plan and redeploying the
              Every App Gateway will fix this problem.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {isSuccess && onContinue && (
        <Button onClick={onContinue}>Continue</Button>
      )}
    </StatusScreen>
  );
}
