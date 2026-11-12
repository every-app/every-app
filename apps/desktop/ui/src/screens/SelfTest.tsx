import { cn } from "cn";
import {
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  Loader2,
  Mic,
  Volume2,
  XCircle,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { selfTestRows, type SelfTestRow } from "../lib/selftest";
import type { SelfTestReport } from "../types";
import { ROW_LEAD } from "./parts";

export type SelfTestState =
  | { kind: "idle" }
  /** Live: `progress` is the helper's report so far (undefined until the first one). */
  | {
      kind: "checking";
      progress?: SelfTestReport;
      levels: { mic: number; system: number };
    }
  /** Stopped (or reached its limit): the last report, without meters. */
  | { kind: "done"; report: SelfTestReport }
  | { kind: "error"; message: string };

export interface SelfTestProps {
  state: SelfTestState;
  onStart: () => void;
  onStop: () => void;
  onOpenSettings: (pane: "mic" | "systemAudio") => void;
  /** Why it can't start right now (a recording). */
  disabledReason?: string;
}

const PRIVACY = "Nothing is recorded or sent anywhere.";

/** "Check microphone & Mac audio": live meters for both sides until Stop. */
export function SelfTest({
  state,
  onStart,
  onStop,
  onOpenSettings,
  disabledReason,
}: SelfTestProps) {
  const checking = state.kind === "checking";
  const rows =
    state.kind === "checking"
      ? selfTestRows(state.progress)
      : state.kind === "done"
        ? selfTestRows(state.report, true)
        : undefined;
  return (
    <div data-slot="selftest" className="flex flex-col gap-2.5 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className={ROW_LEAD}>
          <AudioLines className="size-4 text-foreground/55" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            Check microphone &amp; Mac audio
          </div>
          <div className="text-[12px] text-muted-foreground">
            {checking
              ? `Speak, and play something on your Mac. ${PRIVACY}`
              : (disabledReason ??
                `See that Every App hears you and your Mac. ${PRIVACY}`)}
          </div>
        </div>
        {checking ? (
          <Button size="sm" variant="outline" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={onStart}
            disabled={!!disabledReason}
          >
            {state.kind === "idle" ? "Start check" : "Check again"}
          </Button>
        )}
      </div>
      {state.kind === "error" && (
        <p
          role="alert"
          className="flex items-start gap-2 pl-12 text-[12px] text-destructive"
        >
          <XCircle className="mt-px size-3.5 shrink-0" />
          {state.message}
        </p>
      )}
      {rows && (
        <ul
          aria-label="Microphone and Mac audio"
          className="flex flex-col gap-1.5 pl-12"
        >
          {rows.map((row) => (
            <Row
              key={row.side}
              row={row}
              level={
                state.kind === "checking" ? state.levels[row.side] : undefined
              }
              onOpenSettings={onOpenSettings}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  row,
  level,
  onOpenSettings,
}: {
  row: SelfTestRow;
  /** Live level 0–1; undefined once the check has ended. */
  level?: number;
  onOpenSettings: (pane: "mic" | "systemAudio") => void;
}) {
  const Icon = row.side === "mic" ? Mic : Volume2;
  return (
    <li
      data-side={row.side}
      data-tone={row.tone}
      className="flex h-6 items-center gap-2 text-[12px]"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 font-medium">{row.label}</span>
        {row.device && (
          <span className="truncate text-muted-foreground" title={row.device}>
            {row.device}
          </span>
        )}
      </span>
      {level !== undefined && <Meter label={row.label} level={level} />}
      <span
        className={cn(
          "flex w-[172px] shrink-0 items-center gap-1.5",
          row.tone === "waiting" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <ToneIcon tone={row.tone} />
        <span className="truncate">{row.text}</span>
        {row.openSettings && (
          <button
            type="button"
            className="shrink-0 cursor-default text-foreground underline decoration-foreground/30 underline-offset-3 hover:decoration-foreground"
            onClick={() => onOpenSettings(row.openSettings!)}
          >
            Open Settings
          </button>
        )}
      </span>
    </li>
  );
}

function ToneIcon({ tone }: { tone: SelfTestRow["tone"] }) {
  switch (tone) {
    case "ok":
      return <CheckCircle2 className="size-3.5 shrink-0 text-success" />;
    case "warn":
      return <AlertTriangle className="size-3.5 shrink-0 text-warning" />;
    case "bad":
      return <XCircle className="size-3.5 shrink-0 text-destructive" />;
    case "waiting":
      return <Loader2 className="size-3.5 shrink-0 animate-spin opacity-60" />;
  }
}

/** A horizontal level bar, 0–1 (the helper's −60…0 dBFS scale). */
function Meter({ label, level }: { label: string; level: number }) {
  const l = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  return (
    <span
      role="meter"
      aria-label={`${label} level`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(l * 100)}
      className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-foreground/10"
    >
      <span
        className="block h-full rounded-full bg-foreground/60 transition-[width] duration-100 ease-out"
        style={{ width: `${l * 100}%` }}
      />
    </span>
  );
}
