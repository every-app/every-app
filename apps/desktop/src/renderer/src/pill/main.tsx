// The floating recorder's page (pill.html, src/main/pillWindow.ts). Main decides where things
// sit and whether the panel is open; this draws it, moves the meter with the helper's `levels`,
// asks main to open the meeting on a click, and tells main when a drag of the pill starts and
// ends (main moves the window).

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FloatingRecorder, meterLevel } from "@every-app/desktop-ui";
import type { PillView } from "@shared/ipc";
import { LEVELS_STALE_MS, pillNotice } from "./view";
import "./pill.css";

const bridge = window.everyapp;

function usePillView(): PillView | undefined {
  const [view, setView] = useState<PillView>();
  useEffect(() => {
    let pushed = false;
    const off = bridge.on("pill", (v) => {
      pushed = true;
      setView(v);
    });
    void bridge["pill:get"]().then((v) => {
      if (!pushed) setView(v);
    });
    return off;
  }, []);
  return view;
}

function useLevel(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let stale: ReturnType<typeof setTimeout> | undefined;
    const off = bridge.on("helper", (event) => {
      if (event.event !== "levels") return;
      setLevel(meterLevel(event.mic, event.system));
      clearTimeout(stale);
      stale = setTimeout(() => setLevel(0), LEVELS_STALE_MS);
    });
    return () => {
      off();
      clearTimeout(stale);
    };
  }, []);
  return level;
}

function Pill() {
  const view = usePillView();
  const level = useLevel();
  if (!view) return null;
  return (
    <FloatingRecorder
      layout={view.layout}
      expanded={view.expanded}
      level={level}
      stopping={view.recording.state === "stopping"}
      segments={view.transcript.segments}
      pending={view.transcript.pending}
      notice={pillNotice(view.recording)}
      onOpen={() => void bridge["pill:openMeeting"]()}
      onDragStart={(at) => void bridge["pill:dragStart"](at)}
      onDragEnd={() => void bridge["pill:dragEnd"]()}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Pill />
  </StrictMode>,
);
