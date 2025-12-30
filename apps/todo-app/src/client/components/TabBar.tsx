import { Link } from "@tanstack/react-router";
import { ClipboardList, History, Home } from "lucide-react";

interface TabBarProps {
  currentPath?: string;
}

export function TabBar({ currentPath = "/" }: TabBarProps) {
  return (
    <div className="pt-4">
      <div className="dock dock-xl">
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
          aria-label="Navigate to Every App"
        >
          <Home className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">Every App</span>
        </a>
      </div>
    </div>
  );
}
