/**
 * Shared documentation configuration used by both:
 * - astro.config.mjs (for Starlight sidebar)
 * - scripts/generate-llms-txt.js (for llms.txt generation)
 *
 * This ensures the docs structure stays in sync.
 */

/**
 * @typedef {Object} DocItem
 * @property {string} slug - The document slug (path without extension)
 * @property {string} [label] - Optional custom label for sidebar display
 */

/**
 * @typedef {Object} DocSection
 * @property {string} label - Section name for sidebar/llms.txt
 * @property {DocItem[]} items - Documents in this section
 */

/** @type {DocSection[]} */
export const docsConfig = [
  {
    label: "Introduction",
    items: [{ slug: "docs/introduction" }],
  },
  {
    label: "Getting Started",
    items: [
      { slug: "docs/getting-started/deploy-gateway" },
      { slug: "docs/getting-started/deploy-todo-app" },
    ],
  },
  {
    label: "Build an App",
    items: [
      { slug: "docs/build-an-app/start-from-template" },
      { slug: "docs/build-an-app/development-workflow" },
      { slug: "docs/build-an-app/deployment" },
    ],
  },
  {
    label: "Embedded SDK",
    items: [
      { slug: "docs/embedded-sdk/overview" },
      { slug: "docs/embedded-sdk/client" },
      { slug: "docs/embedded-sdk/server" },
    ],
  },
  {
    label: "Tech Stack",
    items: [
      { slug: "docs/tech-stack/overview", label: "Why These Choices?" },
      { slug: "docs/tech-stack/tanstack-start" },
      { slug: "docs/tech-stack/cloudflare" },
      { slug: "docs/tech-stack/drizzle" },
    ],
  },
  {
    label: "Walkthrough: AI Cooking Assistant",
    items: [
      { slug: "docs/walkthrough/overview", label: "Overview" },
      { slug: "docs/walkthrough/users-and-auth" },
      { slug: "docs/walkthrough/daisyui-theming" },
      { slug: "docs/walkthrough/schema-design" },
      { slug: "docs/walkthrough/repos-and-services" },
      { slug: "docs/walkthrough/tanstack-db" },
      { slug: "docs/walkthrough/ai-integration" },
    ],
  },
  {
    label: "Coding Agent",
    items: [
      { slug: "docs/coding-agent/setup" },
      { slug: "docs/coding-agent/prompts/mockup-from-spec" },
      { slug: "docs/coding-agent/prompts/review-code" },
    ],
  },
];

/**
 * Convert docsConfig to Starlight sidebar format
 * @returns {Array} Starlight sidebar configuration
 */
export function toStarlightSidebar() {
  const sidebar = [];

  for (const section of docsConfig) {
    // Single-item sections (like Introduction) are flattened
    if (section.items.length === 1 && section.label === "Introduction") {
      sidebar.push(section.items[0]);
    } else {
      sidebar.push({
        label: section.label,
        items: section.items,
      });
    }
  }

  // Add llms.txt link at the end
  sidebar.push({
    label: "llms.txt",
    link: "/llms.txt",
    attrs: { target: "_blank" },
  });

  return sidebar;
}
