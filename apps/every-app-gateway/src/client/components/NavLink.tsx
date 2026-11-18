import { createLink } from "@tanstack/react-router";
import type { ComponentProps } from "react";

/**
 * A link in the app's navigation: the sidebar's items and a page's tabs. The
 * router's own Link marks itself current from the address, which a click
 * changes before the page it leads to has rendered. This one leaves that to
 * its caller, who marks the page on screen (`current`).
 */
export const NavLink = createLink(function NavLink({
  current = false,
  ...props
}: ComponentProps<"a"> & { current?: boolean }) {
  return (
    <a
      {...props}
      aria-current={current ? "page" : undefined}
      data-status={undefined}
    />
  );
});
