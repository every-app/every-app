#!/usr/bin/env node

/**
 * Script to generate llms.txt from documentation files.
 * This follows the llms.txt specification (https://llmstxt.org/)
 *
 * Usage:
 *   node scripts/generate-llms-txt.js          # Generate llms.txt
 *   node scripts/generate-llms-txt.js --check  # Check if llms.txt is up to date
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { docsConfig } from "../src/docs-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DOCS_DIR = join(__dirname, "../src/content/docs");
const OUTPUT_FILE = join(__dirname, "../public/llms.txt");

/**
 * Remove MDX frontmatter (content between ---) from the beginning of file
 */
function removeFrontmatter(content) {
  const frontmatterRegex = /^---\n[\s\S]*?\n---\n*/;
  return content.replace(frontmatterRegex, "");
}

/**
 * Extract title from frontmatter
 */
function extractTitle(content) {
  const match = content.match(
    /^---\n[\s\S]*?title:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/,
  );
  return match ? match[1].trim() : null;
}

/**
 * Clean MDX content to plain markdown
 * - Remove import statements
 * - Remove JSX components like <Aside>, <Steps>, etc.
 * - Convert component content to markdown where possible
 */
function cleanMdxContent(content) {
  // Remove import statements
  content = content.replace(/^import\s+.*?from\s+['"].*?['"];?\s*$/gm, "");

  // Handle <Aside> components - extract content and convert to blockquote
  content = content.replace(
    /<Aside[^>]*title=["']([^"']+)["'][^>]*>([\s\S]*?)<\/Aside>/g,
    (match, title, innerContent) => {
      const cleanContent = innerContent.trim();
      return `> **${title}**: ${cleanContent}\n`;
    },
  );

  // Handle <Aside> without title
  content = content.replace(
    /<Aside[^>]*>([\s\S]*?)<\/Aside>/g,
    (match, innerContent) => {
      const cleanContent = innerContent.trim();
      return `> ${cleanContent}\n`;
    },
  );

  // Handle <Steps> - just keep the inner content
  content = content.replace(/<Steps>/g, "");
  content = content.replace(/<\/Steps>/g, "");

  // Remove any remaining self-closing JSX tags
  content = content.replace(/<[A-Z][a-zA-Z]*\s*\/>/g, "");

  // Remove any remaining opening/closing JSX tags without content extraction
  content = content.replace(/<\/?[A-Z][a-zA-Z]*[^>]*>/g, "");

  // Clean up multiple blank lines
  content = content.replace(/\n{3,}/g, "\n\n");

  return content.trim();
}

/**
 * Convert a slug to a file path
 * @param {string} slug - e.g., "docs/introduction"
 * @returns {string} - e.g., "/path/to/docs/introduction.mdx"
 */
function slugToFilePath(slug) {
  return join(DOCS_DIR, `${slug}.mdx`);
}

/**
 * Read and process a single documentation file
 */
function processDocFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const title = extractTitle(content);
  const cleanedContent = removeFrontmatter(content);
  const markdownContent = cleanMdxContent(cleanedContent);

  return {
    title,
    content: markdownContent,
  };
}

/**
 * Generate the llms.txt content
 */
function generateLlmsTxt() {
  const sections = [];

  // Header section
  sections.push("# Every App Documentation\n");
  sections.push(
    "> Every App is a framework for building self-hosted, full-stack web applications on Cloudflare. It provides a Gateway for authentication and app management, plus tools for rapid development with AI coding agents.\n",
  );
  sections.push(
    "This documentation covers how to deploy and build apps with Every App, including the tech stack, embedded SDK for authentication, and coding agent integration.\n",
  );

  // Process each section from the shared config
  for (const section of docsConfig) {
    const sectionContent = [];
    sectionContent.push(`## ${section.label}\n`);

    for (const item of section.items) {
      const filePath = slugToFilePath(item.slug);

      try {
        const { title, content } = processDocFile(filePath);
        const displayTitle = title || basename(item.slug);

        sectionContent.push(`### ${displayTitle}\n`);
        sectionContent.push(content);
        sectionContent.push("\n");
      } catch (error) {
        console.error(
          `Warning: Could not process ${filePath}: ${error.message}`,
        );
      }
    }

    sections.push(sectionContent.join("\n"));
  }

  return sections.join("\n");
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");

  const generatedContent = generateLlmsTxt();

  if (isCheck) {
    // Check mode: compare with existing file
    let existingContent;
    try {
      existingContent = readFileSync(OUTPUT_FILE, "utf-8");
    } catch (error) {
      console.error(
        "Error: llms.txt does not exist. Run 'node scripts/generate-llms-txt.js' to generate it.",
      );
      process.exit(1);
    }

    if (existingContent !== generatedContent) {
      console.error("Error: llms.txt is out of date with documentation.");
      console.error("Run 'node scripts/generate-llms-txt.js' to update it.");
      process.exit(1);
    }

    console.log("llms.txt is up to date.");
    process.exit(0);
  } else {
    // Generate mode: write the file
    writeFileSync(OUTPUT_FILE, generatedContent);
    console.log(`Generated ${OUTPUT_FILE}`);
  }
}

main();
