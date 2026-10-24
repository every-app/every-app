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
 * The page while a sign-in, sign-up or claim is retried after a Cloudflare
 * Worker CPU timeout (hashing a password can exceed the free plan's limit),
 * and what follows: a way on once it worked, or the fix once it didn't.
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
          <AlertTitle>You're signed in</AlertTitle>
        </Alert>
      ) : hasExhaustedRetries ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Still timing out after {maxRetries} tries</AlertTitle>
          <AlertDescription>
            Wait a few minutes and try again. Upgrading the Cloudflare plan
            ($5/month, under Compute &amp; AI → Workers Plans) and redeploying
            the gateway stops this for good.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>
            {secondsUntilRetry > 0
              ? `Retrying in ${secondsUntilRetry}s (${attemptCount} of ${maxRetries})`
              : `Retrying (${attemptCount} of ${maxRetries})`}
          </AlertTitle>
          <AlertDescription>
            Hashing a password can take more CPU time than the Cloudflare free
            plan allows. Upgrading the plan and redeploying the gateway fixes
            it.
          </AlertDescription>
        </Alert>
      )}

      {isSuccess && onContinue && (
        <Button onClick={onContinue}>Continue</Button>
      )}
    </StatusScreen>
  );
}
