import { useEffect, useState } from "react";
import type { RecordingSnapshot } from "@shared/ipc";
import { recordingElapsedMs } from "./recording";

/** The recording's elapsed time, ticking once a second until Stop (then it holds). */
export function useRecordingElapsed(rec: RecordingSnapshot | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!rec && rec.state !== "idle" && !!rec.startedAt && !rec.stoppingSince;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return recordingElapsedMs(rec, now);
}
