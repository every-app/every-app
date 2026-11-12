/**
 * Whether a sandbox works, after `up` and after `update`: status finds it
 * claimed, in sync, running `checkout`'s release with no error to fix (its
 * warnings are shown), and the starter app bound; the owner signs in with a browser and the starter
 * app opens behind the Gateway. What a change under test needs beyond that
 * is the agent's to try on the sandbox.
 */
import { chromium } from "playwright";
import { STARTER_APP_ID, signIn, status } from "./gateway.mjs";

export async function checkHealth({ config, checkout, sandbox, label }) {
  const state = await status({ config, checkout, sandbox, label });
  const problems = [];
  if (!state.claimed) problems.push("it has no owner");
  if (state.upToDate !== true) problems.push(`it doesn't run ${checkout}'s release (it runs ${state.release.version})`);
  if (!state.inSync) problems.push("its apps, bindings or hostnames are out of sync");
  const errors = state.fixes.filter((fix) => fix.severity === "error");
  if (errors.length > 0) problems.push(`status lists errors: ${errors.map((fix) => fix.code).join(", ")}`);
  for (const warning of state.fixes.filter((fix) => fix.severity !== "error")) {
    console.log(`  ! ${warning.message.split("\n")[0]}`);
  }
  const starter = state.apps.find((app) => app.id === STARTER_APP_ID);
  if (!starter?.bound) problems.push("the starter app isn't bound");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await signIn(context, sandbox);
    if (starter) {
      const response = await page.goto(`https://${starter.hostname}/`);
      if (!response?.ok()) problems.push(`the starter app answered ${response?.status()}`);
    }
  } catch (error) {
    problems.push(`the owner couldn't sign in: ${error.message.split("\n")[0]}`);
  } finally {
    await browser.close();
  }
  if (problems.length > 0) throw new Error(`The sandbox isn't healthy: ${problems.join("; ")}`);
  console.log(`  ✔ Healthy: owner signs in, starter app opens, ${state.release.version} from ${checkout}`);
}
