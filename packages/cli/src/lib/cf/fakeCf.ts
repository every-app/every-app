/**
 * `FakeCf` — a scripted {@link CfRunner} for unit tests. Nothing is spawned.
 *
 *   const cf = new FakeCf().on(["d1", "migrations", "apply"], { stdout: "[]" });
 *   await applyLocalMigrations({ cwd, manifest, cf });
 *   expect(cf.calls[0]!.args).toEqual([...]);
 *
 * Scripts match on an argv prefix (or a predicate); the first match wins and
 * unmatched calls succeed with empty output. A response can be computed from
 * the call (to back `cf d1 query` with a real database, say). A non-zero
 * `exitCode` throws the same `CfError` the real runner would, parsed from
 * its output, and so does cf's `Aborted.` after a confirmation it declined.
 */
import type {
  CfCall,
  CfProcess,
  CfResult,
  CfRunner,
  CfStartCall,
} from "./runner";
import { abortedCfError, CfError, parseCfOutput } from "./errors";

export interface FakeCfResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  stoppedByWatchdog?: boolean;
}

export interface RecordedCfCall {
  args: string[];
  plane: CfCall["plane"];
  cwd?: string;
  mode: CfCall["mode"];
  local: boolean;
  env: Record<string, string | undefined>;
  /** Contents of `files`, as the command would have read them. */
  files: Record<string, string>;
}

type Matcher = readonly string[] | ((args: string[]) => boolean);
type FakeCfScript =
  | FakeCfResponse
  | ((call: RecordedCfCall) => FakeCfResponse | Promise<FakeCfResponse>);

export class FakeCf implements CfRunner {
  readonly calls: RecordedCfCall[] = [];
  readonly started: CfStartCall[] = [];
  private readonly scripts: Array<{
    match: Matcher;
    response: FakeCfScript;
  }> = [];
  private resolveExit?: (value: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;

  /** Script the response for calls whose argv starts with `match`. */
  on(match: Matcher, response: FakeCfScript): this {
    this.scripts.push({ match, response });
    return this;
  }

  /** Like `on`, ahead of every script already there. */
  override(match: Matcher, response: FakeCfScript): this {
    this.scripts.unshift({ match, response });
    return this;
  }

  async run(call: CfCall): Promise<CfResult> {
    const files = Object.fromEntries(
      Object.entries(call.files ?? {}).map(([name, content]) => [
        name,
        typeof content === "string" ? content : JSON.stringify(content),
      ]),
    );
    const args =
      typeof call.args === "function"
        ? call.args(
            Object.fromEntries(
              Object.keys(files).map((name) => [
                name,
                `/fake-cf-files/${name}`,
              ]),
            ),
          )
        : [...call.args];
    const recorded: RecordedCfCall = {
      args,
      plane: call.plane,
      cwd: call.cwd,
      mode: call.mode,
      local: call.local ?? false,
      env: call.env ?? {},
      files,
    };
    this.calls.push(recorded);

    const script =
      this.scripts.find(({ match }) => matches(match, args))?.response ?? {};
    const response =
      typeof script === "function" ? await script(recorded) : script;
    const stdout = response.stdout ?? "";
    const stderr = response.stderr ?? "";
    const exitCode = response.exitCode ?? 0;
    if (stdout) call.onOutput?.(stdout);
    if (stderr) call.onOutput?.(stderr);
    if (exitCode !== 0) {
      throw new CfError(parseCfOutput(stderr, stdout), {
        exitCode,
        stderr,
        stdout,
      });
    }
    const aborted = abortedCfError(["cf", ...args].join(" "), stderr);
    if (aborted) throw aborted;
    return {
      stdout,
      stderr,
      stoppedByWatchdog: response.stoppedByWatchdog ?? false,
    };
  }

  async start(call: CfStartCall): Promise<CfProcess> {
    this.started.push(call);
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      this.resolveExit = resolve;
    });
    return {
      exited,
      stop: (signal = "SIGTERM") => this.resolveExit?.({ code: null, signal }),
      releaseOutput: () => {},
    };
  }
}

function matches(match: Matcher, args: string[]): boolean {
  if (typeof match === "function") return match(args);
  return match.every((part, index) => args[index] === part);
}
