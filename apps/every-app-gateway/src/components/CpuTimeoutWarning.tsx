/**
 * Warning component displayed when Cloudflare Worker CPU timeout occurs.
 * This happens on the free plan due to CPU time limits.
 */
export function CpuTimeoutWarning() {
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
        <p className="font-semibold">Cloudflare Free Plan Limitation</p>
        <p>
          Please wait 15 seconds and try again. This may take a few attempts.
          Upgrading to the Cloudflare $5 / month plan will resolve this issue.
        </p>
      </div>
    </div>
  );
}
