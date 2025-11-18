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
 * Prompt user to acknowledge pnpm requirement
 * Loops until user confirms with 'y'
 */
async function promptPnpmAcknowledgement(): Promise<void> {
  let acknowledged = false;
  let response = null;

  while (!acknowledged) {
    response = await enquirer.prompt<{ acknowledged: boolean }>({
      type: "confirm",
      name: "acknowledged",
      message: !response
        ? "pnpm has been chosen as the package manager for Every App projects. Other package managers will not work with `every app deploy` currently.\n\n  Press y to acknowledge this."
        : "You must acknowledge this to proceed. Press y to continue.\n",
      initial: false,
    });

    if (response.acknowledged) {
      acknowledged = true;
    } else {
      console.log();
    }
  }
}

/**
 * Prompt user for app configuration
 */
export async function promptUserInput(): Promise<{ appId: string }> {
  console.log("Project Configuration\n");

  const response = await enquirer.prompt<{ appId: string }>({
    type: "input",
    name: "appId",
    message: "Enter your app ID (kebab-case format)",
    validate: validateAppId,
  });

  console.log();
  await promptPnpmAcknowledgement();

  return { appId: response.appId };
}
