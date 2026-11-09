import { cn } from "cn";
import { Mic, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChannelHealth } from "../types";
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
