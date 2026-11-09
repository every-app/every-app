import "./playground.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cn } from "cn";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { scenes } from "./scenes";

type Theme = "light" | "dark";

const SIZES = [
  { label: "1200 × 800", w: 1200, h: 800 },
  { label: "1440 × 900", w: 1440, h: 900 },
  { label: "1024 × 700", w: 1024, h: 700 },
  { label: "900 × 600 (min)", w: 900, h: 600 },
];

function params() {
  const p = new URLSearchParams(window.location.search);
  return {
    scene: p.get("scene") ?? scenes[0]!.id,
    theme: (p.get("theme") === "dark" ? "dark" : "light") as Theme,
    bare: p.has("bare"),
    size: Number(p.get("size") ?? 0),
  };
}

function setParams(next: Partial<ReturnType<typeof params>>) {
  const current = { ...params(), ...next };
  const p = new URLSearchParams();
  p.set("scene", current.scene);
  p.set("theme", current.theme);
  if (current.size) p.set("size", String(current.size));
  window.history.replaceState(null, "", `?${p}`);
}

/** The window's traffic lights, drawn for the playground only. */
function TrafficLights() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-[20px] top-[19px] z-50 flex gap-2"
    >
      {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
        <span
          key={color}
          className="size-3 rounded-full"
          style={{
            background: color,
            boxShadow: "inset 0 0 0 0.5px rgb(0 0 0 / 0.15)",
          }}
        />
      ))}
    </div>
  );
}

function Window({ sceneId, animate }: { sceneId: string; animate: boolean }) {
  const scene = scenes.find((s) => s.id === sceneId) ?? scenes[0]!;
  return (
    <div className="relative h-full w-full">
      <TrafficLights />
      <div key={scene.id} className="h-full w-full">
        {scene.render({ animate })}
      </div>
    </div>
  );
}

function useTheme(theme: Theme) {
  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      theme === "dark" ? "openseo-dark" : "openseo",
    );
  }, [theme]);
}

function Bare() {
  const { scene, theme } = params();
  useTheme(theme);
  return (
    <div className="h-screen w-screen">
      <Window sceneId={scene} animate={false} />
    </div>
  );
}

function Playground() {
  const initial = params();
  const [sceneId, setScene] = useState(initial.scene);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [sizeIndex, setSize] = useState(initial.size);
  const [animate, setAnimate] = useState(true);
  useTheme(theme);
  useEffect(
    () => setParams({ scene: sceneId, theme, size: sizeIndex }),
    [sceneId, theme, sizeIndex],
  );
  const size = SIZES[sizeIndex] ?? SIZES[0]!;
  const groups = [...new Set(scenes.map((s) => s.group))];

  return (
    <div className="playground flex h-screen w-screen text-[13px]">
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/40 p-3">
        <p className="px-2 pb-3 pt-1 text-[12px] font-semibold">
          Every App UI playground
        </p>
        {groups.map((group) => (
          <div key={group} className="mb-3">
            <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
              {group}
            </p>
            {scenes
              .filter((s) => s.group === group)
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setScene(s.id)}
                  className={cn(
                    "block w-full rounded-md px-2 py-1 text-left",
                    s.id === sceneId
                      ? "bg-foreground/10 font-medium"
                      : "hover:bg-foreground/5",
                  )}
                >
                  {s.label}
                </button>
              ))}
          </div>
        ))}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2">
          <select
            aria-label="Window size"
            value={sizeIndex}
            onChange={(e) => setSize(Number(e.target.value))}
            className="rounded-md border border-border bg-card px-2 py-1"
          >
            {SIZES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-border bg-card px-2 py-1"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "Dark" : "Light"}
          </button>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={animate}
              onChange={(e) => setAnimate(e.target.checked)}
            />
            Animate live data
          </label>
          <a
            className="ml-auto text-muted-foreground underline"
            href={`?scene=${sceneId}&theme=${theme}&bare`}
          >
            Open bare
          </a>
        </div>
        <div className="playground-desk min-h-0 flex-1 overflow-auto p-8">
          <div
            className="mx-auto overflow-hidden rounded-[10px] shadow-[0_0_0_0.5px_rgb(0_0_0/0.25),0_20px_60px_-10px_rgb(0_0_0/0.35)]"
            style={{ width: size.w, height: size.h }}
          >
            <Window sceneId={sceneId} animate={animate} />
          </div>
        </div>
      </div>
    </div>
  );
}

// The screenshot script reads the scene list from here.
(window as unknown as { __DESKTOP_SCENES__: string[] }).__DESKTOP_SCENES__ =
  scenes.map((s) => s.id);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      {params().bare ? <Bare /> : <Playground />}
    </TooltipProvider>
  </StrictMode>,
);
