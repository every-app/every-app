import { Link, type CreateLinkProps } from "@tanstack/react-router";
import { useIsMobile } from "@/client/hooks/use-mobile";
import type { AnchorHTMLAttributes, ReactNode } from "react";

type MobileSlideLinkProps = Omit<
  CreateLinkProps,
  "viewTransition" | "children"
> &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CreateLinkProps> & {
    direction: "left" | "right";
    children: ReactNode;
  };

/**
 * A Link component that applies slide transitions on mobile only.
 * On desktop, it uses the default fade transition.
 *
 * Usage:
 * <MobileSlideLink to="/details" direction="left">View details</MobileSlideLink>
 * <MobileSlideLink to="/" direction="right">Back</MobileSlideLink>
 */
export function MobileSlideLink({
  direction,
  children,
  ...linkProps
}: MobileSlideLinkProps) {
  const isMobile = useIsMobile();

  const viewTransition = isMobile ? { types: [`slide-${direction}`] } : true;

  return (
    <Link viewTransition={viewTransition} {...linkProps}>
      {children}
    </Link>
  );
}
