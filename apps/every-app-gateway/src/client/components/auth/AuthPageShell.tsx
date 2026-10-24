import type { ReactNode } from "react";
import { cn } from "cn";
import { BrandMark } from "@/client/components/BrandLink";
import { Card, CardContent } from "@/client/components/ui/card";
import { FieldSeparator } from "@/client/components/ui/field";

// The auth forms' inputs: card-colored with 16px text, so iOS does not zoom
// into them and they read as fields on the card.
export const authInputClassName =
  "border-foreground/20 bg-card text-base md:text-base";
// The auth forms' full-width submit button: the default metallic button.
export const authSubmitClassName = "w-full font-semibold";
// Links in an auth footer or under a form, such as "Forgot password?".
export const authLinkClassName =
  "font-medium text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80";

/**
 * The page frame for the screens outside the app shell: sign-in, sign-up,
 * password reset, invitations and setup. It centers its child and scrolls
 * when the child is taller than the page.
 */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    // `h-[100dvh]` + `overflow-y-auto` makes this a scroll container, and the
    // auto-margin child centers when it fits but stays fully reachable (top and
    // bottom) when it's taller than the viewport. Plain `justify-center` clips
    // the overflow with no way to scroll to it.
    <div className="flex h-[100dvh] flex-col items-center overflow-y-auto bg-background p-4">
      <div className="m-auto flex w-full flex-col items-center py-4">
        {children}
      </div>
    </div>
  );
}

/**
 * The Every App mark and wordmark, a title and helper text above a card that
 * holds the form, with an optional footer (links such as "Back to sign in")
 * below it.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
  size = "sm",
}: {
  title: ReactNode;
  /** Helper text under the title. */
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** `sm` for a sign-in form, `md` for wider content such as setup steps. */
  size?: "sm" | "md";
}) {
  return (
    <div
      className={cn(
        "w-full space-y-6",
        size === "sm" ? "max-w-sm" : "max-w-md",
      )}
    >
      <div className="space-y-3 text-center">
        <BrandMark mark="size-8" className="justify-center" />
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>

      {footer ? (
        <div className="space-y-1 text-center text-sm text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the password reset pages say on a gateway with no email sender: the
 * admin's menu has "Password reset link" for exactly this.
 */
export function NoEmailResetNotice() {
  return (
    <p className="text-sm text-muted-foreground">
      This gateway doesn't send email. Ask an admin for a password reset link.
    </p>
  );
}

/** The "or" rule between two ways to sign in, inside an AuthCard. */
export function AuthDivider({ children = "or" }: { children?: ReactNode }) {
  return (
    <FieldSeparator className="my-0 text-xs *:data-[slot=field-separator-content]:bg-card">
      {children}
    </FieldSeparator>
  );
}
