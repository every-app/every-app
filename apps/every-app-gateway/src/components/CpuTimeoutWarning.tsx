interface CpuTimeoutWarningProps {
  attemptCount?: number;
  maxRetries?: number;
  hasExhaustedRetries?: boolean;
  secondsUntilRetry?: number;
}

/**
 * Warning component displayed when retrying due to Cloudflare Worker CPU timeout.
 * Props are optional - when omitted, displays a simple "timeout occurred" message.
 */
export function CpuTimeoutWarning({
  attemptCount,
  maxRetries,
  hasExhaustedRetries,
  secondsUntilRetry,
}: CpuTimeoutWarningProps = {}) {
  const isRetrying =
    attemptCount !== undefined &&
    maxRetries !== undefined &&
    !hasExhaustedRetries;
  return (
    <div className="alert alert-warning text-sm">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="stroke-current shrink-0 h-5 w-5 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <div>
        {isRetrying ? (
          <>
            <p className="font-semibold">
              {secondsUntilRetry && secondsUntilRetry > 0
                ? `Retrying in ${secondsUntilRetry} seconds (${attemptCount} of ${maxRetries})...`
                : `Retrying request (${attemptCount} of ${maxRetries})...`}
            </p>
            <p>
              Hashing passwords sometimes takes longer than the Cloudflare Free
              Plan allows for CPU time. We're automatically retrying your
              request.
            </p>
            <p className="mt-2">
              Read how to{" "}
              <a
                href="https://everyapp.dev/docs/build-an-app/create-app/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Build an App
              </a>{" "}
              while you wait.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold">Max Retries Reached</p>
            <p>
              We tried {maxRetries} times but the request keeps timing out.
              Please wait a few minutes before trying again. If you make too
              many requests in quick succession, Cloudflare will lock you out.
            </p>
            <p className="mt-2">
              Upgrading to the $5/month paid plan and redeploying the Gateway
              will resolve this problem. Go to the Cloudflare Sidebar: Compute &
              AI &gt; Workers Plans
            </p>
          </>
        )}
      </div>
    </div>
  );
}
