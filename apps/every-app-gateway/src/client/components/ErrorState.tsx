import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { EmptyState } from "@/client/components/EmptyState";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";

/**
 * The one failure message: what couldn't happen, and a way to try again.
 *
 * - `inline`: red text and a small button, inside a card or a table.
 * - `card`: a destructive Alert, above or in place of a section.
 * - `page`: a centered block that replaces the whole page content (the 404
 *   page and the crash boundary use it too).
 *
 * `message` names what failed ("Couldn't load users."); `title` is only
 * for the page variant, where the message is the detail under it.
 */
export function ErrorState({
  title,
  message,
  detail,
  onRetry,
  isRetrying = false,
  action,
  variant = "card",
}: {
  title?: string;
  message: string;
  /** Small print under the message, such as an error code. Page variant only. */
  detail?: ReactNode;
  onRetry?: () => void;
  /** Shows the retry button as pending, for example while `isFetching`. */
  isRetrying?: boolean;
  /** Buttons beside, or instead of, the retry button. */
  action?: ReactNode;
  variant?: "inline" | "card" | "page";
}) {
  const retry = onRetry ? (
    <Button
      variant={variant === "page" ? "default" : "outline"}
      size={variant === "page" ? "default" : "sm"}
      pending={isRetrying}
      onClick={onRetry}
    >
      Try again
    </Button>
  ) : null;

  if (variant === "page") {
    return (
      <EmptyState
        kind="error"
        variant="plain"
        size="lg"
        title={title ?? "Something went wrong"}
        description={
          <>
            {message}
            {detail ? (
              <span className="mt-2 block font-mono text-xs">{detail}</span>
            ) : null}
          </>
        }
        action={
          retry || action ? (
            <div className="flex flex-wrap justify-center gap-2">
              {retry}
              {action}
            </div>
          ) : undefined
        }
      />
    );
  }

  const button = action ?? retry;

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-destructive"
      >
        <span>{message}</span>
        {button}
      </div>
    );
  }

  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{title ?? message}</AlertTitle>
      {title ? <AlertDescription>{message}</AlertDescription> : null}
      {button ? <div className="col-start-2 mt-2">{button}</div> : null}
    </Alert>
  );
}
