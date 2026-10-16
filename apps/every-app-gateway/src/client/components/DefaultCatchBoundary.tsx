import { Link, rootRouteId, useMatch, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { getErrorCode, getServerErrorMessage } from "@/client/errors";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  console.error("DefaultCatchBoundary Error:", error);

  const code = getErrorCode(error);
  const message = getServerErrorMessage(
    error,
    "Something went wrong. Please try again.",
  );

  return (
    <StatusScreen>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-destructive">{message}</p>
          {code ? (
            <p className="text-xs text-muted-foreground">Code: {code}</p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {isRoot ? (
            <Button
              nativeButton={false}
              render={<Link to="/" />}
              size="sm"
              variant="outline"
            >
              Home
            </Button>
          ) : (
            <Button
              nativeButton={false}
              render={
                <Link
                  to="/"
                  onClick={(e) => {
                    e.preventDefault();
                    window.history.back();
                  }}
                />
              }
              size="sm"
              variant="outline"
            >
              Go Back
            </Button>
          )}
          <Button
            onClick={() => {
              void router.invalidate();
            }}
            size="sm"
          >
            Try Again
          </Button>
        </CardFooter>
      </Card>
    </StatusScreen>
  );
}
