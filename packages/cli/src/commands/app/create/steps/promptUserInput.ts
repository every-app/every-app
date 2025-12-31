import enquirer from "enquirer";

/**
 * Validate app ID format (kebab-case)
 */
function validateAppId(input: string): boolean | string {
  if (!input || input.trim().length === 0) {
    return "App ID cannot be empty";
  }

  if (input.length > 64) {
    return "App ID must be 64 characters or less";
  }

  const kebabCaseRegex = /^[a-z][a-z0-9-]*$/;

  if (!kebabCaseRegex.test(input)) {
    return "App ID must be in kebab-case format (lowercase letters, numbers, and hyphens only, starting with a letter)";
  }

  return true;
}

/**
 * Prompt user for app configuration
 * @param defaultAppId - Optional default value for the app ID prompt
 */
export async function promptUserInput(
  defaultAppId?: string,
): Promise<{ appId: string }> {
  console.log("Project Configuration\n");

  const response = await enquirer.prompt<{ appId: string }>({
    type: "input",
    name: "appId",
    message: "Enter your app ID (kebab-case format)",
    initial: defaultAppId,
    validate: validateAppId,
  });

  console.log();
  return { appId: response.appId };
}
