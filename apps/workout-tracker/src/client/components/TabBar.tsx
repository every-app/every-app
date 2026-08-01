import useDetectKeyboardOpen from "@/client/hooks/useDetectKeyboardOpen";
import { Link } from "@tanstack/react-router";
import { ClipboardList, Dumbbell, History, TreePine } from "lucide-react";
import { gatewayHomeUrl } from "@/client/lib/gatewayHome";

interface TabBarProps {
  currentPath: string;
}

export function TabBar({ currentPath }: TabBarProps) {
  const isKeyboardOpen = useDetectKeyboardOpen();

  if (isKeyboardOpen) return null;

  const isHomeActive = currentPath === "/" || currentPath === "/workout";
  const isProgramsActive = currentPath.startsWith("/programs");
  const isHistoryActive = currentPath === "/history";

  return (
    <div className="tab-bar px-4 pb-4">
      <div className="dock bg-base-300/80 backdrop-blur-xl rounded-full border border-base-content/10">
        <Link
          to="/"
          className={`no-underline ${isHomeActive ? "dock-active text-primary" : ""}`}
          aria-label="Navigate to Home"
          aria-current={isHomeActive ? "page" : undefined}
        >
          <ClipboardList className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">Home</span>
        </Link>
        <Link
          to="/history"
          className={`no-underline ${isHistoryActive ? "dock-active text-primary" : ""}`}
          aria-label="Navigate to History"
          aria-current={isHistoryActive ? "page" : undefined}
        >
          <History className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">History</span>
        </Link>
        <Link
          to="/programs"
          className={`no-underline ${isProgramsActive ? "dock-active text-primary" : ""}`}
          aria-label="Navigate to Programs"
          aria-current={isProgramsActive ? "page" : undefined}
        >
          <Dumbbell className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">Programs</span>
        </Link>
        <a
          href={gatewayHomeUrl()}
          target="_top"
          className="no-underline"
          aria-label="Navigate to Gateway"
        >
          <TreePine className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">Gateway</span>
        </a>
      </div>
    </div>
  );
}
