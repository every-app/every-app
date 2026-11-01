/**
 * A deploy the API refuses or a job that fails, with a stable code for the
 * CLI and a sentence for the person reading it. `status` is the HTTP
 * status a route answers with; a failed job keeps the code and message.
 */
export class DeployError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeployError";
  }
}

/** A bundle the deployer won't upload, with every reason at once. */
export function bundleRefused(problems: readonly string[]): DeployError {
  return new DeployError(
    "BUNDLE_REFUSED",
    422,
    `The app can't be deployed as a third-party app:\n  - ${problems.join("\n  - ")}`,
  );
}
