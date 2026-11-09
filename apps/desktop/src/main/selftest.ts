// Settings → "Check microphone & Mac audio": runs the helper's selftest.run, which captures both
// sides locally (nothing sent or saved) until selftest.stop or 60 s, streaming `levels` and
// `selftest.progress` meanwhile. One at a time, never during a recording (the helper refuses
// too: `busy`). No Electron import.

import { EventEmitter } from "node:events";
import type { SelfTestReport } from "@shared/protocol";
import type { HelperSupervisor } from "./helper/supervisor";

/** The longest a check runs when nobody stops it (the helper's cap). */
export const SELF_TEST_MAX_SECONDS = 60;

export class SelfTestController extends EventEmitter<{ change: [{ running: boolean }] }> {
  private running = false;

  constructor(
    private readonly helper: Pick<HelperSupervisor, "request">,
    private readonly isRecording: () => boolean,
    private readonly log: (line: string) => void = () => {},
  ) {
    super();
  }

  get state(): { running: boolean } {
    return { running: this.running };
  }

  /** Runs until `stop()` or `seconds`, and answers what it heard. */
  async run(seconds = SELF_TEST_MAX_SECONDS): Promise<SelfTestReport> {
    if (this.isRecording()) throw new Error("Scribe is recording. Stop the recording, then check your microphone and Mac audio.");
    if (this.running) throw new Error("Every App is already checking your microphone and Mac audio.");
    this.running = true;
    this.emit("change", this.state);
    try {
      const report = await this.helper.request("selftest.run", { seconds });
      this.log(`self-test: ${report.passed ? "passed" : "not passed"} after ${report.seconds} s (mic ${report.mic.status}, system ${report.system.status})`);
      return report;
    } finally {
      this.running = false;
      this.emit("change", this.state);
    }
  }

  /** Ends the running check (its `run` then answers). Nothing to do when none runs. */
  async stop(): Promise<void> {
    if (!this.running) return;
    await this.helper.request("selftest.stop");
  }
}
