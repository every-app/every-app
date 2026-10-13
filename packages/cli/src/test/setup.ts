/**
 * Every test file runs with its own empty HOME, so no test reads or writes
 * the real `~/.everyapp` (credentials, installs, the private directories
 * cf runs in), and no test leaves signal handlers behind for the next.
 */
import fs from "node:fs";
import { afterAll, afterEach } from "vitest";
import { resetInterruptsForTests } from "@/lib/interrupt";
import { makeTestHome } from "./home";

const home = makeTestHome();
process.env["HOME"] = home;
afterEach(() => resetInterruptsForTests());
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
