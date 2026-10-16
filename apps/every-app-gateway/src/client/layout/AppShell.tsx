import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Sidebar } from "@/client/components/Sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/client/components/ui/sidebar";

/**
 * The signed-in app's frame: the sidebar and an inset content area that
 * scrolls on its own. On phones the sidebar is a drawer behind a top bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider className="h-[100dvh] min-h-0 overflow-hidden">
      <Sidebar />
      <SidebarInset className="min-h-0 overflow-hidden md:!m-0 md:!mt-2 md:!rounded-none md:!rounded-tl-lg md:border-l md:border-t md:border-sidebar-border md:!shadow-none">
        <MobileTopBar />
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function MobileTopBar() {
  return (
    // The installed app runs under the status bar, so the bar starts below it.
    <div className="shrink-0 border-b border-border bg-card pt-safe md:hidden">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <SidebarTrigger aria-label="Toggle sidebar" />
        <Link
          to="/"
          className="flex items-center gap-1 font-semibold text-foreground"
        >
          <img
            src="/transparent-logo.png"
            alt=""
            className="-my-1 size-7 rounded"
          />
          Every App
        </Link>
      </div>
    </div>
  );
}
