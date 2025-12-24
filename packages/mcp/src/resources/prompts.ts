import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MOCKUP_FROM_SPEC_PROMPT = `# Task: Build Mockup UI for App
Below is a description of a Product Spec for my app idea that I want to create a functional mockup for. 

Please implement all the pages and key interactions described in the product spec. Please use Daisy UI to accomplish this. Reference the context7 tool to read the DaisyUI docs if necessary. 

Please implement any interactions that seem reasonable. You can mock all data / should not implement any backend logic. 

## Goal
Functional mockup of product spec supporting key flows built using Daisy UI

## Non-Goals
Implementing any backend functionality

## Coding Guidelines
Please still try to follow good frontend coding practices like breaking things into smaller components / file so that the code is readable. 

## Checklist before implementing
- Please ask any clarifying questions if the Product Spec is ambigious
    - Asking these are not essential and you should only do so if there are major things which are not clear in the spec. 

--
# Product Spec
[PASTE PRODUCT SPEC HERE]`;

const REVIEW_CODE_PROMPT = `# Task: Review Code for Every App Best Practices

Please review the code changes in this PR/file for the following:

## Security
- Check for exposed secrets or sensitive data
- Validate input handling and sanitization
- Review authentication and authorization patterns

## Schema Design
- Check Drizzle schema for proper relationships
- Verify indexes are appropriate
- Review migration safety

## Simplification
- Look for opportunities to simplify complex logic
- Identify duplicate code that could be extracted
- Check for unused imports or dead code

## Every App Patterns
- Verify proper use of TanStack hooks
- Check optimistic mutation patterns
- Review error handling

## Output
Provide specific, actionable feedback organized by category.`;

export function registerPromptResources(server: McpServer) {
  // Register as prompts (user-driven: user selects from prompt list)
  server.prompt(
    "every-app-mockup-from-spec",
    "Build a UI mockup from a product spec using DaisyUI",
    async () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: MOCKUP_FROM_SPEC_PROMPT },
        },
      ],
    })
  );

  server.prompt(
    "every-app-review-code",
    "Review code for Every App best practices",
    async () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: REVIEW_CODE_PROMPT },
        },
      ],
    })
  );

  // Register as resources (application-driven: AI can fetch these proactively)
  server.resource(
    "prompts/mockup-from-spec",
    "every-app://prompts/mockup-from-spec",
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: MOCKUP_FROM_SPEC_PROMPT,
        },
      ],
    })
  );

  server.resource(
    "prompts/review-code",
    "every-app://prompts/review-code",
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: REVIEW_CODE_PROMPT,
        },
      ],
    })
  );
}
