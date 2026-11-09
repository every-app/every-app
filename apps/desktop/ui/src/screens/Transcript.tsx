import { cn } from "cn";
import { useEffect, useRef } from "react";
import type { PartialTranscript, Segment } from "../types";
import { clock } from "./parts";

type Who = "me" | "them";

interface Bubble {
  key: string;
  who: Who;
  text: string;
  at: number | null;
  partial: boolean;
}

/** Consecutive segments from the same speaker read as one bubble. */
function bubbles(segments: Segment[], partial?: PartialTranscript): Bubble[] {
  const out: Bubble[] = [];
  for (const segment of segments) {
    const who: Who = segment.speaker ?? "them";
    const last = out.at(-1);
    if (last && last.who === who && !last.partial) {
      last.text += ` ${segment.text}`;
    } else {
      out.push({
        key: `s${segment.seq}`,
        who,
        text: segment.text,
        at: segment.startedMs,
        partial: false,
      });
    }
  }
  for (const who of ["them", "me"] as const) {
    const text = partial?.[who].trim();
    if (text) out.push({ key: `p-${who}`, who, text, at: null, partial: true });
  }
  return out;
}

/**
 * Me/them bubbles: your mic on the right, the call on the left. Text still
 * being spoken (`partial`) streams in at the end, dimmer, with a caret.
 */
export function Transcript({
  segments,
  partial,
  follow = false,
  className,
  emptyText = "Nothing transcribed yet.",
}: {
  segments: Segment[];
  partial?: PartialTranscript;
  /** Keep scrolled to the newest text while it arrives. */
  follow?: boolean;
  className?: string;
  emptyText?: string;
}) {
  const list = bubbles(segments, partial);
  const endRef = useRef<HTMLDivElement>(null);
  const last = list.at(-1);
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [follow, list.length, last?.text]);

  if (list.length === 0) {
    return (
      <p className={cn("text-[13px] text-muted-foreground", className)}>
        {emptyText}
      </p>
    );
  }
  return (
    <div
      data-selectable
      aria-live={follow ? "polite" : undefined}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {list.map((bubble, i) => {
        const first = list[i - 1]?.who !== bubble.who;
        return (
          <div
            key={bubble.key}
            className={cn(
              "flex flex-col",
              bubble.who === "me" ? "items-end" : "items-start",
              first && i > 0 && "mt-2",
            )}
          >
            {first && (
              <span className="mb-1 px-1 text-[11px] text-muted-foreground">
                {bubble.who === "me" ? "Me" : "Them"}
                {bubble.at !== null && (
                  <span className="ml-1.5 tabular-nums opacity-70">
                    {clock(bubble.at)}
                  </span>
                )}
              </span>
            )}
            <p
              className={cn(
                "max-w-[85%] rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed",
                bubble.who === "me"
                  ? "rounded-br-md bg-me text-me-foreground"
                  : "rounded-bl-md bg-muted text-foreground",
                bubble.partial && "opacity-60",
              )}
            >
              {bubble.text}
              {bubble.partial && (
                <span className="caret-blink ml-0.5 inline-block h-3.5 w-[1.5px] translate-y-0.5 bg-current" />
              )}
            </p>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
