import { cn } from "cn";
import {
  AlertTriangle,
  ArrowUpCircle,
  Folder as FolderIcon,
  House,
  LayoutTemplate,
  PenLine,
  Plus,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import type { Account, Folder, Loadable, NavTarget, Space } from "../types";
import { RecorderBar, type RecorderBarProps } from "./recording";

/** Width the macOS traffic lights take in a hiddenInset title bar. */
const TRAFFIC_LIGHTS = 78;
export const TITLE_BAR_HEIGHT = 52;

/** The recording this Mac is making, for the bar at the bottom of the window. */
export interface FrameRecorder
  extends Pick<
    RecorderBarProps,
    "recording" | "levels" | "elapsedMs" | "stopping" | "onStop"
  > {
  /** The page on screen is the recording meeting's own: it draws the bar (and the transcript). */
  here: boolean;
  /** Go to the recording meeting. */
  onOpen: () => void;
  /** Go to the recording meeting with its live transcript open. */
  onTranscript: () => void;
  /**
   * A quiet line above the bar, as the meeting's own page shows it: the person's own
   * transcription server isn't answering (their audio is kept meanwhile).
   */
  status?: string | null;
  /** Something that went wrong and stays said: audio their server never transcribed. */
  warning?: string | null;
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
  /** The name of the meeting-notes section (the feature's name; default "Scribe"). */
  featureLabel?: string;
  /**
   * The other features' sections (a `SidebarSection` each), after Scribe's. With any here, every
   * section shows its name as a heading; with Scribe alone, none does.
   */
  moreSections?: ReactNode;
}

function same(a: NavTarget | null, b: NavTarget): boolean {
  if (!a || a.to !== b.to) return false;
  return a.to !== "folder" || (b.to === "folder" && a.id === b.id);
}

/** One row of the sidebar. Every row has this shape, so icons and labels share two edges. */
const ROW =
  "no-drag flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const ROW_IDLE =
  "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground";
const ROW_ACTIVE = "bg-sidebar-accent font-medium text-sidebar-foreground";
/** A row's leading icon: 15px wide, so every label starts at the same place. */
const ROW_ICON = "size-[15px] shrink-0";
/** A quiet heading over a group of rows, on the icons' edge. */
const GROUP_HEADING =
  "flex h-7 items-center truncate px-2 text-[11px] font-medium text-sidebar-foreground/50";

/** A page in the sidebar. A feature's section is a list of these. */
export function SidebarItem({
  icon: Icon,
  label,
  target,
  current,
  onNavigate,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  target: NavTarget;
  current: NavTarget | null;
  onNavigate: (target: NavTarget) => void;
}) {
  const active = same(current, target);
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onNavigate(target)}
        className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
      >
        <Icon
          className={cn(
            ROW_ICON,
            active ? "text-sidebar-foreground" : "text-sidebar-foreground/55",
          )}
        />
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}

/** A space's folders under its name. A space with no folders takes no room at all. */
function FolderGroup({
  label,
  folders,
  props,
}: {
  label: string;
  folders: Folder[];
  props: SidebarProps;
}) {
  if (folders.length === 0) return null;
  return (
    <div role="group" aria-label={label}>
      <h3 className={GROUP_HEADING}>{label}</h3>
      <ul className="flex flex-col gap-px">
        {folders.map((folder) => (
          <SidebarItem
            key={folder.id}
            icon={FolderIcon}
            label={folder.name}
            target={{ to: "folder", id: folder.id }}
            current={props.current}
            onNavigate={props.onNavigate}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * The one way to make a folder: a quiet row under the folders (and, with none yet, where they
 * will be), which asks who the folder is for.
 */
function NewFolder({
  orgName,
  onNewFolder,
}: {
  orgName: string;
  onNewFolder: (space: Space) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          ROW,
          "text-sidebar-foreground/50 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground data-popup-open:bg-sidebar-accent/60 data-popup-open:text-sidebar-foreground",
        )}
      >
        <Plus className={ROW_ICON} />
        <span className="truncate">New folder</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuItem
          className="flex-col items-start gap-0"
          onClick={() => onNewFolder("private")}
        >
          <span className="text-[13px]">Private folder</span>
          <span className="text-[12px] text-muted-foreground">
            Only you see it
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="flex-col items-start gap-0"
          onClick={() => onNewFolder("team")}
        >
          <span className="text-[13px]">Team folder</span>
          <span className="text-[12px] text-muted-foreground">
            Everyone in {orgName} sees it
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The folders, by space, then New folder. Nothing says "empty": an empty space isn't drawn. */
function Folders(props: SidebarProps) {
  const { folders } = props;
  const all = folders.status === "ready" ? folders.data : [];
  return (
    <div className="flex flex-col gap-3">
      {folders.status === "loading" && (
        <ul aria-busy className="flex flex-col gap-px">
          {[0, 1].map((i) => (
            <li key={i} className="flex h-7 items-center gap-2 px-2">
              <Skeleton className="size-[15px] rounded bg-sidebar-accent" />
              <Skeleton
                className="h-3 bg-sidebar-accent"
                style={{ width: `${55 - i * 15}%` }}
              />
            </li>
          ))}
        </ul>
      )}
      <FolderGroup
        label="My notes"
        folders={all.filter((folder) => folder.space === "private")}
        props={props}
      />
      <FolderGroup
        label={props.orgName}
        folders={all.filter((folder) => folder.space === "team")}
        props={props}
      />
      {props.onNewFolder && folders.status !== "loading" && (
        <NewFolder orgName={props.orgName} onNewFolder={props.onNewFolder} />
      )}
    </div>
  );
}

/**
 * A feature's part of the sidebar. Its name is a heading only when `titled`: with one feature in
 * the app a heading would tell nobody anything, so the section is named for screen readers only.
 */
export function SidebarSection({
  label,
  titled = true,
  children,
}: {
  label: string;
  titled?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-4">
      {titled && (
        <h2 className="-mb-3 flex h-7 items-center truncate px-2 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
          {label}
        </h2>
      )}
      {children}
    </section>
  );
}

/**
 * The foot of the sidebar: who is signed in, and the way to Settings, as one row. The account
 * lives in Settings (its first section, with Sign out), so the row that names it opens it.
 */
function AccountRow({
  account,
  active,
  onOpen,
}: {
  account?: Account | null;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Settings"
      aria-current={active ? "page" : undefined}
      title="Settings"
      onClick={onOpen}
      className={cn(
        ROW,
        "group/account",
        account && "h-10",
        active ? ROW_ACTIVE : ROW_IDLE,
      )}
    >
      {account ? (
        <>
          {/* As wide as a row's icon, with the avatar centred on it: the name starts where
              every other label does. */}
          <span className="flex w-[15px] shrink-0 justify-center">
            <Avatar name={account.name} className="size-5 text-[9px]" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sidebar-foreground">
              {account.name}
            </span>
            <span className="block truncate text-[11px] font-normal text-sidebar-foreground/50">
              {account.orgName}
            </span>
          </span>
          <Settings
            className={cn(
              ROW_ICON,
              active
                ? "text-sidebar-foreground"
                : "text-sidebar-foreground/45 group-hover/account:text-sidebar-foreground",
            )}
          />
        </>
      ) : (
        <>
          <Settings className={cn(ROW_ICON, "text-sidebar-foreground/55")} />
          <span className="truncate">Settings</span>
        </>
      )}
    </button>
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
        <div className="px-2.5 pb-3">
          <button
            type="button"
            data-slot="sidebar-search"
            onClick={props.onSearch}
            className={cn(
              ROW,
              "bg-sidebar-accent/70 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground/70",
            )}
          >
            <Search className={ROW_ICON} />
            <span className="flex-1 truncate">Search</span>
            <kbd className="font-sans text-[11px] text-sidebar-foreground/40">
              ⌘K
            </kbd>
          </button>
        </div>
      )}
      <nav
        aria-label="Main navigation"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2.5 pb-3"
      >
        {/* One section per feature of the app. Scribe (meeting notes) is the first; a new feature
            passes its own SidebarSection as `moreSections`, and then every section is headed. */}
        <SidebarSection
          label={props.featureLabel ?? "Scribe"}
          titled={!!props.moreSections}
        >
          {/* By how often they're opened: the notes you made, the notes others shared, then the
              templates you set up once. */}
          <ul className="flex flex-col gap-px">
            <SidebarItem
              icon={House}
              label="Home"
              target={{ to: "home" }}
              current={current}
              onNavigate={onNavigate}
            />
            <SidebarItem
              icon={Users}
              label="Shared with me"
              target={{ to: "shared" }}
              current={current}
              onNavigate={onNavigate}
            />
            <SidebarItem
              icon={LayoutTemplate}
              label="Templates"
              target={{ to: "templates" }}
              current={current}
              onNavigate={onNavigate}
            />
          </ul>
          <Folders {...props} />
        </SidebarSection>
        {props.moreSections}
      </nav>
      <div className="border-t border-sidebar-border px-2.5 py-2">
        {props.update && <UpdatePill {...props.update} />}
        <AccountRow
          account={props.account}
          active={same(current, { to: "settings" })}
          onOpen={() => onNavigate({ to: "settings" })}
        />
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
 * right of any traffic lights. While this Mac records, the recorder bar sits at the bottom of the
 * pane on every page; the recording meeting's own page draws it itself (`recorder.here`).
 */
export function AppFrame({
  sidebar,
  titleBar,
  banner,
  recorder,
  children,
  className,
}: {
  sidebar: SidebarProps;
  recorder?: FrameRecorder | null;
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
      <main className="relative flex min-w-0 flex-1 flex-col bg-background">
        <TitleBar>
          {titleBar}
          {/* Top right of every page, except while recording (one recording at a time). */}
          {!recorder && (
            <NewNoteButton
              onClick={sidebar.onNewNote}
              disabledReason={sidebar.newNoteDisabledReason}
            />
          )}
        </TitleBar>
        {banner}
        {children}
        {recorder && !recorder.here && (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 flex flex-col items-center gap-2 px-4">
            {recorder.status && (
              <p
                role="status"
                className="animate-in fade-in-0 pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/85 px-3 py-1 text-[12px] text-muted-foreground backdrop-blur"
              >
                <span className="record-pulse size-1.5 rounded-full bg-foreground/40" />
                {recorder.status}
              </p>
            )}
            {recorder.warning && (
              <p
                role="status"
                className="animate-in fade-in-0 pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/85 px-3 py-1 text-[12px] text-muted-foreground backdrop-blur"
              >
                <AlertTriangle className="size-3.5 shrink-0 text-warning" />
                {recorder.warning}
              </p>
            )}
            <RecorderBar
              recording={recorder.recording}
              levels={recorder.levels}
              elapsedMs={recorder.elapsedMs}
              stopping={recorder.stopping}
              onStop={recorder.onStop}
              onTranscript={recorder.onTranscript}
              onOpen={recorder.onOpen}
            />
          </div>
        )}
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
