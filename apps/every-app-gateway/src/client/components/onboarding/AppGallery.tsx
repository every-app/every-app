import type { ReactNode } from "react";
import { Monitor, Sparkles } from "lucide-react";
import { cn } from "cn";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Card } from "@/client/components/ui/card";
import {
  FEATURED_APPS,
  featuredAppIcon,
  type FeaturedApp,
} from "@/client/lib/featuredApps";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";

interface AppGalleryProps {
  /** Opens the app's dialog: its install command and what it needs. */
  onPickApp: (app: FeaturedApp) => void;
  /** Opens the Build your own dialog. */
  onBuild: () => void;
}

/**
 * The home while the workspace has no apps, for whoever can install one:
 * the four apps as cards, the same shape as the app cards that replace
 * them, and a fifth card for an app of their own. Each card opens a dialog;
 * nothing here installs anything.
 */
export function AppGallery({ onPickApp, onBuild }: AppGalleryProps) {
  return (
    <section aria-labelledby="app-gallery-heading" className="space-y-4">
      <div className="space-y-0.5">
        <h2
          id="app-gallery-heading"
          className="text-sm font-medium text-muted-foreground"
        >
          {FIRST_SCREEN.gallery.heading}
        </h2>
        <p className="text-sm text-muted-foreground">
          {FIRST_SCREEN.gallery.intro}
        </p>
      </div>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {FEATURED_APPS.map((app) => (
          <GalleryCard
            key={app.id}
            title={app.name}
            line={app.line}
            label={`Install ${app.name}`}
            icon={<FeaturedAppIcon app={app} />}
            onClick={() => onPickApp(app)}
          />
        ))}
        <GalleryCard
          title={FIRST_SCREEN.buildCard.title}
          line={FIRST_SCREEN.buildCard.line}
          label={FIRST_SCREEN.buildCard.title}
          icon={
            <GalleryIconTile className="bg-primary/10 text-primary">
              <Sparkles className="size-5" aria-hidden />
            </GalleryIconTile>
          }
          dashed
          onClick={onBuild}
        />
      </ul>
    </section>
  );
}

function GalleryCard({
  title,
  line,
  label,
  icon,
  dashed = false,
  onClick,
}: {
  title: string;
  line: string;
  /** The button's accessible name. */
  label: string;
  icon: ReactNode;
  dashed?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <Card
        className={cn(
          "group relative h-32 gap-0 py-0 transition-colors hover:border-foreground/25 motion-reduce:transition-none md:h-42",
          dashed && "border-dashed bg-card/60 shadow-none",
        )}
      >
        <div className="pointer-events-none grid min-h-0 flex-1 grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-4 rounded-xl p-5 md:flex md:flex-col md:items-stretch">
          {icon}
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight md:text-base">
              {title}
            </h3>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {line}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          onClick={onClick}
          className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        />
      </Card>
    </li>
  );
}

/** On a phone: the command and the prompt are for a computer. Hidden from sm up. */
export function PhoneNotice() {
  return (
    <Alert variant="info" className="sm:hidden">
      <Monitor />
      <AlertDescription className="text-foreground">
        {FIRST_SCREEN.phoneNotice}
      </AlertDescription>
    </Alert>
  );
}

/** The tile an app's launcher icon sits in, the launcher's size on every breakpoint. */
export function GalleryIconTile({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-foreground/5 md:mb-4 md:size-10 md:rounded-lg",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The launcher icon the app ships, as its card will show it once installed. */
export function FeaturedAppIcon({
  app,
  className,
}: {
  app: Pick<FeaturedApp, "id">;
  className?: string;
}) {
  return (
    <GalleryIconTile className={className}>
      <img
        src={featuredAppIcon(app)}
        alt=""
        className="size-full object-contain"
        decoding="async"
      />
    </GalleryIconTile>
  );
}
