import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/client/components/EmptyState";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Button } from "@/client/components/ui/button";

/**
 * The 404 page: the same centered block as every other whole-page state,
 * with the logo, since it renders outside the app shell.
 */
export function NotFound() {
  return (
    <StatusScreen logo>
      <EmptyState
        variant="plain"
        size="lg"
        icon={null}
        title="Page not found"
        action={
          <Button nativeButton={false} render={<Link to="/" />}>
            Go home
          </Button>
        }
      />
    </StatusScreen>
  );
}
