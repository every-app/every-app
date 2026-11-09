import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@every-app/desktop-ui/components/tooltip";
import { Notice } from "./notice";
import { router } from "./router";
import { navigateTarget } from "./navigate";
import { connectBridge } from "./bridge";
import "./styles.css";

// The theme before the first paint (the inline init script can't run under the CSP).
applyStoredTheme();
connectBridge((request) => {
  const target = navigateTarget(request);
  if (target) void router.navigate(target);
});

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Notice />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);

/** Mirrors @every-app/desktop-ui's theme.ts: "light"/"dark" if picked, else the system's. */
function applyStoredTheme() {
  let pick: string | null = null;
  try {
    pick = localStorage.getItem("theme-preference");
  } catch {
    // Storage off: follow the system.
  }
  const dark = pick === "dark" || (pick !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "openseo-dark" : "openseo");
}
