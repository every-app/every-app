import { Link } from "@tanstack/react-router";
import { ClipboardList, History, TreePine } from "lucide-react";

interface TabBarProps {
  currentPath?: string;
}

export function TabBar({ currentPath = "/" }: TabBarProps) {
  return (
    <div className="tab-bar px-4 pb-4">
      <div className="dock bg-base-300/80 backdrop-blur-xl rounded-full border border-base-content/10">
        <Link
          to="/"
          className={`no-underline ${currentPath === "/" ? "dock-active text-primary" : ""}`}
          aria-label="Navigate to Todos"
          aria-current={currentPath === "/" ? "page" : undefined}
        >
          <ClipboardList className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">Todos</span>
        </Link>
        <Link
          to="/history"
          className={`no-underline ${currentPath === "/history" ? "dock-active text-primary" : ""}`}
          aria-label="Navigate to History"
          aria-current={currentPath === "/history" ? "page" : undefined}
        >
          <History className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">History</span>
        </Link>
        <a
          href={import.meta.env.VITE_GATEWAY_URL}
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
