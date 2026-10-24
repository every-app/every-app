import { Link, rootRouteId, useMatch, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { getErrorCode, getServerErrorMessage } from "@/client/errors";
import { ErrorState } from "@/client/components/ErrorState";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Button } from "@/client/components/ui/button";

/** What a page shows when rendering it threw: the page-level error, with a retry. */
export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  console.error("DefaultCatchBoundary Error:", error);

  const code = getErrorCode(error);
  const message = getServerErrorMessage(error, "Please try again.");

  return (
    <StatusScreen>
      <ErrorState
        variant="page"
        title="Something went wrong"
        message={message}
        detail={code}
        onRetry={() => {
          void router.invalidate();
        }}
        action={
          isRoot ? (
            <Button
              nativeButton={false}
              render={<Link to="/" />}
              variant="outline"
            >
              Go home
            </Button>
          ) : (
            <Button
              nativeButton={false}
              variant="outline"
              render={
                <Link
                  to="/"
                  onClick={(e) => {
                    e.preventDefault();
                    window.history.back();
                  }}
                />
              }
            >
              Go back
            </Button>
          )
        }
      />
    </StatusScreen>
  );
}
