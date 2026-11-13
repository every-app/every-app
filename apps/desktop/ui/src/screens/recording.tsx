import { cn } from "cn";
import { MessageSquareText, Mic, Square, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import type { ChannelHealth, Levels, LiveRecording } from "../types";
import { clock } from "./parts";

const BARS = [0.55, 0.85, 1, 0.75, 0.45];

/** A small five-bar meter for one channel's level (0–1). */
export function LevelMeter({
  level,
  health = "ok",
  className,
}: {
  level: number;
  health?: ChannelHealth;
  className?: string;
}) {
  const clamped = health === "ok" ? Math.min(1, Math.max(0, level)) : 0;
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-3.5 items-center gap-[2px]", className)}
    >
      {BARS.map((weight, i) => {
        const height = 3 + clamped * weight * 11;
        return (
          <span
            key={i}
            className={cn(
              "w-[2.5px] rounded-full transition-[height] duration-100 ease-out",
              health === "error"
                ? "bg-destructive/60"
                : clamped > 0.04
                  ? "bg-foreground/70"
                  : "bg-foreground/20",
            )}
            style={{ height }}
          />
        );
      })}
    </span>
  );
}

const healthLabel: Record<ChannelHealth, string> = {
  ok: "",
  silent: "silent",
  error: "not working",
};

/** Mic and system meters side by side, labeled for screen readers. */
export function ChannelMeters({
  mic,
  system,
  micHealth = "ok",
  systemHealth = "ok",
  className,
}: {
  mic: number;
  system: number;
  micHealth?: ChannelHealth;
  systemHealth?: ChannelHealth;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <span
        className="inline-flex items-center gap-1.5"
        title={`Your mic${micHealth === "ok" ? "" : ` (${healthLabel[micHealth]})`}`}
      >
        <Mic
          className={cn(
            "size-3.5 text-muted-foreground",
            micHealth === "error" && "text-destructive",
          )}
        />
        <LevelMeter level={mic} health={micHealth} />
        <span className="sr-only">
          Mic level {Math.round(mic * 100)}% {healthLabel[micHealth]}
        </span>
      </span>
      <span
        className="inline-flex items-center gap-1.5"
        title={`Call audio${systemHealth === "ok" ? "" : ` (${healthLabel[systemHealth]})`}`}
      >
        <Volume2
          className={cn(
            "size-3.5 text-muted-foreground",
            systemHealth === "error" && "text-destructive",
          )}
        />
        <LevelMeter level={system} health={systemHealth} />
        <span className="sr-only">
          Call audio level {Math.round(system * 100)}%{" "}
          {healthLabel[systemHealth]}
        </span>
      </span>
    </span>
  );
}

export function RecordDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "record-pulse size-2 shrink-0 rounded-full bg-record",
        className,
      )}
    />
  );
}

/** Milliseconds since `startedAt`, ticking once a second. */
export function useElapsed(startedAt: string | null, now?: Date): number {
  const [tick, setTick] = useState(() => now?.getTime() ?? Date.now());
  useEffect(() => {
    if (!startedAt || now) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, now]);
  if (!startedAt) return 0;
  return (now?.getTime() ?? tick) - new Date(startedAt).getTime();
}

export function Elapsed({ ms, className }: { ms: number; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{clock(ms)}</span>;
}

export interface RecorderBarProps {
  recording: LiveRecording;
  levels: Levels;
  elapsedMs: number;
  /** Stop was pressed and the recording is finishing. */
  stopping?: boolean;
  onStop?: () => void;
  /** The live transcript is open (only the meeting's own page can show it). */
  transcriptOpen?: boolean;
  onTranscript?: () => void;
  /**
   * Away from the recording meeting's page: the bar names the meeting, and a click anywhere on it
   * but its buttons goes back there.
   */
  onOpen?: () => void;
}

/**
 * The recorder: one bar at the bottom of the window for as long as this Mac records. The timer,
 * both levels, the live transcript and Stop.
 */
export function RecorderBar({
  recording,
  levels,
  elapsedMs,
  stopping = false,
  onStop,
  transcriptOpen = false,
  onTranscript,
  onOpen,
}: RecorderBarProps) {
  const summary = (
    <>
      <RecordDot />
      {onOpen && (
        <span className="max-w-[220px] truncate">{recording.title}</span>
      )}
      <Elapsed
        ms={elapsedMs}
        className={onOpen ? "font-normal text-muted-foreground" : undefined}
      />
    </>
  );
  return (
    // The click on the bar itself is a shortcut for the mouse; the button inside is the same
    // action for the keyboard and screen readers (its click bubbles up to here).
    <div
      role="group"
      aria-label="Recording"
      onClick={onOpen}
      className={cn(
        "pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/90 p-1 shadow-[0_6px_24px_-8px_rgb(0_0_0/0.18),0_1px_2px_rgb(0_0_0/0.06)] backdrop-blur-xl",
        onOpen && "cursor-pointer",
      )}
    >
      {onOpen ? (
        <button
          type="button"
          title={`Go to ${recording.title}`}
          className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-full pl-3 pr-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {summary}
        </button>
      ) : (
        <span className="flex items-center gap-2 pl-3 pr-1 text-[12px] font-medium">
          {summary}
        </span>
      )}
      <ChannelMeters
        mic={levels.mic}
        system={levels.system}
        micHealth={recording.mic}
        systemHealth={recording.system}
        className="px-2"
      />
      <span className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={transcriptOpen}
        className={cn(
          "h-8 rounded-full px-3",
          transcriptOpen && "bg-foreground/[0.06]",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onTranscript?.();
        }}
      >
        <MessageSquareText />
        Transcript
      </Button>
      {stopping ? (
        <Button
          variant="secondary"
          size="sm"
          className="h-8 rounded-full bg-foreground/[0.06] px-3"
          pending
          onClick={(event) => event.stopPropagation()}
        >
          Finishing…
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="h-8 rounded-full bg-foreground/[0.06] px-3"
          onClick={(event) => {
            event.stopPropagation();
            onStop?.();
          }}
        >
          <Square className="size-3 fill-current" />
          Stop
        </Button>
      )}
    </div>
  );
}
