import { cn } from "cn";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { barHeights, smoothLevel } from "../lib/levels";
import type { Segment } from "../types";

/*
 * The floating recorder, in the bottom-right corner of the screen while recording: a small
 * capsule with Every App's mark and a meter, and on hover a panel with the live transcript. Always
 * dark, like the meeting apps it floats over. Sizes follow Granola's pill (Ben's reference
 * screenshots), in points; the bars are the foreground colour, like the rest of the pill.
 */

/** `level` (0–1, already the louder side, see lib/levels) smoothed toward each new value. */
function useSmoothed(level: number, animate: boolean): number {
  const [value, setValue] = useState(level);
  const target = useRef(level);
  target.current = level;
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(
      () => setValue((v) => smoothLevel(v, target.current)),
      50,
    );
    return () => clearInterval(timer);
  }, [animate]);
  return animate ? value : level;
}

/** Three bars in the foreground colour that move with the sound; flat when silent. */
export function LiveBars({
  level,
  animate = true,
  className,
}: {
  level: number;
  animate?: boolean;
  className?: string;
}) {
  const smoothed = useSmoothed(level, animate);
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-[18px] items-center gap-[3px]", className)}
    >
      {barHeights(smoothed).map((height, i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-full bg-foreground transition-[height] duration-75 ease-out"
          style={{ height }}
        />
      ))}
    </span>
  );
}

/** The capsule: Every App's mark over the meter. Clicking it opens the meeting in Every App. */
export function RecorderPill({
  level,
  stopping = false,
  animate = true,
  onClick,
  className,
}: {
  level: number;
  /** Stop was pressed and the transcript is being finished: the meter rests. */
  stopping?: boolean;
  animate?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        stopping
          ? "Scribe is finishing the transcript. Open the meeting"
          : "Scribe is recording. Open the meeting"
      }
      className={cn(
        "flex h-[60px] w-[34px] flex-col items-center justify-between rounded-full border border-white/20 bg-neutral-800 pt-[9px] pb-[10px] outline-none",
        "transition-colors hover:border-white/30 hover:bg-[oklch(30%_0_0)] focus-visible:border-white/40",
        className,
      )}
    >
      <RecorderMark className="size-[17px] opacity-80" />
      <LiveBars level={stopping ? 0 : level} animate={animate} />
    </button>
  );
}

export interface LiveLine {
  speaker: "me" | "them" | null;
  text: string;
}

/** Three dots, one after another: someone is still talking. */
function TypingDots() {
  return (
    <span aria-hidden className="mt-1 flex h-2 items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="typing-dot size-[3.5px] rounded-full bg-neutral-400"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * The live transcript, oldest first, kept scrolled to the newest line (unless you've scrolled
 * up to read). Your lines are indented from the left, the call's from the right; the turn still
 * being spoken is greyer, with dots under it.
 */
export function RecorderPanel({
  segments,
  pending,
  notice,
  className,
}: {
  segments: Segment[];
  /** Turns still being spoken, oldest first. */
  pending: LiveLine[];
  /** A quiet line under the transcript, e.g. "Finishing the transcript…". */
  notice?: string;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = pending.at(-1)?.text ?? segments.at(-1)?.text;
  const count = segments.length + pending.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count, last, notice]);
  const lines: (LiveLine & { key: string; partial: boolean })[] = [
    ...segments.map((s) => ({
      key: `s${s.seq}`,
      speaker: s.speaker,
      text: s.text,
      partial: false,
    })),
    ...pending.map((p, i) => ({
      key: `p${i}`,
      speaker: p.speaker,
      text: p.text,
      partial: true,
    })),
  ];
  return (
    <div
      className={cn(
        "flex h-[342px] w-[292px] flex-col overflow-hidden rounded-xl border border-white/12 bg-neutral-800 text-neutral-100",
        className,
      )}
    >
      <div
        ref={scroller}
        data-selectable
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-2 pt-[9px] pb-2 [scrollbar-width:none]"
      >
        {lines.map((line) => (
          <div
            key={line.key}
            className={cn(
              "rounded-md px-2 py-1.5 text-[13px] leading-[1.4]",
              line.speaker === "them" ? "mr-6" : "ml-6",
              line.partial
                ? "bg-white/[0.04] text-neutral-400"
                : "bg-white/[0.08] text-neutral-100",
            )}
          >
            {line.text}
            {line.partial && <TypingDots />}
          </div>
        ))}
        {lines.length === 0 && (
          <div className="ml-6 rounded-md bg-white/[0.04] px-2 py-1.5 text-[13px] leading-[1.4] text-neutral-400">
            Listening
            <TypingDots />
          </div>
        )}
        {notice && (
          <p className="px-1 pt-1 text-[11px] text-neutral-400">{notice}</p>
        )}
      </div>
    </div>
  );
}

export interface FloatingRecorderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The whole floating window: the panel (shown while `expanded`) and the pill, each where main
 * put it (`layout`, in the window's coordinates). The rest of the window is see-through.
 */
export function FloatingRecorder({
  layout,
  expanded,
  level,
  stopping,
  segments,
  pending,
  notice,
  animate = true,
  onOpen,
}: {
  layout: { panel: FloatingRecorderRect; pill: FloatingRecorderRect };
  expanded: boolean;
  level: number;
  stopping?: boolean;
  segments: Segment[];
  pending: LiveLine[];
  notice?: string;
  animate?: boolean;
  onOpen?: () => void;
}) {
  const at = (r: FloatingRecorderRect) => ({
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
  });
  return (
    <div className="relative size-full">
      <div
        aria-hidden={!expanded}
        className={cn(
          "absolute origin-bottom-right",
          // Opens with a short fade; closes at once (its lines are gone by then).
          expanded
            ? "scale-100 opacity-100 transition-[opacity,scale] duration-150 ease-out"
            : "pointer-events-none scale-[0.97] opacity-0",
        )}
        style={at(layout.panel)}
      >
        {expanded && (
          <RecorderPanel
            segments={segments}
            pending={pending}
            notice={notice}
            className="size-full"
          />
        )}
      </div>
      <div className="absolute" style={at(layout.pill)}>
        <RecorderPill
          level={level}
          stopping={stopping}
          animate={animate}
          onClick={onOpen}
          className="size-full"
        />
      </div>
    </div>
  );
}

/** The recorder's mark: three level bars in a rounded square. */
function RecorderMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={className}>
      <rect width="48" height="48" rx="12" className="fill-foreground" />
      <rect x="14" y="19" width="4" height="10" rx="2" className="fill-background" />
      <rect x="22" y="13" width="4" height="22" rx="2" className="fill-background" />
      <rect x="30" y="17" width="4" height="14" rx="2" className="fill-background" />
    </svg>
  );
}
