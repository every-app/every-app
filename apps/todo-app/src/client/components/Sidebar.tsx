import { Link } from "@tanstack/react-router";
import { ClipboardList, History } from "lucide-react";
import { useLiveQuery } from "@tanstack/react-db";
import { todoCollection } from "@/client/tanstack-db";
import { createPortal } from "react-dom";
import { useDelayedHover } from "@/client/hooks/useDelayedHover";

interface SidebarProps {
  currentPath: string;
  onShowShortcuts?: () => void;
}

export function Sidebar({ currentPath, onShowShortcuts }: SidebarProps) {
  const { data: todos } = useLiveQuery((q) => q.from({ todo: todoCollection }));
  const { hoveredItem, tooltipPosition, onMouseEnter, onMouseLeave } =
    useDelayedHover<string>();

  const hasCompletedTodos = todos?.some((todo) => todo.completed) ?? false;

  const navItems = [
    {
      to: "/",
      label: "Todos",
      icon: ClipboardList,
      isActive: currentPath === "/",
      show: true,
      shortcut: ["G", "T"],
    },
    {
      to: "/history",
      label: "History",
      icon: History,
      isActive: currentPath === "/history",
      show: hasCompletedTodos,
      shortcut: ["G", "H"],
    },
  ];

  return (
    <div className="sidebar w-64 border-r border-base-300 h-full bg-base-100 flex flex-col">
      {/* Header */}
      <div className="px-4 py-4 border-b border-base-300">
        <a
          href={import.meta.env.VITE_GATEWAY_URL}
          target="_top"
          className="font-semibold text-base-content hover:text-primary transition-colors"
        >
          Every App
        </a>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 overflow-y-auto">
        {navItems
          .filter((item) => item.show)
          .map((item) => {
            const Icon = item.icon;

            return (
              <Link
                key={item.to}
                to={item.to}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onMouseEnter(item.to, rect);
                }}
                onMouseLeave={onMouseLeave}
                className={`relative flex items-center gap-3 pl-4 pr-4 py-2 text-sm transition-colors rounded-md ${
                  item.isActive
                    ? "text-base-content font-medium"
                    : "text-base-content/60 hover:text-base-content hover:bg-base-200"
                }`}
              >
                {item.isActive && (
                  <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-primary rounded-r-full" />
                )}
                <Icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
      </nav>

      {/* Keyboard shortcuts button */}
      <div className="px-3 py-3 border-t border-base-300">
        <button
          onClick={onShowShortcuts}
          className="flex items-center justify-center w-8 h-8 rounded-md border border-base-300 text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors"
          aria-label="Show keyboard shortcuts"
          title="Keyboard shortcuts (⌘/)"
        >
          <span className="text-sm font-medium">?</span>
        </button>
      </div>

      {/* Fixed tooltip rendered via portal to document.body */}
      {hoveredItem && (
        <SidebarTooltip
          navItems={navItems}
          hoveredItem={hoveredItem}
          tooltipPosition={tooltipPosition}
        />
      )}
    </div>
  );
}

interface NavItem {
  to: string;
  label: string;
  shortcut: string[];
}

interface SidebarTooltipProps {
  navItems: NavItem[];
  hoveredItem: string;
  tooltipPosition: { top: number; left: number };
}

function SidebarTooltip({
  navItems,
  hoveredItem,
  tooltipPosition,
}: SidebarTooltipProps) {
  const hoveredNav = navItems.find((i) => i.to === hoveredItem);
  if (!hoveredNav) return null;

  return createPortal(
    <div
      className="fixed pointer-events-none px-2.5 py-1.5 bg-base-100 text-base-content rounded-md whitespace-nowrap flex items-center gap-1.5 text-xs z-50 -translate-y-1/2 shadow-lg border border-base-300"
      style={{
        top: tooltipPosition.top,
        left: tooltipPosition.left,
      }}
    >
      <span>Go to {hoveredNav.label.toLowerCase()}</span>
      <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded bg-neutral text-neutral-content text-[10px] font-medium">
        {hoveredNav.shortcut[0]}
      </span>
      <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded bg-neutral text-neutral-content text-[10px] font-medium">
        {hoveredNav.shortcut[1]}
      </span>
    </div>,
    document.body,
  );
}
