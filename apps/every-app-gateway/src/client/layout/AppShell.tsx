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
      <SidebarInset className="min-h-0 overflow-hidden">
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
      <div className="flex h-16 items-center gap-2 px-4">
        <SidebarTrigger aria-label="Toggle sidebar" />
        <Link
          to="/"
          className="flex items-center gap-1 font-semibold text-foreground"
        >
          <img
            src="/android-chrome-192x192.png"
            alt=""
            className="-my-1 size-7 rounded-md"
          />
          Every App
        </Link>
      </div>
    </div>
  );
}
