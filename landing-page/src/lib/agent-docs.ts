import { env } from "cloudflare:workers";

// Server only (the Worker's ASSETS binding): imported by server functions and
// route handlers, never by a component.

/**
 * The agent docs as the site serves them: static Markdown files under
 * public/docs/agent, written by scripts/sync-agent-docs.js before every dev
 * and build, with the page's title and URL as their first line. The Worker
 * reads them through its ASSETS binding (never bundled: compiled to MDX, 3 MB
 * of Markdown became 17 MB of JavaScript) for the HTML pages, llms.txt and
 * llms-full.txt; an agent's fetch of /docs/agent/<page>.md is answered by
 * the asset itself.
 */
export async function readAgentMarkdown(path: string): Promise<string> {
  const response = await env.ASSETS.fetch(
    new Request(`https://assets.invalid/docs/agent/${path}`),
  );
  if (!response.ok) {
    throw new Error(
      `No served Markdown for agent page ${path}: ${response.status}`,
    );
  }
  return response.text();
}

/** A served page without its first line (`# Title (URL)`). */
export function agentPageBody(served: string): string {
  return served.replace(/^# [^\n]*\n\n?/, "");
}
