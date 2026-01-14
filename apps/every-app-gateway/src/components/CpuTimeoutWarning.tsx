import { useState } from "react";
import { CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { GameSnake } from "./GameSnake";

interface CpuTimeoutWarningProps {
  attemptCount: number;
  maxRetries: number;
  hasExhaustedRetries: boolean;
  secondsUntilRetry: number;
  isSuccess?: boolean;
  onContinue?: () => void;
}

const iconClassName = "shrink-0 h-5 w-5 mt-0.5";

/**
 * Full-page warning component displayed when retrying due to Cloudflare Worker CPU timeout.
 * Shows a friendly waiting game while retrying to keep users engaged.
 */
export function CpuTimeoutWarning({
  attemptCount,
  maxRetries,
  hasExhaustedRetries,
  secondsUntilRetry,
  isSuccess,
  onContinue,
}: CpuTimeoutWarningProps) {
  const [showGame, setShowGame] = useState(false);

  const content = (
    <div className="flex flex-col items-center gap-4 py-4 flex-1">
      {/* Success/Warning/Error Alert */}
      {isSuccess ? (
        <div className="alert alert-success text-sm w-full">
          <CheckCircle className={iconClassName} />
          <div>
            <p className="font-semibold">You're signed in!</p>
            <p>Your sign in was successful. Continue when you're ready.</p>
          </div>
        </div>
      ) : hasExhaustedRetries ? (
        <div className="alert alert-error text-sm w-full">
          <XCircle className={iconClassName} />
          <div>
            <p className="font-semibold">Max Retries Reached</p>
            <p>
              We tried {maxRetries} times but the request keeps timing out.
              Please wait a few minutes before trying again.
            </p>
            <p className="mt-2">
              Upgrading to the $5/month paid plan will resolve this. Go to
              Cloudflare: Compute & AI &gt; Workers Plans
            </p>
          </div>
        </div>
      ) : (
        <div className="alert alert-warning text-sm w-full">
          <AlertTriangle className={iconClassName} />
          <div>
            <p className="font-semibold">
              {secondsUntilRetry && secondsUntilRetry > 0
                ? `Retrying in ${secondsUntilRetry} seconds (${attemptCount} of ${maxRetries})...`
                : `Retrying request (${attemptCount} of ${maxRetries})...`}
            </p>
            <p className="pb-2">
              Hashing passwords sometimes takes more CPU time than the
              Cloudflare Free Plan allows. We're automatically retrying your
              request.
            </p>
            <p>
              Upgrading to the $5/month Cloudflare paid plan and redeploying the
              Every App Gateway will fix this problem.
            </p>
          </div>
        </div>
      )}

      {/* Continue button when success */}
      {isSuccess && onContinue && (
        <button className="btn btn-primary" onClick={onContinue}>
          Continue
        </button>
      )}

      {/* Game or button to show game */}
      {showGame ? (
        <GameSnake />
      ) : (
        <div className="w-full max-w-sm">
          <button className="btn btn-primary" onClick={() => setShowGame(true)}>
            Play a game while you wait?
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen items-center justify-center overflow-auto py-8">
      <div className="w-full max-w-md px-4 flex flex-col min-h-[80vh]">
        <img
          src="/transparent-logo.png"
          alt="Logo"
          className="h-12 w-auto mx-auto mb-6"
        />
        {content}
      </div>
    </div>
  );
}
