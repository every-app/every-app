import { cn } from "cn";
import {
  ArrowUpCircle,
  Folder as FolderIcon,
  House,
  LayoutTemplate,
  PenLine,
  Plus,
  Search,
  Settings,
  Square,
  Users,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import type {
  Account,
  Folder,
  Levels,
  LiveRecording,
  Loadable,
  NavTarget,
  Space,
} from "../types";
import { ChannelMeters, Elapsed, RecordDot } from "./recording";

/** Width the macOS traffic lights take in a hiddenInset title bar. */
const TRAFFIC_LIGHTS = 78;
export const TITLE_BAR_HEIGHT = 52;

export interface RecordingSummary {
  live: LiveRecording;
  levels: Levels;
  elapsedMs: number;
}

export interface SidebarProps {
  current: NavTarget | null;
  onNavigate: (target: NavTarget) => void;
  folders: Loadable<Folder[]>;
  orgName: string;
  account?: Account | null;
  onNewFolder?: (space: Space) => void;
  /** Start a note now, not tied to a calendar event. */
  onNewNote: () => void;
  /** A downloaded update, as a quiet pill in the footer (hidden while recording: pass null). */
  update?: UpdatePillProps | null;
  /** Why New note can't start right now (a microphone and system audio test is running). */
  newNoteDisabledReason?: string;
  /** The search field at the top: opens search (⌘K). */
  onSearch?: () => void;
  recording?: RecordingSummary | null;
  onOpenRecording?: () => void;
  onStopRecording?: () => void;
  /** The heading over the meeting-notes pages (the feature's name; default "Scribe"). */
  featureLabel?: string;
}

function same(a: NavTarget | null, b: NavTarget): boolean {
  if (!a || a.to !== b.to) return false;
  return a.to !== "folder" || (b.to === "folder" && a.id === b.id);
}

function NavItem({
  icon: Icon,
  label,
  target,
  current,
  onNavigate,
  shortcut,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  target: NavTarget;
  current: NavTarget | null;
  onNavigate: (target: NavTarget) => void;
  /** A keyboard hint, shown quietly on the right. */
  shortcut?: string;
}) {
  const active = same(current, target);
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onNavigate(target)}
        className={cn(
          "no-drag flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-foreground"
            : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        )}
      >
        <Icon
          className={cn(
            "size-[15px] shrink-0",
            active ? "text-sidebar-foreground" : "text-sidebar-foreground/55",
          )}
        />
        <span className="truncate">{label}</span>
        {shortcut && (
          <kbd className="ml-auto font-sans text-[11px] text-sidebar-foreground/40">
            {shortcut}
          </kbd>
        )}
      </button>
    </li>
  );
}

function FolderGroup({
  label,
  space,
  folders,
  props,
}: {
  label: string;
  space: Space;
  folders: Loadable<Folder[]>;
  props: SidebarProps;
}) {
  const items =
    folders.status === "ready"
      ? folders.data.filter((folder) => folder.space === space)
      : [];
  return (
    <div className="group/folders">
      <div className="flex h-7 items-center justify-between pl-2 pr-1">
        <h3 className="truncate text-[11px] font-medium text-sidebar-foreground/50">
          {label}
        </h3>
        {props.onNewFolder && (
          <button
            type="button"
            title={`New folder in ${label}`}
            onClick={() => props.onNewFolder?.(space)}
            className="no-drag flex size-5 items-center justify-center rounded text-sidebar-foreground/50 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/folders:opacity-100"
          >
            <Plus className="size-3.5" />
            <span className="sr-only">New folder in {label}</span>
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-px">
        {folders.status === "loading" &&
          [0, 1].map((i) => (
            <li key={i} className="flex h-7 items-center gap-2 px-2">
              <Skeleton className="size-3.5 rounded bg-sidebar-accent" />
              <Skeleton
                className="h-3 bg-sidebar-accent"
                style={{ width: `${55 - i * 15}%` }}
              />
            </li>
          ))}
        {items.map((folder) => (
          <NavItem
            key={folder.id}
            icon={FolderIcon}
            label={folder.name}
            target={{ to: "folder", id: folder.id }}
            current={props.current}
            onNavigate={props.onNavigate}
          />
        ))}
        {folders.status === "ready" && items.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-sidebar-foreground/40">
            {space === "private" ? "No folders yet" : "No team folders yet"}
          </li>
        )}
      </ul>
    </div>
  );
}

/** A quiet pill for the call in progress: open it, or stop it. */
export function RecordingPill({
  recording,
  onOpen,
  onStop,
}: {
  recording: RecordingSummary;
  onOpen?: () => void;
  onStop?: () => void;
}) {
  return (
    <div className="no-drag flex items-center gap-1 rounded-lg border border-sidebar-border bg-background/70 p-1 pl-2.5 shadow-xs">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-start py-0.5 text-left focus-visible:outline-none"
      >
        <span className="flex w-full items-center gap-1.5 text-[12px] font-medium">
          <RecordDot className="size-1.5" />
          <span className="truncate">{recording.live.title}</span>
        </span>
        <span className="flex items-center gap-2 pl-3 text-[11px] text-muted-foreground">
          <Elapsed ms={recording.elapsedMs} />
          <ChannelMeters
            mic={recording.levels.mic}
            system={recording.levels.system}
            micHealth={recording.live.mic}
            systemHealth={recording.live.system}
            className="scale-90 gap-2 [&_svg]:size-3"
          />
        </span>
      </button>
      <button
        type="button"
        title="Stop recording"
        onClick={onStop}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <Square className="size-3 fill-current" />
        <span className="sr-only">Stop recording</span>
      </button>
    </div>
  );
}

/** A feature's part of the sidebar: a quiet heading over its pages. */
export function SidebarSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-4">
      <h2 className="-mb-3 truncate px-2 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
        {label}
      </h2>
      {children}
    </section>
  );
}

export function Sidebar(props: SidebarProps) {
  const { current, onNavigate } = props;
  return (
    <aside
      aria-label="Sidebar"
      className="flex h-full w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar backdrop-blur-xl backdrop-saturate-150"
    >
      <div
        className="drag-region flex shrink-0 items-center justify-end pr-2"
        style={{ height: TITLE_BAR_HEIGHT, paddingLeft: TRAFFIC_LIGHTS }}
      />
      {props.onSearch && (
        <div className="px-2.5 pb-2">
          <button
            type="button"
            data-slot="sidebar-search"
            onClick={props.onSearch}
            className="no-drag flex h-7 w-full items-center gap-2 rounded-md bg-sidebar-accent/70 px-2 text-left text-[13px] text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Search className="size-3.5 shrink-0" />
            <span className="flex-1 truncate">Search</span>
            <kbd className="font-sans text-[11px] text-sidebar-foreground/40">
              ⌘K
            </kbd>
          </button>
        </div>
      )}
      {props.recording && (
        <div className="px-2.5 pb-2">
          <RecordingPill
            recording={props.recording}
            onOpen={props.onOpenRecording}
            onStop={props.onStopRecording}
          />
        </div>
      )}
      <nav
        aria-label="Main navigation"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2.5 pb-3"
      >
        {/* One section per feature of the app. Scribe (meeting notes) is the first; a new feature
            adds a sibling SidebarSection with its own pages. */}
        <SidebarSection label={props.featureLabel ?? "Scribe"}>
          <ul className="flex flex-col gap-px">
            <NavItem
              icon={House}
              label="Home"
              target={{ to: "home" }}
              current={current}
              onNavigate={onNavigate}
            />
            <NavItem
              icon={Users}
              label="Shared with me"
              target={{ to: "shared" }}
              current={current}
              onNavigate={onNavigate}
            />
            <NavItem
              icon={LayoutTemplate}
              label="Templates"
              target={{ to: "templates" }}
              current={current}
              onNavigate={onNavigate}
            />
          </ul>
          <FolderGroup
            label="My notes"
            space="private"
            folders={props.folders}
            props={props}
          />
          <FolderGroup
            label={props.orgName}
            space="team"
            folders={props.folders}
            props={props}
          />
        </SidebarSection>
      </nav>
      <div className="border-t border-sidebar-border px-2.5 py-2">
        {props.update && <UpdatePill {...props.update} />}
        <ul className="flex flex-col gap-px">
          <NavItem
            icon={Settings}
            label="Settings"
            target={{ to: "settings" }}
            current={current}
            onNavigate={onNavigate}
          />
        </ul>
        {props.account && (
          <div className="mt-2 flex items-center gap-2 px-2 pb-0.5">
            <Avatar name={props.account.name} />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[12px] font-medium">
                {props.account.name}
              </span>
              <span className="block truncate text-[11px] text-sidebar-foreground/50">
                {props.account.orgName}
              </span>
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

export function Avatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-semibold text-foreground/70",
        className,
      )}
    >
      {initials}
    </span>
  );
}

/**
 * The window: a translucent sidebar on the left, and a content pane with a
 * draggable title bar strip on top. `titleBar` renders inside that strip,
 * right of any traffic lights.
 */
export function AppFrame({
  sidebar,
  titleBar,
  banner,
  children,
  className,
}: {
  sidebar: SidebarProps;
  titleBar?: ReactNode;
  /** A strip under the title bar (offline, sign in again); the page stays below it. */
  banner?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full overflow-hidden bg-window text-foreground",
        className,
      )}
    >
      <Sidebar {...sidebar} />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <TitleBar>
          {titleBar}
          {/* Top right of every page; while recording, the sidebar's recording pill takes its place. */}
          {!sidebar.recording && (
            <NewNoteButton
              onClick={sidebar.onNewNote}
              disabledReason={sidebar.newNoteDisabledReason}
            />
          )}
        </TitleBar>
        {banner}
        {children}
      </main>
    </div>
  );
}

function NewNoteButton({
  onClick,
  disabledReason,
}: {
  onClick: () => void;
  disabledReason?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={!!disabledReason}
      title={disabledReason ?? "New note (⌘N)"}
      className="ml-auto gap-1.5"
    >
      <PenLine className="text-foreground/60" />
      New note
    </Button>
  );
}

/** The draggable strip on top of a pane. Buttons inside stay clickable. */
export function TitleBar({
  children,
  className,
  insetForTrafficLights = false,
}: {
  children?: ReactNode;
  className?: string;
  insetForTrafficLights?: boolean;
}) {
  return (
    <div
      className={cn(
        "drag-region flex shrink-0 items-center gap-2 px-4 [&_a]:no-drag [&_button]:no-drag [&_input]:no-drag",
        className,
      )}
      style={{
        height: TITLE_BAR_HEIGHT,
        paddingLeft: insetForTrafficLights ? TRAFFIC_LIGHTS + 8 : undefined,
      }}
    >
      {children}
    </div>
  );
}

export interface UpdatePillProps {
  version: string;
  /** "ready": just downloaded. "afterStop": a restart was put off by a recording, now over. */
  kind: "ready" | "afterStop";
  onRestart: () => void;
  restarting?: boolean;
}

/** "Update ready · Restart", or after a recording, "Restart to update". Quiet; the menus have it too. */
export function UpdatePill({
  version,
  kind,
  onRestart,
  restarting,
}: UpdatePillProps) {
  return (
    <div
      role="status"
      aria-label="Update"
      className="no-drag animate-in fade-in-0 mb-2 flex items-center gap-2 rounded-lg border border-sidebar-border bg-background/60 py-1 pl-2.5 pr-1 text-[12px]"
    >
      <ArrowUpCircle className="size-3.5 shrink-0 text-foreground/50" />
      <span className="min-w-0 flex-1 truncate text-sidebar-foreground/80">
        {kind === "afterStop" ? "Restart to update" : "Update ready"}
        <span className="text-sidebar-foreground/45"> · {version}</span>
      </span>
      <Button
        size="xs"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-[12px]"
        onClick={onRestart}
        pending={restarting}
      >
        Restart
      </Button>
    </div>
  );
}
