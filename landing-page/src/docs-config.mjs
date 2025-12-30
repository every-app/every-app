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
    items: [{ slug: "docs/getting-started/quickstart" }],
  },
  {
    label: "Build an App",
    items: [{ slug: "docs/build-an-app/create-app" }],
  },
  {
    label: "Coding Agents",
    items: [{ slug: "docs/coding-agents/setup" }],
  },
  {
    label: "Walkthrough: AI Cooking Assistant",
    collapsed: true,
    items: [
      { slug: "docs/walkthrough/overview", label: "Overview" },
      { slug: "docs/walkthrough/users-and-auth", label: "Users & Auth" },
      { slug: "docs/walkthrough/theming", label: "Theming & Styling" },
      { slug: "docs/walkthrough/database-schema", label: "Database Schema" },
      {
        slug: "docs/walkthrough/organize-backend-code",
        label: "Organize Backend Code",
      },
      { slug: "docs/walkthrough/instant-updates", label: "Instant UI Updates" },
      { slug: "docs/walkthrough/ai-chat", label: "AI Chat & Tool Calls" },
    ],
  },
  {
    label: "Reference",
    items: [
      { slug: "docs/tech-stack/overview", label: "Tech Stack" },
      { slug: "docs/embedded-sdk/overview", label: "SDK" },
    ],
  },
];

/**
 * Convert docsConfig to Starlight sidebar format
 * @returns {Array} Starlight sidebar configuration
 */
export function toStarlightSidebar() {
  const sidebar = [];

  // Sections with a single item that should be flattened to top-level
  const flattenedSections = [
    "Introduction",
    "Getting Started",
    "Build an App",
    "Coding Agents",
  ];

  for (const section of docsConfig) {
    // Single-item sections are flattened to top-level links
    if (
      section.items.length === 1 &&
      flattenedSections.includes(section.label)
    ) {
      sidebar.push({
        label: section.label,
        link: `/${section.items[0].slug}`,
      });
    } else {
      const sidebarItem = {
        label: section.label,
        items: section.items,
      };
      if (section.collapsed) {
        sidebarItem.collapsed = true;
      }
      sidebar.push(sidebarItem);
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
