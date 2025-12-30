import useDetectKeyboardOpen from "@/client/hooks/useDetectKeyboardOpen";
import { Link } from "@tanstack/react-router";
import { ClipboardList, Dumbbell, History, LayoutGrid } from "lucide-react";

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
    <div className="py-4">
      <div className="dock dock-xl">
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
          to="/programs"
          className={`no-underline ${isProgramsActive ? "dock-active text-primary" : ""}`}
          aria-label="Navigate to Programs"
          aria-current={isProgramsActive ? "page" : undefined}
        >
          <Dumbbell className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">Programs</span>
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
        <a
          href={import.meta.env.VITE_GATEWAY_URL}
          target="_top"
          className="no-underline"
          aria-label="Navigate to Apps"
        >
          <LayoutGrid className="size-[1.2em]" aria-hidden="true" />
          <span className="dock-label">Apps</span>
        </a>
      </div>
    </div>
  );
}
